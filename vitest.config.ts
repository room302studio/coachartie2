import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

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

    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        'coverage/**',
        'dist/**',
        'packages/**/node_modules/**',
        'packages/**/dist/**',
        '**/*.d.ts',
        '**/*.config.*',
        '**/test-setup.ts',
      ],
    },

    reporter: ['verbose', 'json'],
    retry: 1,
    passWithNoTests: true,

    sequence: {
      concurrent: false,
    },
  },

  resolve: {
    alias: {
      '@coachartie/shared': resolve(__dirname, 'packages/shared/src'),
      '@coachartie/capabilities': resolve(__dirname, 'packages/capabilities/src'),
      '@coachartie/discord': resolve(__dirname, 'packages/discord/src'),
      '@coachartie/email': resolve(__dirname, 'packages/email/src'),
      '@coachartie/sms': resolve(__dirname, 'packages/sms/src'),
    },
  },
});
