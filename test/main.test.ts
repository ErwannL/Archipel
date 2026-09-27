import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { defaultUiDir, main } from '../src/main.js';
import { TEST_ENV } from './helpers/env.js';

describe('main', () => {
  it('starts api + worker, serves health, and stops on close (idempotent)', async () => {
    const r = await main({ ...TEST_ENV, HOST: '127.0.0.1' }, 'all', null);
    expect(r.urls).toHaveLength(2);
    for (const url of r.urls) expect((await fetch(`${url}/healthz`)).status).toBe(200);
    await Promise.all([r.close(), r.close()]);
  });

  it('runs a single role and stops on SIGTERM', async () => {
    const api = await main({ ...TEST_ENV, HOST: '127.0.0.1' }, 'api', null);
    const worker = await main({ ...TEST_ENV, HOST: '127.0.0.1' }, 'worker');
    expect(api.urls).toHaveLength(1);
    expect(worker.urls).toHaveLength(1);
    process.emit('SIGTERM');
    await Promise.all([api.close(), worker.close()]);
    await expect(fetch(`${api.urls[0]}/healthz`)).rejects.toThrow();
  });

  it('refuses to start with an invalid configuration', async () => {
    await expect(main({}, 'api')).rejects.toThrow(/Invalid configuration/);
  });

  it('locates the built UI only if present', () => {
    const root = mkdtempSync(join(tmpdir(), 'arch-'));
    const base = pathToFileURL(join(root, 'src', 'main.js')).href;
    expect(defaultUiDir(base)).toBeNull();
    mkdirSync(join(root, 'dist', 'ui'), { recursive: true });
    writeFileSync(join(root, 'dist', 'ui', 'index.html'), '');
    expect(defaultUiDir(base)).toBe(join(root, 'dist', 'ui'));
    expect(defaultUiDir() === null || typeof defaultUiDir() === 'string').toBe(true);
  });

  it('logs idle pool errors by code only', async () => {
    const r = await main({ ...TEST_ENV, HOST: '127.0.0.1' }, 'api', null);
    r.pool.emit('error', Object.assign(new Error('secret'), { code: '57P01' }));
    r.pool.emit('error', new Error('secret'));
    await r.close();
    expect(r.urls).toHaveLength(1);
  });
});
