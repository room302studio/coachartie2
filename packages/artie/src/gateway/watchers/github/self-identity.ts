/**
 * Artie's own GitHub login.
 *
 * His token belongs to a plain user (`coachartie`), not a `[bot]` app, so the `[bot]` filter
 * never catches his own comments, labels or issues and they echo back into the feed. The
 * poller resolves the login once; the batcher reads it synchronously.
 */

import type { Octokit } from '@octokit/rest';
import { logger } from '../../../shared/logger.js';

const FALLBACK_LOGIN = 'coachartie';

let resolvedLogin: string | null = null;
let inflight: Promise<string> | null = null;

/** Synchronous read: the resolved login, or the fallback before/without resolution. */
export function getSelfLogin(): string {
  if (resolvedLogin) {
    return resolvedLogin;
  }
  return FALLBACK_LOGIN;
}

/** Resolve once via users.getAuthenticated and cache; failures fall back to 'coachartie'. */
export async function resolveSelfLogin(octokit: Octokit): Promise<string> {
  if (resolvedLogin) {
    return resolvedLogin;
  }
  if (inflight) {
    return inflight;
  }
  inflight = (async () => {
    try {
      const { data } = await octokit.users.getAuthenticated();
      if (data?.login) {
        resolvedLogin = data.login;
        return resolvedLogin;
      }
    } catch (error) {
      // Not cached on failure so the next poll retries; the fallback covers the gap.
      logger.warn('Could not resolve authenticated GitHub login, using fallback:', error);
    }
    return FALLBACK_LOGIN;
  })();
  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}

export function isSelfLogin(login: string | undefined | null): boolean {
  if (!login) {
    return false;
  }
  return login.toLowerCase() === getSelfLogin().toLowerCase();
}

/** Test hook. */
export function setSelfLoginForTests(login: string | null): void {
  resolvedLogin = login;
  inflight = null;
}
