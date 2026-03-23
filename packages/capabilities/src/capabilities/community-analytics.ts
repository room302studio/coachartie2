import { logger, getSyncDb } from '@coachartie/shared';
import { RegisteredCapability } from '../services/capability/capability-registry.js';

/**
 * Community Analytics capability
 *
 * Lets Artie answer questions about community activity patterns
 * by querying his own database. All queries are pre-built and parameterized.
 */

interface AnalyticsParams {
  action:
    | 'activity_patterns'
    | 'top_contributors'
    | 'channel_stats'
    | 'topic_trends'
    | 'user_profile'
    | 'github_activity'
    | 'engagement_summary';
  guild_id?: string;
  channel_id?: string;
  user_id?: string;
  time_range?: string; // '7d', '30d', '90d', 'all'
  limit?: number;
}

function parseTimeRange(range: string): string {
  const match = range.match(/^(\d+)([dhm])$/);
  if (!match) return '-30 days';
  const [, num, unit] = match;
  const unitMap: Record<string, string> = { d: 'days', h: 'hours', m: 'minutes' };
  return `-${num} ${unitMap[unit] || 'days'}`;
}

function formatNumber(n: number): string {
  return n.toLocaleString('en-US');
}

// Map guild IDs to names (messages table stores both formats)
const GUILD_NAMES: Record<string, string> = {
  '932719842522443928': 'Room 302 Studio',
  '1420846272545296470': 'Subway Builder',
};

function getGuildVariants(guildId: string): string[] {
  const variants = [guildId];
  if (GUILD_NAMES[guildId]) variants.push(GUILD_NAMES[guildId]);
  // Also check reverse (name → ID)
  for (const [id, name] of Object.entries(GUILD_NAMES)) {
    if (guildId.toLowerCase() === name.toLowerCase()) variants.push(id);
  }
  return [...new Set(variants)];
}

function guildWhere(variants: string[]): { clause: string; params: string[] } {
  const placeholders = variants.map(() => '?').join(', ');
  return { clause: `guild_id IN (${placeholders})`, params: variants };
}

function activityPatterns(db: any, guildId: string, timeRange: string): string {
  const interval = parseTimeRange(timeRange);
  const gw = guildWhere(getGuildVariants(guildId));
  const lines: string[] = [`## Community Activity Patterns (Last ${timeRange})\n`];

  // Hour-of-day distribution
  const hourly: any[] = db.all(
    `SELECT CAST(strftime('%H', created_at) AS INTEGER) as hour,
            COUNT(*) as message_count,
            COUNT(DISTINCT user_id) as unique_users
     FROM messages
     WHERE ${gw.clause}
       AND created_at > datetime('now', ?)
       AND role IS NULL
     GROUP BY hour ORDER BY message_count DESC`,
    [...gw.params, interval]
  );

  if (hourly.length > 0) {
    lines.push('**Peak Hours (UTC):**');
    for (const row of hourly.slice(0, 5)) {
      const h = row.hour;
      const label = h === 0 ? '12 AM' : h < 12 ? `${h} AM` : h === 12 ? '12 PM' : `${h - 12} PM`;
      lines.push(`- ${label}: ${formatNumber(row.message_count)} messages (${row.unique_users} users)`);
    }
  }

  // Day-of-week distribution
  const daily = db.all(
    `SELECT CAST(strftime('%w', created_at) AS INTEGER) as day_num,
            CASE CAST(strftime('%w', created_at) AS INTEGER)
              WHEN 0 THEN 'Sunday' WHEN 1 THEN 'Monday' WHEN 2 THEN 'Tuesday'
              WHEN 3 THEN 'Wednesday' WHEN 4 THEN 'Thursday' WHEN 5 THEN 'Friday'
              WHEN 6 THEN 'Saturday'
            END as day_name,
            COUNT(*) as message_count
     FROM messages
     WHERE ${gw.clause}
       AND created_at > datetime('now', ?)
       AND role IS NULL
     GROUP BY day_num ORDER BY message_count DESC`,
    [...gw.params, interval]
  );

  if (daily.length > 0) {
    lines.push('\n**Busiest Days:**');
    for (const row of daily) {
      lines.push(`- ${row.day_name}: ${formatNumber(row.message_count)} messages`);
    }
  }

  // Quick totals
  const totals = db.get(
    `SELECT COUNT(*) as total,
            COUNT(DISTINCT user_id) as users,
            COUNT(DISTINCT channel_id) as channels
     FROM messages
     WHERE ${gw.clause}
       AND created_at > datetime('now', ?)
       AND role IS NULL`,
    [...gw.params, interval]
  );

  if (totals) {
    lines.push(`\n**Totals:** ${formatNumber(totals.total)} messages from ${totals.users} users across ${totals.channels} channels`);
  }

  return lines.join('\n');
}

