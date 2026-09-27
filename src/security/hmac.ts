import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export const SIGNATURE_HEADER = 'x-archipel-signature';
export const TIMESTAMP_HEADER = 'x-archipel-timestamp';
export const NONCE_HEADER = 'x-archipel-nonce';

/** Canonical string: `<timestamp>\n<nonce>\n<METHOD>\n<path?query>\n<sha256hex(body)>`. */
export function canonicalString(
  timestamp: string,
  nonce: string,
  method: string,
  pathWithQuery: string,
  body: string,
): string {
  const bodyHash = createHash('sha256').update(body, 'utf8').digest('hex');
  return [timestamp, nonce, method.toUpperCase(), pathWithQuery, bodyHash].join('\n');
}

export function sign(secret: string, canonical: string): string {
  return 'v1=' + createHmac('sha256', secret).update(canonical, 'utf8').digest('hex');
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export interface SignedHeaders {
  [SIGNATURE_HEADER]: string;
  [TIMESTAMP_HEADER]: string;
  [NONCE_HEADER]: string;
}

/** Helper used by clients (fake Orqea, tests) to sign a request. */
export function signRequest(
  secret: string,
  method: string,
  pathWithQuery: string,
  body: string,
  nowSeconds: number,
  nonce: string,
): SignedHeaders {
  const ts = String(nowSeconds);
  return {
    [SIGNATURE_HEADER]: sign(secret, canonicalString(ts, nonce, method, pathWithQuery, body)),
    [TIMESTAMP_HEADER]: ts,
    [NONCE_HEADER]: nonce,
  };
}

export type VerifyResult = 'ok' | 'missing' | 'stale' | 'bad_signature';

export function verifySignature(
  secret: string,
  headers: Record<string, string | string[] | undefined>,
  method: string,
  pathWithQuery: string,
  body: string,
  nowSeconds: number,
  windowSeconds: number,
): VerifyResult {
  const sig = headers[SIGNATURE_HEADER];
  const ts = headers[TIMESTAMP_HEADER];
  const nonce = headers[NONCE_HEADER];
  if (typeof sig !== 'string' || typeof ts !== 'string' || typeof nonce !== 'string') {
    return 'missing';
  }
  if (!/^\d{1,12}$/.test(ts) || !/^[A-Za-z0-9_-]{16,128}$/.test(nonce)) return 'missing';
  if (Math.abs(nowSeconds - Number(ts)) > windowSeconds) return 'stale';
  const expected = sign(secret, canonicalString(ts, nonce, method, pathWithQuery, body));
  return safeEqual(expected, sig) ? 'ok' : 'bad_signature';
}
