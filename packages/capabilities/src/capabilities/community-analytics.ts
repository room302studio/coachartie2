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
  time_range?: string;
  limit?: number;
}

// ── Utilities ──

function parseTimeRange(range: string): string {
  if (!range || range === 'all') return '-3650 days'; // ~10 years = "all"
  // Support: 7d, 30d, 90d, 365d, 1w, 2w, 1m, 3m, 6m, 1y, 24h, 48h
  const match = range.match(/^(\d+)\s*(d|h|m|w|mo|y)(?:ays?|ours?|inutes?|eeks?|onths?|ears?)?$/i);
  if (!match) return '-30 days';
  const [, num, unit] = match;
  const n = parseInt(num);
  const unitMap: Record<string, string> = {
    d: 'days', h: 'hours', m: 'minutes', w: 'days', mo: 'days', y: 'days',
  };
  const multiplier: Record<string, number> = {
    d: 1, h: 1, m: 1, w: 7, mo: 30, y: 365,
  };
  return `-${n * (multiplier[unit] || 1)} ${unitMap[unit] || 'days'}`;
}

function formatNumber(n: number): string {
  if (n == null) return '0';
  return n.toLocaleString('en-US');
}

function formatHour(h: number): string {
  if (h === 0) return '12 AM';
  if (h < 12) return `${h} AM`;
  if (h === 12) return '12 PM';
  return `${h - 12} PM`;
}

function timeAgo(dateStr: string): string {
  if (!dateStr) return 'unknown';
  const ms = Date.now() - new Date(dateStr).getTime();
  const hours = ms / (1000 * 60 * 60);
  if (hours < 1) return 'just now';
  if (hours < 24) return `${Math.round(hours)}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.round(days / 7)}w ago`;
  return `${Math.round(days / 30)}mo ago`;
}

// ── Guild ID resolution (messages table stores both names and snowflakes) ──

const GUILD_MAP: Record<string, string[]> = {
  '932719842522443928': ['932719842522443928', 'Room 302 Studio'],
  '1420846272545296470': ['1420846272545296470', 'Subway Builder', 'Subwaybuilder'],
};

function getGuildVariants(guildId: string): string[] {
  // Direct match on ID
  if (GUILD_MAP[guildId]) return GUILD_MAP[guildId];
  // Reverse match on name
  for (const [id, names] of Object.entries(GUILD_MAP)) {
    if (names.some((n) => n.toLowerCase() === guildId.toLowerCase())) {
      return GUILD_MAP[id];
    }
  }
  return [guildId];
}

function guildWhere(variants: string[]): { clause: string; params: string[] } {
  const placeholders = variants.map(() => '?').join(', ');
  return { clause: `guild_id IN (${placeholders})`, params: variants };
}

function getGuildDisplayName(guildId: string): string {
  for (const [, names] of Object.entries(GUILD_MAP)) {
    if (names.includes(guildId) && names.length > 1) return names[1]; // second entry is human name
  }
  return guildId;
}

// ── Name resolution caches ──

let userNameCache: Map<string, string> | null = null;
let channelNameCache: Map<string, string> | null = null;
let cacheBuiltAt = 0;
const CACHE_TTL = 10 * 60 * 1000; // 10 minutes

