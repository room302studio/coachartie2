/**
 * Owner/Admin Configuration
 *
 * EJ is the owner and always has full access.
 * Other users can gain DM access via the pairing system.
 */

import { dmPairingService } from '../services/dm-pairing.js';

// EJ's Discord user ID - the owner of Coach Artie
export const OWNER_USER_ID = '688448399879438340';

// Admin users who can access admin-only capabilities
export const ADMIN_USERS = new Set([
  OWNER_USER_ID,
]);

/**
 * Check if a user can receive proactive DMs
 * Owner always can, others need to be on allowlist
 */
export function canReceiveProactiveDMs(userId: string): boolean {
  if (userId === OWNER_USER_ID) return true;
  try {
    return dmPairingService.isAllowed('discord', userId);
  } catch {
    return false;
  }
}

/**
 * Check if a user can DM Artie for tasks
 * Owner always can, others checked against pairing allowlist
 */
export function canDMForTasks(userId: string): boolean {
  if (userId === OWNER_USER_ID) return true;
  try {
    return dmPairingService.isAllowed('discord', userId);
  } catch {
    return false;
  }
}

/**
 * Check if a user is an admin
 */
export function isAdmin(userId: string): boolean {
  return ADMIN_USERS.has(userId);
}

/**
 * Check if a user is the owner
 */
export function isOwner(userId: string): boolean {
  return userId === OWNER_USER_ID;
}

/**
 * Get the DM policy for a platform
 */
export function getDMPolicy(platform: string = 'discord'): { policy: 'pairing' | 'open' | 'closed'; codeExpiryMinutes: number } {
  try {
    return dmPairingService.getPolicy(platform);
  } catch {
    return { policy: 'pairing', codeExpiryMinutes: 60 };
  }
}
