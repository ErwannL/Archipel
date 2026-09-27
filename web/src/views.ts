import type { Api, EntityDetail, Overview, SearchResult, Source } from './api.js';
import { clear, el } from './dom.js';
import type { GraphRenderer } from './graph.js';

const KIND_LABELS: Record<string, string> = {
  card: 'carte',
  comment: 'commentaire',
  checklist: 'checklist',
  report: 'compte rendu',
  fact: 'fait d’agent',
  doc: 'consignes',
};

/** Human label of a source: "carte c1", "consignes d1 § Paiements"... */
export function citation(s: Pick<Source, 'kind' | 'cardId' | 'docId' | 'heading'>): string {
  const label = KIND_LABELS[s.kind] ?? s.kind;
  if (s.docId !== null) return `${label} « ${s.docId} »${s.heading ? ` § ${s.heading}` : ''}`;
  return `${label} · carte ${s.cardId ?? '?'}`;
}

function gauge(doc: Document, o: Overview): HTMLElement {
  const pct = Math.round(o.status.progress * 100);
  const t = o.status.totals;
  const fill = el(doc, 'div', { class: 'fill' });
  fill.style.width = `${pct}%`; // CSSOM, allowed by the CSP (inline style attributes are not)
  return el(
    doc,
    'div',
    {
      class: 'gauge',
      title: `${t.indexed} indexés · ${t.pending + t.processing} en cours · ${t.failed} en échec`,
    },
    'En mémoire',
    el(doc, 'div', { class: 'bar' }, fill),
    `${pct} %`,
  );
}

function statusTable(doc: Document, o: Overview): HTMLElement {
  if (o.status.cards.length === 0)
    return el(doc, 'p', { class: 'empty' }, 'Aucune carte en mémoire.');
  return el(
    doc,
    'table',
    {},
    el(
      doc,
      'tr',
      {},
      el(doc, 'th', {}, 'Carte'),
      el(doc, 'th', {}, 'État'),
      el(doc, 'th', {}, 'Éléments'),
    ),
    ...o.status.cards.map((c) =>
      el(
        doc,
        'tr',
        {},
        el(doc, 'td', {}, c.cardId),
        el(doc, 'td', { class: `status-${c.status}` }, c.status),
        el(doc, 'td', {}, String(c.items)),
      ),
    ),
  );
}

export function renderPassage(doc: Document, p: Source): HTMLElement {
  return el(
    doc,
    'div',
    { class: 'passage' },
    el(doc, 'span', { class: 'cite' }, citation(p)),
    el(doc, 'p', {}, p.text),
  );
}

export function renderEntity(
  doc: Document,
  d: EntityDetail,
  open: (id: string) => void,
): HTMLElement[] {
  const chip = (id: string, label: string) => {
    const b = el(doc, 'button', { class: 'chip', type: 'button' }, label);
    b.addEventListener('click', () => {
      open(id);
    });
    return b;
  };
  return [
    el(doc, 'h3', {}, `${d.entity.name} `, el(doc, 'span', { class: 'cite' }, d.entity.kind)),
    el(doc, 'h2', {}, 'Relations'),
    d.relations.length === 0
      ? el(doc, 'p', { class: 'empty' }, 'Aucune relation.')
      : el(
          doc,
          'div',
          {},
          ...d.relations.map((r) =>
            chip(
              r.otherId,
              r.direction === 'out' ? `→ ${r.type} ${r.otherName}` : `← ${r.type} ${r.otherName}`,
            ),
          ),
        ),
    el(doc, 'h2', {}, `Sources (${d.sources.length})`),
    ...d.sources.map((s) => renderPassage(doc, s)),
  ];
}

export function renderResults(
  doc: Document,
  r: SearchResult,
  open: (id: string) => void,
): HTMLElement[] {
  if (r.passages.length === 0)
    return [el(doc, 'p', { class: 'empty' }, 'Rien trouvé dans la mémoire de ce board.')];
  const chips = r.graph.nodes.map((n) => {
    const b = el(doc, 'button', { class: 'chip', type: 'button' }, n.name);
    b.addEventListener('click', () => {
      open(n.id);
    });
    return b;
  });
  const links = r.guidelineLinks.map((l) =>
    el(doc, 'div', { class: 'cite' }, `${l.type} → consignes « ${l.docId} » § ${l.section}`),
  );
  return [
    el(doc, 'div', {}, ...chips),
    el(doc, 'div', {}, ...links),
    ...r.passages.map((p) => renderPassage(doc, p)),
  ];
}

/** Renders the whole app for the session's board. */
export async function renderApp(
  root: HTMLElement,
  api: Api,
  overview: Overview,
  draw: GraphRenderer,
): Promise<void> {
  const doc = root.ownerDocument;
  const detail = el(
    doc,
    'div',
    {},
    el(doc, 'p', { class: 'empty' }, 'Cliquez une entité pour voir ses sources.'),
  );
  const results = el(doc, 'div', {});
  const graphBox = el(doc, 'section', { id: 'graph' });
  const input = el(doc, 'input', {
    type: 'search',
    name: 'q',
    placeholder: 'Chercher dans la mémoire…',
    maxlength: '2000',
  }) as HTMLInputElement;
  const form = el(
    doc,
    'form',
    { role: 'search' },
    input,
    el(doc, 'button', { type: 'submit' }, 'Chercher'),
  );

  const open = async (id: string) => {
    clear(detail, ...renderEntity(doc, await api.entity(id), (x) => void open(x)));
  };
  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const q = input.value.trim();
    if (!q) return;
    void api.search(q).then((r) => {
      clear(results, ...renderResults(doc, r, (x) => void open(x)));
    });
  });

  clear(
    root,
    el(
      doc,
      'header',
      {},
      el(doc, 'h1', {}, 'Archipel'),
      el(doc, 'span', { class: 'board' }, `board ${overview.boardId}`),
      gauge(doc, overview),
    ),
    el(
      doc,
      'main',
      {},
      el(
        doc,
        'section',
        {},
        el(doc, 'h2', {}, 'Recherche'),
        form,
        results,
        el(doc, 'h2', {}, 'État des cartes'),
        statusTable(doc, overview),
      ),
      graphBox,
      el(doc, 'section', {}, el(doc, 'h2', {}, 'Entité'), detail),
    ),
  );
  const graph = await api.graph();
  if (graph.nodes.length === 0) {
    graphBox.append(el(doc, 'p', { class: 'empty' }, 'Le graphe de ce board est vide.'));
    return;
  }
  draw(graphBox, graph, (id) => void open(id));
}