function buildNameCaches(db: any): void {
  const now = Date.now();
  if (userNameCache && channelNameCache && now - cacheBuiltAt < CACHE_TTL) return;

  userNameCache = new Map();
  channelNameCache = new Map();
  cacheBuiltAt = now;

  // User names from identity mappings
  try {
    const mappings = db.all(
      `SELECT github_username, discord_user_id, display_name FROM github_identity_mappings WHERE display_name IS NOT NULL`
    );
    for (const m of mappings) {
      if (m.discord_user_id && m.display_name) {
        userNameCache.set(m.discord_user_id, m.display_name);
      }
    }
  } catch { /* table may not exist */ }

  // Channel names from observational memories (they contain "#channel-name" in content)
  try {
    const obs = db.all(
      `SELECT DISTINCT channel_id, content FROM memories
       WHERE user_id = 'observational-system' AND channel_id IS NOT NULL
       ORDER BY timestamp DESC LIMIT 200`
    );
    for (const o of obs) {
      if (o.channel_id && o.content) {
        // Extract channel name from "[Observation from Guild #channel-name (...)]"
        const match = o.content.match(/#([a-z0-9_-]+)/i);
        if (match) channelNameCache.set(o.channel_id, `#${match[1]}`);
      }
    }
  } catch { /* */ }

  // Also try to fetch channel names from Discord bot API
  try {
    // Synchronous fetch not available, but we have channel IDs in the messages table
    // that sometimes store channel names directly
    const namedChannels = db.all(
      `SELECT DISTINCT channel_id FROM messages WHERE channel_id IS NOT NULL AND channel_id NOT GLOB '[0-9]*' LIMIT 50`
    );
    for (const c of namedChannels) {
      if (c.channel_id) channelNameCache.set(c.channel_id, `#${c.channel_id}`);
    }
  } catch { /* */ }
}

function resolveUser(db: any, userId: string): string {
  buildNameCaches(db);
  return userNameCache?.get(userId) || userId;
}

function resolveChannel(db: any, channelId: string): string {
  if (!channelId || channelId === 'null') return '#unknown';
  buildNameCaches(db);
  return channelNameCache?.get(channelId) || channelId;
}

// ── Data freshness ──

function dataFreshness(db: any, gw: { clause: string; params: string[] }): string {
  const latest = db.get(
    `SELECT MAX(created_at) as latest, MIN(created_at) as earliest, COUNT(*) as total
     FROM messages WHERE ${gw.clause}`,
    gw.params
  );
  if (!latest || !latest.total) return '\n_No message data available._';
  return `\n_Data: ${formatNumber(latest.total)} messages from ${latest.earliest?.split('T')[0] || '?'} to ${latest.latest?.split('T')[0] || '?'}_`;
}

// ── Actions ──

function activityPatterns(db: any, guildId: string, timeRange: string): string {
  const interval = parseTimeRange(timeRange);
  const gw = guildWhere(getGuildVariants(guildId));
  const guildName = getGuildDisplayName(guildId);
  const lines: string[] = [`## Activity Patterns — ${guildName} (${timeRange})\n`];

  const hourly: any[] = db.all(
    `SELECT CAST(strftime('%H', created_at) AS INTEGER) as hour,
            COUNT(*) as message_count,
            COUNT(DISTINCT user_id) as unique_users
     FROM messages
     WHERE ${gw.clause} AND created_at > datetime('now', ?) AND role IS NULL
     GROUP BY hour ORDER BY message_count DESC`,
    [...gw.params, interval]
  );

  if (hourly.length > 0) {
    lines.push('**Peak Hours (UTC):**');
    for (const row of hourly.slice(0, 5)) {
      lines.push(`- ${formatHour(row.hour)}: ${formatNumber(row.message_count)} messages (${row.unique_users} users)`);
    }
    // Also show quietest
    const quietest = hourly.slice(-2).reverse();
    if (quietest.length > 0 && hourly.length > 5) {
      lines.push(`\n**Quietest:** ${quietest.map((r: any) => `${formatHour(r.hour)} (${r.message_count})`).join(', ')}`);
    }
  }

  const daily = db.all(
    `SELECT CAST(strftime('%w', created_at) AS INTEGER) as day_num,
            CASE CAST(strftime('%w', created_at) AS INTEGER)
              WHEN 0 THEN 'Sun' WHEN 1 THEN 'Mon' WHEN 2 THEN 'Tue'
              WHEN 3 THEN 'Wed' WHEN 4 THEN 'Thu' WHEN 5 THEN 'Fri'
              WHEN 6 THEN 'Sat'
            END as day_name,
            COUNT(*) as message_count
     FROM messages
     WHERE ${gw.clause} AND created_at > datetime('now', ?) AND role IS NULL
     GROUP BY day_num ORDER BY message_count DESC`,
    [...gw.params, interval]
  );

  if (daily.length > 0) {
    lines.push('\n**By Day:**');
    const maxMsgs = daily[0]?.message_count || 1;
    for (const row of daily) {
      const bar = '█'.repeat(Math.max(1, Math.round((row.message_count / maxMsgs) * 15)));
      lines.push(`${row.day_name}: ${bar} ${formatNumber(row.message_count)}`);
    }
  }

  const totals = db.get(
    `SELECT COUNT(*) as total, COUNT(DISTINCT user_id) as users, COUNT(DISTINCT channel_id) as channels
     FROM messages WHERE ${gw.clause} AND created_at > datetime('now', ?) AND role IS NULL`,
    [...gw.params, interval]
  );

  if (totals) {
    lines.push(`\n**Totals:** ${formatNumber(totals.total)} messages, ${totals.users} users, ${totals.channels} channels`);
  }

  lines.push(dataFreshness(db, gw));
  return lines.join('\n');
}

function topContributors(db: any, guildId: string, timeRange: string, limit: number): string {
  const interval = parseTimeRange(timeRange);
  const gw = guildWhere(getGuildVariants(guildId));
  const guildName = getGuildDisplayName(guildId);
  const lines: string[] = [`## Top Contributors — ${guildName} (${timeRange})\n`];

  const users: any[] = db.all(
    `SELECT user_id, COUNT(*) as message_count,
            COUNT(DISTINCT channel_id) as channels_active_in,
            MAX(created_at) as last_seen
     FROM messages
     WHERE ${gw.clause} AND created_at > datetime('now', ?) AND role IS NULL
     GROUP BY user_id ORDER BY message_count DESC LIMIT ?`,
    [...gw.params, interval, limit]
  );

  if (users.length === 0) {
    return lines[0] + '\nNo activity found in this time range.';
  }

  for (let i = 0; i < users.length; i++) {
    const u = users[i];
    const name = resolveUser(db, u.user_id);
    lines.push(
      `${i + 1}. **${name}** — ${formatNumber(u.message_count)} msgs across ${u.channels_active_in} channels (last: ${timeAgo(u.last_seen)})`
    );
  }

  lines.push(dataFreshness(db, gw));
  return lines.join('\n');
}

function channelStats(db: any, guildId: string, timeRange: string): string {
  const interval = parseTimeRange(timeRange);
  const gw = guildWhere(getGuildVariants(guildId));
  const guildName = getGuildDisplayName(guildId);
  const lines: string[] = [`## Channel Activity — ${guildName} (${timeRange})\n`];

  const channels: any[] = db.all(
    `SELECT channel_id, COUNT(*) as message_count,
            COUNT(DISTINCT user_id) as unique_users,
            MAX(created_at) as last_activity
     FROM messages
     WHERE ${gw.clause} AND created_at > datetime('now', ?) AND channel_id IS NOT NULL AND channel_id != 'null'
     GROUP BY channel_id ORDER BY message_count DESC`,
    [...gw.params, interval]
  );

  if (channels.length === 0) {
    return lines[0] + '\nNo channel activity found.';
  }

  const maxMsgs = channels[0]?.message_count || 1;
  for (const ch of channels.slice(0, 15)) {
    const name = resolveChannel(db, ch.channel_id);
    const bar = '█'.repeat(Math.max(1, Math.round((ch.message_count / maxMsgs) * 12)));
    lines.push(`${bar} **${name}**: ${formatNumber(ch.message_count)} msgs (${ch.unique_users} users, last: ${timeAgo(ch.last_activity)})`);
  }

  lines.push(dataFreshness(db, gw));
  return lines.join('\n');
}

function topicTrends(db: any, guildId: string, timeRange: string): string {
  const interval = parseTimeRange(timeRange);
  const guildName = getGuildDisplayName(guildId);
  const variants = getGuildVariants(guildId);
  const lines: string[] = [`## Topics & Themes — ${guildName} (${timeRange})\n`];

  // Try each guild variant for observations
  let observations: any[] = [];
  for (const v of variants) {
    observations = db.all(
      `SELECT content, timestamp, channel_id
       FROM memories
       WHERE user_id = 'observational-system' AND guild_id = ? AND timestamp > datetime('now', ?)
       ORDER BY timestamp DESC LIMIT 15`,
      [v, interval]
    );
    if (observations.length > 0) break;
  }

  // Fallback: all observations in time range
  if (observations.length === 0) {
    observations = db.all(
      `SELECT content, timestamp FROM memories
       WHERE user_id = 'observational-system' AND timestamp > datetime('now', ?)
       ORDER BY timestamp DESC LIMIT 15`,
      [interval]
    );
  }

  if (observations.length === 0) {
    return lines[0] + '\nNo observational data available yet. I need to observe more conversations first.';
  }

  lines.push(`Based on ${observations.length} observations:\n`);
  for (const obs of observations.slice(0, 10)) {
    // Clean up the observation format
    let summary = obs.content.replace(/^\[Observation from [^\]]+\]\s*/i, '');
    summary = summary.slice(0, 200).replace(/\n/g, ' ').trim();
    if (summary.length >= 200) summary += '...';
    const when = obs.timestamp ? ` _(${timeAgo(obs.timestamp)})_` : '';
    lines.push(`- ${summary}${when}`);
  }

  return lines.join('\n');
}

