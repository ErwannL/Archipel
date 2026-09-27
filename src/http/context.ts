import type pg from 'pg';
import type { ModelProvider } from '../ai/provider.js';
import type { Config } from '../config.js';

export interface AppContext {
  config: Config;
  pool: pg.Pool;
  provider: ModelProvider;
  /** Directory of the built UI (index.html + assets), or null to not serve it. */
  uiDir: string | null;
  now?: () => number;
}

/** Error with an HTTP status and a stable machine code (never user content). */
export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
  ) {
    super(code);
  }
}
