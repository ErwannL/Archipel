import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { canonicalString, sign, signRequest, verifySignature } from '../src/security/hmac.js';
import { signHs256, verifyHandoff } from '../src/security/jwt.js';
import { RateLimiter } from '../src/security/ratelimit.js';
import { decodeSession, encodeSession, readCookie } from '../src/security/session.js';
import { TEST_ENV } from './helpers/env.js';

const SECRET = 'k'.repeat(40);

describe('HMAC', () => {
  it('matches the worked example of docs/CONTRACT.md', () => {
    const body = '{"events":[]}';
    const canonical = canonicalString(
      '1700000000',
      '3f2a9c1e5b7d4f60a8e2c4b6d8f0a1b3',
      'POST',
      '/v1/events',
      body,
    );
    expect(canonical).toBe(
      '1700000000\n3f2a9c1e5b7d4f60a8e2c4b6d8f0a1b3\nPOST\n/v1/events\n24de1c4a19c43ad41b013f13dcd858c17b0daa7f33a53f19913e5b11366d1c2e',
    );
    expect(sign('example-hmac-secret-please-change-0123456789', canonical)).toBe(
      'v1=6c662205c14ce6357926aebc494b867935a2027820176391be83d3046db2679f',
    );
  });

  it('verifies and rejects each malformed input', () => {
    const h = signRequest(SECRET, 'GET', '/p', '', 100, 'abcdefghijklmnop');
    expect(verifySignature(SECRET, { ...h }, 'GET', '/p', '', 100, 300)).toBe('ok');
    expect(verifySignature(SECRET, {}, 'GET', '/p', '', 100, 300)).toBe('missing');
    expect(
      verifySignature(SECRET, { ...h, 'x-archipel-timestamp': 'abc' }, 'GET', '/p', '', 100, 300),
    ).toBe('missing');
    expect(
      verifySignature(SECRET, { ...h, 'x-archipel-nonce': 'short' }, 'GET', '/p', '', 100, 300),
    ).toBe('missing');
    expect(verifySignature(SECRET, { ...h }, 'GET', '/p', '', 1000, 300)).toBe('stale');
    expect(
      verifySignature(SECRET, { ...h, 'x-archipel-signature': 'v1=00' }, 'GET', '/p', '', 100, 300),
    ).toBe('bad_signature');
  });
});

describe('handoff JWT', () => {
  it('matches the worked example of docs/CONTRACT.md', () => {
    const token =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOiJ1LTQyIiwiYm9hcmRJZCI6ImItNyIsImlhdCI6MTcwMDAwMDAwMCwiZXhwIjoxNzAwMDAwMDYwfQ.SHYJeYfQlLNN6loQxu7fa9sSXGprmbhEZxcYbL-J8dk';
    expect(verifyHandoff('example-handoff-secret-please-change-01234', token, 1700000030)).toEqual({
      userId: 'u-42',
      boardId: 'b-7',
      iat: 1700000000,
      exp: 1700000060,
    });
  });
  const now = 1_000_000;
  const claims = { userId: 'u', boardId: 'b', iat: now, exp: now + 60 };
  it('accepts a valid token', () => {
    expect(verifyHandoff(SECRET, signHs256(SECRET, claims), now)).toEqual(claims);
  });
  it('rejects wrong secret, structure, alg, claims and timing', () => {
    const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const withHeader = (head: string, body: string) => {
      return `${head}.${body}.${createHmac('sha256', SECRET).update(`${head}.${body}`).digest('base64url')}`;
    };
    expect(verifyHandoff('x'.repeat(40), signHs256(SECRET, claims), now)).toBeNull();
    expect(verifyHandoff(SECRET, 'a.b', now)).toBeNull();
    expect(verifyHandoff(SECRET, withHeader(b64({ alg: 'none' }), b64(claims)), now)).toBeNull();
    expect(verifyHandoff(SECRET, withHeader('!!!', b64(claims)), now)).toBeNull();
    expect(verifyHandoff(SECRET, signHs256(SECRET, { ...claims, boardId: 7 }), now)).toBeNull();
    expect(verifyHandoff(SECRET, signHs256(SECRET, claims), now + 120)).toBeNull();
    expect(verifyHandoff(SECRET, signHs256(SECRET, claims), now - 60)).toBeNull();
    expect(
      verifyHandoff(SECRET, signHs256(SECRET, { ...claims, exp: now + 3600 }), now),
    ).toBeNull();
    expect(
      verifyHandoff(SECRET, signHs256(SECRET, { ...claims, exp: now - 1, iat: now }), now),
    ).toBeNull();
  });
});

