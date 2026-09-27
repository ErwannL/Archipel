import { EventEmitter } from 'node:events';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import pino from 'pino';
import { FakeProvider } from '../src/ai/fake.js';
import { Worker } from '../src/processing/worker.js';
import { ArchipelClient } from '../fake-orqea/client.js';
import { openInBrowser, runDemo, runDemoCli } from '../fake-orqea/demo.js';
import { config, testApp } from './helpers/app.js';
import { testPool } from './helpers/db.js';
import { TEST_ENV } from './helpers/env.js';

const pool = testPool();
let app: FastifyInstance;
let baseUrl: string;
const worker = new Worker(pool, new FakeProvider(), pino({ level: 'silent' }), {
  pollMs: 10,
  maxAttempts: 3,
  backoffBaseMs: 1,
});
const secrets = () => ({
  baseUrl,
  hmacSecret: config.ARCHIPEL_HMAC_SECRET,
  handoffSecret: config.ARCHIPEL_HANDOFF_SECRET,
});

beforeAll(async () => {
  await pool.query('DELETE FROM archipel.jobs');
  app = await testApp(pool);
  baseUrl = await app.listen({ host: '127.0.0.1', port: 0 });
  worker.start();
});
afterAll(async () => {
  await worker.stop();
  await app.close();
  await pool.end();
});

describe('fake Orqea demo (end to end over HTTP)', () => {
  it('pushes the demo board, queries it, proves isolation and deletion, opens the UI', async () => {
    const lines: string[] = [];
    const open = vi.fn();
    const r = await runDemo({
      ...secrets(),
      boardId: 'demo-test',
      log: (l) => lines.push(l),
      open,
    });
    expect(r.status.progress).toBe(1);
    expect(r.status.cards.map((c) => c.cardId)).toEqual(['c-101', 'c-102', 'c-103']);
    expect(r.answer.citations.length).toBeGreaterThan(0);
    const types = r.answer.guidelineLinks.map((l) => l.type);
    expect(types).toEqual(expect.arrayContaining(['applies', 'contradicts']));
    expect(JSON.stringify(r.leakCheck)).not.toContain('ornithorynque');
    expect(Object.values(r.deletion.after).every((n) => n === 0)).toBe(true);
    expect(r.deletion.before.items).toBe(1);
    expect(open).toHaveBeenCalledWith(r.uiUrl);
    expect(lines.join('\n')).toContain('ne fuit pas');

    const token = r.uiUrl.split('#handoff=')[1]!;
    const session = await fetch(`${baseUrl}/ui/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    expect(await session.json()).toMatchObject({ boardId: 'demo-test' });
  });

  it('works with defaults (generated board id, silent log, no browser)', async () => {
    const r = await runDemo(secrets());
    expect(r.boardId).toMatch(/^demo-\d+$/);
  });
});

describe('demo failure paths', () => {
  const stub = (responses: Record<string, unknown>) =>
    ({
      call: (method: string, path: string) => {
        const key = Object.keys(responses).find((k) => `${method} ${path}`.includes(k))!;
        return Promise.resolve(responses[key]);
      },
      handoffUrl: () => 'http://x/#handoff=t',
    }) as unknown as ArchipelClient;

  it('times out when indexing never finishes', async () => {
    const client = stub({
      '/v1/events': { results: [] },
      '/facts': {},
      '/status': { progress: 0.5, totals: {}, cards: [] },
    });
    await expect(runDemo({ ...secrets(), timeoutMs: 250 }, client)).rejects.toThrow(
      'indexing not finished after 250 ms',
    );
  });

  it('reports a leak if one ever happened', async () => {
    const q = {
      passages: [],
      graph: { nodes: [], edges: [] },
      guidelineLinks: [],
      citations: [],
      usedChars: 0,
      leaked: 'ornithorynque',
    };
    const client = stub({
      '/v1/events': { results: [] },
      '/facts': {},
      '/status': { progress: 1, totals: {}, cards: [] },
      '/query': q,
      DELETE: { before: {}, after: {} },
    });
    const lines: string[] = [];
    await runDemo({ ...secrets(), log: (l) => lines.push(l) }, client);
    expect(lines.join('\n')).toContain('FUIT');
  });
});

describe('client', () => {
  it('surfaces HTTP errors with status and error code', async () => {
    const client = new ArchipelClient({ ...secrets(), hmacSecret: 'w'.repeat(40) });
    await expect(client.call('GET', '/v1/boards/x/status')).rejects.toThrow(
      'GET /v1/boards/x/status → 401 {"error":"signature_bad_signature"}',
    );
  });
});

describe('openInBrowser', () => {
  it('uses the platform opener and ignores a missing one', () => {
    const calls: string[] = [];
    const run = ((cmd: string) => {
      calls.push(cmd);
      const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
      setImmediate(() => child.emit('error', new Error('ENOENT')));
      return child;
    }) as never;
    for (const p of ['darwin', 'win32', 'linux'] as const) openInBrowser('http://x', p, run);
    expect(calls).toEqual(['open', 'explorer', 'xdg-open']);
  });
});

describe('runDemoCli', () => {
  it('requires the secrets', async () => {
    await expect(runDemoCli({})).rejects.toThrow('ARCHIPEL_HMAC_SECRET is required');
  });

  it('runs against ARCHIPEL_URL or the default port, printing to stdout by default', async () => {
    const out: string[] = [];
    const port = new URL(baseUrl).port;
    const env = { ...TEST_ENV, DEMO_OPEN: '0' };
    const r = await runDemoCli({ ...env, ARCHIPEL_URL: baseUrl }, (l) => out.push(l));
    expect(r.status.progress).toBe(1);
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await runDemoCli({ ...env, ARCHIPEL_PORT: port });
    expect(write).toHaveBeenCalled();
    write.mockRestore();
    await expect(
      runDemoCli({ ...env, ARCHIPEL_PORT: undefined, DEMO_OPEN: '0' }, () => undefined),
    ).rejects.toThrow();
  });

  it('opens the browser unless DEMO_OPEN=0', async () => {
    const spawn = vi.fn(() => Object.assign(new EventEmitter(), { unref: vi.fn() }));
    vi.doMock('node:child_process', () => ({ spawn }));
    vi.resetModules();
    const mod = await import('../fake-orqea/demo.js');
    await mod.runDemoCli({ ...TEST_ENV, ARCHIPEL_URL: baseUrl }, () => undefined);
    expect(spawn).toHaveBeenCalledOnce();
    vi.doUnmock('node:child_process');
  });
});
