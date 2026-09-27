import type { IslandTx } from '../store/islands.js';

/** Minimum cosine similarity for a neutral passage to be linked to a guideline passage. */
export const LINK_THRESHOLD = 0.3;
/** Lower bar when the passage explicitly applies or contradicts a guideline. */
export const STANCE_LINK_THRESHOLD = 0.15;

/**
 * Links passages (cards, comments, reports, facts...) to their closest guideline
 * passage (board docs). The link type is the passage's stance: `applies`,
 * `contradicts`, or `relates` when neutral. `onlyItem` restricts to one item.
 */
export async function relink(tx: IslandTx, onlyItem: string | null): Promise<void> {
  if (onlyItem === null) await tx.query('DELETE FROM guideline_links');
  await tx.query(
    `INSERT INTO guideline_links (from_passage, to_passage, type, score)
     SELECT p.id, best.id, CASE p.stance WHEN 'neutral' THEN 'relates' ELSE p.stance END, best.score
     FROM passages p
     JOIN items i ON i.key = p.item_key AND i.kind <> 'doc'
     CROSS JOIN LATERAL (
       SELECT d.id, 1 - (d.embedding <=> p.embedding) AS score
       FROM passages d JOIN items di ON di.key = d.item_key AND di.kind = 'doc'
       WHERE d.model = p.model
       ORDER BY d.embedding <=> p.embedding LIMIT 1
     ) best
     WHERE best.score >= CASE p.stance WHEN 'neutral' THEN $1::float8 ELSE $3::float8 END
       AND ($2::text IS NULL OR p.item_key = $2)
     ON CONFLICT DO NOTHING`,
    [LINK_THRESHOLD, onlyItem, STANCE_LINK_THRESHOLD],
  );
}
