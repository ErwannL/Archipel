export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  'postgres://archipel_app:change-me-archipel-app@127.0.0.1:5433/archipel_test';

export const TEST_ENV: Record<string, string> = {
  DATABASE_URL: TEST_DATABASE_URL,
  ARCHIPEL_HMAC_SECRET: 'test-hmac-secret-0123456789abcdef0123456789',
  ARCHIPEL_HANDOFF_SECRET: 'test-handoff-secret-0123456789abcdef012345',
  ARCHIPEL_SESSION_SECRET: 'test-session-secret-0123456789abcdef012345',
  LOG_LEVEL: 'silent',
  PORT: '0',
  WORKER_HEALTH_PORT: '0',
  WORKER_POLL_MS: '20',
  JOB_BACKOFF_BASE_MS: '10',
};
