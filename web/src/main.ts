import type { Api } from './api.js';
import { DEFAULT_ORQEA_URL, loader, notFoundPage } from './brand.js';
import { clear } from './dom.js';
import type { GraphRenderer } from './graph.js';
import { renderApp } from './views.js';

/**
 * Reads `#handoff=<jwt>` from the URL fragment (never sent to any server by the
 * browser), removes it from the address bar at once, exchanges it for a session
 * cookie, then renders the board. Without a valid token or session: 404.
 */
export async function boot(
  win: Window,
  api: Api,
  draw: GraphRenderer,
): Promise<'app' | 'notfound'> {
  const root = win.document.getElementById('app')!;
  clear(root, loader(win.document));
  const token = new URLSearchParams(win.location.hash.slice(1)).get('handoff');
  if (token !== null) win.history.replaceState(null, '', win.location.pathname);
  const orqeaUrl = (await api.orqeaUrl()) ?? DEFAULT_ORQEA_URL;
  const notFound = () => {
    clear(root, notFoundPage(win.document, orqeaUrl));
    return 'notfound' as const;
  };
  if (token !== null && !(await api.session(token))) return notFound();
  const overview = await api.overview().catch(() => null);
  if (overview === null) return notFound();
  await renderApp(root, api, overview, draw, orqeaUrl);
  return 'app';
}
