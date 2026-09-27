import { el } from './dom.js';
import { logo } from './logo.js';

/**
 * Branding shared by every screen, one source of truth (same set as SportSplitter
 * by Orqea): logo, « by Orqea », credits, « Retour sur Orqea ». The Orqea link is
 * the one of THIS environment (`ARCHIPEL_ORQEA_URL`, learnt from `/healthz`).
 */
export const DEFAULT_ORQEA_URL = 'https://orqea.dev';
export const AUTHOR = { name: 'Erwann Laplante', href: 'https://github.com/ErwannL' } as const;

/** Name + « Propulsé par Orqea » / « Développé par Erwann Laplante », two distinct links. */
export function brand(doc: Document, orqeaUrl: string): HTMLElement {
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
      el(doc, 'h1', {}, 'Archipel ', el(doc, 'span', { class: 'by' }, 'by Orqea')),
      el(
        doc,
        'div',
        { class: 'credits' },
        // Same tab: Orqea's session lives in the tab (sessionStorage).
        el(doc, 'a', { href: orqeaUrl, 'data-credit': 'owner' }, 'Propulsé par Orqea'),
        el(
          doc,
          'a',
          {
            href: AUTHOR.href,
            target: '_blank',
            rel: 'noreferrer noopener',
            'aria-label': `Développé par ${AUTHOR.name} (nouvel onglet)`,
            'data-credit': 'author',
          },
          `Développé par ${AUTHOR.name}`,
        ),
      ),
    ),
  );
}

/** « Retour sur Orqea »: the session comes from Orqea, so there is no logout, we go back. */
export function backToOrqea(doc: Document, orqeaUrl: string): HTMLElement {
  return el(doc, 'a', { class: 'back', href: orqeaUrl }, '← Retour sur Orqea');
}

/** Full-page loader: the animated logo, never a spinner. */
export function loader(doc: Document): HTMLElement {
  const box = el(doc, 'div', { class: 'loader', role: 'status' });
  box.append(logo(doc, { size: 56, mode: 'loop' }), el(doc, 'span', {}, 'Chargement…'));
  return box;
}

/** 404 page (no or expired session): still branded, with the way back to Orqea. */
export function notFoundPage(doc: Document, orqeaUrl: string): HTMLElement {
  const box = el(doc, 'div', { class: 'notfound' });
  box.append(
    logo(doc, { size: 64, title: 'Archipel' }),
    el(doc, 'p', {}, '404 — introuvable'),
    el(
      doc,
      'p',
      { class: 'empty' },
      'Ouvrez la mémoire d’un board depuis Orqea : le lien est valable une minute.',
    ),
    backToOrqea(doc, orqeaUrl),
    brand(doc, orqeaUrl),
  );
  return box;
}
