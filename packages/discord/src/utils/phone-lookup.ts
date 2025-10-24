import { UserProfileService } from '@coachartie/shared';
import { logger } from '@coachartie/shared';

export interface LinkedPhone {
  phoneNumber: string;
  phoneHash: string;
  verifiedAt: number;
  userId: string;
}

/**
 * Get user phone (uses unified profile system)
 */
export async function getUserPhone(userId: string): Promise<LinkedPhone | null> {
  try {
    const phone = await UserProfileService.getAttribute(userId, 'phone');
    const phoneHash = await UserProfileService.getAttribute(userId, 'phoneHash');

    if (!phone) {
      return null;
    }

    // Return legacy format for compatibility
    return {
      phoneNumber: phone,
      phoneHash: phoneHash || '',
      verifiedAt: Date.now(), // We don't track this anymore, but kept for compatibility
      userId,
    };
  } catch (error) {
    logger.error('Error getting user phone:', error);
    return null;
  }
}

export async function isPhoneLinked(userId: string): Promise<boolean> {
  const phone = await getUserPhone(userId);
  return phone !== null;
}

export async function getMaskedPhone(userId: string): Promise<string | null> {
  const phone = await getUserPhone(userId);
  if (!phone) return null;

  // Mask phone number for display (e.g., +1234***6789)
  return phone.phoneNumber.replace(/(\+\d{1,3})\d{6}(\d{4})/, '$1******$2');
}
