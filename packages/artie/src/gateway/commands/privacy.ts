import { MessageFlags, ChatInputCommandInteraction, SlashCommandBuilder } from 'discord.js';
import { logger } from '../../shared/logger.js';
import { optOut, optIn, isOptedOut } from '../../shared/privacy-opt-out.js';

/**
 * /artie-optout and /artie-optin: self-serve privacy (shared/services/privacy-opt-out.ts).
 * Opting out stops Artie reading, storing or remembering anything you send and deletes what
 * he already holds about you. Replies are always private. Linked from the privacy policy.
 */
const PRIVACY_URL = 'https://coachartie.tools.ejfox.com/privacy';

/**
 * Describe what happened during opt-in.
 */
function optInChangeStatus(changed: boolean): string {
  if (changed) {
    return 'was opted out';
  }
  return 'no-op';
}

export const optOutCommand = {
  data: new SlashCommandBuilder()
    .setName('artie-optout')
    .setDescription("Stop Artie reading, storing or remembering your messages, and delete what he has"),
  async execute(interaction: ChatInputCommandInteraction) {
    const userId = interaction.user.id;
    if (isOptedOut(userId)) {
      return interaction.reply({
        content: `You're already opted out. Artie isn't reading or storing your messages. \`/artie-optin\` turns him back on for you.`,
        flags: MessageFlags.Ephemeral,
      });
    }
    // Every handle they're known by, so memories that name them (stored under other people's
    // ids) go too. Server nickname comes from the member, if this ran in a server.
    const member = interaction.member as { nick?: string | null } | null;
    const removed = optOut(userId, [interaction.user.username, interaction.user.globalName, member?.nick]);
    const total = Object.values(removed).reduce((a, b) => a + b, 0);
    logger.info(`🔒 Privacy opt-out: ${userId} (${total} rows deleted)`, removed);
    return interaction.reply({
      content:
        `Done. Artie will no longer read, store, remember or reply to your messages, and ` +
        `what he held about you (${(removed.memories ?? 0) + (removed.memories_mentioning ?? 0)} memories, ${removed.messages ?? 0} logged messages) is deleted, including memories other conversations formed that named you. ` +
        `Change your mind any time with \`/artie-optin\`. Details: ${PRIVACY_URL}`,
      flags: MessageFlags.Ephemeral,
    });
  },
};

export const optInCommand = {
  data: new SlashCommandBuilder()
    .setName('artie-optin')
    .setDescription('Let Artie read and remember your messages again (undoes /artie-optout)'),
  async execute(interaction: ChatInputCommandInteraction) {
    const changed = optIn(interaction.user.id);
    const changeStatus = optInChangeStatus(changed);
    logger.info(`🔓 Privacy opt-in: ${interaction.user.id} (${changeStatus})`);
    let replyContent: string;
    if (changed) {
      replyContent = `Welcome back. Artie will read and remember your messages again. Nothing deleted earlier comes back.`;
    } else {
      replyContent = `You weren't opted out, so nothing changed.`;
    }
    return interaction.reply({
      content: replyContent,
      flags: MessageFlags.Ephemeral,
    });
  },
};