function userProfile(db: any, userId: string, guildId: string): string {
  const gw = guildWhere(getGuildVariants(guildId));
  const userName = resolveUser(db, userId);
  const lines: string[] = [`## User Profile: ${userName}\n`];

  const stats: any = db.get(
    `SELECT COUNT(*) as total_messages, COUNT(DISTINCT channel_id) as channels,
            MIN(created_at) as first_seen, MAX(created_at) as last_seen
     FROM messages WHERE user_id = ? AND ${gw.clause} AND role IS NULL`,
    [userId, ...gw.params]
  );

  if (!stats || stats.total_messages === 0) {
    return lines[0] + '\nNo data found for this user in this guild.';
  }

  lines.push(`**Messages:** ${formatNumber(stats.total_messages)}`);
  lines.push(`**Active in:** ${stats.channels} channels`);
  lines.push(`**First seen:** ${stats.first_seen?.split('T')[0] || '?'} (${timeAgo(stats.first_seen)})`);
  lines.push(`**Last seen:** ${stats.last_seen?.split('T')[0] || '?'} (${timeAgo(stats.last_seen)})`);

  // Peak hour
  const peakHour = db.get(
    `SELECT CAST(strftime('%H', created_at) AS INTEGER) as hour, COUNT(*) as count
     FROM messages WHERE user_id = ? AND ${gw.clause} AND role IS NULL
     GROUP BY hour ORDER BY count DESC LIMIT 1`,
    [userId, ...gw.params]
  );
  if (peakHour) {
    lines.push(`**Peak hour:** ${formatHour(peakHour.hour)} UTC`);
  }

  // Peak day
  const peakDay = db.get(
    `SELECT CASE CAST(strftime('%w', created_at) AS INTEGER)
              WHEN 0 THEN 'Sunday' WHEN 1 THEN 'Monday' WHEN 2 THEN 'Tuesday'
              WHEN 3 THEN 'Wednesday' WHEN 4 THEN 'Thursday' WHEN 5 THEN 'Friday'
              WHEN 6 THEN 'Saturday' END as day_name, COUNT(*) as count
     FROM messages WHERE user_id = ? AND ${gw.clause} AND role IS NULL
     GROUP BY CAST(strftime('%w', created_at) AS INTEGER) ORDER BY count DESC LIMIT 1`,
    [userId, ...gw.params]
  );
  if (peakDay) {
    lines.push(`**Most active day:** ${peakDay.day_name}`);
  }

  // Top channels
  const topChannels = db.all(
    `SELECT channel_id, COUNT(*) as count
     FROM messages WHERE user_id = ? AND ${gw.clause} AND role IS NULL
     GROUP BY channel_id ORDER BY count DESC LIMIT 5`,
    [userId, ...gw.params]
  );
  if (topChannels.length > 0) {
    lines.push('\n**Top channels:**');
    for (const ch of topChannels) {
      const chName = resolveChannel(db, ch.channel_id);
      lines.push(`- ${chName}: ${formatNumber(ch.count)} messages`);
    }
  }

  // GitHub identity
  try {
    const ghMapping = db.get(
      `SELECT github_username, confidence, source FROM github_identity_mappings WHERE discord_user_id = ?`,
      [userId]
    );
    if (ghMapping) {
      lines.push(`\n**GitHub:** ${ghMapping.github_username} (${Math.round(ghMapping.confidence * 100)}% confidence, via ${ghMapping.source})`);
    }
  } catch { /* table may not exist */ }

  return lines.join('\n');
}

