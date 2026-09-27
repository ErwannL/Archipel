import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import pino from 'pino';
import { FakeProvider } from '../src/ai/fake.js';
import { Worker } from '../src/processing/worker.js';
import { signRequest } from '../src/security/hmac.js';
import { config, nonce, signed, testApp } from './helpers/app.js';
import { newBoardId, testPool } from './helpers/db.js';

const pool = testPool();
let app: FastifyInstance;
const worker = new Worker(pool, new FakeProvider(), pino({ level: 'silent' }), {
  pollMs: 10,
  maxAttempts: 3,
  backoffBaseMs: 1,
});
beforeAll(async () => {
  app = await testApp(pool);
});
afterAll(async () => {
  await app.close();
  await pool.end();
});

const ev = (boardId: string, type: string, version: number, data: object) => ({
  eventId: `e-${type}-${version}-${Math.random()}`,
  boardId,
  type,
  version,
  data,
});

describe('service authentication', () => {
  it('rejects unsigned, badly signed, stale and replayed requests', async () => {
    const url = '/v1/boards/x/status';
    expect((await app.inject({ method: 'GET', url })).json()).toEqual({
      error: 'signature_missing',
    });
    const now = Math.floor(Date.now() / 1000);
    const bad = signRequest('wrong-secret-wrong-secret-wrong-secret', 'GET', url, '', now, nonce());
    const r1 = await app.inject({ method: 'GET', url, headers: { ...bad } });
    expect(r1.statusCode).toBe(401);
    expect(r1.json()).toEqual({ error: 'signature_bad_signature' });
    const old = signRequest(config.ARCHIPEL_HMAC_SECRET, 'GET', url, '', now - 3600, nonce());
    expect((await app.inject({ method: 'GET', url, headers: { ...old } })).json()).toEqual({
      error: 'signature_stale',
    });
    const ok = signRequest(config.ARCHIPEL_HMAC_SECRET, 'GET', url, '', now, nonce());
    expect((await app.inject({ method: 'GET', url, headers: { ...ok } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url, headers: { ...ok } })).json()).toEqual({
      error: 'signature_replayed',
    });
  });

  it('binds the signature to the body and the query string', async () => {
    const url = '/v1/boards/x/query';
    const now = Math.floor(Date.now() / 1000);
    const h = signRequest(
      config.ARCHIPEL_HMAC_SECRET,
      'POST',
      url,
      '{"question":"a"}',
      now,
      nonce(),
    );
    const r = await app.inject({
      method: 'POST',
      url,
      headers: { ...h, 'content-type': 'application/json' },
      payload: '{"question":"b"}',
    });
    expect(r.statusCode).toBe(401);
    const h2 = signRequest(
      config.ARCHIPEL_HMAC_SECRET,
      'DELETE',
      '/v1/boards/x?version=1',
      '',
      now,
      nonce(),
    );
    const r2 = await app.inject({
      method: 'DELETE',
      url: '/v1/boards/x?version=9',
      headers: { ...h2 },
    });
    expect(r2.statusCode).toBe(401);
  });

  it('returns stable error codes without echoing content', async () => {
    const r = await signed(app, 'POST', '/v1/events', {
      events: [{ type: 'card.created', secret: 'TOP SECRET' }],
    });
    expect(r.statusCode).toBe(400);
    expect(r.body).not.toContain('TOP SECRET');
    expect(r.json()).toEqual({ error: 'invalid_event:0' });
    const bad = await signed(app, 'POST', '/v1/events', { nope: 1 });
    expect(bad.json()).toEqual({ error: 'invalid_request', fields: ['events'] });
    const now = Math.floor(Date.now() / 1000);
    const h = signRequest(config.ARCHIPEL_HMAC_SECRET, 'POST', '/v1/events', '{oops', now, nonce());
    const r3 = await app.inject({
      method: 'POST',
      url: '/v1/events',
      headers: { ...h, 'content-type': 'application/json' },
      payload: '{oops',
    });
    expect(r3.json()).toEqual({ error: 'invalid_json' });
    const h4 = signRequest(config.ARCHIPEL_HMAC_SECRET, 'POST', '/v1/events', 'x', now, nonce());
    const r4 = await app.inject({
      method: 'POST',
      url: '/v1/events',
      headers: { ...h4, 'content-type': 'text/plain' },
      payload: 'x',
    });
    expect(r4.json()).toEqual({ error: 'unsupported_media_type' });
    expect((await app.inject({ method: 'GET', url: '/nothing' })).json()).toEqual({
      error: 'not_found',
    });
    expect((await signed(app, 'GET', '/v1/boards/x/cards/c/status')).json()).toEqual({
      error: 'card_not_found',
    });
    expect(
      (await signed(app, 'POST', '/v1/boards/missing/query', { question: 'q' })).json(),
    ).toEqual({ error: 'board_not_found' });
  });

  it('rejects oversized events and bodies', async () => {
    const b = newBoardId();
    const big = ev(b, 'card.created', 1, {
      cardId: 'c',
      title: 't',
      description: 'x'.repeat(config.MAX_EVENT_BYTES),
    });
    const r = await signed(app, 'POST', '/v1/events', { events: [big] });
    expect(r.statusCode).toBe(413);
    expect(r.json()).toEqual({ error: 'event_too_large:0' });
    const huge = await app.inject({
      method: 'POST',
      url: '/v1/events',
      headers: { 'content-type': 'application/json' },
      payload: 'x'.repeat(5 * 1024 * 1024),
    });
    expect(huge.json()).toEqual({ error: 'payload_too_large' });
  });

  it('rate limits per board', async () => {
    const limited = await testApp(pool, { env: { RATE_LIMIT_PER_MINUTE: '2' } });
    const url = '/v1/boards/rl/status';
    expect((await signed(limited, 'GET', url)).statusCode).toBe(200);
    expect((await signed(limited, 'GET', url)).statusCode).toBe(200);
    expect((await signed(limited, 'GET', url)).json()).toEqual({ error: 'rate_limited' });
    expect((await signed(limited, 'GET', '/v1/boards/other/status')).statusCode).toBe(200);
    await limited.close();
  });

  it('serves health', async () => {
    expect((await app.inject({ method: 'GET', url: '/healthz' })).json()).toEqual({
      ok: true,
      orqeaUrl: 'https://orqea.dev',
    });
  });
});

