/**
 * Security audit 2026-10-26 (sec-leaks.md finding #2, sec-batch2-spec.md item 5): the `http`
 * capability is owner-only (owner-only.ts), but an owner's own turn can be prompt-injected —
 * a fetched page or a linked message telling Artie to call `http:get` against an internal
 * address. http.ts used to do a raw `fetch()` with no URL validation at all, so it could reach
 * Artie's own loopback-trusted internal routes (/health/detailed, /api/memories with no
 * userId scope, …) and any other private/internal host. It now reuses web-fetch.ts's
 * validateUrl + guarded DNS lookup instead of duplicating that logic — these tests exercise
 * the handler directly (bypassing the owner-only registry gate, which is covered separately
 * in owner-only.test.ts) to prove the SSRF guard itself is wired in.
 */
import { describe, it, expect } from 'vitest';
import { httpCapability } from '../../../../src/engine/capabilities/core/http.js';

async function expectRefused(url: string): Promise<void> {
  await expect(httpCapability.handler({ action: 'get', url }, undefined)).rejects.toThrow(
    /Refused/
  );
}

describe('http capability SSRF guard', () => {
  it('refuses loopback addresses', async () => {
    await expectRefused('http://127.0.0.1:47324/api/memories');
    await expectRefused('http://[::1]:47324/health/detailed');
  });

  it('refuses the localhost domain', async () => {
    await expectRefused('http://localhost:47324/health/detailed');
  });

  it('refuses cloud-metadata and link-local addresses', async () => {
    await expectRefused('http://169.254.169.254/latest/meta-data');
  });

  it('refuses RFC1918 private ranges', async () => {
    await expectRefused('http://10.0.0.5/internal');
    await expectRefused('http://192.168.1.1/internal');
    await expectRefused('http://172.16.0.1/internal');
  });

  it('requires the url param at all', async () => {
    await expect(httpCapability.handler({ action: 'get' }, undefined)).rejects.toThrow(
      /URL parameter is required/
    );
  });
});
