/**
 * Owner/Admin Configuration
 *
 * EJ is the owner and only user who should receive proactive DMs
 * and have special access to administrative features.
 */

// EJ's Discord user ID - the owner of Coach Artie
export const OWNER_USER_ID = '688448399879438340';

// Users who can receive proactive DMs (opt-in whitelist)
// For now, only the owner. Later this can be expanded with a proper opt-in system.
export const PROACTIVE_DM_WHITELIST = new Set([
  OWNER_USER_ID,
]);

// Users who can DM Artie directly for tasks
export const DM_TASK_WHITELIST = new Set([
  OWNER_USER_ID,
]);

// Admin users who can access admin-only capabilities
export const ADMIN_USERS = new Set([
  OWNER_USER_ID,
]);

/**
 * Check if a user can receive proactive DMs
 */
export function canReceiveProactiveDMs(userId: string): boolean {
  return PROACTIVE_DM_WHITELIST.has(userId);
}

/**
 * Check if a user can DM Artie for tasks
 */
export function canDMForTasks(userId: string): boolean {
  return DM_TASK_WHITELIST.has(userId);
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
