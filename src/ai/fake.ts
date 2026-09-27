import {
  normalizeName,
  type EntityRef,
  type Extraction,
  type ModelProvider,
  type Stance,
} from './provider.js';

export const FAKE_DIMENSIONS = 256;

const STOPWORDS = new Set(
  (
    'le la les un une des du de d l et ou a au aux en dans sur pour par avec sans ce cette ces ' +
    'est sont etre il elle ils elles on nous vous je tu qui que quoi ne pas plus se sa son ses leur ' +
    'the a an and or of to in on for with is are be it this that as at by from not'
  ).split(' '),
);

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function tokens(text: string): string[] {
  return normalizeName(text)
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t));
}

/** Deterministic bag of words + character trigrams, hashed into a unit vector. */
export function fakeEmbedding(text: string): number[] {
  const v = new Array<number>(FAKE_DIMENSIONS).fill(0);
  const add = (feature: string, weight: number) => {
    const h = fnv1a(feature);
    v[h % FAKE_DIMENSIONS]! += h & 0x80000000 ? -weight : weight;
  };
  for (const t of tokens(text)) {
    add(`w:${t}`, 1);
    for (let i = 0; i + 3 <= t.length; i++) add(`c:${t.slice(i, i + 3)}`, 0.3);
  }
  const norm = Math.hypot(...v);
  if (norm === 0) v[0] = 1;
  return norm === 0 ? v : v.map((x) => x / norm);
}

const IDENT = '`?([\\p{L}][\\p{L}\\p{N}_.-]*[\\p{L}\\p{N}])`?';
const RELATION_PATTERNS: [RegExp, string][] = [
  [
    new RegExp(`${IDENT}[ \\t]+(?:dépend(?:ent)? de|depends on)[ \\t]+${IDENT}`, 'giu'),
    'depends_on',
  ],
  [new RegExp(`${IDENT}[ \\t]+(?:remplace|replaces)[ \\t]+${IDENT}`, 'giu'), 'replaces'],
  [new RegExp(`${IDENT}[ \\t]+(?:utilise|appelle|uses|calls)[ \\t]+${IDENT}`, 'giu'), 'uses'],
];
const COMPONENT_WORD = new RegExp(
  `\\b(?:module|composant|service|component|api|table|librairie|library)[ \\t]+${IDENT}`,
  'giu',
);
const LABELLED_LINE =
  /^[\s>*-]*(d[ée]cid[ée]e?s?|d[ée]cision|decided|decision|bug|anomalie|incident)\s*:\s*(.+)$/gimu;

function clip(s: string): string {
  return s
    .replace(/[\s.;,!]+$/u, '')
    .slice(0, 80)
    .trim();
}

function stanceOf(text: string): Stance {
  const t = normalizeName(text);
  if (
    /contrairement|contredi|malgre|ne respecte pas|deroge|en violation|contrary to|violates|despite/.test(
      t,
    )
  ) {
    return 'contradicts';
  }
  if (/conformement|applique|respecte|selon la consigne|as per|according to|follows/.test(t)) {
    return 'applies';
  }
  return 'neutral';
}

/** Rule-based extraction: deterministic, offline, good enough for demos and tests. */
export function fakeExtract(text: string): Extraction {
  const entities = new Map<string, EntityRef>();
  const add = (kind: EntityRef['kind'], name: string): EntityRef => {
    const ref = { kind, name: clip(name) };
    entities.set(`${kind}:${normalizeName(ref.name)}`, ref);
    return ref;
  };
  const relations: Extraction['relations'] = [];

  for (const m of text.matchAll(/(?<![\p{L}\p{N}])@([\p{L}][\p{L}\p{N}_.-]*[\p{L}\p{N}])/gu))
    add('person', m[1]!);
  for (const m of text.matchAll(/`([^`\n]{2,60})`/g)) add('component', m[1]!);
  for (const m of text.matchAll(COMPONENT_WORD)) add('component', m[1]!);
  for (const m of text.matchAll(/(?<![\p{L}\p{N}#])#([\p{L}][\p{L}\p{N}_-]+)/gu))
    add('concept', m[1]!);
  for (const [re, type] of RELATION_PATTERNS) {
    for (const m of text.matchAll(re)) {
      relations.push({ src: add('component', m[1]!), dst: add('component', m[2]!), type });
    }
  }
  const components = [...entities.values()].filter((e) => e.kind === 'component');
  for (const m of text.matchAll(LABELLED_LINE)) {
    const isBug = /^(bug|anomalie|incident)$/i.test(m[1]!);
    const labelled = add(isBug ? 'bug' : 'decision', m[2]!);
    for (const c of components)
      relations.push({ src: labelled, dst: c, type: isBug ? 'affects' : 'concerns' });
  }
  return { entities: [...entities.values()], relations, stance: stanceOf(text) };
}

export class FakeProvider implements ModelProvider {
  readonly id = 'fake:v1';
  embed(texts: string[]): Promise<number[][]> {
    return Promise.resolve(texts.map(fakeEmbedding));
  }
  extract(text: string): Promise<Extraction> {
    return Promise.resolve(fakeExtract(text));
  }
}
