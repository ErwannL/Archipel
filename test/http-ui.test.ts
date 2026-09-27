import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import pino from 'pino';
import { FakeProvider } from '../src/ai/fake.js';
import { applyOperation } from '../src/ingest/apply.js';
import { Worker } from '../src/processing/worker.js';
import { handoff, testApp } from './helpers/app.js';
import { newBoardId, testPool } from './helpers/db.js';
import { op } from './helpers/events.js';

const pool = testPool();
let app: FastifyInstance;
beforeAll(async () => {
  app = await testApp(pool);
});
afterAll(async () => {
  await app.close();
  await pool.end();
});

async function login(boardId: string, a = app): Promise<string> {
  const r = await a.inject({
    method: 'POST',
    url: '/ui/session',
    payload: { token: handoff(boardId) },
  });
  expect(r.statusCode).toBe(200);
  expect(r.json().boardId).toBe(boardId);
  return r.headers['set-cookie']!.toString().split(';')[0]!;
}

describe('handoff → session', () => {
  it('404s without a valid, fresh, unused token', async () => {
    const b = newBoardId();
    const post = (payload: object) => app.inject({ method: 'POST', url: '/ui/session', payload });
    expect((await post({})).statusCode).toBe(404);
    expect((await post({ token: 'garbage' })).statusCode).toBe(404);
    expect((await post({ token: handoff(b, 'u', 60, -3600) })).statusCode).toBe(404);
    const t = handoff(b);
    expect((await post({ token: t })).statusCode).toBe(200);
    expect((await post({ token: t })).statusCode).toBe(404); // single use
  });

  it('protects every UI endpoint (404 without session)', async () => {
    for (const [method, url] of [
      ['GET', '/ui/api/overview'],
      ['GET', '/ui/api/graph'],
      ['GET', '/ui/api/entities/1'],
      ['POST', '/ui/api/search'],
    ] as const) {
      const r = await app.inject({
        method,
        url,
        headers: { cookie: 'archipel_session=forged.value' },
      });
      expect(r.statusCode).toBe(404);
    }
  });

  it('sets a hardened cookie and can log out', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/ui/session',
      payload: { token: handoff(newBoardId()) },
    });
    expect(r.headers['set-cookie']).toMatch(/HttpOnly; SameSite=Strict; Max-Age=1800$/);
    expect(r.headers['content-security-policy']).toContain("default-src 'self'");
    const secure = await testApp(pool, { env: { COOKIE_SECURE: 'true' } });
    const r2 = await secure.inject({
      method: 'POST',
      url: '/ui/session',
      payload: { token: handoff(newBoardId()) },
    });
    expect(r2.headers['set-cookie']).toContain('; Secure');
    await secure.close();
    const out = await app.inject({ method: 'DELETE', url: '/ui/session' });
    expect(out.headers['set-cookie']).toContain('Max-Age=0');
  });
});

describe('UI data, scoped to the session board only', () => {
  it('shows overview, graph, search and entity detail of its own board', async () => {
    const a = newBoardId();
    const b = newBoardId();
    await applyOperation(
      pool,
      op(a, 'card.created', 1, {
        cardId: 'c',
        title: 'Cache',
        description: 'Le service `Api` dépend de `Redis`.',
      }),
    );
    await applyOperation(
      pool,
      op(b, 'card.created', 1, {
        cardId: 'c',
        title: 'Secret',
        description: 'Le service `Api` dépend de `Oracle`.',
      }),
    );
    await new Worker(pool, new FakeProvider(), pino({ level: 'silent' }), {
      pollMs: 5,
      maxAttempts: 3,
      backoffBaseMs: 1,
    }).drain();
    const cookie = await login(a);
    const get = (url: string) => app.inject({ method: 'GET', url, headers: { cookie } });

    const ov = (await get('/ui/api/overview')).json();
    expect(ov).toMatchObject({ boardId: a, exists: true, status: { progress: 1 } });
    const graph = (await get('/ui/api/graph')).json();
    const names = graph.nodes.map((n: { name: string }) => n.name).sort();
    expect(names).toEqual(['Api', 'Redis']);
    expect(graph.edges).toEqual([expect.objectContaining({ type: 'depends_on', weight: 1 })]);

    const search = await app.inject({
      method: 'POST',
      url: '/ui/api/search',
      headers: { cookie },
      payload: { question: 'Oracle' },
    });
    const texts = JSON.stringify(search.json());
    expect(texts).not.toContain('Oracle');
    expect(texts).not.toContain('Secret');

    const api = graph.nodes.find((n: { name: string }) => n.name === 'Api');
    const detail = (await get(`/ui/api/entities/${api.id}`)).json();
    expect(detail.entity.name).toBe('Api');
    expect(detail.sources[0]).toMatchObject({ itemKey: 'card:c', cardId: 'c' });
    expect(detail.relations).toEqual([
      expect.objectContaining({ direction: 'out', type: 'depends_on', otherName: 'Redis' }),
    ]);
    const redis = graph.nodes.find((n: { name: string }) => n.name === 'Redis');
    expect((await get(`/ui/api/entities/${redis.id}`)).json().relations[0].direction).toBe('in');

    // Entity ids of the other board resolve inside this board's island only.
    const { withIsland } = await import('../src/store/islands.js');
    const foreign = await withIsland(pool, b, (tx) =>
      tx.query<{ id: string }>('SELECT id::text AS id FROM entities'),
    );
    for (const { id } of foreign.rows) {
      const r = await get(`/ui/api/entities/${id}`);
      expect(r.body).not.toContain('Oracle');
    }
    expect((await get('/ui/api/entities/999999999')).statusCode).toBe(404);
    expect((await get('/ui/api/entities/abc')).statusCode).toBe(404);
  });

  it('shows an empty board when the island does not exist yet', async () => {
    const cookie = await login(newBoardId());
    const get = (url: string) => app.inject({ method: 'GET', url, headers: { cookie } });
    expect((await get('/ui/api/overview')).json()).toMatchObject({
      exists: false,
      status: { progress: 1, cards: [] },
    });
    expect((await get('/ui/api/graph')).json()).toEqual({ nodes: [], edges: [] });
    expect((await get('/ui/api/entities/1')).statusCode).toBe(404);
    const s = await app.inject({
      method: 'POST',
      url: '/ui/api/search',
      headers: { cookie },
      payload: { question: 'x' },
    });
    expect(s.json().passages).toEqual([]);
  });
});

describe('static UI', () => {
  it('serves the built UI when a directory is given', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ui-'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>Archipel</title>');
    const withUi = await testApp(pool, { uiDir: dir });
    const r = await withUi.inject({ method: 'GET', url: '/' });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('Archipel');
    await withUi.close();
  });
});
