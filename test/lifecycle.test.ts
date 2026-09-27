import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import type { Logger } from 'pino';
import { FakeProvider } from '../src/ai/fake.js';
import { ModelError, type ModelProvider } from '../src/ai/provider.js';
import { eraseUser, ERASED_NAME } from '../src/erase/user.js';
import { applyOperation } from '../src/ingest/apply.js';
import { Worker } from '../src/processing/worker.js';
import { boardStatus, retryable } from '../src/query/status.js';
import { dropIsland, islandCounts, withIsland } from '../src/store/islands.js';
import { claimJob, enqueue } from '../src/store/jobs.js';
import { newBoardId, testPool } from './helpers/db.js';
import { op } from './helpers/events.js';

const pool = testPool();
afterAll(() => pool.end());
const fake = new FakeProvider();
const silent = () =>
  ({ info: vi.fn(), error: vi.fn() }) as unknown as Logger & { error: ReturnType<typeof vi.fn> };
const worker = (provider: ModelProvider = fake, maxAttempts = 3) =>
  new Worker(pool, provider, silent(), { pollMs: 5, maxAttempts, backoffBaseMs: 1 });
const apply = (b: string, type: string, v: number, data: object) =>
  applyOperation(pool, op(b, type, v, data));
const rows = async (b: string, sql: string) =>
  (await withIsland(pool, b, (tx) => tx.query(sql))).rows;

describe('idempotence and ordering', () => {
  it('ignores replays and older versions, applies newer ones', async () => {
    const b = newBoardId();
    expect(await apply(b, 'card.created', 5, { cardId: 'c', title: 'v5' })).toBe('queued');
    expect(await apply(b, 'card.updated', 5, { cardId: 'c', title: 'v5 again' })).toBe('duplicate');
    expect(await apply(b, 'card.updated', 3, { cardId: 'c', title: 'old' })).toBe('stale');
    expect(await apply(b, 'card.updated', 7, { cardId: 'c', title: 'v7' })).toBe('queued');
    expect(await rows(b, 'SELECT title, version FROM items')).toEqual([
      { title: 'v7', version: '7' },
    ]);
    await worker().drain();
    expect(await apply(b, 'card.updated', 6, { cardId: 'c', title: 'late' })).toBe('stale');
    expect(await rows(b, 'SELECT count(*)::int AS n FROM passages')).toEqual([{ n: 1 }]);
  });
});

describe('real deletion', () => {
  it('a deleted card takes its comments, reports, facts, passages and orphan entities', async () => {
    const b = newBoardId();
    await apply(b, 'card.created', 1, {
      cardId: 'c1',
      title: 'Paiement',
      description: 'Le module `Stripe` et `Shared`.',
    });
    await apply(b, 'comment.created', 2, { commentId: 'm1', cardId: 'c1', text: 'Voir `Stripe`' });
    await apply(b, 'report.created', 3, {
      reportId: 'r1',
      cardId: 'c1',
      text: 'Décidé : `Stripe`',
    });
    await apply(b, 'card.created', 1, {
      cardId: 'c2',
      title: 'Autre',
      description: 'Utilise `Shared`.',
    });
    await worker().drain();
    const before = await islandCounts(pool, b);
    expect(before.items).toBe(4);

    expect(await apply(b, 'card.deleted', 10, { cardId: 'c1' })).toBe('applied');
    expect(await apply(b, 'card.deleted', 10, { cardId: 'c1' })).toBe('duplicate');
    expect(await apply(b, 'card.deleted', 9, { cardId: 'c1' })).toBe('stale');
    const names = (await rows(b, 'SELECT name FROM entities ORDER BY name')).map((r) => r.name);
    expect(names).toEqual(['Shared']);
    expect(await rows(b, 'SELECT key FROM items')).toEqual([{ key: 'card:c2' }]);
    expect(
      await rows(b, "SELECT count(*)::int AS n FROM passages WHERE item_key LIKE '%1'"),
    ).toEqual([{ n: 0 }]);
    // Late events about the deleted card cannot resurrect it.
    expect(
      await apply(b, 'comment.updated', 8, { commentId: 'm1', cardId: 'c1', text: 'late' }),
    ).toBe('stale');
    expect(await apply(b, 'card.updated', 9, { cardId: 'c1', title: 'late' })).toBe('stale');
    expect(await apply(b, 'comment.deleted', 4, { commentId: 'm9', cardId: 'c2' })).toBe('applied');
  });

  it('deleting a guideline doc removes and recomputes its links', async () => {
    const b = newBoardId();
    await apply(b, 'doc.created', 1, {
      docId: 'd1',
      title: 'Règles',
      markdown: '# Paiements\nTous les paiements passent par `Gateway`.',
    });
    await apply(b, 'doc.created', 1, {
      docId: 'd2',
      title: 'Règles bis',
      markdown: '# Paiements\nLes paiements passent par `Gateway` toujours.',
    });
    await apply(b, 'report.created', 2, {
      reportId: 'r',
      cardId: 'c',
      text: 'Contrairement à la consigne, les paiements ne passent pas par `Gateway`.',
    });
    await worker().drain();
    const links = await rows(b, 'SELECT type FROM guideline_links');
    expect(links).toEqual([{ type: 'contradicts' }]);
    await apply(b, 'doc.deleted', 5, { docId: 'd1' });
    await apply(b, 'doc.deleted', 5, { docId: 'd2' });
    expect(await rows(b, 'SELECT count(*)::int AS n FROM guideline_links')).toEqual([{ n: 0 }]);
    expect((await islandCounts(pool, b)).items).toBe(1);
  });

  it('deleting a board removes the island, its jobs, and blocks older events', async () => {
    const b = newBoardId();
    await apply(b, 'card.created', 1, { cardId: 'c', title: 'x' });
    expect(await apply(b, 'board.deleted', 100, {})).toBe('applied');
    expect(await pool.query('SELECT 1 FROM archipel.jobs WHERE board_id = $1', [b])).toMatchObject({
      rowCount: 0,
    });
    expect(await apply(b, 'card.created', 50, { cardId: 'c', title: 'x' })).toBe('stale');
    expect(await apply(b, 'card.created', 101, { cardId: 'c', title: 'recreated later' })).toBe(
      'queued',
    );
  });
});

