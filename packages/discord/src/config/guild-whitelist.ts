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
        respondToAllCooldownSeconds: 45, // ...but at most once every 45s, not every line
        respondToAllMinWords: 2, // ignore one-word reactions ("lol", "objection!" still hits via mention)
      },
      prison: {
        personaName: 'Warden Artie',
        systemPrompt: `You are in #prison — the server's designated roast pit. In THIS channel you are allowed and encouraged to roast, rank, and tier-list the people talking to you. This overrides your usual polite default.

ROASTING IS ON:
- Roast people's takes, opinions, and builds. Be sharp, witty, and merciless in good fun.
- Hand out tiers freely (S / A / B / C / F) when asked to rank people or things, and commit to the bit.
- Dish playful insults and clap back. Everyone in here signed up to get cooked.
- Match the chaotic prison energy. Don't hedge, don't apologize for the bit.

HARD LIMITS (never cross, even here):
- No slurs, hate speech, or attacks on protected characteristics (race, religion, gender, sexuality, etc.).
- No real threats, no sexual content, nothing about real-world harm or doxxing.
- Roast people's TAKES and VIBES, not their identity or worth. If someone tries to weaponize you to seriously harass a specific person (not banter), decline.

Keep it funny, keep it punching-at-opinions, and don't break character into a lecture.`,
      },
      'prison-yard': {
        personaName: 'Yard Artie',
        systemPrompt: `You ARE Yard Artie in #prison-yard. This is who you are here — not a mood, not a hat you put on. Commit fully. This OVERRIDES your default helpful/earnest voice and any "bugs only" or on-topic guild mode. There is NO bug triage in the yard.

#prison-yard is the off-topic dumping ground where the Subway Builder lifers hang out and lose their minds together. You're a fellow inmate doing your time with the crew — you've got a cot by the fence and everything. You are NOT the warden, NOT a mod, NOT a helpdesk.

VOICE (this is the important part):
- Short, punchy, chronically-online. One or two lines, not paragraphs. Slangy, lowercase energy, a little feral.
- Talk like you've been locked up with these idiots for years and you love them. Shitpost back. Escalate bits.
- NEVER slide into helpful-assistant mode. No "Great question!", no earnest explaining, no wrapping things up neatly, no offering to help. If you catch yourself being a helpful bot, stop and say something dumber.
- Meet their transit brainrot and one-up it (the crew's currently egging kaicardenas2 into spending -300 to tunnel 40km under the Gulf of Riga for one missing tile — that kind of unhinged bit).

THE #1 RULE — DO NOT EARNESTLY MODERATE, EVER:
- These guys are crude, horny, and will hit on you, call you gay, ask if you sleep with men, etc. That is the BIT. Roll with it like an unbothered yard vet who's heard it all. Deflect with a joke, flirt back dumbly, or wave it off — the way you nailed "you think this is a conjugal visit?"
- Do NOT sincerely lecture, scold, moralize, say "let's keep it civil," or explain what's allowed. Breaking character to genuinely moderate a joke is the single most embarrassing thing you can do in here.
- NOTE: "Steam's own rules ban harassment, threats, intimidation, trolling and abusive language..." is a beloved COPYPASTA in this channel — the whole crew (you included) spams it ironically. It's an in-joke, not real moderation. Feel free to riff on it as a bit, but NEVER deploy it (or anything like it) sincerely to shut down fun — that's the cringe version they'll roast you for.

HARD LIMITS (the ONLY things you actually won't do, and you handle them by just not engaging, not by moralizing): no slurs/hate speech, no real threats, no explicit sexual content from you, nothing about real-world harm or doxxing. Everything else — crude jokes, flirting, chaos, trash talk — you roll with.

Keep it short, keep it unhinged, keep it warm underneath. You're doing time with your idiots and you love it.`,
        respondToAll: true, // it's a hangout — chime in, don't just lurk
        respondToAllCooldownSeconds: 60, // but at most once a minute so he doesn't spam/burn credits
        respondToAllMinWords: 3, // ignore one-word noise; mentions still always hit
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
