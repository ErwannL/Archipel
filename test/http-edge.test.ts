import { afterAll, describe, expect, it } from 'vitest';
import pino from 'pino';
import { FakeProvider } from '../src/ai/fake.js';
import { ModelError, type ModelProvider } from '../src/ai/provider.js';
import { applyOperation } from '../src/ingest/apply.js';
import { Worker } from '../src/processing/worker.js';
import { signRequest } from '../src/security/hmac.js';
import { query } from '../src/query/query.js';
import { boardStatus } from '../src/query/status.js';
import { config, nonce, signed, testApp } from './helpers/app.js';
import { newBoardId, testPool } from './helpers/db.js';
import { op } from './helpers/events.js';

const pool = testPool();
afterAll(() => pool.end());
const fake = new FakeProvider();
const drain = (p: ModelProvider = fake) =>
  new Worker(pool, p, pino({ level: 'silent' }), {
    pollMs: 5,
    maxAttempts: 1,
    backoffBaseMs: 1,
  }).drain();

describe('HTTP edge cases', () => {
  it('turns unexpected errors into a bare 500 (with or without a code)', async () => {
    const b = newBoardId();
    await applyOperation(pool, op(b, 'card.created', 1, { cardId: 'c', title: 'x' }));
    await drain();
    const throwing = await testApp(pool, {
      provider: {
        id: fake.id,
        embed: () => Promise.reject(new Error('secret')),
        extract: fake.extract,
      },
    });
    const r = await signed(throwing, 'POST', `/v1/boards/${b}/query`, {
      question: 'secret question',
    });
    expect(r.statusCode).toBe(500);
    expect(r.json()).toEqual({ error: 'internal_error' });
    await throwing.close();
    const wrongDims = await testApp(pool, {
      provider: { id: fake.id, embed: () => Promise.resolve([[1, 2]]), extract: fake.extract },
    });
    const r2 = await signed(wrongDims, 'POST', `/v1/boards/${b}/query`, { question: 'q' });
    expect(r2.json()).toEqual({ error: 'internal_error' });
    await wrongDims.close();
  });

  it('accepts an empty JSON body', async () => {
    const app = await testApp(pool);
    const url = '/v1/users/empty-body-user/erase';
    const h = signRequest(
      config.ARCHIPEL_HMAC_SECRET,
      'POST',
      url,
      '',
      Math.floor(Date.now() / 1000),
      nonce(),
    );
    const r = await app.inject({
      method: 'POST',
      url,
      headers: { ...h, 'content-type': 'application/json' },
      payload: '',
    });
    expect(r.statusCode).toBe(200);
    await app.close();
  });

  it('stores facts without any author and re-queues failed items', async () => {
    const app = await testApp(pool);
    const b = newBoardId();
    const f = await signed(app, 'POST', `/v1/boards/${b}/facts`, {
      cardId: 'c',
      facts: [{ factId: 'f', text: 'Le module `X` dépend de `Y`.' }],
    });
    expect(f.json().results[0].outcome).toBe('queued');
    await pool.query('DELETE FROM archipel.jobs WHERE board_id <> $1', [b]);
    await drain({
      id: fake.id,
      embed: () => Promise.reject(new ModelError('model_http_500')),
      extract: fake.extract,
    });
    expect((await boardStatus(pool, b)).totals.failed).toBe(1);
    expect((await signed(app, 'POST', `/v1/boards/${b}/retry`)).json()).toEqual({ requeued: 1 });
    await drain();
    expect((await boardStatus(pool, b)).totals.indexed).toBe(1);
    await app.close();
  });
});

describe('query edge cases', () => {
  it('orders ties deterministically and truncates to the budget', async () => {
    const b = newBoardId();
    const long = 'Le module `Moteur` gère la file. '.repeat(40);
    await applyOperation(
      pool,
      op(b, 'card.created', 1, { cardId: 'a', title: 'Même', description: long }),
    );
    await applyOperation(
      pool,
      op(b, 'card.created', 1, { cardId: 'b', title: 'Même', description: long }),
    );
    await drain();
    const full = await query(pool, fake, b, { question: 'Moteur file', maxChars: 50000, topK: 10 });
    const ps = full.passages;
    const ties = ps.slice(1).filter((p, i) => p.score === ps[i]!.score);
    expect(ties.length).toBeGreaterThan(0);
    ps.slice(1).forEach((p, i) => {
      const prev = ps[i]!;
      expect(prev.score > p.score || prev.passageId.localeCompare(p.passageId) < 0).toBe(true);
    });
    for (const max of [500, 900, 1500, 3000]) {
      const r = await query(pool, fake, b, { question: 'Moteur file', maxChars: max, topK: 10 });
      expect(r.usedChars).toBeLessThanOrEqual(max);
      expect([max, r.truncated]).toEqual([max, true]);
      expect(r.citations.flatMap((c) => c.passageIds).sort()).toEqual(
        r.passages.map((p) => p.passageId).sort(),
      );
    }
    const small = await query(pool, fake, b, { question: 'Moteur file', maxChars: 700, topK: 10 });
    expect(small.passages.some((p) => p.text.endsWith('…'))).toBe(true);
  });

  it('reports full progress for an island with no items left', async () => {
    const b = newBoardId();
    await applyOperation(pool, op(b, 'card.created', 1, { cardId: 'c', title: 'x' }));
    await applyOperation(pool, op(b, 'card.deleted', 2, { cardId: 'c' }));
    expect(await boardStatus(pool, b)).toEqual({
      boardId: b,
      progress: 1,
      totals: { pending: 0, processing: 0, indexed: 0, failed: 0 },
      cards: [],
    });
  });
});
