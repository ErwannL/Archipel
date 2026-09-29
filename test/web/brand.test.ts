// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, createApi, type CardDetail } from '../../web/src/api.js';
import { AUTHOR, DEFAULT_ORQEA_URL, loader, notFoundPage } from '../../web/src/brand.js';
import { ISLES, logo } from '../../web/src/logo.js';
import { boot } from '../../web/src/main.js';
import { errorLabel, STALE_PENDING_MS, statusTable, STATUS_LABELS } from '../../web/src/views.js';
import { fakeApi } from './fixtures.js';

const ORQEA = 'http://localhost:3001/apps/return';

beforeEach(() => {
  document.body.innerHTML = '<div id="app"></div>';
  window.history.replaceState(null, '', '/');
});

describe('logo', () => {
  it('draws three islands, decorative by default', () => {
    const svg = logo(document);
    expect(svg.getAttribute('width')).toBe('32');
    expect(svg.getAttribute('class')).toBe('ap-logo ap-logo--static');
    expect(svg.getAttribute('aria-hidden')).toBe('true');
    expect(svg.querySelectorAll('circle')).toHaveLength(ISLES.length);
    expect(svg.querySelectorAll('line')).toHaveLength(3);
  });

  it('is an image with a name when titled, and ids never collide', () => {
    const a = logo(document, { size: 56, mode: 'loop', title: 'Archipel' });
    const b = logo(document, { mode: 'hover' });
    expect(a.getAttribute('role')).toBe('img');
    expect(a.getAttribute('aria-label')).toBe('Archipel');
    expect(a.getAttribute('class')).toContain('ap-logo--loop');
    expect(b.getAttribute('class')).toContain('ap-logo--hover');
    expect(a.querySelector('linearGradient')!.id).not.toBe(b.querySelector('linearGradient')!.id);
  });

  it('ships the same drawing as static files', () => {
    for (const f of ['favicon.svg', 'logo-animated.svg']) {
      const svg = readFileSync(`web/public/${f}`, 'utf8');
      for (const s of ISLES) expect(svg).toContain(`cx="${s.cx}" cy="${s.cy}" r="${s.r}"`);
    }
    expect(readFileSync('web/public/logo-animated.svg', 'utf8')).toContain('animateTransform');
    expect(readFileSync('web/index.html', 'utf8')).toContain('<title>Archipel by Orqea</title>');
  });
});

describe('branding in the app', () => {
  it('shows the loader first, then logo, by Orqea, credits and the way back', async () => {
    let release: () => void = () => undefined;
    const api = fakeApi({
      orqeaUrl: vi.fn(
        () =>
          new Promise<string>((r) => {
            release = () => {
              r(ORQEA);
            };
          }),
      ),
    });
    const done = boot(window, api, vi.fn());
    expect(document.querySelector('.loader .ap-logo--loop')).not.toBeNull();
    expect(document.body.textContent).toContain('Chargement…');
    release();
    expect(await done).toBe('app');
    const header = document.querySelector('header')!;
    expect(header.textContent).toContain('Archipel by Orqea');
    const owner = header.querySelector('a[data-credit=owner]')!;
    expect(owner.textContent).toBe('Propulsé par Orqea');
    expect(owner.getAttribute('href')).toBe(ORQEA);
    expect(owner.hasAttribute('target')).toBe(false);
    const author = header.querySelector('a[data-credit=author]')!;
    expect(author.getAttribute('href')).toBe(AUTHOR.href);
    expect(author.getAttribute('target')).toBe('_blank');
    expect(author.getAttribute('rel')).toBe('noreferrer noopener');
    const back = header.querySelector('a.back')!;
    expect(back.textContent).toBe('← Retour sur Orqea');
    expect(back.getAttribute('href')).toBe(ORQEA);
  });

  it('falls back to orqea.dev and keeps the 404 branded', async () => {
    const api = fakeApi({
      orqeaUrl: vi.fn(() => Promise.resolve(null)),
      overview: () => Promise.reject(new ApiError(404)),
    });
    expect(await boot(window, api, vi.fn())).toBe('notfound');
    expect(document.querySelector('.notfound a.back')!.getAttribute('href')).toBe(
      DEFAULT_ORQEA_URL,
    );
    expect(document.querySelector('.notfound svg[role=img]')).not.toBeNull();
    expect(document.body.textContent).toContain('Développé par Erwann Laplante');
  });

  it('builds loader and 404 on their own', () => {
    expect(loader(document).getAttribute('role')).toBe('status');
    const page = notFoundPage(document, ORQEA);
    expect(page.textContent).toContain('404');
    // every mark on the branded 404 animates on hover only (never the loop of the loader)
    const marks = [...page.querySelectorAll('svg')].map((s) => s.getAttribute('class'));
    expect(marks.length).toBe(2);
    for (const c of marks) expect(c).toContain('ap-logo--hover');
  });
});

