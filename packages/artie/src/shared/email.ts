import { z } from 'zod';

/**
 * The one email-format check (wave 10, ledger Group 2). Four sites had four slightly different
 * regexes (email.ts's accepted addresses user-profile.ts's rejected); they all use zod's now.
 */
const emailSchema = z.string().email();

export function isEmail(value: unknown): boolean {
  return emailSchema.safeParse(value).success;
}
