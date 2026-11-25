/**
 * Guild context: the per-guild knowledge block (context file + scratchpad) and the
 * reply-time stack built on top of it (channel persona, Subway Builder rule blocks,
 * Artie's live display name). Moved verbatim out of on-message.ts (wave 5).
 */

import type { Message } from 'discord.js';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { logger } from '../../shared/logger.js';
import { getGuildDocsRoot } from '../../shared/paths.js';
import { isStaffRole } from '../../shared/staff-role.js';
import type { ChannelPersona, GuildConfig } from '../../shared/config/guilds.js';
import {
  getShortRulesBlock,
  getStaffRespectBlock,
  getJanRuleBlock,
  getClapBackBlock,
} from '../../shared/config/guild-prompt-blocks.js';

/**
 * Load guild context with scratchpad notes
 * Returns the base context plus any notes from the guild's scratchpad file
 */

// Exported so the prompt-measurement harness can build the REAL guild context. Measuring
// without it understated the prompt by ~4,000 tokens and produced a 68%-reduction claim that
// was pure instrument error — the harness was reading a February fallback file instead of the
// live 8.5KB persona this assembles.
export function getEnhancedGuildContext(
  guildConfig: GuildConfig | null | undefined
): string | undefined {
  // Load context from file if contextPath is set, otherwise use inline context
  let baseContext: string | undefined;

  if (guildConfig?.contextPath) {
    try {
      const baseDir = getGuildDocsRoot();
      const contextFullPath = join(baseDir, guildConfig.contextPath);
      if (existsSync(contextFullPath)) {
        baseContext = readFileSync(contextFullPath, 'utf-8');
      } else {
        logger.warn(`Context file not found for ${guildConfig.name}: ${contextFullPath}`);
        baseContext = guildConfig.context; // Fall back to inline
      }
    } catch (error) {
      logger.warn(`Failed to load context file for ${guildConfig.name}:`, error);
      baseContext = guildConfig.context; // Fall back to inline
    }
  } else {
    baseContext = guildConfig?.context;
  }

  if (!baseContext) return undefined;

  let fullContext = baseContext;

  // Load scratchpad if configured (guildConfig is guaranteed to exist if we have baseContext from it)
  if (guildConfig?.scratchpadPath) {
    try {
      const scratchpadFullPath = join(getGuildDocsRoot(), guildConfig.scratchpadPath);
      if (existsSync(scratchpadFullPath)) {
        const scratchpadContent = readFileSync(scratchpadFullPath, 'utf-8');
        fullContext += `

📝 YOUR SCRATCHPAD (your personal notes for this guild):
${scratchpadContent}

To add a note, call the scratchpad tool (action "note" or "append", with the date and who it's
about); "write" replaces the whole pad. What you save shows up here next turn.`;
      }
    } catch (error) {
      logger.warn(`Failed to load scratchpad for ${guildConfig?.name}:`, error);
    }
  }

  return fullContext;
}

/**
 * The guild knowledge block an addressed/approved reply carries: the guild context (or the
 * proactive judgment's copy of it), replaced by a channel persona where one exists, with the
 * Subway Builder rule blocks and Artie's live display name stacked on top.
 */
export function buildReplyGuildContext(
  message: Message,
  guildConfig: GuildConfig | null,
  channelPersona: ChannelPersona | null,
  proactiveAnswerContext: string | undefined,
  shortId: string
): string | undefined {
  // Process with unified intent processor
  // Always pass guild context if available (not just for proactive answers)
  let guildContextToPass = proactiveAnswerContext || getEnhancedGuildContext(guildConfig);

  // If there's a channel persona (Judge/Warden/Yard Artie), it REPLACES the
  // guild's on-topic mandate for this channel. Otherwise the Subway Builder
  // guild context (currently "BUGS ONLY triage" mode) leaks into persona
  // channels and drags them back into bug-collector voice — which is exactly
  // why Yard Artie kept begging for bug reports in #prison-yard.
  if (channelPersona?.systemPrompt) {
    const personaContext = `🎭 CHANNEL PERSONA — this defines who you are and how you behave in this channel. It OVERRIDES any other guild focus/mode.

${channelPersona.systemPrompt}
---
`;
    guildContextToPass = personaContext;
    logger.info(`⚖️ Applying ${channelPersona.personaName} persona (replaces guild focus) [${shortId}]`);
  }

  // 😤 CLAP-BACK: if a user is hostile/trolling/baiting/creepy toward Artie, he can be
  // really mean right back. Reactive only — normal users get normal Artie. Slur/hate
  // blocklist still enforced on output. Scoped to the Subway Builder guild.
  if (message.guildId === '1420846272545296470') {
    guildContextToPass = getShortRulesBlock() + (guildContextToPass || '');
    const _ju = (message.author.username || '').toLowerCase();
    const _jd = (message.author.displayName || '').toLowerCase();
    const isJanGbg = _ju === 'jan_gbg' || _jd === 'jan_gbg';
    let _roles: string[];
    if (message.member) {
      _roles = message.member.roles.cache.map((r) => r.name.toLowerCase());
    } else {
      _roles = [];
    }
    const isStaff =
      _ju === 'hudson' ||
      _jd === 'hudson' ||
      _roles.some((r) => isStaffRole(r));
    // Staff (mods/devs/admins) + Hudson get baseline respect, always.
    guildContextToPass = getStaffRespectBlock() + (guildContextToPass || '');
    // jan_gbg is universally protected: always warm + respectful, never roasted.
    guildContextToPass = getJanRuleBlock() + (guildContextToPass || '');
    const clapBack = getClapBackBlock();
    if (!isJanGbg && !isStaff) {
      guildContextToPass = clapBack + (guildContextToPass || '');
    }
  }

  // Self-awareness: Artie's live per-guild display name, so nickname bits land
  // ("who's Sterling?" — that's you) and he knows what to change FROM.
  const botDisplayName = message.guild?.members?.me?.displayName;
  if (botDisplayName) {
    guildContextToPass =
      `YOUR NAME HERE: you currently appear in this server as "${botDisplayName}" — when people use that name, they mean you. You can change it anytime with the discord-nickname capability.\n\n` +
      (guildContextToPass || '');
  }

  return guildContextToPass;
}
