import { beforeAll, afterAll } from 'vitest';

// Global test setup
beforeAll(async () => {
  // Set test environment variables
  process.env.NODE_ENV = 'test';
  process.env.LOG_LEVEL = 'silent'; // Reduce logging noise in tests
  
  // Mock external dependencies if needed
  // Example: Mock Redis in CI environments where Redis isn't available
  if (process.env.CI && !process.env.REDIS_URL) {
    console.log('⚠️  Running in CI without Redis - some integration tests may be skipped');
  }
  
  console.log('🧪 Test environment initialized');
});

afterAll(async () => {
  // Global cleanup
  console.log('🧹 Test environment cleaned up');
});