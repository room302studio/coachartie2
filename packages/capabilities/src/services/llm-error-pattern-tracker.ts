import { logger } from '@coachartie/shared';
import { StructuredCapabilityError } from '../types/structured-errors.js';

/**
 * Tracks error patterns from LLM to help prevent repeated mistakes
 * Learns what errors are common and can inject prevention strategies
 */

interface ErrorPattern {
  capability: string;
  action: string;
  errorCode: string;
  frequency: number;
  lastOccurrence: string;
  variations: string[]; // Different ways the error was triggered
}

interface UserErrorProfile {
  userId: string;
  totalErrors: number;
  patterns: Map<string, ErrorPattern>;
  lastUpdated: string;
}

export class LLMErrorPatternTracker {
  private userProfiles = new Map<string, UserErrorProfile>();
  private globalPatterns = new Map<string, ErrorPattern>();

  /**
   * Record an error occurrence and learn from it
   */
  recordError(userId: string, error: StructuredCapabilityError): void {
    // Get or create user profile
    let profile = this.userProfiles.get(userId);
    if (!profile) {
      profile = {
        userId,
        totalErrors: 0,
        patterns: new Map(),
        lastUpdated: new Date().toISOString(),
      };
      this.userProfiles.set(userId, profile);
    }

    profile.totalErrors++;
    profile.lastUpdated = new Date().toISOString();

    // Key for this type of error
    const patternKey = `${error.capability}:${error.action}:${error.errorCode}`;

    // Update user-specific pattern
    let userPattern = profile.patterns.get(patternKey);
    if (!userPattern) {
      userPattern = {
        capability: error.capability,
        action: error.action,
        errorCode: error.errorCode,
        frequency: 0,
        lastOccurrence: new Date().toISOString(),
        variations: [],
      };
      profile.patterns.set(patternKey, userPattern);
    }

    userPattern.frequency++;
    userPattern.lastOccurrence = new Date().toISOString();

    // Track variation if it's new
    const variation = `${error.message}`;
    if (!userPattern.variations.includes(variation) && userPattern.variations.length < 5) {
      userPattern.variations.push(variation);
    }

    // Update global pattern
    let globalPattern = this.globalPatterns.get(patternKey);
    if (!globalPattern) {
      globalPattern = {
        capability: error.capability,
        action: error.action,
        errorCode: error.errorCode,
        frequency: 0,
        lastOccurrence: new Date().toISOString(),
        variations: [],
      };
      this.globalPatterns.set(patternKey, globalPattern);
    }

    globalPattern.frequency++;
    globalPattern.lastOccurrence = new Date().toISOString();

    logger.info(
      `📊 Error pattern recorded: ${patternKey} (user: ${userPattern.frequency}x, global: ${globalPattern.frequency}x)`
    );
  }

  /**
   * Get repeat error detection for a user
   * Returns guidance if they keep making the same mistake
   */
  getRepeatErrorGuidance(userId: string, error: StructuredCapabilityError): string | null {
    const profile = this.userProfiles.get(userId);
    if (!profile) return null;

    const patternKey = `${error.capability}:${error.action}:${error.errorCode}`;
    const pattern = profile.patterns.get(patternKey);

    if (!pattern || pattern.frequency < 2) {
      return null; // Not a repeat error yet
    }

    // This is a repeat error - provide guidance
    const timesRepeated = pattern.frequency - 1;
    return `⚠️ NOTE: You've tried this ${timesRepeated} time(s) before with the same error. This time, make sure to provide: ${error.requiredParams?.map((p) => p.name).join(', ') || 'required parameters'}`;
  }

  /**
   * Get prevention tips based on user's error history
   * Inject into system prompt to prevent common mistakes
   */
  getPreventionTips(userId: string): string {
    const profile = this.userProfiles.get(userId);
    if (!profile || profile.patterns.size === 0) {
      return '';
    }

    // Get top 3 most frequent errors
    const topErrors = Array.from(profile.patterns.values())
      .sort((a, b) => b.frequency - a.frequency)
      .slice(0, 3);

    if (topErrors.length === 0) {
      return '';
    }

    let tips = '\n📋 COMMON MISTAKES TO AVOID (from your history):\n';
    for (const error of topErrors) {
      tips += `• ${error.capability}:${error.action} - ${error.errorCode}: Occurred ${error.frequency}x\n`;
    }

    return tips;
  }

  /**
   * Check if user is in a repeat error loop
   * (same error multiple times in short succession)
   */
  isInErrorLoop(userId: string, error: StructuredCapabilityError): boolean {
    const profile = this.userProfiles.get(userId);
    if (!profile) return false;

    const patternKey = `${error.capability}:${error.action}:${error.errorCode}`;
    const pattern = profile.patterns.get(patternKey);

    if (!pattern) return false;

    // If they've made this error 3+ times, they're in a loop
    return pattern.frequency >= 3;
  }

  /**
   * Get error breakdown for a user
   */
  getUserErrorStats(userId: string): {
    totalErrors: number;
    uniqueErrorTypes: number;
    mostCommonError: ErrorPattern | null;
    errorsByCapability: Record<string, number>;
  } {
    const profile = this.userProfiles.get(userId);
    if (!profile) {
      return {
        totalErrors: 0,
        uniqueErrorTypes: 0,
        mostCommonError: null,
        errorsByCapability: {},
      };
    }

    const patterns = Array.from(profile.patterns.values());
    const mostCommon =
      patterns.length > 0 ? patterns.sort((a, b) => b.frequency - a.frequency)[0] : null;

    const errorsByCapability: Record<string, number> = {};
    for (const pattern of patterns) {
      errorsByCapability[pattern.capability] = (errorsByCapability[pattern.capability] || 0) + 1;
    }

    return {
      totalErrors: profile.totalErrors,
      uniqueErrorTypes: patterns.length,
      mostCommonError: mostCommon,
      errorsByCapability,
    };
  }

  /**
   * Get global error statistics
   */
  getGlobalErrorStats(): {
    totalUniqueUsers: number;
    totalErrors: number;
    mostCommonErrors: ErrorPattern[];
  } {
    const patterns = Array.from(this.globalPatterns.values()).sort(
      (a, b) => b.frequency - a.frequency
    );

    return {
      totalUniqueUsers: this.userProfiles.size,
      totalErrors: Array.from(this.userProfiles.values()).reduce((sum, p) => sum + p.totalErrors, 0),
      mostCommonErrors: patterns.slice(0, 10),
    };
  }

  /**
   * Clear old data to prevent memory leaks
   */
  cleanup(): void {
    const oneWeekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;

    // Remove user profiles that haven't had errors in a week
    for (const [userId, profile] of this.userProfiles.entries()) {
      const lastUpdate = new Date(profile.lastUpdated).getTime();
      if (lastUpdate < oneWeekAgo) {
        this.userProfiles.delete(userId);
      }
    }

    logger.info(`🧹 Error pattern tracker cleanup: ${this.userProfiles.size} active users`);
  }
}

// Export singleton
export const errorPatternTracker = new LLMErrorPatternTracker();

// Cleanup old data every hour
setInterval(() => {
  errorPatternTracker.cleanup();
}, 60 * 60 * 1000);
