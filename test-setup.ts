// Test setup file for vitest
// Configure global test environment

// Set test environment variables
process.env.NODE_ENV = 'test';
process.env.DATABASE_PATH = ':memory:';

// Suppress noisy logs during tests
process.env.LOG_LEVEL = 'error';
