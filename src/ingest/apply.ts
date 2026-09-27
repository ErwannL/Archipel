import type pg from 'pg';
import { boardTombstone, erasedUsers } from '../store/control.js';
import { dropIsland, ensureIsland, withIsland, type IslandTx } from '../store/islands.js';
import { enqueue } from '../store/jobs.js';
import { relink } from '../processing/links.js';
import type { ItemInput, Operation } from './events.js';

export type Outcome = 'queued' | 'applied' | 'duplicate' | 'stale';

/** Deletes entities that no longer have any source passage. */
export async function collectOrphans(tx: IslandTx): Promise<void> {
  await tx.query(
    'DELETE FROM entities e WHERE NOT EXISTS (SELECT 1 FROM mentions m WHERE m.entity_id = e.id)',
  );
}

async function tombstoneVersion(tx: IslandTx, keys: string[]): Promise<number> {
  const r = await tx.query<{ v: string | null }>(
    'SELECT max(version) AS v FROM tombstones WHERE key = ANY($1)',
    [keys],
  );
  return Number(r.rows[0]!.v ?? -1);
}

async function upsertItem(tx: IslandTx, version: number, item: ItemInput): Promise<Outcome> {
  const keys = item.cardId ? [item.key, `card:${item.cardId}`] : [item.key];
  if ((await tombstoneVersion(tx, keys)) >= version) return 'stale';
  const cur = await tx.query<{ version: string }>('SELECT version FROM items WHERE key = $1', [
    item.key,
  ]);
  const current = Number(cur.rows[0]?.version ?? -1);
  if (current > version) return 'stale';
  if (current === version) return 'duplicate';
  await tx.query(
    `INSERT INTO items (key, kind, card_id, doc_id, author_id, author_name, version, title, body,
                        status, attempts, error_code, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending', 0, NULL, now())
     ON CONFLICT (key) DO UPDATE SET kind = $2, card_id = $3, doc_id = $4, author_id = $5,
       author_name = $6, version = $7, title = $8, body = $9, status = 'pending', attempts = 0,
       error_code = NULL, updated_at = now()`,
    [
      item.key,
      item.kind,
      item.cardId,
      item.docId,
      item.authorId,
      item.authorName,
      version,
      item.title,
      item.body,
    ],
  );
  return 'queued';
}

async function deleteItem(
  tx: IslandTx,
  version: number,
  key: string,
  cardId: string | null,
): Promise<Outcome> {
  const tomb = await tombstoneVersion(tx, [key]);
  if (tomb >= version) return tomb === version ? 'duplicate' : 'stale';
  await tx.query(
    `INSERT INTO tombstones (key, version) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET version = $2`,
    [key, version],
  );
  // A deleted card takes everything attached to it (comments, checklists, reports, facts).
  await tx.query('DELETE FROM items WHERE (key = $1 OR card_id = $2) AND version <= $3', [
    key,
    cardId,
    version,
  ]);
  if (key.startsWith('doc:')) await relink(tx, null);
  await collectOrphans(tx);
  return 'applied';
}

/**
 * Applies one operation. Upserts only store the item and queue it (fast path);
 * deletions are applied synchronously so erased data is gone when we answer.
 */
export async function applyOperation(pool: pg.Pool, op: Operation): Promise<Outcome> {
  if (op.version <= (await boardTombstone(pool, op.boardId))) return 'stale';
  if (op.op === 'deleteBoard') {
    await dropIsland(pool, op.boardId, op.version);
    return 'applied';
  }
  if (op.op === 'upsert' && op.item.authorId) {
    const erased = await erasedUsers(pool, [op.item.authorId]);
    if ((erased.get(op.item.authorId) ?? -1) >= op.version) return 'stale';
  }
  await ensureIsland(pool, op.boardId);
  if (op.op === 'delete') {
    return withIsland(pool, op.boardId, (tx) => deleteItem(tx, op.version, op.key, op.cardId));
  }
  const outcome = await withIsland(pool, op.boardId, (tx) => upsertItem(tx, op.version, op.item));
  if (outcome === 'queued') await enqueue(pool, op.boardId, op.item.key);
  return outcome;
}
