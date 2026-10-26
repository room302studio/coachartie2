import { describe, it, expect } from 'vitest';
import { tipJarUrl } from '../../src/shared/tip-jar-config.js';

describe('tipJarUrl', () => {
  it('accepts a well-formed https URL', () => {
    expect(tipJarUrl('https://buy.stripe.com/abc123')).toBe('https://buy.stripe.com/abc123');
  });

  it('rejects http', () => {
    expect(tipJarUrl('http://buy.stripe.com/abc123')).toBeNull();
  });

  it('rejects unset / empty', () => {
    expect(tipJarUrl(undefined)).toBeNull();
    expect(tipJarUrl(null)).toBeNull();
    expect(tipJarUrl('')).toBeNull();
  });

  it('rejects malformed URLs without throwing', () => {
    expect(tipJarUrl('not a url')).toBeNull();
    expect(tipJarUrl('javascript:alert(1)')).toBeNull();
    expect(tipJarUrl('ftp://example.com/x')).toBeNull();
  });

  it('reads ARTIE_TIP_JAR_URL when called with no argument', () => {
    const prev = process.env.ARTIE_TIP_JAR_URL;
    process.env.ARTIE_TIP_JAR_URL = 'https://buy.stripe.com/env-default';
    expect(tipJarUrl()).toBe('https://buy.stripe.com/env-default');
    if (prev === undefined) {
      delete process.env.ARTIE_TIP_JAR_URL;
    } else {
      process.env.ARTIE_TIP_JAR_URL = prev;
    }
  });
});
