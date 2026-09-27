/**
 * Tables of one island. Executed with `search_path` set to the island schema and
 * `ROLE` set to the island role, so every object is owned by that role and lives
 * only in that schema.
 */
export const ISLAND_DDL = `
CREATE TABLE items (
  key text PRIMARY KEY,
  kind text NOT NULL,
  card_id text,
  doc_id text,
  author_id text,
  author_name text,
  version bigint NOT NULL,
  title text NOT NULL DEFAULT '',
  body text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'pending',
  attempts int NOT NULL DEFAULT 0,
  error_code text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX items_card ON items (card_id);
CREATE INDEX items_author ON items (author_id);
CREATE TABLE tombstones (
  key text PRIMARY KEY,
  version bigint NOT NULL
);
CREATE TABLE passages (
  id bigserial PRIMARY KEY,
  item_key text NOT NULL REFERENCES items(key) ON DELETE CASCADE,
  ordinal int NOT NULL,
  heading text NOT NULL DEFAULT '',
  text text NOT NULL,
  embedding vector NOT NULL,
  model text NOT NULL,
  stance text NOT NULL DEFAULT 'neutral',
  tsv tsvector GENERATED ALWAYS AS (to_tsvector('simple', heading || ' ' || text)) STORED
);
CREATE INDEX passages_item ON passages (item_key);
CREATE INDEX passages_tsv ON passages USING gin (tsv);
CREATE TABLE entities (
  id bigserial PRIMARY KEY,
  kind text NOT NULL,
  name text NOT NULL,
  norm text NOT NULL,
  user_id text,
  UNIQUE (kind, norm)
);
CREATE TABLE mentions (
  entity_id bigint NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  passage_id bigint NOT NULL REFERENCES passages(id) ON DELETE CASCADE,
  PRIMARY KEY (entity_id, passage_id)
);
CREATE INDEX mentions_passage ON mentions (passage_id);
CREATE TABLE relations (
  src bigint NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  dst bigint NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  type text NOT NULL,
  passage_id bigint NOT NULL REFERENCES passages(id) ON DELETE CASCADE,
  PRIMARY KEY (src, dst, type, passage_id)
);
CREATE INDEX relations_passage ON relations (passage_id);
CREATE TABLE guideline_links (
  from_passage bigint NOT NULL REFERENCES passages(id) ON DELETE CASCADE,
  to_passage bigint NOT NULL REFERENCES passages(id) ON DELETE CASCADE,
  type text NOT NULL,
  score real NOT NULL,
  PRIMARY KEY (from_passage, to_passage)
);
CREATE INDEX guideline_links_to ON guideline_links (to_passage);
`;

/** Every table of an island, used for the verifiable counts. */
export const ISLAND_TABLES = [
  'items',
  'tombstones',
  'passages',
  'entities',
  'mentions',
  'relations',
  'guideline_links',
] as const;

export type IslandCounts = Record<(typeof ISLAND_TABLES)[number], number>;
