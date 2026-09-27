import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import pg from 'pg';
import pino from 'pino';
import { createProvider } from './ai/index.js';
import { loadConfig } from './config.js';
import { buildApp } from './http/app.js';
import { Worker } from './processing/worker.js';
import { migrateControl } from './store/control.js';

export type Role = 'api' | 'worker' | 'all';

export interface Running {
  /** Base URL of the API (role api/all) or of the worker health endpoint. */
  urls: string[];
  pool: pg.Pool;
  close(): Promise<void>;
}

/** Built UI location: `<repo>/dist/ui`, resolved from this file in both src/ and dist/src/. */
export function defaultUiDir(base: string = import.meta.url): string | null {
  const candidates = ['../ui', '../dist/ui'].map((p) => fileURLToPath(new URL(p, base)));
  return candidates.find((d) => existsSync(`${d}/index.html`)) ?? null;
}

/**
 * Process entry point (the Docker image calls it; there is no other launcher).
 * `api` serves HTTP, `worker` processes the queue, `all` does both (local dev).
 */
export async function main(
  env: Record<string, string | undefined>,
  role: Role,
  uiDir: string | null = defaultUiDir(),
): Promise<Running> {
  const config = loadConfig(env);
  const log = pino({ level: config.LOG_LEVEL });
  const pool = new pg.Pool({ connectionString: config.DATABASE_URL, max: 10 });
  pool.on('error', (err) => {
    log.error({ code: (err as { code?: string }).code ?? 'pool_error' }, 'idle client error');
  });
  await migrateControl(pool);
  const provider = createProvider(config);
  const closers: (() => Promise<void>)[] = [];
  const urls: string[] = [];

  if (role !== 'worker') {
    const app = await buildApp({ config, pool, provider, uiDir });
    urls.push(await app.listen({ host: config.HOST, port: config.PORT }));
    closers.push(() => app.close());
  }
  if (role !== 'api') {
    const worker = new Worker(pool, provider, log, {
      pollMs: config.WORKER_POLL_MS,
      maxAttempts: config.JOB_MAX_ATTEMPTS,
      backoffBaseMs: config.JOB_BACKOFF_BASE_MS,
    });
    worker.start();
    const health = Fastify();
    health.get('/healthz', async () => {
      await pool.query('SELECT 1');
      return { ok: true };
    });
    urls.push(await health.listen({ host: config.HOST, port: config.WORKER_HEALTH_PORT }));
    closers.push(
      () => health.close(),
      () => worker.stop(),
    );
  }

  let closing: Promise<void> | null = null;
  const close = () => {
    closing ??= (async () => {
      process.off('SIGTERM', onSignal);
      process.off('SIGINT', onSignal);
      for (const c of closers) await c();
      await pool.end();
      log.info({ role }, 'stopped');
    })();
    return closing;
  };
  const onSignal = () => void close();
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);
  log.info({ role, provider: provider.id }, 'started');
  return { urls, pool, close };
}
