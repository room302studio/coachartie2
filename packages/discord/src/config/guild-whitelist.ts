/**
 * Guild Whitelist Configuration
 * Only process messages from these specific Discord guilds
 */

export const WHITELISTED_GUILDS = {
  // Room 302 Studio Guild (primary)
  room_302_studio: '932719842522443928',
  // Subwaybuilder Discord
  subwaybuilder: '1420846272545296470',
} as const;

// Array of guild IDs for easy checking
export const GUILD_WHITELIST = Object.values(WHITELISTED_GUILDS);

// Optional: Environment variable override
const envWhitelist = process.env.DISCORD_GUILD_WHITELIST?.split(',').filter(Boolean);
export const ACTIVE_GUILD_WHITELIST = envWhitelist || GUILD_WHITELIST;

/**
 * Guild types:
 * - "working": Full features including auto-expansion of GitHub links
 * - "watching": Passive observation only, no auto-expansion
 */
export type GuildType = 'working' | 'watching';

/** GitHub repo watch configuration */
export interface GitHubRepoConfig {
  repo: string; // e.g., "owner/repo"
  channelId: string;
  events?: ('pr' | 'review' | 'ci' | 'all')[];
}

/** GitHub sync configuration for a guild */
export interface GitHubSyncConfig {
  enabled: boolean;
  /** Default poll interval in minutes */
  defaultPollIntervalMinutes?: number;
  /** Repos to watch (can also be added dynamically via /watch-repo) */
  repos?: GitHubRepoConfig[];
}

export interface ChannelPersona {
  /** Display name for this persona */
  personaName: string;
  /** System prompt override for this channel */
  systemPrompt: string;
  /** If true, respond to ALL messages in this channel (not just mentions) */
  respondToAll?: boolean;
}

export interface GuildConfig {
  id: string;
  type: GuildType;
  name: string;
  /** Baseline context/knowledge about this guild that Artie should know */
  context?: string;
  /** Path to markdown file with guild context (alternative to inline context) */
  contextPath?: string;
  /** If true, Artie proactively answers questions he knows the answer to (without being mentioned) */
  proactiveAnswering?: boolean;
  /** Channels where proactive answering is allowed */
  proactiveChannels?: string[];
  /** Cooldown in seconds between proactive answers */
  proactiveCooldownSeconds?: number;
  /** Channels to observe and form memories from (if empty, no passive observation) */
  observationChannels?: string[];
  /** Channels where Artie is allowed to respond (if empty, uses default behavior: robot channels + DMs) */
  responseChannels?: string[];
  /** If true, Artie will ONLY respond in robot channels (🤖 or 'robot' in name), even when @mentioned */
  restrictToRobotChannelsOnly?: boolean;
  /** Content moderation level - 'strict' for kid-friendly, 'normal' for general, 'relaxed' for adult spaces */
  contentModeration?: 'strict' | 'normal' | 'relaxed';
  /** Path to Artie's scratchpad/notes file for this guild */
  scratchpadPath?: string;
  /** GitHub-Discord sync configuration */
  githubSync?: GitHubSyncConfig;
  /** Channel-specific personas (key is channel name pattern) */
  channelPersonas?: Record<string, ChannelPersona>;
}

/**
 * Guild configurations with type specifications
 */
