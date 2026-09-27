// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, createApi } from '../../web/src/api.js';
import { boot } from '../../web/src/main.js';
import { citation, renderApp, renderEntity, renderResults } from '../../web/src/views.js';
import { detail, fakeApi, overview, result } from './fixtures.js';

const ORQEA = 'http://localhost:3001/apps/return';
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  document.body.innerHTML = '<div id="app"></div>';
  window.history.replaceState(null, '', '/');
});

describe('boot (handoff in the URL fragment)', () => {
  it('exchanges the token, strips the fragment and renders the board', async () => {
    window.location.hash = '#handoff=tok.en.sig';
    const api = fakeApi();
    const draw = vi.fn();
    expect(await boot(window, api, draw)).toBe('app');
    expect(api.session).toHaveBeenCalledWith('tok.en.sig');
    expect(window.location.hash).toBe('');
    expect(document.querySelector('header')!.textContent).toContain('board b-7');
    expect(document.querySelector('.gauge')!.textContent).toContain('50 %');
    expect((document.querySelector('.fill') as HTMLElement).style.width).toBe('50%');
    expect(draw).toHaveBeenCalledOnce();
  });

  it('shows 404 for a rejected token or without session', async () => {
    window.location.hash = '#handoff=bad';
    expect(await boot(window, fakeApi({ session: () => Promise.resolve(false) }), vi.fn())).toBe(
      'notfound',
    );
    expect(document.body.textContent).toContain('404');
    expect(
      await boot(window, fakeApi({ overview: () => Promise.reject(new ApiError(404)) }), vi.fn()),
    ).toBe('notfound');
  });

  it('reuses an existing session when there is no fragment', async () => {
    const api = fakeApi();
    expect(await boot(window, api, vi.fn())).toBe('app');
    expect(api.session).not.toHaveBeenCalled();
  });
});

describe('app', () => {
  it('searches, opens entities from results, relations and graph', async () => {
    const api = fakeApi();
    let select: (id: string) => void = () => undefined;
    await renderApp(
      document.getElementById('app')!,
      api,
      overview,
      (_c, _g, onSelect) => {
        select = onSelect;
      },
      ORQEA,
    );
    const input = document.querySelector('input')!;
    const form = document.querySelector('form')!;
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    expect(api.search).not.toHaveBeenCalled();
    input.value = ' paiements ';
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    await flush();
    expect(api.search).toHaveBeenCalledWith('paiements');
    expect(document.body.textContent).toContain('applies → consignes « d1 » § Paiements');
    (document.querySelector('.chip') as HTMLButtonElement).click();
    await flush();
    expect(api.entity).toHaveBeenCalledWith('1');
    expect(document.body.textContent).toContain('→ depends_on Redis');
    expect(document.body.textContent).toContain('← uses Front');
    expect(document.body.innerHTML).toContain('&lt;b&gt;pas du HTML&lt;/b&gt;');
    const rel = [...document.querySelectorAll('.chip')].find(
      (b) => b.textContent === '→ depends_on Redis',
    ) as HTMLButtonElement;
    rel.click();
    await flush();
    expect(api.entity).toHaveBeenCalledWith('2');
    select('3');
    await flush();
    expect(api.entity).toHaveBeenCalledWith('3');
  });

  it('handles empty boards and empty results', async () => {
    const api = fakeApi({
      graph: () => Promise.resolve({ nodes: [], edges: [] }),
      search: () => Promise.resolve({ ...result, passages: [] }),
    });
    const empty = { ...overview, cards: [] };
    await renderApp(document.getElementById('app')!, api, empty, vi.fn(), ORQEA);
    expect(document.body.textContent).toContain('Le graphe de ce board est vide.');
    expect(document.body.textContent).toContain('Aucune carte en mémoire.');
    document.querySelector('input')!.value = 'x';
    document.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    await flush();
    expect(document.body.textContent).toContain('Rien trouvé');
  });

  it('renders entities without relations and labels citations', () => {
    const nodes = renderEntity(document, { ...detail, relations: [] }, vi.fn());
    expect(nodes.map((n) => n.textContent).join('|')).toContain('Aucune relation.');
    expect(renderResults(document, result, vi.fn())).toHaveLength(3);
    expect(citation({ kind: 'doc', docId: 'd1', cardId: null, heading: '' })).toBe(
      'consignes « d1 »',
    );
    expect(citation({ kind: 'fact', docId: null, cardId: 'c1', heading: '' })).toBe(
      'fait d’agent · carte c1',
    );
    expect(citation({ kind: 'mystery', docId: null, cardId: null, heading: '' })).toBe(
      'mystery · carte ?',
    );
  });
});

describe('api client', () => {
  it('calls same-origin JSON endpoints and maps errors', async () => {
    const calls: [string, RequestInit][] = [];
    const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
    const fetchFn = vi.fn((url: string, init: RequestInit) => {
      calls.push([url, init]);
      return Promise.resolve(
        url.includes('entities/x%2Fy') ? new Response('', { status: 404 }) : ok({ ok: 1 }),
      );
    }) as unknown as typeof fetch;
    const api = createApi(fetchFn);
    expect(await api.session('t')).toBe(true);
    expect(await api.overview()).toEqual({ ok: 1 });
    await api.graph();
    await api.search('q');
    await expect(api.entity('x/y')).rejects.toEqual(new ApiError(404));
    expect(calls.map(([u, i]) => `${i.method} ${u}`)).toEqual([
      'POST /ui/session',
      'GET /ui/api/overview',
      'GET /ui/api/graph',
      'POST /ui/api/search',
      'GET /ui/api/entities/x%2Fy',
    ]);
    expect(calls[0]![1]).toMatchObject({ credentials: 'same-origin', body: '{"token":"t"}' });
    const failing = createApi(() => Promise.resolve(new Response('', { status: 404 })));
    expect(await failing.session('t')).toBe(false);
  });

  it('defaults to the global fetch', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'));
    await createApi().graph();
    expect(spy).toHaveBeenCalledOnce();
    spy.mockRestore();
  });
});
