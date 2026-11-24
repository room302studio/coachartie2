import { describe, it, expect } from 'vitest';
import { validateUrl, isBlockedAddress, makeGuardedLookup } from '../../../../src/engine/capabilities/core/web-fetch.js';

// Wave 7 (b): the SSRF guard is a node:net BlockList, checked through validateUrl so the
// WHATWG URL hostname forms ([::ffff:a00:1], bracketed IPv6) are what gets tested.
describe('web-fetch SSRF guard', () => {
  const blocked = [
    'http://192.0.0.1/',
    'http://198.18.0.1/',
    'http://[::ffff:10.0.0.1]/',
    'http://169.254.169.254/latest/meta-data/',
    'http://[fd00::1]/',
    'http://127.0.0.1/',
    'http://[::1]/',
    'http://100.64.0.1/',
    'http://10.1.2.3/',
    'http://172.31.255.255/',
    'http://192.168.1.1/',
    'http://224.0.0.1/',
    'http://240.0.0.1/',
    'http://0.0.0.0/',
    'http://[fe80::1]/',
    'http://2130706433/', // 127.0.0.1 as a bare integer; URL normalizes it
    'http://localhost:8080/',
  ];
  for (const url of blocked) {
    it(`blocks ${url}`, () => {
      expect(validateUrl(url).isValid).toBe(false);
    });
  }

  const allowed = [
    'http://8.8.8.8/',
    'https://1.1.1.1/',
    'https://example.com/page',
    'http://172.32.0.1/', // just outside 172.16/12
    'http://[2606:4700:4700::1111]/',
  ];
  for (const url of allowed) {
    it(`allows ${url}`, () => {
      expect(validateUrl(url).isValid).toBe(true);
    });
  }

  it('unwraps IPv4-mapped IPv6 in both dotted and hex form', () => {
    expect(isBlockedAddress('::ffff:10.0.0.1')).toBe(true);
    expect(isBlockedAddress('[::ffff:a00:1]')).toBe(true);
    expect(isBlockedAddress('::ffff:8.8.8.8')).toBe(false);
  });

  it('leaves hostnames alone (no DNS here)', () => {
    expect(isBlockedAddress('example.com')).toBe(false);
  });
});

describe('web-fetch guarded DNS lookup', () => {
  const fakeDns = (answer: unknown) => (_h: string, _o: unknown, cb: (...a: any[]) => void) =>
    cb(null, answer, 4);
  const run = (answer: unknown, options: object = {}) =>
    new Promise<Error | null>((done) => makeGuardedLookup(fakeDns(answer))('evil.example', options, (err) => done(err)));

  it('refuses a hostname that resolves to a private address', async () => {
    expect((await run('127.0.0.1'))?.message).toMatch(/private address/);
    expect((await run('169.254.169.254'))?.message).toMatch(/private address/);
  });
  it('refuses when any of all:true results is private', async () => {
    expect(await run([{ address: '8.8.8.8', family: 4 }, { address: '10.0.0.5', family: 4 }], { all: true })).toBeTruthy();
  });
  it('passes public results through', async () => {
    expect(await run('93.184.216.34')).toBeNull();
    expect(await run([{ address: '2606:4700::1', family: 6 }], { all: true })).toBeNull();
  });
});
