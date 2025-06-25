import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  test: {
    // Global test configuration
    globals: true,
    environment: 'node',
    
    // Test timeout settings
    testTimeout: 10000, // 10 seconds for integration tests
    hookTimeout: 15000, // 15 seconds for setup/teardown
    
    // Test file patterns
    include: [
      'packages/**/src/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}',
      'packages/**/tests/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'
    ],
    
    // Exclude patterns
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/.turbo/**',
      'mcp-servers/**'
    ],
    
    // Test setup
    setupFiles: ['./test-setup.ts'],
    
    // Coverage configuration
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
        '**/test-setup.ts'
      ]
    },
    
    // Reporter configuration
    reporter: ['verbose', 'json'],
    
    // Retry failed tests
    retry: 1,
    
    // Run tests in sequence for integration tests
    sequence: {
      concurrent: false // Disable for Redis/integration tests
    }
  },
  
  // Resolve configuration for monorepo
  resolve: {
    alias: {
      '@coachartie/shared': resolve(__dirname, 'packages/shared/src'),
      '@coachartie/capabilities': resolve(__dirname, 'packages/capabilities/src'),
      '@coachartie/discord': resolve(__dirname, 'packages/discord/src'),
      '@coachartie/email': resolve(__dirname, 'packages/email/src'),
      '@coachartie/sms': resolve(__dirname, 'packages/sms/src'),
    }
  }
});