describe('session cookie', () => {
  it('round-trips and rejects tampering or expiry', () => {
    const v = encodeSession(SECRET, { boardId: 'b', userId: 'u', exp: 50 });
    expect(decodeSession(SECRET, v, 10)).toEqual({ boardId: 'b', userId: 'u', exp: 50 });
    expect(decodeSession(SECRET, v, 50)).toBeNull();
    expect(decodeSession(SECRET, undefined, 10)).toBeNull();
    expect(decodeSession(SECRET, `${v}.x`, 10)).toBeNull();
    expect(decodeSession('z'.repeat(40), v, 10)).toBeNull();
    const forged = Buffer.from('{"b":1}').toString('base64url');
    const mac = createHmac('sha256', SECRET).update(`session.${forged}`).digest('base64url');
    expect(decodeSession(SECRET, `${forged}.${mac}`, 10)).toBeNull();
  });
  it('reads a cookie among others', () => {
    expect(readCookie('a=1; archipel_session=xyz; b=2', 'archipel_session')).toBe('xyz');
    expect(readCookie('novalue; =x', 'archipel_session')).toBeUndefined();
    expect(readCookie(undefined, 'archipel_session')).toBeUndefined();
  });
});

describe('rate limiter', () => {
  it('resets each minute', () => {
    let t = 0;
    const rl = new RateLimiter(1, () => t);
    expect(rl.hit('a')).toBe(true);
    expect(rl.hit('a')).toBe(false);
    t = 60_000;
    expect(rl.hit('a')).toBe(true);
  });
  it('defaults to the wall clock', () => {
    expect(new RateLimiter(1).hit('a')).toBe(true);
  });
});

describe('config', () => {
  it('parses the test env with defaults', () => {
    const c = loadConfig(TEST_ENV);
    expect(c.AI_PROVIDER).toBe('fake');
  });
  it('names invalid variables without leaking values', () => {
    const secret = 'short-secret-value';
    expect(() => loadConfig({ ...TEST_ENV, ARCHIPEL_HMAC_SECRET: secret })).toThrow(
      /ARCHIPEL_HMAC_SECRET/,
    );
    try {
      loadConfig({ ...TEST_ENV, ARCHIPEL_HMAC_SECRET: secret });
    } catch (e) {
      expect(String(e)).not.toContain(secret);
    }
    expect(() =>
      loadConfig({ ...TEST_ENV, ARCHIPEL_HANDOFF_SECRET: TEST_ENV.ARCHIPEL_HMAC_SECRET! }),
    ).toThrow(/must differ/);
    expect(() => loadConfig({ ...TEST_ENV, AI_PROVIDER: 'openai' })).toThrow(/OPENAI_API_KEY/);
    // frame-ancestors is written into the CSP: nothing but origins may get in.
    for (const bad of ["http://a; script-src 'unsafe-inline'", '*', "'self'", 'javascript:x'])
      expect(() => loadConfig({ ...TEST_ENV, ARCHIPEL_FRAME_ANCESTORS: bad })).toThrow(
        /ARCHIPEL_FRAME_ANCESTORS/,
      );
    expect(
      loadConfig({ ...TEST_ENV, ARCHIPEL_FRAME_ANCESTORS: 'https://x.dev:8443' })
        .ARCHIPEL_FRAME_ANCESTORS,
    ).toBe('https://x.dev:8443');
    expect(
      loadConfig({ ...TEST_ENV, AI_PROVIDER: 'openai', OPENAI_API_KEY: 'k' }).AI_PROVIDER,
    ).toBe('openai');
  });
});
