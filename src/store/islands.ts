import { createHash } from 'node:crypto';
import type pg from 'pg';
import { ISLAND_DDL, ISLAND_TABLES, type IslandCounts } from './island-ddl.js';

/**
 * A transaction confined to one island: `ROLE` is the island's own role and
 * `search_path` is the island's schema. The island role has no privilege on any
 * other island nor on the control schema, so isolation is enforced by Postgres
 * itself, not by application filters.
 */
export interface IslandTx {
  readonly boardId: string;
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(
    sql: string,
    params?: unknown[],
  ): Promise<pg.QueryResult<R>>;
}

export class IslandNotFound extends Error {
  constructor() {
    super('island_not_found');
  }
}

/** Schema/role name: derived from database + board id, safe identifier chars only. */
export function islandName(database: string, boardId: string): string {
  return 'isl_' + createHash('sha256').update(`${database}\0${boardId}`).digest('hex').slice(0, 40);
}

/** Statements that could leave the island's role or schema are refused outright. */
const ROLE_ESCAPE = /\b(ROLE|SESSION\s+AUTHORIZATION|search_path|set_config)\b/i;

async function lookup(client: pg.PoolClient, boardId: string): Promise<string | undefined> {
  const r = await client.query<{ schema_name: string }>(
    'SELECT schema_name FROM archipel.islands WHERE board_id = $1',
    [boardId],
  );
  return r.rows[0]?.schema_name;
}

async function enter(client: pg.PoolClient, name: string): Promise<void> {
  // `name` is produced by islandName() (hex only), never from user input.
  await client.query(`SET LOCAL ROLE ${name}`);
  await client.query(`SET LOCAL search_path TO ${name}, public`);
}

async function inTx<T>(pool: pg.Pool, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let out: T;
  try {
    await client.query('BEGIN');
    out = await fn(client);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  return out;
}

/** Creates the island (role + schema + tables) if needed. Idempotent and race-safe. */
export async function ensureIsland(pool: pg.Pool, boardId: string): Promise<void> {
  await inTx(pool, async (client) => {
    const db = await client.query<{ db: string }>('SELECT current_database() AS db');
    const name = islandName(db.rows[0]!.db, boardId);
    const inserted = await client.query(
      `INSERT INTO archipel.islands (board_id, schema_name) VALUES ($1, $2)
       ON CONFLICT (board_id) DO NOTHING`,
      [boardId, name],
    );
    if (inserted.rowCount === 0) return;
    await client.query(`CREATE ROLE ${name} NOLOGIN NOINHERIT`);
    await client.query(`GRANT ${name} TO CURRENT_USER WITH INHERIT FALSE, SET TRUE`);
    await client.query(`CREATE SCHEMA ${name} AUTHORIZATION ${name}`);
    await enter(client, name);
    await client.query(ISLAND_DDL);
  });
}

/** Runs `fn` inside the island of `boardId`. Throws IslandNotFound if it does not exist. */
export async function withIsland<T>(
  pool: pg.Pool,
  boardId: string,
  fn: (tx: IslandTx) => Promise<T>,
): Promise<T> {
  return inTx(pool, async (client) => {
    const name = await lookup(client, boardId);
    if (name === undefined) throw new IslandNotFound();
    await enter(client, name);
    return fn({
      boardId,
      query: (sql, params) => {
        if (ROLE_ESCAPE.test(sql)) throw new Error('forbidden_statement');
        return client.query(sql, params);
      },
    });
  });
}

export async function islandExists(pool: pg.Pool, boardId: string): Promise<boolean> {
  const r = await pool.query('SELECT 1 FROM archipel.islands WHERE board_id = $1', [boardId]);
  return r.rowCount === 1;
}

export async function listIslands(pool: pg.Pool): Promise<string[]> {
  const r = await pool.query<{ board_id: string }>(
    'SELECT board_id FROM archipel.islands ORDER BY board_id',
  );
  return r.rows.map((row) => row.board_id);
}

export const EMPTY_COUNTS: IslandCounts = Object.fromEntries(
  ISLAND_TABLES.map((t) => [t, 0]),
) as IslandCounts;

export async function countIsland(tx: IslandTx): Promise<IslandCounts> {
  const sql = ISLAND_TABLES.map((t) => `(SELECT count(*) FROM ${t})::int AS ${t}`).join(', ');
  const r = await tx.query<IslandCounts>(`SELECT ${sql}`);
  return r.rows[0]!;
}

/** Counts of an island, or all zeros when it does not exist. */
export async function islandCounts(pool: pg.Pool, boardId: string): Promise<IslandCounts> {
  if (!(await islandExists(pool, boardId))) return { ...EMPTY_COUNTS };
  return withIsland(pool, boardId, countIsland);
}

/**
 * Drops the whole island: schema (all tables, cascade), role, registry row and
 * queued jobs. Records a board tombstone so late events cannot recreate it.
 */
export async function dropIsland(pool: pg.Pool, boardId: string, version: number): Promise<void> {
  const database = await inTx(pool, async (client) => {
    await client.query(
      `INSERT INTO archipel.board_tombstones (board_id, version) VALUES ($1, $2)
       ON CONFLICT (board_id) DO UPDATE SET version = GREATEST(board_tombstones.version, $2)`,
      [boardId, version],
    );
    const name = await lookup(client, boardId);
    if (name !== undefined) {
      await client.query('DELETE FROM archipel.islands WHERE board_id = $1', [boardId]);
      await client.query(`SET LOCAL ROLE ${name}`);
      await client.query(`DROP SCHEMA ${name} CASCADE`);
    }
    const db = await client.query<{ db: string }>('SELECT current_database() AS db');
    return db.rows[0]!.db;
  });
  // Separate statement: a role cannot be dropped by a transaction that is using it.
  // Always attempted, so a crash between the two steps is repaired by a retry.
  await pool.query(`DROP ROLE IF EXISTS ${islandName(database, boardId)}`);
}
