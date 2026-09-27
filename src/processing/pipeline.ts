import type pg from 'pg';
import { collectOrphans } from '../ingest/apply.js';
import {
  ModelError,
  normalizeName,
  type EntityRef,
  type Extraction,
  type ModelProvider,
} from '../ai/provider.js';
import { withIsland, type IslandTx } from '../store/islands.js';
import { chunkMarkdown } from './chunk.js';
import { relink } from './links.js';

interface ItemRow {
  key: string;
  kind: string;
  version: string;
  title: string;
  body: string;
  author_id: string | null;
  author_name: string | null;
}

export type ProcessResult = 'indexed' | 'skipped' | 'failed';

export const toVector = (v: number[]): string => `[${v.join(',')}]`;

async function upsertEntity(tx: IslandTx, e: EntityRef, userId: string | null = null) {
  const norm = userId ? `user:${userId}` : normalizeName(e.name);
  const r = await tx.query<{ id: string }>(
    `INSERT INTO entities (kind, name, norm, user_id) VALUES ($1, $2, $3, $4)
     ON CONFLICT (kind, norm) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
    [e.kind, e.name, norm, userId],
  );
  return r.rows[0]!.id;
}

async function writeGraph(
  tx: IslandTx,
  item: ItemRow,
  model: string,
  chunks: { heading: string; text: string }[],
  vectors: number[][],
  extractions: Extraction[],
): Promise<void> {
  await tx.query('DELETE FROM passages WHERE item_key = $1', [item.key]);
  const author = item.author_id
    ? await upsertEntity(
        tx,
        { kind: 'person', name: item.author_name ?? item.author_id },
        item.author_id,
      )
    : null;
  for (const [i, chunk] of chunks.entries()) {
    const ex = extractions[i]!;
    const p = await tx.query<{ id: string }>(
      `INSERT INTO passages (item_key, ordinal, heading, text, embedding, model, stance)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [item.key, i, chunk.heading, chunk.text, toVector(vectors[i]!), model, ex.stance],
    );
    const passageId = p.rows[0]!.id;
    const ids = new Map<string, string>();
    const idOf = async (e: EntityRef) => {
      const k = `${e.kind}:${normalizeName(e.name)}`;
      const id = ids.get(k) ?? (await upsertEntity(tx, e));
      ids.set(k, id);
      return id;
    };
    const mentioned = author ? [author] : [];
    for (const e of ex.entities) mentioned.push(await idOf(e));
    for (const r of ex.relations) {
      const [src, dst] = [await idOf(r.src), await idOf(r.dst)];
      mentioned.push(src, dst);
      await tx.query(
        `INSERT INTO relations (src, dst, type, passage_id) VALUES ($1, $2, $3, $4)
         ON CONFLICT DO NOTHING`,
        [src, dst, r.type, passageId],
      );
    }
    await tx.query(
      `INSERT INTO mentions (entity_id, passage_id) SELECT unnest($1::bigint[]), $2
       ON CONFLICT DO NOTHING`,
      [mentioned, passageId],
    );
  }
  await relink(tx, item.kind === 'doc' ? null : item.key);
  await collectOrphans(tx);
}

/**
 * Processes one item: chunk, embed, extract, then atomically replace its part of
 * the graph. Model calls happen outside any transaction. If the item changed or
 * disappeared meanwhile, the result is discarded.
 */
export async function processItem(
  pool: pg.Pool,
  provider: ModelProvider,
  boardId: string,
  itemKey: string,
): Promise<ProcessResult> {
  const item = await withIsland(pool, boardId, async (tx) => {
    const r = await tx.query<ItemRow>(
      `UPDATE items SET status = 'processing', updated_at = now()
       WHERE key = $1 AND status <> 'indexed'
       RETURNING key, kind, version, title, body, author_id, author_name`,
      [itemKey],
    );
    return r.rows[0];
  });
  if (!item) return 'skipped';
  const chunks = chunkMarkdown(item.title, item.body);
  const texts = chunks.map((c) => `${c.heading}\n${c.text}`);
  try {
    const vectors = await provider.embed(texts);
    const extractions: Extraction[] = [];
    for (const t of texts) extractions.push(await provider.extract(t));
    return await withIsland(pool, boardId, async (tx) => {
      const cur = await tx.query('SELECT 1 FROM items WHERE key = $1 AND version = $2 FOR UPDATE', [
        item.key,
        item.version,
      ]);
      if (cur.rowCount === 0) return 'skipped';
      await writeGraph(tx, item, provider.id, chunks, vectors, extractions);
      await tx.query(
        `UPDATE items SET status = 'indexed', error_code = NULL, updated_at = now() WHERE key = $1`,
        [item.key],
      );
      return 'indexed';
    });
  } catch (err) {
    const code = err instanceof ModelError ? err.message : 'internal_error';
    await withIsland(pool, boardId, (tx) =>
      tx.query(
        `UPDATE items SET status = 'failed', attempts = attempts + 1, error_code = $3,
           updated_at = now() WHERE key = $1 AND version = $2`,
        [item.key, item.version, code],
      ),
    );
    return 'failed';
  }
}
