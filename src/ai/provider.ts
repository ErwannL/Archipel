export type EntityKind = 'person' | 'component' | 'decision' | 'bug' | 'concept';
export const ENTITY_KINDS: readonly EntityKind[] = [
  'person',
  'component',
  'decision',
  'bug',
  'concept',
];

export type Stance = 'applies' | 'contradicts' | 'neutral';

export interface EntityRef {
  kind: EntityKind;
  name: string;
}

export interface Extraction {
  entities: EntityRef[];
  relations: { src: EntityRef; dst: EntityRef; type: string }[];
  /** How the passage positions itself relative to board guidelines. */
  stance: Stance;
}

/** Interchangeable model backend: embeddings + entity/relation extraction. */
export interface ModelProvider {
  /** Stable identifier stored with every embedding (vectors of different models never mix). */
  readonly id: string;
  embed(texts: string[]): Promise<number[][]>;
  extract(text: string): Promise<Extraction>;
}

/** Model failure. The message is a short code; it never contains board content. */
export class ModelError extends Error {
  constructor(code: string) {
    super(code);
    this.name = 'ModelError';
  }
}

/** Normalised form used for entity identity inside one island. */
export function normalizeName(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[`"'’]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
