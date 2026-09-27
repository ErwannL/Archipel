import type pg from 'pg';

export interface Job {
  boardId: string;
  itemKey: string;
  seq: string;
  attempts: number;
}

/** Queues (or re-queues) processing of one item. Ids only. */
export async function enqueue(pool: pg.Pool, boardId: string, itemKey: string): Promise<void> {
  await pool.query(
    `INSERT INTO archipel.jobs (board_id, item_key) VALUES ($1, $2)
     ON CONFLICT (board_id, item_key) DO UPDATE
       SET seq = nextval(pg_get_serial_sequence('archipel.jobs', 'seq')),
           attempts = 0, run_after = now(), locked_until = NULL`,
    [boardId, itemKey],
  );
}

/** Claims one due job with a lease; concurrent workers never get the same job. */
export async function claimJob(pool: pg.Pool, leaseSeconds = 120): Promise<Job | null> {
  const r = await pool.query<{ board_id: string; item_key: string; seq: string; attempts: number }>(
    `UPDATE archipel.jobs SET locked_until = now() + make_interval(secs => $1)
     WHERE (board_id, item_key) = (
       SELECT board_id, item_key FROM archipel.jobs
       WHERE run_after <= now() AND (locked_until IS NULL OR locked_until < now())
       ORDER BY run_after LIMIT 1 FOR UPDATE SKIP LOCKED)
     RETURNING board_id, item_key, seq, attempts`,
    [leaseSeconds],
  );
  const row = r.rows[0];
  return row
    ? { boardId: row.board_id, itemKey: row.item_key, seq: row.seq, attempts: row.attempts }
    : null;
}

/** Removes the job unless it was re-queued meanwhile (newer seq). */
export async function completeJob(pool: pg.Pool, job: Job): Promise<void> {
  await pool.query(`DELETE FROM archipel.jobs WHERE board_id = $1 AND item_key = $2 AND seq = $3`, [
    job.boardId,
    job.itemKey,
    job.seq,
  ]);
  await pool.query(
    `UPDATE archipel.jobs SET locked_until = NULL WHERE board_id = $1 AND item_key = $2`,
    [job.boardId, job.itemKey],
  );
}

/** Schedules a retry with exponential backoff, or gives up after `maxAttempts`. */
export async function failJob(
  pool: pg.Pool,
  job: Job,
  maxAttempts: number,
  backoffBaseMs: number,
): Promise<'retry' | 'gave_up'> {
  const attempts = job.attempts + 1;
  if (attempts >= maxAttempts) {
    await completeJob(pool, job);
    return 'gave_up';
  }
  const delayMs = Math.min(backoffBaseMs * 2 ** (attempts - 1), 3600_000);
  await pool.query(
    `UPDATE archipel.jobs SET attempts = $4, locked_until = NULL,
       run_after = now() + make_interval(secs => $5::float8 / 1000)
     WHERE board_id = $1 AND item_key = $2 AND seq = $3`,
    [job.boardId, job.itemKey, job.seq, attempts, delayMs],
  );
  return 'retry';
}

export async function pendingJobCount(pool: pg.Pool, boardId: string): Promise<number> {
  const r = await pool.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM archipel.jobs WHERE board_id = $1',
    [boardId],
  );
  return r.rows[0]!.n;
}
