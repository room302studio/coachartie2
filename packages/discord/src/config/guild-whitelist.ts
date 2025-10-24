/**
 * Guild Whitelist Configuration
 * Only process messages from these specific Discord guilds
 */

export const WHITELISTED_GUILDS = {
  // Room 302 Studio Guild (primary)
  room_302_studio: '932719842522443928',
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
