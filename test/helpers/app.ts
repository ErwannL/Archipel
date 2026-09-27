import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { FakeProvider } from '../../src/ai/fake.js';
import type { ModelProvider } from '../../src/ai/provider.js';
import { loadConfig } from '../../src/config.js';
import { buildApp } from '../../src/http/app.js';
import { signRequest } from '../../src/security/hmac.js';
import { signHs256 } from '../../src/security/jwt.js';
import { TEST_ENV } from './env.js';

export const config = loadConfig(TEST_ENV);

export async function testApp(
  pool: pg.Pool,
  opts: {
    provider?: ModelProvider;
    now?: () => number;
    uiDir?: string | null;
    env?: Record<string, string>;
  } = {},
): Promise<FastifyInstance> {
  return buildApp({
    config: opts.env ? loadConfig({ ...TEST_ENV, ...opts.env }) : config,
    pool,
    provider: opts.provider ?? new FakeProvider(),
    uiDir: opts.uiDir ?? null,
    ...(opts.now ? { now: opts.now } : {}),
  });
}

export const nonce = () => randomBytes(16).toString('hex');

/** Sends an HMAC-signed request exactly as Orqea must. */
export function signed(
  app: FastifyInstance,
  method: 'GET' | 'POST' | 'DELETE',
  url: string,
  body?: unknown,
) {
  const payload = body === undefined ? '' : JSON.stringify(body);
  const headers = signRequest(
    config.ARCHIPEL_HMAC_SECRET,
    method,
    url,
    payload,
    Math.floor(Date.now() / 1000),
    nonce(),
  );
  return app.inject({
    method,
    url,
    headers: { ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    payload,
  });
}

export function handoff(boardId: string, userId = 'u1', lifetime = 60, iatOffset = 0): string {
  const iat = Math.floor(Date.now() / 1000) + iatOffset;
  return signHs256(config.ARCHIPEL_HANDOFF_SECRET, { userId, boardId, iat, exp: iat + lifetime });
}
