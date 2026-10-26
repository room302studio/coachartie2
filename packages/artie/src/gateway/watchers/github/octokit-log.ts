import { logger } from '../../../shared/logger.js';

/**
 * Octokit's request-log plugin reports every failed request (GitHub 5xx blips,
 * expected 404s) at error level, before the caller's own handling runs. Callers
 * already log what matters, so these go in as warnings.
 */
export const octokitLog = {
  debug: () => {},
  info: () => {},
  warn: (message: string): void => {
    logger.warn(`GitHub API: ${message}`);
  },
  error: (message: string): void => {
    logger.warn(`GitHub API: ${message}`);
  },
};