function githubActivity(db: any, timeRange: string): string {
  const interval = parseTimeRange(timeRange);
  const lines: string[] = [`## GitHub Activity (${timeRange})\n`];

  // Try the events queue first
  let hasData = false;
  try {
    const events = db.all(
      `SELECT event_type, COUNT(*) as count, MAX(created_at) as latest
       FROM github_events_queue WHERE created_at > datetime('now', ?)
       GROUP BY event_type ORDER BY count DESC`,
      [interval]
    );
    if (events.length > 0) {
      hasData = true;
      lines.push('**Event Types:**');
      for (const e of events) {
        lines.push(`- ${e.event_type}: ${e.count} events (latest: ${timeAgo(e.latest)})`);
      }
    }
  } catch { /* table may not exist */ }

  // Show watched repos status
  try {
    const watches = db.all(
      `SELECT w.repo, w.is_active, s.last_polled_at, s.poll_errors
       FROM github_repo_watches w
       LEFT JOIN github_sync_state s ON w.repo = s.repo
       ORDER BY s.last_polled_at DESC`
    );
    if (watches.length > 0) {
      lines.push(`\n**Watched Repos (${watches.length}):**`);
      for (const w of watches) {
        const status = w.is_active ? '✅' : '❌';
        const lastPoll = w.last_polled_at ? timeAgo(w.last_polled_at) : 'never';
        const errors = w.poll_errors > 0 ? ` (${w.poll_errors} errors)` : '';
        lines.push(`${status} **${w.repo}** — last polled ${lastPoll}${errors}`);
      }
    }
  } catch { /* */ }

  // Show identity mappings
  try {
    const mappings = db.all(
      `SELECT github_username, display_name, confidence, source FROM github_identity_mappings ORDER BY confidence DESC`
    );
    if (mappings.length > 0) {
      lines.push(`\n**Identity Mappings (${mappings.length}):**`);
      for (const m of mappings) {
        lines.push(`- ${m.github_username} → ${m.display_name} (${Math.round(m.confidence * 100)}%, ${m.source})`);
      }
    }
  } catch { /* */ }

  if (!hasData && lines.length <= 1) {
    lines.push('No GitHub event data in the queue (events are processed and cleared in real-time).');
    lines.push('Check the watched repos and identity mappings above for current status.');
  }

  return lines.join('\n');
}

