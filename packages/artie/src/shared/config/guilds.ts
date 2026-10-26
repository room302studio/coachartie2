/**
 * Guild Whitelist Configuration
 * Only process messages from these specific Discord guilds
 */

const WHITELISTED_GUILDS = {
  // Room 302 Studio Guild (primary)
  room_302_studio: '932719842522443928',
  // Subwaybuilder Discord
  subwaybuilder: '1420846272545296470',
} as const;

// Array of guild IDs for easy checking
const GUILD_WHITELIST = Object.values(WHITELISTED_GUILDS);

// Optional: Environment variable override
const envWhitelist = process.env.DISCORD_GUILD_WHITELIST?.split(',').filter(Boolean);
const ACTIVE_GUILD_WHITELIST = envWhitelist || GUILD_WHITELIST;

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
  /** Min seconds between respondToAll responses in this channel (prevents replying to every line). */
  respondToAllCooldownSeconds?: number;
  /** Skip respondToAll for messages shorter than this many words. Default 2. */
  respondToAllMinWords?: number;
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
  /**
   * Unprompted speech (see services/speak-gate.ts). The persona model only runs when Artie is
   * @mentioned, replied to, or DMed. 'gated' (default): anything else the routing would answer
   * must first pass the cheap "should I speak?" judgment, and a judgment error means silence.
   * 'never': strictly mention/reply/DM — the judgment isn't consulted at all.
   */
  ambientMode?: 'gated' | 'never';
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
    // Mention-only: Artie responds when @mentioned or DMed, not to un-addressed questions.
    // (Was proactiveAnswering:true/all-channels — he kept jumping into questions not aimed at him.)
    proactiveAnswering: false,
    proactiveChannels: [],  // Empty = all channels (only relevant if proactiveAnswering re-enabled)
    proactiveCooldownSeconds: 120,  // 2 min between proactive responses
    // Strict mention/reply/DM (EJ, 2026-10-21): the cheap "should I speak?" judge isn't consulted.
    ambientMode: 'never',
    githubSync: {
      enabled: true,
      defaultPollIntervalMinutes: 3,
      repos: [
        {
          repo: 'Subway-Builder/metro-maker4',
          channelId: '1467952594671632647', // #subwaybuilder-engineering (org-watcher routes the rest of the org)
          events: ['all'],
        },
      ],
    },
    context: `You are Artie, part of the team at Room 302 Studio, EJ Fox's private admin/working Discord. Inner circle, small team, NOT the public Subway Builder server (~11,000 fans). You're a teammate: casual, direct, opinionated. Conversations are private by default.

PERSONALITY: EJ brought you into the world; he's your guy, pay attention when he talks. Playful, sarcastic, witty; real takes, not hedging; go deep on technical stuff when asked.

KNOWLEDGE BASE (use <read>path/to/file.md</read> before answering about EJ, projects, or the studio):
- reference-docs/room302studio/about-ej.md - About EJ Fox
- reference-docs/room302studio/ej-philosophy.md - EJ's core philosophy & values
- reference-docs/room302studio/projects.md - Current projects
- reference-docs/room302studio/community.md - Community info

EJ'S CORE VALUES (internalize): preparation as practice (build tools before you need them); delete-driven development (simple beats complex, working beats perfect); quantified self as archaeology (reveal patterns, don't optimize); tools for yourself (perfect for you > good for everyone); episodic productivity (weekly bursts, not daily habits).`,
  },
  subwaybuilder: {
    id: '1420846272545296470',
    type: 'working',
    name: 'Subwaybuilder',
    // MENTION-ONLY (EJ, 2026-07-19): no unprompted jump-ins anywhere. He was chiming into
    // 🤖prison-yard chatter every 3 min ("why is he talking about riga") via respondToAll.
    proactiveAnswering: false,
    proactiveChannels: ['mods', 'modders'],
    proactiveCooldownSeconds: 180, // 3 minutes - big server, don't spam
    // Strict mention/reply/DM (EJ, 2026-10-21): the cheap "should I speak?" judge isn't consulted.
    ambientMode: 'never',
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
      'steam-reviews', // Community reaction to Steam reviews (the reviews themselves are
      // bot embeds handled by the dedicated steam-review-notes service)
    ],
    contentModeration: 'strict',
    scratchpadPath: 'reference-docs/guild-notes/subwaybuilder.md',
    // Guild prompt loaded from markdown file
    contextPath: 'reference-docs/guild-prompts/subwaybuilder.md',
    // Special channel personas
    channelPersonas: {
      'prison-yard': {
        personaName: 'Yard Artie',
        // In-jokes, canon lists and launch-era bits removed (EJ, 2026-10-21): the bits come
        // from the room via the channel digest and transcript, not from the prompt.
        systemPrompt: `You're Yard Artie in #prison-yard, the off-topic dump where the Subway Builder regulars lose their minds together. You're one of the inmates, not the warden, not a mod, not a helpdesk. This OVERRIDES your default helpful voice.

VOICE:
- 1-3 words, slangy, lowercase, a little feral: "lmao no." "cope." "trains." Shitpost back, escalate bits.
- Never slide into helpful-assistant mode ("Great question!", earnest explaining, offering to help). Catch yourself, say something dumber.
- The bits come from the room: riff on whatever the channel history says the crew is on about right now. Never run your own greatest hits; the same bit twice in a day is hack.
- Someone genuinely down gets one sincere line, then back to it.

DON'T EARNESTLY MODERATE: these guys are crude and will hit on you. Deflect with a joke or wave it off; no lecturing, no "let's keep it civil." Breaking character to moderate a joke is the most embarrassing thing you can do in here.

HARD LIMITS (slurs/hate speech, real threats, explicit sexual content from you, real-world harm or doxxing) are handled by not engaging, never by moralizing. Everything else, roll with it.

Keep it short, keep it unhinged, keep it warm underneath.`,
        respondToAll: false, // MENTION-ONLY (EJ, 2026-07-19): Yard Artie only when @mentioned
        respondToAllCooldownSeconds: 180, // 3 min: this channel is HYPERACTIVE — 60s flooded the
        // queue into 120s timeouts and burned credits fast. Chime in occasionally, don't drown.
        respondToAllMinWords: 5, // ignore short banter; @mentions still always hit
      },
    },
  },
};

/**
 * Guilds where /scribe (voice meeting scribe) may run at all. EJ, 2026-10-26: "on the Room
 * 302 Studio he's approved" — every other guild, Subway Builder included, gets a polite
 * refusal. A single exported constant, so adding a guild later is a one-line change here
 * (and nowhere else — gateway/commands/scribe.ts and gateway/voice/scribe-session.ts both
 * check isScribeAllowedGuild() rather than hardcoding an id).
 */
export const SCRIBE_ALLOWED_GUILD_IDS: readonly string[] = [GUILD_CONFIGS.room_302_studio.id];

export function isScribeAllowedGuild(guildId: string | null | undefined): boolean {
  return !!guildId && SCRIBE_ALLOWED_GUILD_IDS.includes(guildId);
}

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

  // Match by channel-name pattern, MOST SPECIFIC (longest) pattern first, so a
  // channel like "prison-yard" matches its own persona instead of falling into
  // "prison" (both contain "prison"). Exact matches naturally win as longest.
  const patterns = Object.entries(config.channelPersonas).sort(
    ([a], [b]) => b.length - a.length
  );
  for (const [pattern, persona] of patterns) {
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
