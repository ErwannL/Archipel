import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { boardGraph, entityDetail } from '../query/explore.js';
import { query } from '../query/query.js';
import { boardStatus } from '../query/status.js';
import { claimHandoff } from '../store/control.js';
import { islandCounts, islandExists } from '../store/islands.js';
import { verifyHandoff } from '../security/jwt.js';
import {
  decodeSession,
  encodeSession,
  readCookie,
  SESSION_COOKIE,
  type Session,
} from '../security/session.js';
import { HttpError, type AppContext } from './context.js';

const NOT_FOUND = new HttpError(404, 'not_found');

/**
 * Human UI API. No accounts: a 60 s single-use handoff JWT signed by Orqea is
 * exchanged for a short session cookie bound to ONE board. Every UI endpoint
 * takes the board from the session only; anything without a valid session is 404.
 */
export function uiRoutes(ctx: AppContext) {
  const now = ctx.now ?? Date.now;
  const seconds = () => Math.floor(now() / 1000);
  const cookieFlags = `Path=/ui; HttpOnly; SameSite=Strict${ctx.config.COOKIE_SECURE === 'true' ? '; Secure' : ''}`;

  function session(req: FastifyRequest): Session {
    const raw = readCookie(req.headers.cookie, SESSION_COOKIE);
    const s = decodeSession(ctx.config.ARCHIPEL_SESSION_SECRET, raw, seconds());
    if (!s) throw NOT_FOUND;
    return s;
  }

  const setCookie = (reply: FastifyReply, value: string, maxAge: number) =>
    reply.header('set-cookie', `${SESSION_COOKIE}=${value}; ${cookieFlags}; Max-Age=${maxAge}`);

  return function plugin(app: FastifyInstance): Promise<void> {
    app.post('/ui/session', async (req, reply) => {
      const body = z.object({ token: z.string().max(4096) }).safeParse(req.body);
      const claims = body.success
        ? verifyHandoff(ctx.config.ARCHIPEL_HANDOFF_SECRET, body.data.token, seconds())
        : null;
      if (!claims) throw NOT_FOUND;
      const hash = createHash('sha256').update(body.data!.token).digest('hex');
      if (!(await claimHandoff(ctx.pool, hash, 120))) throw NOT_FOUND;
      const exp = seconds() + ctx.config.SESSION_TTL_SECONDS;
      const value = encodeSession(ctx.config.ARCHIPEL_SESSION_SECRET, {
        boardId: claims.boardId,
        userId: claims.userId,
        exp,
      });
      setCookie(reply, value, ctx.config.SESSION_TTL_SECONDS);
      return { boardId: claims.boardId, expiresAt: exp };
    });

    app.delete('/ui/session', async (_req, reply) => {
      setCookie(reply, '', 0);
      return { ok: true };
    });

    app.get('/ui/api/overview', async (req) => {
      const { boardId } = session(req);
      const [status, counts, exists] = await Promise.all([
        boardStatus(ctx.pool, boardId),
        islandCounts(ctx.pool, boardId),
        islandExists(ctx.pool, boardId),
      ]);
      return { boardId, exists, status, counts };
    });

    app.get('/ui/api/graph', async (req) => {
      return boardGraph(ctx.pool, session(req).boardId, 400);
    });

    app.get('/ui/api/entities/:entityId', async (req) => {
      const { boardId } = session(req);
      const detail = await entityDetail(
        ctx.pool,
        boardId,
        (req.params as { entityId: string }).entityId,
      );
      if (!detail) throw NOT_FOUND;
      return detail;
    });

    app.post('/ui/api/search', async (req) => {
      const { boardId } = session(req);
      const { question } = z.object({ question: z.string().min(1).max(2000) }).parse(req.body);
      if (!(await islandExists(ctx.pool, boardId))) {
        return {
          passages: [],
          graph: { nodes: [], edges: [] },
          guidelineLinks: [],
          citations: [],
          usedChars: 0,
          truncated: false,
        };
      }
      return query(ctx.pool, ctx.provider, boardId, { question, maxChars: 20000, topK: 10 });
    });
    return Promise.resolve();
  };
}