function topContributors(db: any, guildId: string, timeRange: string, limit: number): string {
  const interval = parseTimeRange(timeRange);
  const gw = guildWhere(getGuildVariants(guildId));
  const lines: string[] = [`## Top Contributors (Last ${timeRange})\n`];

  const users: any[] = db.all(
    `SELECT user_id,
            COUNT(*) as message_count,
            COUNT(DISTINCT channel_id) as channels_active_in,
            MIN(created_at) as first_seen,
            MAX(created_at) as last_seen
     FROM messages
     WHERE ${gw.clause}
       AND created_at > datetime('now', ?)
       AND role IS NULL
     GROUP BY user_id
     ORDER BY message_count DESC
     LIMIT ?`,
    [...gw.params, interval, limit]
  );

  if (users.length === 0) {
    return lines[0] + '\nNo activity found in this time range.';
  }

  for (let i = 0; i < users.length; i++) {
    const u = users[i];
    lines.push(
      `${i + 1}. **${u.user_id}** — ${formatNumber(u.message_count)} messages across ${u.channels_active_in} channels`
    );
  }

  return lines.join('\n');
}

function channelStats(db: any, guildId: string, timeRange: string): string {
  const interval = parseTimeRange(timeRange);
  const gw = guildWhere(getGuildVariants(guildId));
  const lines: string[] = [`## Channel Activity (Last ${timeRange})\n`];

  const channels: any[] = db.all(
    `SELECT channel_id,
            COUNT(*) as message_count,
            COUNT(DISTINCT user_id) as unique_users,
            MAX(created_at) as last_activity
     FROM messages
     WHERE ${gw.clause}
       AND created_at > datetime('now', ?)
     GROUP BY channel_id
     ORDER BY message_count DESC`,
    [...gw.params, interval]
  );

  if (channels.length === 0) {
    return lines[0] + '\nNo channel activity found.';
  }

  for (const ch of channels.slice(0, 15)) {
    lines.push(`- **${ch.channel_id}**: ${formatNumber(ch.message_count)} messages (${ch.unique_users} users)`);
  }

  return lines.join('\n');
}

function topicTrends(db: any, guildId: string, timeRange: string): string {
  const interval = parseTimeRange(timeRange);
  const lines: string[] = [`## Recent Topics & Themes (Last ${timeRange})\n`];

  // Get recent observational memories
  const observations = db.all(
    `SELECT content, timestamp, channel_id
     FROM memories
     WHERE user_id = 'observational-system'
       AND guild_id = ?
       AND timestamp > datetime('now', ?)
     ORDER BY timestamp DESC
     LIMIT 15`,
    [guildId, interval]
  );

  if (observations.length === 0) {
    // Try with guild name instead of ID
    const obs2 = db.all(
      `SELECT content, timestamp
       FROM memories
       WHERE user_id = 'observational-system'
         AND timestamp > datetime('now', ?)
       ORDER BY timestamp DESC
       LIMIT 15`,
      [interval]
    );
    if (obs2.length === 0) {
      return lines[0] + '\nNo observational data available yet.';
    }
    lines.push('Here are my recent observations:\n');
    for (const obs of obs2.slice(0, 10)) {
      const summary = obs.content.slice(0, 200).replace(/\n/g, ' ');
      lines.push(`- ${summary}...`);
    }
    return lines.join('\n');
  }

  lines.push('Here are my recent observations:\n');
  for (const obs of observations.slice(0, 10)) {
    const summary = obs.content.slice(0, 200).replace(/\n/g, ' ');
    lines.push(`- ${summary}...`);
  }

  return lines.join('\n');
}

