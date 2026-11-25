import { defineConfig } from 'vitest/config';
import { tmpdir } from 'os';
import { join } from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    testTimeout: 10000,
    hookTimeout: 15000,

    include: [
      'packages/**/src/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}',
      'packages/**/tests/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}',
    ],

    exclude: ['**/node_modules/**', '**/dist/**', '**/build/**', '**/.turbo/**', 'mcp-servers/**'],

    setupFiles: ['./test-setup.ts'],

    // Test workers log to a temp dir, never the bot's real one (getLogsDir() honors LOGS_DIR):
    // test runs on the VPS used to fill prod's error log with fake "SCHEMA VALIDATION FAILED"
    // lines from in-memory DBs (2026-11-25).
    env: {
      LOGS_DIR: join(tmpdir(), 'coachartie-test-logs'),
    },

    reporter: ['verbose', 'json'],
    retry: 1,
    passWithNoTests: true,

    sequence: {
      concurrent: false,
    },
  },

  // No more @coachartie/{shared,capabilities,discord} aliases (wave 3): those three packages
  // are gone, merged into packages/artie as one package with plain relative imports.
});
