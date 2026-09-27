export class ApiError extends Error {
  constructor(readonly status: number) {
    super(`http_${status}`);
  }
}

export interface Overview {
  boardId: string;
  exists: boolean;
  status: {
    progress: number;
    totals: Record<'pending' | 'processing' | 'indexed' | 'failed', number>;
    cards: { cardId: string; status: string; items: number }[];
  };
  counts: Record<string, number>;
}
export interface GraphNode {
  id: string;
  kind: string;
  name: string;
  sources?: number;
}
export interface GraphEdge {
  src: string;
  dst: string;
  type: string;
  weight: number;
}
export interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}
export interface Source {
  passageId: string;
  itemKey: string;
  kind: string;
  cardId: string | null;
  docId: string | null;
  heading: string;
  text: string;
}
export interface EntityDetail {
  entity: GraphNode;
  sources: Source[];
  relations: {
    direction: 'in' | 'out';
    type: string;
    otherId: string;
    otherKind: string;
    otherName: string;
    weight: number;
  }[];
}
export interface SearchResult {
  passages: (Source & { score: number })[];
  graph: Graph;
  guidelineLinks: {
    fromPassage: string;
    toPassage: string;
    docId: string;
    section: string;
    type: string;
    score: number;
  }[];
  citations: {
    itemKey: string;
    kind: string;
    cardId: string | null;
    docId: string | null;
    passageIds: string[];
  }[];
  truncated: boolean;
}

export interface Api {
  session(token: string): Promise<boolean>;
  overview(): Promise<Overview>;
  graph(): Promise<Graph>;
  entity(id: string): Promise<EntityDetail>;
  search(question: string): Promise<SearchResult>;
}

/** Same-origin JSON client; the session cookie is sent automatically. */
export function createApi(fetchFn: typeof fetch = (...a) => fetch(...a)): Api {
  async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
    const res = await fetchFn(url, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!res.ok) throw new ApiError(res.status);
    return (await res.json()) as T;
  }
  return {
    session: (token) =>
      call('POST', '/ui/session', { token }).then(
        () => true,
        () => false,
      ),
    overview: () => call('GET', '/ui/api/overview'),
    graph: () => call('GET', '/ui/api/graph'),
    entity: (id) => call('GET', `/ui/api/entities/${encodeURIComponent(id)}`),
    search: (question) => call('POST', '/ui/api/search', { question }),
  };
}
