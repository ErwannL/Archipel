import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { IslandNotFound } from '../store/islands.js';
import { HttpError, type AppContext } from './context.js';
import { serviceRoutes } from './service.js';
import { uiRoutes } from './ui.js';

declare module 'fastify' {
  interface FastifyRequest {
    rawBody: string;
  }
}

const SECURITY_HEADERS = {
  'content-security-policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'cache-control': 'no-store',
};

/** Maps any error to `{ error: code }`. Logs carry the code only, never a message or body. */
function toHttp(err: unknown): { status: number; body: object; log: boolean } {
  if (err instanceof HttpError)
    return { status: err.statusCode, body: { error: err.code }, log: false };
  if (err instanceof ZodError) {
    const fields = [...new Set(err.issues.map((i) => i.path.join('.')))];
    return { status: 400, body: { error: 'invalid_request', fields }, log: false };
  }
  if (err instanceof IslandNotFound)
    return { status: 404, body: { error: 'board_not_found' }, log: false };
  const e = err as { statusCode?: number; code?: string };
  if (e.statusCode === 413)
    return { status: 413, body: { error: 'payload_too_large' }, log: false };
  if (e.statusCode === 415)
    return { status: 415, body: { error: 'unsupported_media_type' }, log: false };
  return { status: 500, body: { error: 'internal_error' }, log: true };
}

export async function buildApp(ctx: AppContext): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: ctx.config.LOG_LEVEL },
    disableRequestLogging: true,
    bodyLimit: 4 * 1024 * 1024,
    trustProxy: false,
  });

  app.removeAllContentTypeParsers();
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    req.rawBody = body as string;
    try {
      done(null, body === '' ? {} : JSON.parse(body as string));
    } catch {
      done(new HttpError(400, 'invalid_json'), undefined);
    }
  });
  app.addHook('onRequest', (req, _reply, done) => {
    req.rawBody = '';
    done();
  });
  app.addHook('onSend', async (_req, reply) => {
    reply.headers(SECURITY_HEADERS);
  });
  app.addHook('onResponse', async (req, reply) => {
    // Route pattern only (e.g. /v1/boards/:boardId/query): no ids from query strings, no bodies.
    req.log.info(
      {
        method: req.method,
        route: req.routeOptions.url ?? 'unmatched',
        status: reply.statusCode,
        ms: Math.round(reply.elapsedTime),
      },
      'request',
    );
  });
  app.setErrorHandler((err, req, reply) => {
    const out = toHttp(err);
    if (out.log)
      req.log.error(
        { code: (err as { code?: string }).code ?? 'unknown', route: req.routeOptions.url },
        'unhandled',
      );
    return reply.status(out.status).send(out.body);
  });
  app.setNotFoundHandler((_req, reply) => reply.status(404).send({ error: 'not_found' }));

  app.get('/healthz', async () => {
    await ctx.pool.query('SELECT 1');
    return { ok: true };
  });
  await app.register(serviceRoutes(ctx), { prefix: '/v1' });
  await app.register(uiRoutes(ctx));
  if (ctx.uiDir !== null) {
    await app.register(fastifyStatic, { root: ctx.uiDir, index: 'index.html', wildcard: false });
  }
  return app;
}
