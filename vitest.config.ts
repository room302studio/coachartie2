import { defineConfig } from 'vitest/config';

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
