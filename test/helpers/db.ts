import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { TEST_DATABASE_URL } from './env.js';

export function testPool(): pg.Pool {
  return new pg.Pool({ connectionString: TEST_DATABASE_URL, max: 5 });
}

/** A fresh board id, unique per test, so tests never share an island. */
export function newBoardId(prefix = 'board'): string {
  return `${prefix}-${randomUUID()}`;
}
