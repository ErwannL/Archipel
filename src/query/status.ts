import type pg from 'pg';
import { islandExists, withIsland } from '../store/islands.js';

export type ItemStatus = 'pending' | 'processing' | 'indexed' | 'failed';

/** Card status: the worst status among the card's items. */
export function aggregate(statuses: ItemStatus[]): ItemStatus {
  for (const s of ['failed', 'processing', 'pending'] as const) if (statuses.includes(s)) return s;
  return 'indexed';
}

export interface BoardStatus {
  boardId: string;
  progress: number;
  totals: Record<ItemStatus, number>;
  cards: { cardId: string; status: ItemStatus; items: number }[];
}

export async function boardStatus(pool: pg.Pool, boardId: string): Promise<BoardStatus> {
  const totals: Record<ItemStatus, number> = { pending: 0, processing: 0, indexed: 0, failed: 0 };
  if (!(await islandExists(pool, boardId))) return { boardId, progress: 1, totals, cards: [] };
  return withIsland(pool, boardId, async (tx) => {
    const t = await tx.query<{ status: ItemStatus; n: number }>(
      'SELECT status, count(*)::int AS n FROM items GROUP BY status',
    );
    for (const row of t.rows) totals[row.status] = row.n;
    const c = await tx.query<{ card_id: string; statuses: ItemStatus[] }>(
      `SELECT card_id, array_agg(status) AS statuses FROM items WHERE card_id IS NOT NULL
       GROUP BY card_id ORDER BY card_id`,
    );
    const total = Object.values(totals).reduce((a, b) => a + b, 0);
    return {
      boardId,
      progress: total === 0 ? 1 : Math.round((totals.indexed / total) * 1000) / 1000,
      totals,
      cards: c.rows.map((r) => ({
        cardId: r.card_id,
        status: aggregate(r.statuses),
        items: r.statuses.length,
      })),
    };
  });
}

export async function cardStatus(pool: pg.Pool, boardId: string, cardId: string) {
  const status = await boardStatus(pool, boardId);
  return status.cards.find((c) => c.cardId === cardId) ?? null;
}

/** Re-queues failed and pending items of a board; returns their keys. */
export async function retryable(pool: pg.Pool, boardId: string): Promise<string[]> {
  return withIsland(pool, boardId, async (tx) => {
    const r = await tx.query<{ key: string }>(
      `UPDATE items SET status = 'pending', attempts = 0, error_code = NULL
       WHERE status IN ('failed', 'pending') RETURNING key`,
    );
    return r.rows.map((row) => row.key).sort();
  });
}

export interface CardDetail {
  cardId: string;
  /** Title of the card item, as Orqea sent it ('' when only comments/checklists arrived). */
  title: string;
  status: ItemStatus;
  items: number;
  /** Last change of any item of the card (ISO 8601). */
  updatedAt: string;
  /** Error code of a failed item (a code, never a message), or null. */
  errorCode: string | null;
  /** Oldest pending item of the card (ISO 8601), or null: a long wait means no worker runs. */
  pendingSince: string | null;
}

/**
 * Per-card detail for the human UI (the service status above keeps its contract).
 * Only data already in the island: an encrypted board never sends anything here.
 */
export async function cardDetails(pool: pg.Pool, boardId: string): Promise<CardDetail[]> {
  if (!(await islandExists(pool, boardId))) return [];
  return withIsland(pool, boardId, async (tx) => {
    const r = await tx.query<{
      card_id: string;
      statuses: ItemStatus[];
      title: string | null;
      updated_at: Date;
      error_code: string | null;
      pending_since: Date | null;
    }>(
      `SELECT card_id, array_agg(status) AS statuses,
              (array_agg(title) FILTER (WHERE kind = 'card'))[1] AS title,
              max(updated_at) AS updated_at,
              (array_agg(error_code) FILTER (WHERE status = 'failed'))[1] AS error_code,
              min(updated_at) FILTER (WHERE status = 'pending') AS pending_since
       FROM items WHERE card_id IS NOT NULL
       GROUP BY card_id ORDER BY max(updated_at) DESC, card_id`,
    );
    return r.rows.map((row) => ({
      cardId: row.card_id,
      title: row.title ?? '',
      status: aggregate(row.statuses),
      items: row.statuses.length,
      updatedAt: row.updated_at.toISOString(),
      errorCode: row.error_code,
      pendingSince: row.pending_since?.toISOString() ?? null,
    }));
  });
}
