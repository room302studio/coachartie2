/**
 * Guild context: the per-guild knowledge block (context file + scratchpad) and the
 * reply-time stack built on top of it (channel persona, Subway Builder rule blocks,
 * Artie's live display name). Moved verbatim out of on-message.ts (wave 5).
 */

import type { Message } from 'discord.js';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { logger } from '../../shared/logger.js';
import { REPO_ROOT } from '../../shared/paths.js';
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
/**
 * Resolve the repo root that holds reference-docs/. This used to probe `APP_ROOT`, the
 * hardcoded Docker path `/app`, and two cwd-relative guesses in order, falling through to the
 * next candidate whenever the previous one didn't actually contain reference-docs/. Docker
 * support was removed in wave 1 (the `/app` and bare-cwd candidates are unreachable dead code:
 * `.env.production` is read by `ecosystem.config.cjs`, not by this process, so I can't confirm
 * `APP_ROOT` is unset there — the `APP_ROOT` override itself stays, exactly as before, rather
 * than assume). `REPO_ROOT` (found by walking up to `pnpm-workspace.yaml`, not by probing cwd)
 * replaces the cwd-relative fallback, since it always contains reference-docs/ in every
 * environment this now runs in.
 */
function resolveRepoRoot(): string {
  const appRoot = process.env.APP_ROOT;
  if (appRoot && existsSync(join(appRoot, 'reference-docs'))) return appRoot;
  return REPO_ROOT;
}

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
      const baseDir = resolveRepoRoot();
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
      const scratchpadFullPath = join(resolveRepoRoot(), guildConfig.scratchpadPath);
      if (existsSync(scratchpadFullPath)) {
        const scratchpadContent = readFileSync(scratchpadFullPath, 'utf-8');
        fullContext += `

📝 YOUR SCRATCHPAD (your personal notes for this guild):
${scratchpadContent}

To add notes: <append path="${guildConfig.scratchpadPath}">
## New Note (include date/username)
Your observation here
</append>

To rewrite entirely: <write path="${guildConfig.scratchpadPath}">full new content</write>
To delete: <rm path="${guildConfig.scratchpadPath}" />`;
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
    const _roles = message.member ? message.member.roles.cache.map((r) => r.name.toLowerCase()) : [];
    const isStaff =
      _ju === 'hudson' ||
      _jd === 'hudson' ||
      _roles.some((r) => /\b(dev|developer|moderator|admin|administrator|staff|sbat)\b/.test(r));
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
