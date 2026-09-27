import type pg from 'pg';
import { islandExists, withIsland } from '../store/islands.js';

/** Whole-board graph for the human UI, limited to the most connected entities. */
export async function boardGraph(pool: pg.Pool, boardId: string, limit: number) {
  if (!(await islandExists(pool, boardId))) return { nodes: [], edges: [] };
  return withIsland(pool, boardId, async (tx) => {
    const nodes = await tx.query<{ id: string; kind: string; name: string; sources: number }>(
      `SELECT e.id::text AS id, e.kind, e.name, count(m.passage_id)::int AS sources
       FROM entities e JOIN mentions m ON m.entity_id = e.id
       GROUP BY e.id ORDER BY sources DESC, e.id LIMIT $1`,
      [limit],
    );
    const ids = nodes.rows.map((n) => n.id);
    const edges = await tx.query<{ src: string; dst: string; type: string; weight: number }>(
      `SELECT src::text AS src, dst::text AS dst, type, count(*)::int AS weight FROM relations
       WHERE src = ANY($1::bigint[]) AND dst = ANY($1::bigint[]) GROUP BY src, dst, type`,
      [ids],
    );
    return { nodes: nodes.rows, edges: edges.rows };
  });
}

/** One entity with its relations and every source passage (with citations). */
export async function entityDetail(pool: pg.Pool, boardId: string, entityId: string) {
  if (!/^\d{1,18}$/.test(entityId) || !(await islandExists(pool, boardId))) return null;
  return withIsland(pool, boardId, async (tx) => {
    const e = await tx.query<{ id: string; kind: string; name: string }>(
      'SELECT id::text AS id, kind, name FROM entities WHERE id = $1',
      [entityId],
    );
    const entity = e.rows[0];
    if (!entity) return null;
    const sources = await tx.query(
      `SELECT p.id::text AS "passageId", p.item_key AS "itemKey", i.kind, i.card_id AS "cardId",
              i.doc_id AS "docId", p.heading, p.text, i.status
       FROM mentions m JOIN passages p ON p.id = m.passage_id JOIN items i ON i.key = p.item_key
       WHERE m.entity_id = $1 ORDER BY p.item_key, p.ordinal LIMIT 100`,
      [entityId],
    );
    const relations = await tx.query(
      `SELECT CASE WHEN r.src = $1 THEN 'out' ELSE 'in' END AS direction, r.type,
              o.id::text AS "otherId", o.kind AS "otherKind", o.name AS "otherName",
              count(*)::int AS weight
       FROM relations r JOIN entities o ON o.id = CASE WHEN r.src = $1 THEN r.dst ELSE r.src END
       WHERE r.src = $1 OR r.dst = $1
       GROUP BY 1, 2, 3, 4, 5 ORDER BY weight DESC, 3`,
      [entityId],
    );
    return { entity, sources: sources.rows, relations: relations.rows };
  });
}
