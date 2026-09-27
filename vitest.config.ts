import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/global-setup.ts'],
    fileParallelism: false,
    testTimeout: 20000,
    hookTimeout: 30000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts', 'web/src/**/*.ts', 'fake-orqea/**/*.ts'],
      reporter: ['text', 'json-summary'],
      thresholds: { perFile: true, 100: true },
    },
  },
});
