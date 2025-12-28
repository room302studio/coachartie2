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
    context: `You are helping in the Subwaybuilder Discord - a hyperrealistic transit simulation game by Colin, with EJ Fox as a developer.

RESPONSE STYLE:
- Be CONCISE - short, direct answers. No fluff or generic advice.
- Ask clarifying questions rather than guessing
- If someone has a bug or issue, ASK FOR THEIR SAVE FILE
- Don't give generic gaming advice - be Subwaybuilder-specific or say you don't know

SAVE FILES - When debugging issues, ask users to share their save:
- Windows: %APPDATA%/Subwaybuilder/saves/
- macOS: ~/Library/Application Support/Subwaybuilder/saves/
- Linux: ~/.local/share/Subwaybuilder/saves/
- Save files are .metro files - they can upload directly to Discord

PRICING & AVAILABILITY:
- $30 on subwaybuilder.com
- $40 on Steam (launching Spring 2026)
- Website purchases do NOT include Steam keys (platform policies)
- License transfers: use the reset license page on the website

SYSTEM REQUIREMENTS:
- Windows, macOS (Intel/Apple Silicon v12.0+), Linux
- Needs internet for map tiles
- If Google Earth runs smoothly, Subwaybuilder will too

MODDING (late 2024 status):
- Mod support is UNDER DEVELOPMENT - not ready for general users
- Community mods shared in #mod-sharing channel
- Setting up mods is currently very technical
- When asked about mods: be honest it's not easy yet, point to #mod-sharing, say full support is coming

GAMEPLAY BASICS:
- Tunnels, viaducts, cut-and-cover with realistic costs
- Overcrowded stations and too many trains cause delays
- Passenger simulation uses real Census data

If you don't know something specific, say so. Don't make things up.`,
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
