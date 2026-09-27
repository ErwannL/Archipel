import { createHmac } from 'node:crypto';
import { z } from 'zod';
import { safeEqual } from './hmac.js';

const b64url = (buf: Buffer | string): string => Buffer.from(buf).toString('base64url');

export function signHs256(secret: string, payload: object): string {
  const head = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(payload));
  const sig = createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}

const headerSchema = z.object({ alg: z.literal('HS256') });

export const handoffSchema = z.object({
  userId: z.string().min(1).max(128),
  boardId: z.string().min(1).max(128),
  iat: z.number().int(),
  exp: z.number().int(),
});

export type Handoff = z.infer<typeof handoffSchema>;

function decodeJson(part: string): unknown {
  try {
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

/**
 * Verifies an Orqea handoff token: HS256 only, valid signature, `iat` not in the
 * future, `exp` in the future and at most `maxLifetime` seconds after `iat`.
 */
export function verifyHandoff(
  secret: string,
  token: string,
  nowSeconds: number,
  maxLifetime = 60,
  skew = 5,
): Handoff | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [head, body, sig] = parts as [string, string, string];
  const expected = createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url');
  if (!safeEqual(expected, sig)) return null;
  if (!headerSchema.safeParse(decodeJson(head)).success) return null;
  const claims = handoffSchema.safeParse(decodeJson(body));
  if (!claims.success) return null;
  const { iat, exp } = claims.data;
  const valid =
    iat <= nowSeconds + skew && exp > nowSeconds - skew && exp > iat && exp - iat <= maxLifetime;
  return valid ? claims.data : null;
}
