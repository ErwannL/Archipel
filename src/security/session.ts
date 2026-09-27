import { createHmac } from 'node:crypto';
import { z } from 'zod';
import { safeEqual } from './hmac.js';

export const SESSION_COOKIE = 'archipel_session';

const sessionSchema = z.object({ b: z.string(), u: z.string(), exp: z.number() });
export interface Session {
  boardId: string;
  userId: string;
  exp: number;
}

function mac(secret: string, data: string): string {
  return createHmac('sha256', secret).update(`session.${data}`).digest('base64url');
}

export function encodeSession(secret: string, s: Session): string {
  const data = Buffer.from(JSON.stringify({ b: s.boardId, u: s.userId, exp: s.exp })).toString(
    'base64url',
  );
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
  return { boardId: parsed.data.b, userId: parsed.data.u, exp: parsed.data.exp };
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const idx = part.indexOf('=');
    if (idx > 0 && part.slice(0, idx).trim() === name) return part.slice(idx + 1).trim();
  }
  return undefined;
}
