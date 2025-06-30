import { createRedisConnection } from '@coachartie/shared';
import { logger } from '@coachartie/shared';

const redis = createRedisConnection();

export interface LinkedPhone {
  phoneNumber: string;
  phoneHash: string;
  verifiedAt: number;
  userId: string;
}

export async function getUserPhone(userId: string): Promise<LinkedPhone | null> {
  try {
    const userPhoneKey = `user_phone:${userId}`;
    const phoneData = await redis.get(userPhoneKey);
    
    if (!phoneData) {
      return null;
    }

    return JSON.parse(phoneData) as LinkedPhone;
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