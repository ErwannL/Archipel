import pg from 'pg';
import { migrateControl } from '../src/store/control.js';
import { TEST_DATABASE_URL } from './helpers/env.js';

/** Starts every run from an empty test database (islands, roles, control rows). */
export default async function setup(): Promise<void> {
  const pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
  try {
    await migrateControl(pool);
    const r = await pool.query<{ schema_name: string }>('SELECT schema_name FROM archipel.islands');
    for (const { schema_name: name } of r.rows) {
      await pool.query(`SET ROLE ${name}; DROP SCHEMA IF EXISTS ${name} CASCADE; RESET ROLE`);
      await pool.query(`DROP ROLE IF EXISTS ${name}`);
    }
    await pool.query(
      'TRUNCATE archipel.islands, archipel.board_tombstones, archipel.erased_users, archipel.jobs, archipel.nonces, archipel.used_handoffs CASCADE',
    );
  } finally {
    await pool.end();
  }
}
