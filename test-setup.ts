// Test setup file for vitest
// Configure global test environment

// Set test environment variables BEFORE any imports
process.env.NODE_ENV = 'test';
process.env.DATABASE_PATH = ':memory:';
process.env.LOG_LEVEL = 'error';

// Import and initialize the database schema
import { initializeDb, closeDb } from '@coachartie/shared';

// Initialize the in-memory database with schema
initializeDb(':memory:');

// Clean up after all tests
afterAll(() => {
  closeDb();
});
