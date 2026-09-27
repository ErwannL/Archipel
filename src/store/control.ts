import type pg from 'pg';

/**
 * Control schema `archipel`: ids, versions and queue entries only — never any
 * board content. It is owned by the application role and not readable by any
 * island role.
 */
const CONTROL_DDL = `
CREATE SCHEMA IF NOT EXISTS archipel;
REVOKE ALL ON SCHEMA archipel FROM PUBLIC;
CREATE TABLE IF NOT EXISTS archipel.islands (
  board_id text PRIMARY KEY,
  schema_name text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS archipel.board_tombstones (
  board_id text PRIMARY KEY,
  version bigint NOT NULL
);
CREATE TABLE IF NOT EXISTS archipel.erased_users (
  user_id text PRIMARY KEY,
  version bigint NOT NULL
);
CREATE TABLE IF NOT EXISTS archipel.jobs (
  board_id text NOT NULL REFERENCES archipel.islands(board_id) ON DELETE CASCADE,
  item_key text NOT NULL,
  seq bigserial NOT NULL,
  attempts int NOT NULL DEFAULT 0,
  run_after timestamptz NOT NULL DEFAULT now(),
  locked_until timestamptz,
  PRIMARY KEY (board_id, item_key)
);
CREATE INDEX IF NOT EXISTS jobs_run_after ON archipel.jobs (run_after);
CREATE TABLE IF NOT EXISTS archipel.nonces (
  nonce text PRIMARY KEY,
  expires_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS archipel.used_handoffs (
  token_hash text PRIMARY KEY,
  expires_at timestamptz NOT NULL
);
`;

export async function migrateControl(pool: pg.Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(424242)');
    await client.query(CONTROL_DDL);
  } finally {
    await client.query('SELECT pg_advisory_unlock(424242)');
    client.release();
  }
}

/** Records a nonce; returns false if it was already used (replay). */
export async function claimNonce(pool: pg.Pool, nonce: string, ttlSeconds: number) {
  const r = await pool.query(
    `INSERT INTO archipel.nonces (nonce, expires_at)
     VALUES ($1, now() + make_interval(secs => $2)) ON CONFLICT DO NOTHING`,
    [nonce, ttlSeconds],
  );
  return r.rowCount === 1;
}

/** Marks a handoff token hash as used; returns false if already used. */
export async function claimHandoff(pool: pg.Pool, tokenHash: string, ttlSeconds: number) {
  const r = await pool.query(
    `INSERT INTO archipel.used_handoffs (token_hash, expires_at)
     VALUES ($1, now() + make_interval(secs => $2)) ON CONFLICT DO NOTHING`,
    [tokenHash, ttlSeconds],
  );
  return r.rowCount === 1;
}

export async function purgeExpired(pool: pg.Pool): Promise<void> {
  await pool.query('DELETE FROM archipel.nonces WHERE expires_at < now()');
  await pool.query('DELETE FROM archipel.used_handoffs WHERE expires_at < now()');
}

export async function boardTombstone(pool: pg.Pool, boardId: string): Promise<number> {
  const r = await pool.query<{ version: string }>(
    'SELECT version FROM archipel.board_tombstones WHERE board_id = $1',
    [boardId],
  );
  return Number(r.rows[0]?.version ?? -1);
}

export async function erasedUsers(pool: pg.Pool, userIds: string[]): Promise<Map<string, number>> {
  const r = await pool.query<{ user_id: string; version: string }>(
    'SELECT user_id, version FROM archipel.erased_users WHERE user_id = ANY($1)',
    [userIds],
  );
  return new Map(r.rows.map((row) => [row.user_id, Number(row.version)]));
}