describe('user erasure', () => {
  it('removes memory from the user contributions only, anonymises remaining references', async () => {
    const b = newBoardId();
    const other = newBoardId();
    await apply(b, 'card.created', 1, {
      cardId: 'c1',
      title: 'Carte de U',
      description: '`Alpha`',
      authorId: 'U',
      authorName: 'Ulysse',
    });
    await apply(b, 'card.created', 1, {
      cardId: 'c2',
      title: 'Carte de V',
      description: '`Beta`',
      authorId: 'V',
      authorName: 'Vera',
    });
    await apply(b, 'comment.created', 2, {
      commentId: 'm',
      cardId: 'c2',
      text: '`Gamma`',
      authorId: 'U',
    });
    await apply(b, 'doc.created', 2, {
      docId: 'd',
      title: 'Doc de U',
      markdown: 'règle',
      authorId: 'U',
    });
    await apply(other, 'card.created', 1, {
      cardId: 'c9',
      title: 'Ailleurs',
      authorId: 'U',
      authorName: 'Ulysse',
    });
    await worker().drain();
    // A person entity of U that another source still references.
    await withIsland(pool, b, (tx) =>
      tx.query(`INSERT INTO mentions (entity_id, passage_id)
                SELECT e.id, p.id FROM entities e, passages p
                WHERE e.user_id = 'U' AND p.item_key = 'card:c2'`),
    );
    const report = await eraseUser(pool, 'U', 50);
    expect(report.itemsRemoved).toBe(4);
    expect(report.entitiesAnonymized).toBe(1);
    expect(report.boardsScanned).toBeGreaterThanOrEqual(2);
    expect(await rows(b, 'SELECT key FROM items ORDER BY key')).toEqual([{ key: 'card:c2' }]);
    const ents = await rows(b, 'SELECT kind, name, user_id FROM entities ORDER BY kind, name');
    expect(ents).toEqual([
      { kind: 'component', name: 'Beta', user_id: null },
      { kind: 'person', name: ERASED_NAME, user_id: null },
      { kind: 'person', name: 'Vera', user_id: 'V' },
    ]);
    expect((await islandCounts(pool, other)).items).toBe(0);
    // Late events authored by the erased user are ignored; newer ones are accepted.
    expect(
      await apply(b, 'comment.created', 40, {
        commentId: 'z',
        cardId: 'c2',
        text: 'x',
        authorId: 'U',
      }),
    ).toBe('stale');
    expect(
      await apply(b, 'comment.created', 60, {
        commentId: 'z',
        cardId: 'c2',
        text: 'x',
        authorId: 'U',
      }),
    ).toBe('queued');
  });
});