describe('api.orqeaUrl', () => {
  it('reads /healthz and never throws', async () => {
    const ok = createApi(() =>
      Promise.resolve(new Response(JSON.stringify({ ok: true, orqeaUrl: ORQEA }))),
    );
    expect(await ok.orqeaUrl()).toBe(ORQEA);
    const bare = createApi(() => Promise.resolve(new Response(JSON.stringify({ ok: true }))));
    expect(await bare.orqeaUrl()).toBeNull();
    const down = createApi(() => Promise.resolve(new Response('', { status: 503 })));
    expect(await down.orqeaUrl()).toBeNull();
  });
});

describe('card status table', () => {
  const now = Date.parse('2026-09-27T12:00:00.000Z');
  const card = (over: Partial<CardDetail>): CardDetail => ({
    cardId: 'c1',
    title: 'Paiements',
    status: 'indexed',
    items: 3,
    updatedAt: '2026-09-27T11:59:00.000Z',
    errorCode: null,
    pendingSince: null,
    ...over,
  });

  it('shows title, translated status, items, date and explains the columns', () => {
    const t = statusTable(document, [card({})], now);
    expect(t.textContent).toContain('« En attente » : reçue d’Orqea');
    expect(t.querySelectorAll('th')).toHaveLength(4);
    const cells = [...t.querySelectorAll('td')].map((c) => c.textContent);
    expect(cells[0]).toBe('Paiements #c1');
    expect(cells[1]).toBe('En mémoire');
    expect(cells[2]).toBe('3');
    expect(t.querySelector('time')!.getAttribute('datetime')).toBe('2026-09-27T11:59:00.000Z');
    expect(cells[3]).toMatch(/27\/09\/2026/);
  });

  it('shows the id alone without title, the failure reason, and a stale queue', () => {
    const t = statusTable(
      document,
      [
        card({ cardId: 'a', title: '', status: 'failed', errorCode: 'model_unreachable' }),
        card({ cardId: 'b', status: 'failed', errorCode: 'model_http_503' }),
        card({
          cardId: 'c',
          status: 'pending',
          pendingSince: new Date(now - STALE_PENDING_MS - 1).toISOString(),
        }),
        card({ cardId: 'd', status: 'pending', pendingSince: new Date(now - 1000).toISOString() }),
      ],
      now,
    );
    const rows = [...t.querySelectorAll('tr')].slice(1).map((r) => r.textContent);
    expect(rows[0]).toContain('#a');
    expect(rows[0]).not.toContain('Paiements');
    expect(rows[0]).toContain('En échecmodèle injoignable');
    expect(rows[1]).toContain('model_http_503');
    expect(rows[2]).toContain('worker arrêté ?');
    expect(rows[3]).not.toContain('worker');
    expect(t.querySelector('.status-pending')).not.toBeNull();
  });

  it('labels every status and known error', () => {
    expect(Object.keys(STATUS_LABELS).sort()).toEqual([
      'failed',
      'indexed',
      'pending',
      'processing',
    ]);
    expect(errorLabel('internal_error')).toBe('erreur interne');
    expect(errorLabel('model_bad_response')).toBe('réponse du modèle illisible');
  });

  it('defaults to the current time', () => {
    expect(statusTable(document, [card({})]).querySelectorAll('tr')).toHaveLength(2);
  });
});