function engagementSummary(db: any, guildId: string, timeRange: string): string {
  const interval = parseTimeRange(timeRange);
  const gw = guildWhere(getGuildVariants(guildId));
  const guildName = getGuildDisplayName(guildId);
  const lines: string[] = [`## Community Health — ${guildName} (${timeRange})\n`];

  // Overall stats
  const overall = db.get(
    `SELECT COUNT(*) as total, COUNT(DISTINCT user_id) as total_users,
            COUNT(DISTINCT channel_id) as total_channels,
            COUNT(DISTINCT date(created_at)) as active_days
     FROM messages WHERE ${gw.clause} AND created_at > datetime('now', ?) AND role IS NULL`,
    [...gw.params, interval]
  );

  if (!overall || overall.total === 0) {
    return lines[0] + '\nNo activity data available.';
  }

  lines.push(`**Total:** ${formatNumber(overall.total)} messages from ${overall.total_users} users in ${overall.total_channels} channels over ${overall.active_days} active days`);

  // Daily active users
  const dau = db.all(
    `SELECT date(created_at) as day, COUNT(DISTINCT user_id) as dau, COUNT(*) as messages
     FROM messages WHERE ${gw.clause} AND created_at > datetime('now', ?) AND role IS NULL
     GROUP BY day ORDER BY day DESC LIMIT 14`,
    [...gw.params, interval]
  );

  if (dau.length > 0) {
    const avgDau = dau.reduce((sum: number, d: any) => sum + d.dau, 0) / dau.length;
    const avgMsgs = dau.reduce((sum: number, d: any) => sum + d.messages, 0) / dau.length;
    const maxDau = Math.max(...dau.map((d: any) => d.dau));

    lines.push(`\n**Avg daily active users:** ${avgDau.toFixed(1)}`);
    lines.push(`**Avg daily messages:** ${avgMsgs.toFixed(0)}`);

    lines.push('\n**Last 14 days:**');
    for (const day of dau) {
      const bar = '█'.repeat(Math.max(1, Math.round((day.dau / Math.max(maxDau, 1)) * 15)));
      lines.push(`${day.day}: ${bar} ${day.dau} users / ${day.messages} msgs`);
    }
  }

  // Conversation stats
  try {
    const convos = db.get(
      `SELECT COUNT(DISTINCT conversation_id) as total, AVG(cnt) as avg_length
       FROM (SELECT conversation_id, COUNT(*) as cnt FROM messages
             WHERE ${gw.clause} AND conversation_id IS NOT NULL AND created_at > datetime('now', ?)
             GROUP BY conversation_id)`,
      [...gw.params, interval]
    );
    if (convos && convos.total > 0) {
      lines.push(`\n**Conversations:** ${convos.total} total, avg ${(convos.avg_length || 0).toFixed(1)} messages each`);
    }
  } catch { /* */ }

  // New vs returning users (appeared before vs after the time range)
  try {
    const newUsers = db.get(
      `SELECT COUNT(DISTINCT m.user_id) as new_users
       FROM messages m WHERE ${gw.clause.replace(/guild_id/g, 'm.guild_id')} AND m.created_at > datetime('now', ?) AND m.role IS NULL
       AND m.user_id NOT IN (
         SELECT DISTINCT user_id FROM messages WHERE ${gw.clause} AND created_at <= datetime('now', ?) AND role IS NULL
       )`,
      [...gw.params, interval, ...gw.params, interval]
    );
    if (newUsers && newUsers.new_users > 0) {
      lines.push(`**New users in this period:** ${newUsers.new_users}`);
    }
  } catch { /* complex query may fail, that's ok */ }

  lines.push(dataFreshness(db, gw));
  return lines.join('\n');
}