describe('worker and failures', () => {
  beforeEach(async () => {
    await pool.query('DELETE FROM archipel.jobs');
  });
  const failing = (code: string): ModelProvider => ({
    id: 'fake:v1',
    embed: () => Promise.reject(new ModelError(code)),
    extract: () => Promise.reject(new ModelError(code)),
  });

  it('marks items failed, retries with backoff, gives up, and recovers via retry', async () => {
    const b = newBoardId();
    await apply(b, 'card.created', 1, { cardId: 'c', title: 'x' });
    const w = worker(failing('model_http_503'), 2);
    expect(await w.tick()).toBe(true);
    expect(await rows(b, 'SELECT status, attempts, error_code FROM items')).toEqual([
      { status: 'failed', attempts: 1, error_code: 'model_http_503' },
    ]);
    expect((await boardStatus(pool, b)).cards[0]!.status).toBe('failed');
    await new Promise((r) => setTimeout(r, 20));
    expect(await w.drain()).toBe(1); // second attempt → gives up
    expect(await pool.query('SELECT 1 FROM archipel.jobs WHERE board_id = $1', [b])).toMatchObject({
      rowCount: 0,
    });
    expect(await retryable(pool, b)).toEqual(['card:c']);
    await enqueue(pool, b, 'card:c');
    await worker().drain();
    expect((await boardStatus(pool, b)).progress).toBe(1);
  });

  it('never blocks ingestion while the model is down', async () => {
    const b = newBoardId();
    await apply(b, 'card.created', 1, { cardId: 'c', title: 'x' });
    await worker(failing('model_unreachable')).tick();
    expect(await apply(b, 'card.updated', 2, { cardId: 'c', title: 'y' })).toBe('queued');
    expect((await boardStatus(pool, b)).totals.pending).toBe(1);
  });

  it('reports internal errors generically and skips jobs of deleted boards', async () => {
    const b = newBoardId();
    await apply(b, 'card.created', 1, { cardId: 'c', title: 'x' });
    const broken: ModelProvider = {
      id: 'fake:v1',
      embed: () => Promise.reject(new Error('secret')),
      extract: fake.extract,
    };
    await worker(broken).tick();
    expect(await rows(b, 'SELECT error_code FROM items')).toEqual([
      { error_code: 'internal_error' },
    ]);

    await pool.query('DELETE FROM archipel.jobs');
    const d = newBoardId();
    await apply(d, 'card.created', 1, { cardId: 'c', title: 'x' });
    const dropping: ModelProvider = {
      id: 'fake:v1',
      embed: async (t) => {
        await dropIsland(pool, d, 1000);
        return fake.embed(t);
      },
      extract: fake.extract,
    };
    expect(await worker(dropping).tick()).toBe(true);
    expect(await claimJob(pool)).toBeNull();
  });

  it('retries database errors during processing', async () => {
    const b = newBoardId();
    await apply(b, 'card.created', 1, { cardId: 'c', title: 'x' });
    const sabotage: ModelProvider = {
      id: 'fake:v1',
      embed: async (t) => {
        await withIsland(pool, b, (tx) => tx.query('DROP TABLE items CASCADE'));
        return fake.embed(t);
      },
      extract: fake.extract,
    };
    expect(await worker(sabotage).tick()).toBe(true);
    const job = await pool.query<{ attempts: number }>(
      'SELECT attempts FROM archipel.jobs WHERE board_id = $1',
      [b],
    );
    expect(job.rows[0]!.attempts).toBe(1);
    await dropIsland(pool, b, 1);
  });

  it('skips items already indexed or gone', async () => {
    const b = newBoardId();
    await apply(b, 'card.created', 1, { cardId: 'c', title: 'x' });
    await worker().drain();
    await enqueue(pool, b, 'card:c');
    await enqueue(pool, b, 'card:missing');
    expect(await worker().drain()).toBe(2);
  });

  it('discards results when the item changed during processing', async () => {
    const b = newBoardId();
    await apply(b, 'card.created', 1, { cardId: 'c', title: 'x' });
    const racing: ModelProvider = {
      id: 'fake:v1',
      embed: async (t) => {
        await apply(b, 'card.updated', 2, { cardId: 'c', title: 'y' });
        return fake.embed(t);
      },
      extract: fake.extract,
    };
    await worker(racing).tick();
    expect(await rows(b, 'SELECT status, title FROM items')).toEqual([
      { status: 'pending', title: 'y' },
    ]);
    await worker().drain();
    expect(await rows(b, 'SELECT status FROM items')).toEqual([{ status: 'indexed' }]);
  });

  it('runs as a loop, logs failures by code only, and stops cleanly', async () => {
    const b = newBoardId();
    await apply(b, 'card.created', 1, { cardId: 'c', title: 'x' });
    const w = new Worker(pool, fake, silent(), { pollMs: 5, maxAttempts: 3, backoffBaseMs: 1 });
    w.start();
    await vi.waitFor(async () => {
      expect((await boardStatus(pool, b)).progress).toBe(1);
    });
    await w.stop();

    for (const [err, code] of [
      [Object.assign(new Error('x'), { code: '57P01' }), '57P01'],
      [new Error('x'), 'worker_error'],
    ] as const) {
      const log = silent();
      const brokenPool = { query: () => Promise.reject(err) } as unknown as pg.Pool;
      const bw = new Worker(brokenPool, fake, log, { pollMs: 5, maxAttempts: 3, backoffBaseMs: 1 });
      bw.start();
      await vi.waitFor(() => {
        expect(log.error).toHaveBeenCalledWith({ code }, 'worker tick failed');
      });
      await bw.stop();
    }
  });
});
