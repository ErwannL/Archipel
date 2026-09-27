import { randomBytes } from 'node:crypto';
import { signRequest } from '../src/security/hmac.js';
import { signHs256 } from '../src/security/jwt.js';

export interface OrqeaSecrets {
  baseUrl: string;
  hmacSecret: string;
  handoffSecret: string;
}

/** What Orqea does to call Archipel: HMAC-sign every request. */
export class ArchipelClient {
  constructor(
    private readonly s: OrqeaSecrets,
    private readonly fetchFn: typeof fetch = (...a) => fetch(...a),
  ) {}

  async call<T>(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<T> {
    const payload = body === undefined ? '' : JSON.stringify(body);
    const headers = signRequest(
      this.s.hmacSecret,
      method,
      path,
      payload,
      Math.floor(Date.now() / 1000),
      randomBytes(16).toString('hex'),
    );
    const res = await this.fetchFn(`${this.s.baseUrl}${path}`, {
      method,
      headers: {
        ...headers,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: payload }),
    });
    const json = (await res.json()) as T;
    if (res.status >= 300)
      throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(json)}`);
    return json;
  }

  /** UI link carrying a 60 s handoff token in the URL fragment. */
  handoffUrl(boardId: string, userId: string): string {
    const iat = Math.floor(Date.now() / 1000);
    const token = signHs256(this.s.handoffSecret, { userId, boardId, iat, exp: iat + 60 });
    return `${this.s.baseUrl}/#handoff=${token}`;
  }
}