// ── Capability definition ──

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
- activity_patterns: When are users most active? (hour-of-day, day-of-week distributions)
- top_contributors: Who posts the most? Top N users ranked by message count
- channel_stats: Which channels are busiest? Activity ranked by channel
- topic_trends: What topics are people talking about? (from observational memories)
- user_profile: Deep dive on a specific user's activity, peak times, top channels
- github_activity: GitHub watched repos, identity mappings, event summary
- engagement_summary: Community health dashboard — DAU trends, conversation stats, growth

Parameters (all optional):
- guild_id: Discord guild snowflake ID (defaults to context guild)
- time_range: "7d", "30d", "90d", "365d", "all", "1w", "3mo", "1y" etc.
- user_id: Discord user snowflake ID (for user_profile)
- limit: max results for top-N queries (default 10)

Use this when someone asks about community patterns, user activity, popular channels, or engagement metrics.`,
  requiredParams: [],
  examples: [
    '<capability name="community-analytics" action="activity_patterns" data=\'{"guild_id":"1420846272545296470","time_range":"90d"}\' />',
    '<capability name="community-analytics" action="top_contributors" data=\'{"time_range":"30d","limit":10}\' />',
    '<capability name="community-analytics" action="engagement_summary" data=\'{"time_range":"90d"}\' />',
    '<capability name="community-analytics" action="user_profile" data=\'{"user_id":"272782606347796481"}\' />',
    '<capability name="community-analytics" action="channel_stats" data=\'{"time_range":"30d"}\' />',
    '<capability name="community-analytics" action="github_activity" data=\'{"time_range":"90d"}\' />',
    '<capability name="community-analytics" action="topic_trends" data=\'{"time_range":"30d"}\' />',
  ],

  handler: async (params: any) => {
    const {
      action = 'engagement_summary',
      guild_id,
      user_id,
      time_range = '90d',
      limit = 10,
    } = params as AnalyticsParams;

    const guildId = guild_id || params.context?.guildId || params.guildId || '1420846272545296470';

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
      logger.error(`Community analytics error (${action}):`, error);
      return `Error running ${action}: ${error.message}`;
    }
  },
};
