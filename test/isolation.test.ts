import { afterAll, describe, expect, it } from 'vitest';
import {
  countIsland,
  dropIsland,
  ensureIsland,
  islandCounts,
  islandExists,
  islandName,
  IslandNotFound,
  listIslands,
  withIsland,
} from '../src/store/islands.js';
import { newBoardId, testPool } from './helpers/db.js';

const pool = testPool();
afterAll(() => pool.end());

async function seedEntity(boardId: string, name: string) {
  await withIsland(pool, boardId, (tx) =>
    tx.query(`INSERT INTO entities (kind, name, norm) VALUES ('component', $1, lower($1))`, [name]),
  );
}

describe('island isolation (enforced by Postgres roles and schemas)', () => {
  it('derives distinct, identifier-safe names per board and per database', () => {
    const a = islandName('db', 'A');
    expect(a).toMatch(/^isl_[0-9a-f]{40}$/);
    expect(islandName('db', 'B')).not.toBe(a);
    expect(islandName('other', 'A')).not.toBe(a);
  });

  it('keeps same-named entities of two boards completely separate', async () => {
    const a = newBoardId();
    const b = newBoardId();
    await ensureIsland(pool, a);
    await ensureIsland(pool, b);
    await ensureIsland(pool, a); // idempotent
    await seedEntity(a, 'Payment');
    await seedEntity(b, 'Payment');
    const inA = await withIsland(pool, a, (tx) => tx.query('SELECT id, name FROM entities'));
    expect(inA.rows).toHaveLength(1);
    expect((await withIsland(pool, a, countIsland)).entities).toBe(1);
    expect((await withIsland(pool, b, countIsland)).entities).toBe(1);
  });

  it('refuses at the storage level any read of another island schema', async () => {
    const a = newBoardId();
    const b = newBoardId();
    await ensureIsland(pool, a);
    await ensureIsland(pool, b);
    await seedEntity(b, 'Secret');
    const db = (await pool.query<{ db: string }>('SELECT current_database() AS db')).rows[0]!.db;
    const other = islandName(db, b);
    await expect(
      withIsland(pool, a, (tx) => tx.query(`SELECT * FROM ${other}.entities`)),
    ).rejects.toThrow(/permission denied/);
  });

  it('refuses any access to the control schema from inside an island', async () => {
    const a = newBoardId();
    await ensureIsland(pool, a);
    await expect(
      withIsland(pool, a, (tx) => tx.query('SELECT * FROM archipel.islands')),
    ).rejects.toThrow(/permission denied/);
  });

  it('refuses statements that would leave the island role or schema', async () => {
    const a = newBoardId();
    await ensureIsland(pool, a);
    for (const sql of [
      'RESET ROLE',
      'SET ROLE archipel_app',
      "SELECT set_config('x','y',true)",
      'SET search_path TO public',
    ]) {
      await expect(withIsland(pool, a, (tx) => tx.query(sql))).rejects.toThrow(
        'forbidden_statement',
      );
    }
    const ok = await withIsland(pool, a, (tx) => tx.query<{ n: number }>('SELECT 1 AS n'));
    expect(ok.rows[0]!.n).toBe(1);
  });

  it('throws IslandNotFound for an unknown board and rolls back on error', async () => {
    await expect(withIsland(pool, newBoardId(), () => Promise.resolve(1))).rejects.toBeInstanceOf(
      IslandNotFound,
    );
    const a = newBoardId();
    await ensureIsland(pool, a);
    await expect(
      withIsland(pool, a, async (tx) => {
        await tx.query(`INSERT INTO entities (kind, name, norm) VALUES ('x', 'y', 'y')`);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect((await islandCounts(pool, a)).entities).toBe(0);
  });

  it('drops the whole island: schema, role, registry; counts before/after', async () => {
    const a = newBoardId();
    const b = newBoardId();
    await ensureIsland(pool, a);
    await ensureIsland(pool, b);
    await seedEntity(a, 'Doomed');
    await seedEntity(b, 'Survivor');
    expect((await islandCounts(pool, a)).entities).toBe(1);
    expect(await listIslands(pool)).toContain(a);
    await dropIsland(pool, a, 10);
    await dropIsland(pool, a, 5); // idempotent, keeps the highest version
    expect(await islandExists(pool, a)).toBe(false);
    expect(await islandCounts(pool, a)).toEqual({
      items: 0,
      tombstones: 0,
      passages: 0,
      entities: 0,
      mentions: 0,
      relations: 0,
      guideline_links: 0,
    });
    const db = (await pool.query<{ db: string }>('SELECT current_database() AS db')).rows[0]!.db;
    const name = islandName(db, a);
    const leftovers = await pool.query(
      `SELECT (SELECT count(*) FROM pg_namespace WHERE nspname = $1)::int AS schemas,
              (SELECT count(*) FROM pg_roles WHERE rolname = $1)::int AS roles`,
      [name],
    );
    expect(leftovers.rows[0]).toEqual({ schemas: 0, roles: 0 });
    const tomb = await pool.query(
      'SELECT version FROM archipel.board_tombstones WHERE board_id=$1',
      [a],
    );
    expect(Number(tomb.rows[0].version)).toBe(10);
    expect((await islandCounts(pool, b)).entities).toBe(1);
  });

  it('creates islands concurrently without errors', async () => {
    const a = newBoardId();
    await Promise.all([ensureIsland(pool, a), ensureIsland(pool, a), ensureIsland(pool, a)]);
    expect(await islandExists(pool, a)).toBe(true);
  });
});
