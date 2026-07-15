/**
 * Protected Users Configuration
 * Single source of truth for users who cannot be moderated
 */

export const PROTECTED_USERS = {
  // Discord usernames (case-insensitive matching)
  discord: ['jan_gbg', 'hudson', 'colin', 'ejfox'],

  // Discord user IDs and alternative names
  alternatives: {
    hudson: ['theonlyhudson'],  // Alternative accounts for same user
  },
};

/**
 * Check if a user is protected
 * @param username Discord username or display name
 * @param userId Optional Discord numeric ID
 * @returns true if user cannot be moderated
 */
export function isProtectedUser(username?: string, userId?: string): boolean {
  if (!username && !userId) return false;

  // Check by username (case-insensitive)
  if (username) {
    const normalizedUsername = (username || '').toLowerCase();

    // Check primary list
    if (PROTECTED_USERS.discord.some(u => u.toLowerCase() === normalizedUsername)) {
      return true;
    }

    // Check alternative accounts
    for (const alts of Object.values(PROTECTED_USERS.alternatives)) {
      if (alts.some(a => a.toLowerCase() === normalizedUsername)) {
        return true;
      }
    }
  }

  // Check by ID if provided
  if (userId) {
    for (const alts of Object.values(PROTECTED_USERS.alternatives)) {
      if (alts.includes(userId)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Get list of all protected usernames for logging/display
 */
export function getProtectedUsersList(): string {
  const all = [
    ...PROTECTED_USERS.discord,
    ...Object.values(PROTECTED_USERS.alternatives).flat(),
  ];
  return [...new Set(all)].join(', ');
}