describe('service routes', () => {
  it('ingests, reports status, answers queries, accepts facts, deletes and verifies', async () => {
    const b = newBoardId();
    const events = [
      ev(b, 'doc.created', 1, {
        docId: 'd1',
        title: 'Consignes',
        markdown: '# Base de données\nNe jamais supprimer la table `users` en production.',
      }),
      ev(b, 'card.created', 1, {
        cardId: 'c1',
        title: 'Migration',
        description: 'Le service `Billing` dépend de `Postgres`.',
        authorId: 'u1',
        authorName: 'Alice',
      }),
      ev(b, 'comment.created', 2, {
        commentId: 'm1',
        cardId: 'c1',
        text: 'Voir avec @bob',
        authorId: 'u2',
      }),
      ev(b, 'checklist.created', 2, {
        checklistId: 'k1',
        cardId: 'c1',
        title: 'Étapes',
        items: [
          { text: 'Sauvegarde', done: true },
          { text: 'Migrer', done: false },
        ],
      }),
    ];
    const r = await signed(app, 'POST', '/v1/events', { events });
    expect(r.statusCode).toBe(202);
    expect(r.json().results.map((x: { outcome: string }) => x.outcome)).toEqual([
      'queued',
      'queued',
      'queued',
      'queued',
    ]);
    const replay = await signed(app, 'POST', '/v1/events', { events });
    expect(replay.json().results.map((x: { outcome: string }) => x.outcome)).toEqual([
      'duplicate',
      'duplicate',
      'duplicate',
      'duplicate',
    ]);

    const pending = (await signed(app, 'GET', `/v1/boards/${b}/cards/c1/status`)).json();
    expect(pending).toEqual({ boardId: b, cardId: 'c1', status: 'pending', items: 3 });
    await worker.drain();
    const st = (await signed(app, 'GET', `/v1/boards/${b}/status`)).json();
    expect(st.progress).toBe(1);
    expect(st.totals).toEqual({ pending: 0, processing: 0, indexed: 4, failed: 0 });

    const facts = await signed(app, 'POST', `/v1/boards/${b}/facts`, {
      cardId: 'c1',
      agentId: 'agent-7',
      facts: [{ factId: 'f1', text: 'Décidé : `Billing` utilise `Stripe`.' }],
    });
    expect(facts.statusCode).toBe(202);
    expect(facts.json()).toEqual({ results: [{ factId: 'f1', outcome: 'queued' }] });
    await worker.drain();

    const q = await signed(app, 'POST', `/v1/boards/${b}/query`, {
      question: 'Billing Stripe',
      maxTokens: 500,
      cardId: 'c1',
    });
    expect(q.statusCode).toBe(200);
    const body = q.json();
    expect(body.usedChars).toBeLessThanOrEqual(2000);
    expect(body.citations.map((c: { itemKey: string }) => c.itemKey)).toContain('fact:f1');
    expect(
      (
        await signed(app, 'POST', `/v1/boards/${b}/query`, {
          question: 'x',
          maxChars: 1000,
          maxTokens: 300,
        })
      ).json(),
    ).toEqual({ error: 'invalid_request', fields: ['maxTokens'] });
    expect(
      (await signed(app, 'POST', `/v1/boards/${b}/query`, { question: 'Billing' })).statusCode,
    ).toBe(200);

    const delFact = await signed(app, 'DELETE', `/v1/boards/${b}/facts/f1`);
    expect(delFact.json()).toEqual({ factId: 'f1', outcome: 'applied' });
    const retry = await signed(app, 'POST', `/v1/boards/${b}/retry`);
    expect(retry.json()).toEqual({ requeued: 0 });
    await signed(app, 'POST', `/v1/boards/${b}/facts`, {
      cardId: 'c1',
      version: 5,
      authorId: 'u9',
      authorName: 'Zoé',
      facts: [{ factId: 'f2', text: 'Le module `A` dépend de `B`.' }],
    });

    const stats = (await signed(app, 'GET', `/v1/boards/${b}/stats`)).json();
    expect(stats.exists).toBe(true);
    expect(stats.counts.passages).toBeGreaterThan(0);
    const del = await signed(app, 'DELETE', `/v1/boards/${b}?version=${Date.now()}`);
    expect(del.statusCode).toBe(200);
    const d = del.json();
    expect(d.before.entities).toBeGreaterThan(0);
    expect(Object.values(d.after).every((n) => n === 0)).toBe(true);
    expect(d.exists).toBe(false);
    const late = await signed(app, 'POST', '/v1/events', {
      events: [ev(b, 'card.updated', 2, { cardId: 'c1', title: 'x' })],
    });
    expect(late.json().results[0].outcome).toBe('stale');
    expect((await signed(app, 'DELETE', `/v1/boards/${b}`)).json().exists).toBe(false);
  });

  it('erases a user across boards and reports counts', async () => {
    const r = await signed(app, 'POST', '/v1/users/nobody-at-all/erase');
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({
      userId: 'nobody-at-all',
      itemsRemoved: 0,
      entitiesAnonymized: 0,
    });
    const r2 = await signed(app, 'POST', '/v1/users/nobody-2/erase', { version: 3 });
    expect(r2.json().itemsRemoved).toBe(0);
  });
});
