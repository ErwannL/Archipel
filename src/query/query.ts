import type pg from 'pg';
import { normalizeName, type ModelProvider } from '../ai/provider.js';
import { toVector } from '../processing/pipeline.js';
import { withIsland, type IslandTx } from '../store/islands.js';
import { pack, sizeOf } from './budget.js';

export interface QueryOptions {
  question: string;
  maxChars: number;
  topK: number;
  cardId?: string | undefined;
}

export interface Passage {
  passageId: string;
  itemKey: string;
  kind: string;
  cardId: string | null;
  docId: string | null;
  heading: string;
  text: string;
  score: number;
}

interface Node {
  id: string;
  kind: string;
  name: string;
}
interface Edge {
  src: string;
  dst: string;
  type: string;
  weight: number;
}
interface GuidelineLink {
  fromPassage: string;
  toPassage: string;
  docId: string;
  section: string;
  type: string;
  score: number;
}
export interface Citation {
  itemKey: string;
  kind: string;
  cardId: string | null;
  docId: string | null;
  passageIds: string[];
}

export interface QueryResult {
  passages: Passage[];
  graph: { nodes: Node[]; edges: Edge[] };
  guidelineLinks: GuidelineLink[];
  citations: Citation[];
  usedChars: number;
  truncated: boolean;
}

const ENTITY_BOOST = 0.25;
const CARD_BOOST = 0.1;

async function candidates(tx: IslandTx, qv: string, question: string, model: string, k: number) {
  const r = await tx.query<Omit<Passage, 'score'> & { vscore: number; ehit: boolean }>(
    `WITH hit AS (
       SELECT id FROM entities WHERE length(norm) >= 3 AND position(norm IN $2) > 0),
     cand AS (
       (SELECT id FROM passages WHERE model = $3 ORDER BY embedding <=> $1 LIMIT $4)
       UNION
       (SELECT m.passage_id FROM mentions m JOIN hit ON hit.id = m.entity_id LIMIT $4))
     SELECT p.id::text AS "passageId", p.item_key AS "itemKey", i.kind, i.card_id AS "cardId",
            i.doc_id AS "docId", p.heading, p.text,
            1 - (p.embedding <=> $1) AS vscore,
            EXISTS (SELECT 1 FROM mentions m JOIN hit ON hit.id = m.entity_id
                    WHERE m.passage_id = p.id) AS ehit
     FROM cand JOIN passages p ON p.id = cand.id JOIN items i ON i.key = p.item_key
     WHERE p.model = $3`,
    [qv, normalizeName(question), model, k * 3],
  );
  return r.rows;
}

async function subgraph(tx: IslandTx, passageIds: string[]) {
  const nodes = await tx.query<Node>(
    `SELECT DISTINCT e.id::text AS id, e.kind, e.name FROM entities e
     JOIN mentions m ON m.entity_id = e.id WHERE m.passage_id = ANY($1::bigint[])
     ORDER BY 1`,
    [passageIds],
  );
  const ids = nodes.rows.map((n) => n.id);
  const edges = await tx.query<Edge>(
    `SELECT src::text AS src, dst::text AS dst, type, count(*)::int AS weight FROM relations
     WHERE src = ANY($1::bigint[]) AND dst = ANY($1::bigint[])
     GROUP BY src, dst, type ORDER BY weight DESC, src, dst LIMIT 200`,
    [ids],
  );
  const links = await tx.query<GuidelineLink>(
    `SELECT l.from_passage::text AS "fromPassage", l.to_passage::text AS "toPassage",
            i.doc_id AS "docId", d.heading AS section, l.type, round(l.score::numeric, 3)::float8 AS score
     FROM guideline_links l JOIN passages d ON d.id = l.to_passage JOIN items i ON i.key = d.item_key
     WHERE l.from_passage = ANY($1::bigint[]) OR l.to_passage = ANY($1::bigint[])
     ORDER BY l.score DESC LIMIT 50`,
    [passageIds],
  );
  return { nodes: nodes.rows, edges: edges.rows, links: links.rows };
}

function citationsOf(passages: Passage[]): Citation[] {
  const byItem = new Map<string, Citation>();
  for (const p of passages) {
    const c = byItem.get(p.itemKey) ?? {
      itemKey: p.itemKey,
      kind: p.kind,
      cardId: p.cardId,
      docId: p.docId,
      passageIds: [],
    };
    c.passageIds.push(p.passageId);
    byItem.set(p.itemKey, c);
  }
  return [...byItem.values()];
}

const shrinkPassage = (p: Passage, room: number): Passage | null => {
  const overhead = sizeOf({ ...p, text: '' });
  const keep = room - overhead - 1;
  return keep >= 80 ? { ...p, text: p.text.slice(0, keep - 1) + '…' } : null;
};

/**
 * Answers a question from one island only: passages ranked by vector similarity,
 * boosted when they mention an entity named in the question, plus the subgraph of
 * their entities, guideline links and citations — all within `maxChars`.
 */
export async function query(
  pool: pg.Pool,
  provider: ModelProvider,
  boardId: string,
  opts: QueryOptions,
): Promise<QueryResult> {
  const [vector] = await provider.embed([opts.question]);
  const qv = toVector(vector!);
  return withIsland(pool, boardId, async (tx) => {
    const rows = await candidates(tx, qv, opts.question, provider.id, opts.topK);
    const ranked: Passage[] = rows
      .map(({ vscore, ehit, ...p }) => ({
        ...p,
        score:
          Math.round(
            (vscore +
              (ehit ? ENTITY_BOOST : 0) +
              (p.cardId === (opts.cardId ?? null) ? CARD_BOOST : 0)) *
              1000,
          ) / 1000,
      }))
      .sort((a, b) => b.score - a.score || a.passageId.localeCompare(b.passageId))
      .slice(0, opts.topK);

    const envelope =
      sizeOf({
        passages: [],
        graph: { nodes: [], edges: [] },
        guidelineLinks: [],
        citations: [],
        usedChars: 0,
        truncated: false,
      }) + 12;
    let budget = opts.maxChars - envelope;
    // Citations are sized for all passages first so they always fit what is kept.
    const p = pack(ranked, Math.floor(budget * 0.7), shrinkPassage);
    const citations = citationsOf(p.kept);
    budget -= p.used + sizeOf(citations);
    const g = await subgraph(
      tx,
      p.kept.map((x) => x.passageId),
    );
    const links = pack(g.links, Math.floor(budget / 3));
    budget -= links.used;
    const edges = pack(g.edges, Math.floor(budget / 2));
    budget -= edges.used;
    const wanted = new Set(edges.kept.flatMap((e) => [e.src, e.dst]));
    const ordered = [
      ...g.nodes.filter((n) => wanted.has(n.id)),
      ...g.nodes.filter((n) => !wanted.has(n.id)),
    ];
    const nodes = pack(ordered, budget);
    const keptNodes = new Set(nodes.kept.map((n) => n.id));
    const result: QueryResult = {
      passages: p.kept,
      graph: {
        nodes: nodes.kept,
        edges: edges.kept.filter((e) => keptNodes.has(e.src) && keptNodes.has(e.dst)),
      },
      guidelineLinks: links.kept,
      citations,
      usedChars: 0,
      truncated: p.truncated || links.truncated || edges.truncated || nodes.truncated,
    };
    result.usedChars = sizeOf(result);
    return result;
  });
}
