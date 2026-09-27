import { createHmac } from 'node:crypto';
import { z } from 'zod';
import { safeEqual } from './hmac.js';

export const SESSION_COOKIE = 'archipel_session';

const sessionSchema = z.object({
  b: z.string(),
  u: z.string(),
  exp: z.number(),
  n: z.string().optional(),
});
export interface Session {
  boardId: string;
  userId: string;
  /** Board display name from the handoff, kept in the signed cookie only. */
  boardName?: string;
  exp: number;
}

function mac(secret: string, data: string): string {
  return createHmac('sha256', secret).update(`session.${data}`).digest('base64url');
}

export function encodeSession(secret: string, s: Session): string {
  const data = Buffer.from(
    JSON.stringify({ b: s.boardId, u: s.userId, exp: s.exp, n: s.boardName }),
  ).toString('base64url');
  return `${data}.${mac(secret, data)}`;
}

export function decodeSession(
  secret: string,
  raw: string | undefined,
  nowSeconds: number,
): Session | null {
  const [data, sig, extra] = (raw ?? '').split('.');
  if (!data || !sig || extra !== undefined || !safeEqual(mac(secret, data), sig)) return null;
  const parsed = sessionSchema.safeParse(JSON.parse(Buffer.from(data, 'base64url').toString()));
  if (!parsed.success || parsed.data.exp <= nowSeconds) return null;
  const { b, u, exp, n } = parsed.data;
  return { boardId: b, userId: u, exp, ...(n === undefined ? {} : { boardName: n }) };
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const idx = part.indexOf('=');
    if (idx > 0 && part.slice(0, idx).trim() === name) return part.slice(idx + 1).trim();
  }
  return undefined;
}