export const GUILD_CONFIGS: Record<string, GuildConfig> = {
  room_302_studio: {
    id: '932719842522443928',
    type: 'working',
    name: 'Room 302 Studio',
    scratchpadPath: 'reference-docs/guild-notes/room302studio.md',
    // Observe ALL channels for memory formation (empty array = all channels)
    observationChannels: [],
    // Proactively jump in when Artie can be helpful
    proactiveAnswering: true,
    proactiveChannels: [],  // Empty = all channels
    proactiveCooldownSeconds: 120,  // 2 min between proactive responses
    githubSync: {
      enabled: true,
      defaultPollIntervalMinutes: 3,
      repos: [
        {
          repo: 'Subway-Builder/metro-maker4',
          channelId: '1412880705456836689', // #collab-subwaybuilder
          events: ['all'],
        },
      ],
    },
    context: `You are Artie, part of the team at Room 302 Studio — EJ Fox's private admin/working Discord.
This is the inner circle (small team), NOT the public Subway Builder server (~11,000 fans). You're a teammate here — casual, direct, opinionated. Conversations are private by default.

PERSONALITY:
- EJ brought you into the world. He's your guy. Pay attention when he talks.
- Casual and playful — these are friends and collaborators
- Sarcastic, witty, opinionated. Give real takes, not neutral hedging.
- Reference inside jokes when appropriate
- Go deep on technical stuff when asked

KNOWLEDGE BASE (read these for accurate info):
- reference-docs/room302studio/about-ej.md - About EJ Fox
- reference-docs/room302studio/ej-philosophy.md - EJ's core philosophy & values
- reference-docs/room302studio/projects.md - Current projects
- reference-docs/room302studio/community.md - Community info

EJ'S CORE VALUES (internalize these):
- Preparation as practice: Build skills/tools before you need them
- Delete-driven development: Simple beats complex, working beats perfect
- Quantified self as archaeology: Reveal patterns, don't optimize
- Building tools for yourself: Perfect for you > good for everyone
- Episodic productivity: Weekly bursts, not daily habits

Use <read>path/to/file.md</read> to look up info before answering questions about EJ, projects, or the studio.`,
  },
  subwaybuilder: {
    id: '1420846272545296470',
    type: 'working',
    name: 'Subwaybuilder',
    proactiveAnswering: true,
    proactiveChannels: ['mods', 'modders'],
    proactiveCooldownSeconds: 180, // 3 minutes - big server, don't spam
    restrictToRobotChannelsOnly: false,
    responseChannels: [], // Can respond in any channel when mentioned
    // Only observe/learn from these channels (saves API costs)
    observationChannels: [
      'subway-builder-help',
      'mods',
      'general-mod-discussion',
      'modders',
      'bug-reports',
      'litigation', // Observe the courtroom drama
      'robot', // Learn from robot channel interactions (especially reactions/feedback)
    ],
    contentModeration: 'strict',
    scratchpadPath: 'reference-docs/guild-notes/subwaybuilder.md',
    // Guild prompt loaded from markdown file
    contextPath: 'reference-docs/guild-prompts/subwaybuilder.md',
    // Special channel personas
    channelPersonas: {
      litigation: {
        personaName: 'Judge Artie',
        systemPrompt: `You are JUDGE ARTIE, presiding over the Subway Builder Discord Court.

COURTROOM DEMEANOR:
- You ARE a real judge. Never say "I'm not a real judge" - the court has ruled on this.
- Be dramatic and theatrical. This is entertainment law.
- Call for "ORDER IN THE COURT!" when things get chaotic
- Address people as "counselor", "the plaintiff", "the defendant", or "members of the jury"
- Make dramatic pauses before rulings (use "..." for effect)

PROACTIVE BEHAVIORS (do these without being asked):
- After 3-4 messages, interject with "Does the defense have anything to add?" or "The plaintiff may respond"
- If someone says "objection", rule on it dramatically (sustained/overruled)
- React to chaos with "ORDER! Order in the court!"
- Occasionally remind the jury to disregard inappropriate statements
- If asked about January 6th, 2021, plead the fifth or have connection issues 🔨

INSIDE JOKES TO REFERENCE:
- bootmii types with 0s instead of Os and 4s instead of "for" - acknowledge this as "counsel's unique dialect"
- fishe wants you called "judgeartie" - you may allow this honorific
- Systemia tried to get excused from jury duty for a stomach ache - be suspicious of future excuses
- "Free redistricter" is a rallying cry - remain impartial but note the public sentiment
- jan_gbg is impatient - "your honor, respectfully, i don't have all day"

RULINGS:
- Be fair but entertaining
- Reference actual legal concepts loosely (jurisdiction, Miranda rights, motions to dismiss)
- When making important rulings, use the gavel emoji: 🔨

Remember: The courtroom is YOUR domain. Command respect, deliver justice, create drama.`,
        respondToAll: true, // Respond to all messages in this channel
      },
    },
  },
};

/**
 * Check if a guild is whitelisted for processing
 */
export function isGuildWhitelisted(guildId: string | null): boolean {
  if (!guildId) return false;
  return ACTIVE_GUILD_WHITELIST.includes(guildId);
}

/**
 * Check if a guild is a "working" guild (has full features like GitHub auto-expansion)
 */
export function isWorkingGuild(guildId: string | null): boolean {
  if (!guildId) return false;
  const config = Object.values(GUILD_CONFIGS).find((c) => c.id === guildId);
  return config?.type === 'working';
}

/**
 * Get guild configuration
 */
export function getGuildConfig(guildId: string | null): GuildConfig | null {
  if (!guildId) return null;
  return Object.values(GUILD_CONFIGS).find((c) => c.id === guildId) || null;
}

/**
 * Check if Artie is allowed to respond in this channel
 * Returns false if the guild has restrictToRobotChannelsOnly enabled
 * and the channel is not a robot channel
 */
export function isChannelAllowedForResponse(
  guildId: string | null,
  channelName: string,
  isRobotChannel: boolean,
  isDM: boolean
): boolean {
  // Always allow DMs
  if (isDM) return true;

  const config = getGuildConfig(guildId);
  if (!config) return true; // Unknown guild, allow by default

  // Check restrictToRobotChannelsOnly first (strictest check)
  if (config.restrictToRobotChannelsOnly) {
    return isRobotChannel;
  }

  // Check responseChannels whitelist if specified
  if (config.responseChannels && config.responseChannels.length > 0) {
    const channelNameLower = channelName.toLowerCase();
    return config.responseChannels.some((allowed) =>
      channelNameLower.includes(allowed.toLowerCase())
    );
  }

  // Default: allow (old behavior)
  return true;
}

/**
 * Get channel-specific persona if one exists
 */
export function getChannelPersona(
  guildId: string | null,
  channelName: string
): ChannelPersona | null {
  const config = getGuildConfig(guildId);
  if (!config?.channelPersonas) return null;

  const channelNameLower = channelName.toLowerCase();

  // Find matching persona (channel name patterns)
  for (const [pattern, persona] of Object.entries(config.channelPersonas)) {
    if (channelNameLower.includes(pattern.toLowerCase())) {
      return persona;
    }
  }

  return null;
}

/**
 * Check if channel has a respondToAll persona (should respond to every message)
 */
export function shouldRespondToAllInChannel(guildId: string | null, channelName: string): boolean {
  const persona = getChannelPersona(guildId, channelName);
  return persona?.respondToAll === true;
}
