import type pg from 'pg';
import { islandExists, withIsland, type IslandTx } from '../store/islands.js';

/** Graph ids of card nodes: `card:<cardId>` (entity ids are plain integers). */
export const CARD_PREFIX = 'card:';

const CARD_NAME = `coalesce(nullif((array_agg(i.title) FILTER (WHERE i.kind = 'card'))[1], ''),
                            '#' || i.card_id)`;

/**
 * Whole-board graph for the human UI: the most connected entities plus the indexed
 * cards themselves, each card linked to the entities its items mention. A board whose
 * text yields no entity still shows its cards.
 */
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
    const cards = await tx.query<{ id: string; kind: string; name: string; sources: number }>(
      `SELECT $2 || i.card_id AS id, 'card' AS kind, ${CARD_NAME} AS name,
              count(*)::int AS sources
       FROM items i WHERE i.card_id IS NOT NULL AND i.status = 'indexed'
       GROUP BY i.card_id ORDER BY i.card_id LIMIT $1`,
      [limit, CARD_PREFIX],
    );
    const cardIds = cards.rows.map((c) => c.id.slice(CARD_PREFIX.length));
    const cardEdges = await tx.query<{ src: string; dst: string; type: string; weight: number }>(
      `SELECT $3 || i.card_id AS src, m.entity_id::text AS dst, 'mentions' AS type,
              count(*)::int AS weight
       FROM items i JOIN passages p ON p.item_key = i.key JOIN mentions m ON m.passage_id = p.id
       WHERE i.card_id = ANY($1) AND m.entity_id = ANY($2::bigint[])
       GROUP BY i.card_id, m.entity_id ORDER BY 1, 2`,
      [cardIds, ids, CARD_PREFIX],
    );
    return { nodes: [...nodes.rows, ...cards.rows], edges: [...edges.rows, ...cardEdges.rows] };
  });
}

const SOURCE_COLUMNS = `p.id::text AS "passageId", p.item_key AS "itemKey", i.kind,
  i.card_id AS "cardId", i.doc_id AS "docId", p.heading, p.text, i.status`;

/** A card node: its passages as sources, the entities they mention as relations. */
async function cardNode(tx: IslandTx, cardId: string) {
  const c = await tx.query<{ id: string; kind: string; name: string }>(
    `SELECT $2 || i.card_id AS id, 'card' AS kind, ${CARD_NAME} AS name
     FROM items i WHERE i.card_id = $1 GROUP BY i.card_id`,
    [cardId, CARD_PREFIX],
  );
  const entity = c.rows[0];
  if (!entity) return null;
  const sources = await tx.query(
    `SELECT ${SOURCE_COLUMNS} FROM passages p JOIN items i ON i.key = p.item_key
     WHERE i.card_id = $1 ORDER BY p.item_key, p.ordinal LIMIT 100`,
    [cardId],
  );
  const relations = await tx.query(
    `SELECT 'out' AS direction, 'mentions' AS type, e.id::text AS "otherId",
            e.kind AS "otherKind", e.name AS "otherName", count(*)::int AS weight
     FROM items i JOIN passages p ON p.item_key = i.key JOIN mentions m ON m.passage_id = p.id
     JOIN entities e ON e.id = m.entity_id
     WHERE i.card_id = $1 GROUP BY e.id ORDER BY weight DESC, e.id`,
    [cardId],
  );
  return { entity, sources: sources.rows, relations: relations.rows };
}

/** One entity (or card node) with its relations and every source passage (with citations). */
export async function entityDetail(pool: pg.Pool, boardId: string, entityId: string) {
  const isCard = entityId.startsWith(CARD_PREFIX);
  const valid = isCard
    ? entityId.length > CARD_PREFIX.length // Fastify caps path params at 100 chars
    : /^\d{1,18}$/.test(entityId);
  if (!valid || !(await islandExists(pool, boardId))) return null;
  return withIsland(pool, boardId, async (tx) => {
    if (isCard) return cardNode(tx, entityId.slice(CARD_PREFIX.length));
    const e = await tx.query<{ id: string; kind: string; name: string }>(
      'SELECT id::text AS id, kind, name FROM entities WHERE id = $1',
      [entityId],
    );
    const entity = e.rows[0];
    if (!entity) return null;
    const sources = await tx.query(
      `SELECT ${SOURCE_COLUMNS}
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