function userProfile(db: any, userId: string, guildId: string): string {
  const gw = guildWhere(getGuildVariants(guildId));
  const lines: string[] = [`## User Profile: ${userId}\n`];

  const stats: any = db.get(
    `SELECT COUNT(*) as total_messages,
            COUNT(DISTINCT channel_id) as channels,
            MIN(created_at) as first_seen,
            MAX(created_at) as last_seen
     FROM messages
     WHERE user_id = ? AND ${gw.clause}
       AND role IS NULL`,
    [userId, ...gw.params]
  );

  if (!stats || stats.total_messages === 0) {
    return lines[0] + '\nNo data found for this user.';
  }

  lines.push(`**Total messages:** ${formatNumber(stats.total_messages)}`);
  lines.push(`**Active in:** ${stats.channels} channels`);
  lines.push(`**First seen:** ${stats.first_seen}`);
  lines.push(`**Last seen:** ${stats.last_seen}`);

  // Peak hour
  const peakHour = db.get(
    `SELECT CAST(strftime('%H', created_at) AS INTEGER) as hour, COUNT(*) as count
     FROM messages
     WHERE user_id = ? AND ${gw.clause} AND role IS NULL
     GROUP BY hour ORDER BY count DESC LIMIT 1`,
    [userId, ...gw.params]
  );

  if (peakHour) {
    const h = peakHour.hour;
    const label = h === 0 ? '12 AM' : h < 12 ? `${h} AM` : h === 12 ? '12 PM' : `${h - 12} PM`;
    lines.push(`**Most active at:** ${label} UTC`);
  }

  // Top channels
  const topChannels = db.all(
    `SELECT channel_id, COUNT(*) as count
     FROM messages
     WHERE user_id = ? AND ${gw.clause} AND role IS NULL
     GROUP BY channel_id ORDER BY count DESC LIMIT 5`,
    [userId, ...gw.params]
  );

  if (topChannels.length > 0) {
    lines.push('\n**Top channels:**');
    for (const ch of topChannels) {
      lines.push(`- ${ch.channel_id}: ${formatNumber(ch.count)} messages`);
    }
  }

  return lines.join('\n');
}

function githubActivity(db: any, timeRange: string): string {
  const interval = parseTimeRange(timeRange);
  const lines: string[] = [`## GitHub Activity (Last ${timeRange})\n`];

  const events = db.all(
    `SELECT event_type, COUNT(*) as count, MAX(created_at) as latest
     FROM github_events_queue
     WHERE created_at > datetime('now', ?)
     GROUP BY event_type ORDER BY count DESC`,
    [interval]
  );

  if (events.length === 0) {
    return lines[0] + '\nNo GitHub events recorded in this time range.';
  }

  for (const e of events) {
    lines.push(`- **${e.event_type}**: ${e.count} events`);
  }

  return lines.join('\n');
}

