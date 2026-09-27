import type pg from 'pg';
import { collectOrphans } from '../ingest/apply.js';
import { relink } from '../processing/links.js';
import { listIslands, withIsland } from '../store/islands.js';

export interface EraseReport {
  boardsScanned: number;
  itemsRemoved: number;
  entitiesAnonymized: number;
}

export const ERASED_NAME = 'Utilisateur effacé';

/**
 * Right to erasure for one user, across every island (each handled inside its
 * own isolated transaction): the memory derived from the user's contributions is
 * deleted, and the user's person entity is anonymised where other sources still
 * mention it. Orqea's own cards/comments are never touched — they are not ours.
 */
export async function eraseUser(
  pool: pg.Pool,
  userId: string,
  version: number,
): Promise<EraseReport> {
  await pool.query(
    `INSERT INTO archipel.erased_users (user_id, version) VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE SET version = GREATEST(erased_users.version, $2)`,
    [userId, version],
  );
  const report: EraseReport = { boardsScanned: 0, itemsRemoved: 0, entitiesAnonymized: 0 };
  for (const boardId of await listIslands(pool)) {
    await withIsland(pool, boardId, async (tx) => {
      const removed = await tx.query<{ kind: string }>(
        'DELETE FROM items WHERE author_id = $1 RETURNING kind',
        [userId],
      );
      if (removed.rows.some((r) => r.kind === 'doc')) await relink(tx, null);
      await collectOrphans(tx);
      const anon = await tx.query(
        `UPDATE entities SET name = $2, norm = 'erased:' || id, user_id = NULL WHERE user_id = $1`,
        [userId, ERASED_NAME],
      );
      report.boardsScanned++;
      report.itemsRemoved += removed.rowCount!;
      report.entitiesAnonymized += anon.rowCount!;
    });
  }
  return report;
}
