import { vi } from 'vitest';
import type { Api, EntityDetail, Overview, SearchResult } from '../../web/src/api.js';

export const overview: Overview = {
  boardId: 'b-7',
  exists: true,
  status: {
    progress: 0.5,
    totals: { pending: 1, processing: 0, indexed: 1, failed: 0 },
    cards: [{ cardId: 'c1', status: 'pending', items: 2 }],
  },
  counts: { items: 2 },
};

export const detail: EntityDetail = {
  entity: { id: '1', kind: 'component', name: 'Gateway' },
  sources: [
    {
      passageId: '9',
      itemKey: 'doc:d1',
      kind: 'doc',
      cardId: null,
      docId: 'd1',
      heading: 'Paiements',
      text: '<b>pas du HTML</b>',
    },
  ],
  relations: [
    {
      direction: 'out',
      type: 'depends_on',
      otherId: '2',
      otherKind: 'component',
      otherName: 'Redis',
      weight: 1,
    },
    {
      direction: 'in',
      type: 'uses',
      otherId: '3',
      otherKind: 'component',
      otherName: 'Front',
      weight: 2,
    },
  ],
};

export const result: SearchResult = {
  passages: [
    {
      passageId: '9',
      itemKey: 'card:c1',
      kind: 'card',
      cardId: 'c1',
      docId: null,
      heading: 'T',
      text: 'texte',
      score: 1,
    },
  ],
  graph: { nodes: [{ id: '1', kind: 'component', name: 'Gateway' }], edges: [] },
  guidelineLinks: [
    {
      fromPassage: '9',
      toPassage: '10',
      docId: 'd1',
      section: 'Paiements',
      type: 'applies',
      score: 0.8,
    },
  ],
  citations: [],
  truncated: false,
};

export function fakeApi(over: Partial<Api> = {}): Api {
  return {
    session: vi.fn(() => Promise.resolve(true)),
    overview: vi.fn(() => Promise.resolve(overview)),
    graph: vi.fn(() =>
      Promise.resolve({ nodes: [{ id: '1', kind: 'component', name: 'Gateway' }], edges: [] }),
    ),
    entity: vi.fn(() => Promise.resolve(detail)),
    search: vi.fn(() => Promise.resolve(result)),
    ...over,
  };
}
