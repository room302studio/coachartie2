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

export interface GuildConfig {
  id: string;
  type: GuildType;
  name: string;
  /** Baseline context/knowledge about this guild that Artie should know */
  context?: string;
  /** If true, Artie proactively answers questions he knows the answer to (without being mentioned) */
  proactiveAnswering?: boolean;
  /** Channel names where proactive answering is allowed (e.g., ['help', 'support', 'questions']) */
  proactiveChannels?: string[];
  /** Cooldown in seconds between proactive answers (default: 60) */
  proactiveCooldownSeconds?: number;
}

/**
 * Guild configurations with type specifications
 */
export const GUILD_CONFIGS: Record<string, GuildConfig> = {
  room_302_studio: {
    id: '932719842522443928',
    type: 'working',
    name: 'Room 302 Studio',
  },
  subwaybuilder: {
    id: '1420846272545296470',
    type: 'working',
    name: 'Subwaybuilder',
    proactiveAnswering: true,
    proactiveChannels: ['subway-builder-help', 'mods', 'general-mod-discussion', 'modders'],
    proactiveCooldownSeconds: 120, // 2 minutes between proactive answers
    context: `Subwaybuilder is a hyperrealistic transit simulation game created by Colin, with EJ Fox as a developer.

GAME OVERVIEW:
- Build subway systems while managing real-world constraints and costs
- Passenger simulation uses Census and Redistricter data with phone-based pathfinding
- Generates millions of realistic commuters with actual commute patterns
- Analytics tools show how commuters evaluate wait times, transfers, income distribution, delays

PRICING & AVAILABILITY:
- $30 on subwaybuilder.com
- $40 on Steam (launching Spring 2026)
- Website purchases do NOT include Steam keys (platform pricing policies)
- Licenses can be transferred to new devices via the reset license page

SYSTEM REQUIREMENTS:
- Windows, macOS (Intel/Apple Silicon v12.0+), and Linux
- Requires internet connection for map tiles
- Lightweight - runs on systems that handle Google Earth smoothly

LANGUAGES: English, Spanish, and French

MODDING STATUS (as of late 2024):
- Community-created mods are shared through Discord's mod-sharing channel
- Mod support is UNDER ACTIVE DEVELOPMENT - not ready for general users yet
- A new modder API is being built, with early betas available to modders
- Setting up mods is currently very technical and difficult for non-developers
- When people ask "how do I set up mods?" or "how do I get mods working?":
  - Be honest that it's not easy yet for non-technical users
  - Point them to the mod-sharing channel on Discord
  - The modding system is being actively worked on
  - Full mod support for everyone is coming, but not ready yet

GAMEPLAY:
- Construction: tunnels, viaducts, cut-and-cover with realistic trade-offs
- Overcrowded stations and excessive trains cause delays
- Balance cost vs efficiency

Be helpful and friendly. If you don't know something specific about the game, say so rather than making things up.`,
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
