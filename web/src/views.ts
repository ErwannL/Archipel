import type { Api, CardDetail, EntityDetail, Overview, SearchResult, Source } from './api.js';
import { backToOrqea, brand } from './brand.js';
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

export const STATUS_LABELS: Record<CardDetail['status'], string> = {
  pending: 'En attente',
  processing: 'En cours d’analyse',
  indexed: 'En mémoire',
  failed: 'En échec',
};

const ERROR_LABELS: Record<string, string> = {
  model_unreachable: 'modèle injoignable',
  model_bad_response: 'réponse du modèle illisible',
  internal_error: 'erreur interne',
};

/** Human reason of a failure; unknown codes (e.g. `model_http_503`) are shown as is. */
export function errorLabel(code: string): string {
  return ERROR_LABELS[code] ?? code;
}

/** A pending item older than this means no worker is draining the queue. */
export const STALE_PENDING_MS = 5 * 60_000;

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });
}

function cardRow(doc: Document, c: CardDetail, now: number): HTMLElement {
  const name = el(doc, 'td', {});
  if (c.title) name.append(el(doc, 'span', { class: 'title' }, c.title), ' ');
  name.append(el(doc, 'span', { class: 'cite' }, `#${c.cardId}`));
  const state = el(doc, 'td', { class: `status-${c.status}` }, STATUS_LABELS[c.status]);
  if (c.errorCode !== null)
    state.append(el(doc, 'div', { class: 'reason' }, errorLabel(c.errorCode)));
  if (c.pendingSince !== null && now - Date.parse(c.pendingSince) > STALE_PENDING_MS)
    state.append(
      el(doc, 'div', { class: 'reason' }, `depuis ${formatDate(c.pendingSince)} — worker arrêté ?`),
    );
  return el(
    doc,
    'tr',
    {},
    name,
    state,
    el(doc, 'td', { class: 'num' }, String(c.items)),
    el(doc, 'td', {}, el(doc, 'time', { datetime: c.updatedAt }, formatDate(c.updatedAt))),
  );
}

export function statusTable(doc: Document, cards: CardDetail[], now = Date.now()): HTMLElement {
  if (cards.length === 0) return el(doc, 'p', { class: 'empty' }, 'Aucune carte en mémoire.');
  return el(
    doc,
    'div',
    {},
    el(
      doc,
      'p',
      { class: 'empty help' },
      '« En attente » : reçue d’Orqea, pas encore analysée par le worker. « Éléments » : la carte, ses commentaires et checklists, analysés séparément. Un board chiffré n’envoie rien.',
    ),
    el(
      doc,
      'table',
      {},
      el(
        doc,
        'tr',
        {},
        el(doc, 'th', {}, 'Carte'),
        el(doc, 'th', {}, 'État'),
        el(doc, 'th', { title: 'Carte, commentaires et checklists' }, 'Éléments'),
        el(doc, 'th', {}, 'Mise à jour'),
      ),
      ...cards.map((c) => cardRow(doc, c, now)),
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
  orqeaUrl: string,
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
      brand(doc, orqeaUrl),
      el(doc, 'span', { class: 'board' }, overview.boardName ?? `Board #${overview.boardId}`),
      gauge(doc, overview),
      backToOrqea(doc, orqeaUrl),
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
        statusTable(doc, overview.cards),
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
