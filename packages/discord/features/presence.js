import { ActivityType } from 'discord.js';
import { logger } from '../utils/logger.js';

export class PresenceManager {
  constructor(client) {
    this.client = client;
    this.stats = {
      usersHelped: 0,
      messagesProcessed: 0,
      startTime: Date.now(),
      lastEmoji: null,
      currentMood: '😊',
      // Track unique users we've helped
      uniqueUsers: new Set(),
      lastPresenceUpdate: 0, // Track last update time
      capabilitiesStatus: '🔄', // Track capabilities status
      capabilitiesVersion: null, // Track capabilities version
      queueStats: { pending: 0, processing: 0 }, // Add queue stats tracking
    };

    // Start periodic health checks
    this.startHealthChecks();
  }

  // Start periodic health checks
  async startHealthChecks() {
    const checkHealth = async () => {
      try {
        logger.debug('Running periodic health check', {
          last_status: this.stats.capabilitiesStatus,
          last_version: this.stats.capabilitiesVersion,
          queue_stats: this.stats.queueStats,
        });

        const normalizeUrl = url => {
          const cleanUrl = url.replace(/^(https?:\/\/)/, '');
          return `http://${cleanUrl}`;
        };

        const rawUrl = process.env.CAPABILITIES_URL || '';
        const normalizedUrl = normalizeUrl(rawUrl);
        const healthUrl = `${normalizedUrl}/health`;

        const response = await fetch(healthUrl);
        if (!response.ok)
          throw new Error(`Health check failed: ${response.status}`);

        const data = await response.json();
        this.stats.capabilitiesStatus =
          data.status === 'healthy'
            ? '🟢'
            : data.status === 'degraded'
            ? '🟡'
            : '🔴';
        this.stats.capabilitiesVersion = data.version;

        // Update queue stats if available
        if (data.queue) {
          this.stats.queueStats = {
            pending: data.queue.pending || 0,
            processing: data.queue.processing || 0,
          };
        }

        this.updatePresence();
      } catch (error) {
        this.stats.capabilitiesStatus = '🔴';
        this.stats.queueStats = { pending: 0, processing: 0 };
        logger.warn('Failed to check capabilities health', {
          error: error.message,
        });
      }
    };

    // Initial check
    await checkHealth();
    // Check every 5 minutes
    setInterval(checkHealth, 300000);
  }

  // Update stats and optionally set a mood/activity
  incrementStat(key, userId = null) {
    this.stats[key]++;

    // If we have a userId and it's a new user, increment usersHelped
    if (userId && !this.stats.uniqueUsers.has(userId)) {
      this.stats.uniqueUsers.add(userId);
      this.stats.usersHelped = this.stats.uniqueUsers.size;
    }

    // Only update presence every 5 seconds max
    const now = Date.now();
    if (now - this.stats.lastPresenceUpdate > 5000) {
      this.stats.lastPresenceUpdate = now;
      this.updatePresence();
    }
  }

  // Get queue status string
  getQueueString() {
    const { pending, processing } = this.stats.queueStats;
    const total = pending + processing;
    return total > 0 ? `⏳${total}` : '';
  }

  // Set the bot's current mood/emoji
  async setMood(emoji) {
    this.stats.lastEmoji = emoji;
    this.stats.currentMood = emoji;

    // Map emojis to activities
    const moodActivities = {
      '🤔': 'Thinking hard...',
      '💡': 'Having ideas',
      '✨': 'Making magic happen',
      '🎯': 'Focusing on goals',
      '🎮': 'Playing games',
      '📚': 'Learning new things',
      '💪': 'Getting stronger',
      '🎨': 'Being creative',
      '🤖': 'Beep boop',
      '❤️': 'Spreading love',
      '🎉': 'Celebrating',
      default: `Helped ${this.stats.usersHelped} users`,
    };

    const activity = moodActivities[emoji] || moodActivities.default;
    const type = emoji === '🎮' ? ActivityType.Playing : ActivityType.Custom;

    try {
      const version = process.env.npm_package_version || '1.0.4';
      const queueInfo = this.getQueueString();
      const statusInfo = `${this.stats.capabilitiesStatus} v${version}${
        queueInfo ? ` ${queueInfo}` : ''
      }`;

      await this.client.user.setPresence({
        status: 'online',
        activities: [
          {
            name: `${emoji} ${activity} | ${this.getUptime()}h | ${statusInfo}`,
            type,
          },
        ],
      });
      logger.debug('Updated mood', { emoji, activity, stats: this.stats });
    } catch (error) {
      logger.warn('Failed to update mood', { error: error.message });
    }
  }

  // Get uptime in hours
  getUptime() {
    return Math.round((Date.now() - this.stats.startTime) / (1000 * 60 * 60));
  }

  // Update bot's presence/status
  async updatePresence(status = 'online') {
    try {
      const mood = this.stats.currentMood;
      const version = process.env.npm_package_version || '1.0.4';
      const queueInfo = this.getQueueString();
      const statusInfo = `${this.stats.capabilitiesStatus} v${version}${
        queueInfo ? ` ${queueInfo}` : ''
      }`;

      await this.client.user.setPresence({
        status,
        activities: [
          {
            name: `${mood} Helped ${
              this.stats.usersHelped
            } users | ${this.getUptime()}h | ${statusInfo}`,
            type: ActivityType.Custom,
          },
        ],
      });
      logger.debug('Updated presence', { status, mood, stats: this.stats });
    } catch (error) {
      logger.warn('Failed to update presence', { error: error.message });
    }
  }

  // Set maintenance mode
  async setMaintenance(isOn = true) {
    await this.updatePresence(isOn ? 'dnd' : 'online');
    if (isOn) {
      await this.client.user.setActivity('🔧 Maintenance Mode', {
        type: ActivityType.Watching,
      });
    }
  }
}
