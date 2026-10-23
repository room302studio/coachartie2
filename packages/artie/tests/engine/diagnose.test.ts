/**
 * tools/ops/diagnose.ts analyzeError: one row per entry in its errorPatterns table (wave 11).
 * toContain, not toEqual: some inputs legitimately hit two rows ("not found" is both the
 * ENOENT row and the 404 row).
 *
 * The word-boundary describe at the bottom moved here from shared/text-helpers.test.ts (wave 10).
 */
import { describe, it, expect } from 'vitest';
import { analyzeError } from '../../src/engine/tools/ops/diagnose.js';

describe('analyzeError: every known pattern', () => {
  it.each([
    ["Error: ENOENT: no such file or directory, open '/workspace/config.json'", 'File or directory does not exist'],
    ["EACCES: permission denied, open '/etc/shadow'", 'Permission denied'],
    ['listen EADDRINUSE: address already in use :::3000', 'Port is already in use'],
    ['connect ECONNREFUSED 127.0.0.1:6379', 'Service not running or wrong port'],
    ['connect ETIMEDOUT 10.0.0.1:443', 'Operation timed out'],
    ["Error: Cannot find module 'express'", 'Missing dependency'],
    ['SyntaxError: Unexpected token } in JSON at position 4', 'Syntax error in code'],
    ["Type 'string' is not assignable to type 'number'.", 'TypeScript type error'],
    ["TypeError: Cannot read properties of undefined (reading 'x')", 'Null/undefined reference'],
    ['FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory', 'Memory exhaustion'],
    ["blocked by CORS policy: No 'Access-Control-Allow-Origin' header", 'CORS policy blocking request'],
    ['Request failed with status code 401', 'Authentication failed'],
    ['HTTP 403 Forbidden', 'Access forbidden'],
    ['GET /api/thing 404', 'Resource not found'],
    ['500 Internal Server Error', 'Server-side error'],
  ])('%s -> %s', (input, cause) => {
    const { causes, suggestions } = analyzeError(input);
    expect(causes).toContain(cause);
    expect(suggestions).toHaveLength(causes.length);
  });

  it('no pattern: generic advice', () => {
    expect(analyzeError('everything is fine').causes).toEqual(['Unknown error type']);
  });

  it('pulls file:line out of a stack trace', () => {
    const { stackInfo } = analyzeError(
      'Error: boom\n    at foo (/app/src/x.ts:12:5)\n    at bar (/app/src/y.ts:30:1)'
    );
    expect(stackInfo).toContainEqual({ file: '/app/src/x.ts', line: 12 });
    expect(stackInfo).toContainEqual({ file: '/app/src/y.ts', line: 30 });
  });
});

describe('diagnose: bare status codes need word boundaries', () => {
  it('matches a status, not a longer number', () => {
    expect(analyzeError('Request failed with status code 404').causes).toContain('Resource not found');
    expect(analyzeError('listening on port 4010').causes).not.toContain('Authentication failed');
    expect(analyzeError('order 15003 shipped').causes).not.toContain('Server-side error');
    expect(analyzeError('HTTP 403').causes).toContain('Access forbidden');
  });
});
