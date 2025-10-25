import { UserProfileService, logger } from '@coachartie/shared';

export interface LinkedEmail {
  email: string;
  linkedAt: number;
  userId: string;
}

/**
 * Get user email (uses unified profile system)
 */
export async function getUserEmail(userId: string): Promise<LinkedEmail | null> {
  try {
    const email = await UserProfileService.getAttribute(userId, 'email');

    if (!email) {
      return null;
    }

    // Return legacy format for compatibility
    return {
      email,
      linkedAt: Date.now(), // We don't track this anymore, but kept for compatibility
      userId,
    };
  } catch (error) {
    logger.error('Error getting user email:', error);
    return null;
  }
}

export async function isEmailLinked(userId: string): Promise<boolean> {
  const email = await getUserEmail(userId);
  return email !== null;
}

/**
 * Link user email (uses unified profile system)
 */
export async function linkUserEmail(userId: string, email: string): Promise<void> {
  try {
    await UserProfileService.setAttribute(userId, 'email', email);
    logger.info('Email linked successfully', { userId, email: email.substring(0, 3) + '***' });
  } catch (error) {
    logger.error('Error linking user email:', error);
    throw error;
  }
}

/**
 * Unlink user email (uses unified profile system)
 */
export async function unlinkUserEmail(userId: string): Promise<void> {
  try {
    await UserProfileService.deleteAttribute(userId, 'email');
    logger.info('Email unlinked successfully', { userId });
  } catch (error) {
    logger.error('Error unlinking user email:', error);
    throw error;
  }
}
