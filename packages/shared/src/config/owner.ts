/**
 * Owner/Admin Configuration
 *
 * EJ is the owner and always has full access.
 * Other users can gain DM access via the pairing system.
 */

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
  // Owner always receives proactive DMs
  if (userId === OWNER_USER_ID) return true;

  // For others, check allowlist via pairing service
  // This is a lazy import to avoid circular deps
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { dmPairingService } = require('../services/dm-pairing.js');
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
  // Owner always has DM access
  if (userId === OWNER_USER_ID) return true;

  // For others, check allowlist
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { dmPairingService } = require('../services/dm-pairing.js');
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
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { dmPairingService } = require('../services/dm-pairing.js');
    return dmPairingService.getPolicy(platform);
  } catch {
    return { policy: 'pairing', codeExpiryMinutes: 60 };
  }
}
