import { el } from './dom.js';
import { logo } from './logo.js';

/**
 * Branding shared by every screen, one source of truth (same set as SportSplitter
 * by Orqea): logo, « by Orqea », credits, « Revenir sur Orqea ». The Orqea link is
 * the one of THIS environment (`ARCHIPEL_ORQEA_URL`, learnt from `/healthz`).
 */
export const DEFAULT_ORQEA_URL = 'https://orqea.dev';
export const AUTHOR = { name: 'Erwann Laplante', href: 'https://github.com/ErwannL' } as const;

const TEXTS = {
  fr: {
    by: 'par Orqea',
    owner: 'Propulsé par Orqea',
    author: 'Développé par',
    back: '← Revenir sur Orqea',
    loading: 'Chargement…',
    notFound: '404 — introuvable',
    notFoundHint: 'Ouvrez la mémoire d’un board depuis Orqea : le lien est valable une minute.',
  },
  en: {
    by: 'by Orqea',
    owner: 'Powered by Orqea',
    author: 'Developed by',
    back: '← Back to Orqea',
    loading: 'Loading…',
    notFound: '404 — not found',
    notFoundHint: 'Open a board’s memory from Orqea: the link is valid for one minute.',
  },
} as const;

/** The branding texts in the browser language (French by default, English for `en*`). */
function texts(doc: Document) {
  const lang = (doc.defaultView as Window).navigator.language;
  return lang.toLowerCase().startsWith('en') ? TEXTS.en : TEXTS.fr;
}

/** Name + « Propulsé par Orqea » / « Développé par Erwann Laplante », two distinct links. */
export function brand(doc: Document, orqeaUrl: string): HTMLElement {
  const tx = texts(doc);
  const home = el(doc, 'span', { class: 'brand-logo ap-hover' });
  home.append(logo(doc, { size: 32, mode: 'hover', title: 'Archipel' }));
  return el(
    doc,
    'div',
    { class: 'brand' },
    home,
    el(
      doc,
      'div',
      { class: 'brand-text' },
      el(doc, 'h1', {}, 'Archipel ', el(doc, 'span', { class: 'by' }, tx.by)),
      el(
        doc,
        'div',
        { class: 'credits' },
        // Same tab (Orqea's session lives in the tab), outside the console iframe.
        el(doc, 'a', { href: orqeaUrl, target: '_top', 'data-credit': 'owner' }, tx.owner),
        el(
          doc,
          'a',
          {
            href: AUTHOR.href,
            target: '_blank',
            rel: 'noreferrer noopener',
            'aria-label': `${tx.author} ${AUTHOR.name}`,
            'data-credit': 'author',
          },
          `${tx.author} ${AUTHOR.name}`,
        ),
      ),
    ),
  );
}

/** « Revenir sur Orqea »: the session comes from Orqea, so there is no logout, we go back. */
export function backToOrqea(doc: Document, orqeaUrl: string): HTMLElement {
  // Inside the Orqea console iframe the console itself is the way back: the button is hidden.
  const win = doc.defaultView as Window;
  const link = el(doc, 'a', { class: 'back', href: orqeaUrl, target: '_top' }, texts(doc).back);
  link.hidden = win.self !== win.top;
  return link;
}

/** Full-page loader: the animated logo, never a spinner. */
export function loader(doc: Document): HTMLElement {
  const box = el(doc, 'div', { class: 'loader', role: 'status' });
  box.append(logo(doc, { size: 56, mode: 'loop' }), el(doc, 'span', {}, texts(doc).loading));
  return box;
}

/** 404 page (no or expired session): still branded, with the way back to Orqea. */
export function notFoundPage(doc: Document, orqeaUrl: string): HTMLElement {
  const tx = texts(doc);
  const box = el(doc, 'div', { class: 'notfound' });
  box.append(
    logo(doc, { size: 64, mode: 'hover', title: 'Archipel' }),
    el(doc, 'p', {}, tx.notFound),
    el(doc, 'p', { class: 'empty' }, tx.notFoundHint),
    backToOrqea(doc, orqeaUrl),
    brand(doc, orqeaUrl),
  );
  return box;
}
