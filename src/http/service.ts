import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { eraseUser } from '../erase/user.js';
import { id, eventSchema, toOperation, type Operation } from '../ingest/events.js';
import { applyOperation } from '../ingest/apply.js';
import { query } from '../query/query.js';
import { boardStatus, cardStatus, retryable } from '../query/status.js';
import { claimNonce } from '../store/control.js';
import { dropIsland, islandCounts, islandExists } from '../store/islands.js';
import { enqueue } from '../store/jobs.js';
import { NONCE_HEADER, verifySignature } from '../security/hmac.js';
import { RateLimiter } from '../security/ratelimit.js';
import { HttpError, type AppContext } from './context.js';

const boardParams = z.object({ boardId: id });
const version = z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

const eventsBody = z.object({ events: z.array(z.unknown()).min(1).max(100) });
const queryBody = z
  .object({
    question: z.string().min(1).max(2000),
    maxChars: z.number().int().min(500).max(200000).optional(),
    maxTokens: z.number().int().min(125).max(50000).optional(),
    topK: z.number().int().min(1).max(50).default(8),
    cardId: id.optional(),
  })
  .refine((q) => q.maxChars === undefined || q.maxTokens === undefined, {
    message: 'maxChars and maxTokens are exclusive',
    path: ['maxTokens'],
  });
const factsBody = z.object({
  cardId: id,
  agentId: id.optional(),
  authorId: id.optional(),
  authorName: z.string().max(200).optional(),
  version: version.optional(),
  facts: z
    .array(z.object({ factId: id, text: z.string().min(1).max(4000) }))
    .min(1)
    .max(50),
});
const versionQuery = z.object({ version: version.optional() });

export function serviceRoutes(ctx: AppContext) {
  const now = ctx.now ?? Date.now;
  const limiter = new RateLimiter(ctx.config.RATE_LIMIT_PER_MINUTE, now);
  const window = ctx.config.SIGNATURE_WINDOW_SECONDS;

  async function authenticate(req: FastifyRequest): Promise<void> {
    const verdict = verifySignature(
      ctx.config.ARCHIPEL_HMAC_SECRET,
      req.headers,
      req.method,
      req.url,
      req.rawBody,
      Math.floor(now() / 1000),
      window,
    );
    if (verdict !== 'ok') throw new HttpError(401, `signature_${verdict}`);
    if (!(await claimNonce(ctx.pool, req.headers[NONCE_HEADER] as string, window * 2))) {
      throw new HttpError(401, 'signature_replayed');
    }
    const params = req.params as { boardId?: string };
    if (!limiter.hit(params.boardId ?? '*')) throw new HttpError(429, 'rate_limited');
  }

  return async function plugin(app: FastifyInstance): Promise<void> {
    app.addHook('preHandler', authenticate);

    app.post('/events', async (req, reply) => {
      const { events } = eventsBody.parse(req.body);
      const ops: { eventId: string; op: Operation }[] = [];
      for (const [i, raw] of events.entries()) {
        if (JSON.stringify(raw).length > ctx.config.MAX_EVENT_BYTES) {
          throw new HttpError(413, `event_too_large:${i}`);
        }
        const parsed = eventSchema.safeParse(raw);
        if (!parsed.success) throw new HttpError(400, `invalid_event:${i}`);
        ops.push({ eventId: parsed.data.eventId, op: toOperation(parsed.data) });
      }
      const results = [];
      for (const { eventId, op } of ops) {
        results.push({ eventId, outcome: await applyOperation(ctx.pool, op) });
      }
      return reply.status(202).send({ results });
    });

    app.get('/boards/:boardId/status', async (req) => {
      return boardStatus(ctx.pool, boardParams.parse(req.params).boardId);
    });

    app.get('/boards/:boardId/cards/:cardId/status', async (req) => {
      const { boardId, cardId } = z.object({ boardId: id, cardId: id }).parse(req.params);
      const status = await cardStatus(ctx.pool, boardId, cardId);
      if (!status) throw new HttpError(404, 'card_not_found');
      return { boardId, ...status };
    });

    app.get('/boards/:boardId/stats', async (req) => {
      const { boardId } = boardParams.parse(req.params);
      return {
        boardId,
        exists: await islandExists(ctx.pool, boardId),
        counts: await islandCounts(ctx.pool, boardId),
      };
    });

    app.delete('/boards/:boardId', async (req) => {
      const { boardId } = boardParams.parse(req.params);
      const v = versionQuery.parse(req.query).version ?? now();
      const before = await islandCounts(ctx.pool, boardId);
      await dropIsland(ctx.pool, boardId, v);
      const after = await islandCounts(ctx.pool, boardId);
      return {
        boardId,
        deleted: true,
        before,
        after,
        exists: await islandExists(ctx.pool, boardId),
      };
    });

    app.post('/boards/:boardId/query', async (req) => {
      const { boardId } = boardParams.parse(req.params);
      const q = queryBody.parse(req.body);
      const maxChars = q.maxChars ?? (q.maxTokens ?? 2000) * 4;
      return query(ctx.pool, ctx.provider, boardId, {
        question: q.question,
        maxChars,
        topK: q.topK,
        cardId: q.cardId,
      });
    });

    app.post('/boards/:boardId/facts', async (req, reply) => {
      const { boardId } = boardParams.parse(req.params);
      const body = factsBody.parse(req.body);
      const v = body.version ?? now();
      const results = [];
      for (const f of body.facts) {
        const outcome = await applyOperation(ctx.pool, {
          op: 'upsert',
          boardId,
          version: v,
          item: {
            key: `fact:${f.factId}`,
            kind: 'fact',
            cardId: body.cardId,
            docId: null,
            authorId: body.authorId ?? null,
            authorName: body.authorName ?? body.agentId ?? null,
            title: '',
            body: f.text,
          },
        });
        results.push({ factId: f.factId, outcome });
      }
      return reply.status(202).send({ results });
    });

    app.delete('/boards/:boardId/facts/:factId', async (req) => {
      const { boardId, factId } = z.object({ boardId: id, factId: id }).parse(req.params);
      const v = versionQuery.parse(req.query).version ?? now();
      const outcome = await applyOperation(ctx.pool, {
        op: 'delete',
        boardId,
        version: v,
        key: `fact:${factId}`,
        cardId: null,
      });
      return { factId, outcome };
    });

    app.post('/boards/:boardId/retry', async (req, reply) => {
      const { boardId } = boardParams.parse(req.params);
      const keys = await retryable(ctx.pool, boardId);
      for (const key of keys) await enqueue(ctx.pool, boardId, key);
      return reply.status(202).send({ requeued: keys.length });
    });

    app.post('/users/:userId/erase', async (req) => {
      const { userId } = z.object({ userId: id }).parse(req.params);
      const v = versionQuery.parse(req.body ?? {}).version ?? now();
      return { userId, ...(await eraseUser(ctx.pool, userId, v)) };
    });
  };
}
