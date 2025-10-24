import { createRedisConnection } from '@coachartie/shared';
import { logger } from '@coachartie/shared';

const redis = createRedisConnection();

export interface LinkedEmail {
  email: string;
  linkedAt: number;
  userId: string;
}

export async function getUserEmail(userId: string): Promise<LinkedEmail | null> {
  try {
    const userEmailKey = `user_email:${userId}`;
    const emailData = await redis.get(userEmailKey);

    if (!emailData) {
      return null;
    }

    return JSON.parse(emailData) as LinkedEmail;
  } catch (error) {
    logger.error('Error getting user email:', error);
    return null;
  }
}

export async function isEmailLinked(userId: string): Promise<boolean> {
  const email = await getUserEmail(userId);
  return email !== null;
}

export async function linkUserEmail(userId: string, email: string): Promise<void> {
  try {
    const userEmailKey = `user_email:${userId}`;
    const linkedEmail: LinkedEmail = {
      email,
      linkedAt: Date.now(),
      userId,
    };

    await redis.set(userEmailKey, JSON.stringify(linkedEmail));
    logger.info('Email linked successfully', { userId, email: email.substring(0, 3) + '***' });
  } catch (error) {
    logger.error('Error linking user email:', error);
    throw error;
  }
}

export async function unlinkUserEmail(userId: string): Promise<void> {
  try {
    const userEmailKey = `user_email:${userId}`;
    await redis.del(userEmailKey);
    logger.info('Email unlinked successfully', { userId });
  } catch (error) {
    logger.error('Error unlinking user email:', error);
    throw error;
  }
}