function engagementSummary(db: any, guildId: string, timeRange: string): string {
  const interval = parseTimeRange(timeRange);
  const gw = guildWhere(getGuildVariants(guildId));
  const lines: string[] = [`## Community Health (Last ${timeRange})\n`];

  // Daily active users
  const dau = db.all(
    `SELECT date(created_at) as day,
            COUNT(DISTINCT user_id) as dau,
            COUNT(*) as messages
     FROM messages
     WHERE ${gw.clause}
       AND created_at > datetime('now', ?)
       AND role IS NULL
     GROUP BY day ORDER BY day DESC LIMIT 14`,
    [...gw.params, interval]
  );

  if (dau.length === 0) {
    return lines[0] + '\nNo activity data available.';
  }

  const avgDau = dau.reduce((sum: number, d: any) => sum + d.dau, 0) / dau.length;
  const avgMsgs = dau.reduce((sum: number, d: any) => sum + d.messages, 0) / dau.length;
  const todayDau = dau[0];

  lines.push(`**Avg daily active users:** ${avgDau.toFixed(1)}`);
  lines.push(`**Avg daily messages:** ${avgMsgs.toFixed(0)}`);

  if (todayDau) {
    lines.push(`**Today:** ${todayDau.dau} users, ${todayDau.messages} messages`);
  }

  lines.push('\n**Recent daily activity:**');
  for (const day of dau.slice(0, 7)) {
    const bar = '█'.repeat(Math.min(20, Math.round(day.dau / Math.max(avgDau, 1) * 10)));
    lines.push(`${day.day}: ${bar} ${day.dau} users / ${day.messages} msgs`);
  }

  // Conversation stats
  const convos = db.get(
    `SELECT COUNT(DISTINCT conversation_id) as total,
            AVG(cnt) as avg_length
     FROM (
       SELECT conversation_id, COUNT(*) as cnt
       FROM messages
       WHERE ${gw.clause}
         AND conversation_id IS NOT NULL
         AND created_at > datetime('now', ?)
       GROUP BY conversation_id
     )`,
    [...gw.params, interval]
  );

  if (convos && convos.total > 0) {
    lines.push(`\n**Conversations:** ${convos.total} total, avg ${(convos.avg_length || 0).toFixed(1)} messages each`);
  }

  return lines.join('\n');
}

export const communityAnalyticsCapability: RegisteredCapability = {
  name: 'community-analytics',
  emoji: '📈',
  supportedActions: [
    'activity_patterns',
    'top_contributors',
    'channel_stats',
    'topic_trends',
    'user_profile',
    'github_activity',
    'engagement_summary',
  ],
  description: `Query community activity data to answer questions about Discord usage patterns, GitHub activity, and community health.

Actions:
- activity_patterns: When are users most active? (hour-of-day, day-of-week)
- top_contributors: Who posts the most? Top N users by message count
- channel_stats: Which channels are busiest?
- topic_trends: What topics are people talking about? (from observational memories)
- user_profile: Deep dive on a specific user's activity patterns
- github_activity: GitHub events summary (PRs, issues, commits)
- engagement_summary: Community health dashboard (DAU, avg messages, trends)

Use this when someone asks about community patterns, user activity, popular channels, or engagement metrics.`,
  requiredParams: [],
  examples: [
    '<capability name="community-analytics" action="activity_patterns" data=\'{"guild_id":"1420846272545296470","time_range":"30d"}\' />',
    '<capability name="community-analytics" action="top_contributors" data=\'{"time_range":"7d","limit":10}\' />',
    '<capability name="community-analytics" action="engagement_summary" data=\'{"time_range":"14d"}\' />',
    '<capability name="community-analytics" action="user_profile" data=\'{"user_id":"272782606347796481"}\' />',
    '<capability name="community-analytics" action="topic_trends" data=\'{"time_range":"7d"}\' />',
  ],

  handler: async (params: any) => {
    const {
      action = 'engagement_summary',
      guild_id,
      channel_id,
      user_id,
      time_range = '30d',
      limit = 10,
    } = params as AnalyticsParams;

    // Use context guild_id if not specified, fall back to Subway Builder
    const guildId = guild_id || params.context?.guildId || '1420846272545296470';

    logger.info(`📈 Community analytics: ${action} (guild=${guildId}, range=${time_range})`);

    try {
      const db = getSyncDb();

      switch (action) {
        case 'activity_patterns':
          return activityPatterns(db, guildId, time_range);
        case 'top_contributors':
          return topContributors(db, guildId, time_range, limit || 10);
        case 'channel_stats':
          return channelStats(db, guildId, time_range);
        case 'topic_trends':
          return topicTrends(db, guildId, time_range);
        case 'user_profile':
          if (!user_id) return 'Please specify a user_id to look up.';
          return userProfile(db, user_id, guildId);
        case 'github_activity':
          return githubActivity(db, time_range);
        case 'engagement_summary':
          return engagementSummary(db, guildId, time_range);
        default:
          return `Unknown action: ${action}. Available: activity_patterns, top_contributors, channel_stats, topic_trends, user_profile, github_activity, engagement_summary`;
      }
    } catch (error: any) {
      logger.error(`Community analytics error:`, error);
      return `Error running analytics query: ${error.message}`;
    }
  },
};
