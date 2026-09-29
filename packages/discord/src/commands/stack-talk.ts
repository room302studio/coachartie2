import {
  ChatInputCommandInteraction,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import { logger, isOwner } from '@coachartie/shared';

/**
 * /stack-talk — ask a cheap long-context model a question over a huge pack of Artie's
 * memories (capabilities POST /stack-talk). Owner-only; the reply is private unless `public`,
 * because answers can quote anyone's memories.
 */
const DISCORD_LIMIT = 1900;

export function chunkForDiscord(text: string, limit = DISCORD_LIMIT): string[] {
  const chunks: string[] = [];
  let rest = text.trim();
  while (rest.length > limit) {
    // Break at the last paragraph/line/space inside the limit rather than mid-word.
    const window = rest.slice(0, limit);
    const cut = Math.max(window.lastIndexOf('\n\n'), window.lastIndexOf('\n'), window.lastIndexOf(' '));
    const at = cut > limit * 0.5 ? cut : limit;
    chunks.push(rest.slice(0, at).trimEnd());
    rest = rest.slice(at).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

export const stackTalkCommand = {
  data: new SlashCommandBuilder()
    .setName('stack-talk')
    .setDescription("Ask the stacks: a cheap long-context model over Artie's memories (owner only)")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption((o) =>
      o.setName('question').setDescription('What do you want to know?').setRequired(true)
    )
    .addBooleanOption((o) =>
      o
        .setName('deep')
        .setDescription('~1M tokens of memories on a 1M-context model (default: ~200k on Kimi)')
    )
    .addUserOption((o) => o.setName('person').setDescription('Only memories about this person'))
    .addBooleanOption((o) =>
      o.setName('this-server').setDescription('Only memories from this server')
    )
    .addBooleanOption((o) =>
      o.setName('public').setDescription('Post the answer in the channel (default: only you see it)')
    ),

  async execute(interaction: ChatInputCommandInteraction) {
    if (!isOwner(interaction.user.id)) {
      await interaction.reply({ content: 'stack-talk is owner-only.', flags: MessageFlags.Ephemeral });
      return;
    }

    const question = interaction.options.getString('question', true);
    const deep = interaction.options.getBoolean('deep') ?? false;
    const person = interaction.options.getUser('person');
    const thisServer = interaction.options.getBoolean('this-server') ?? false;
    const isPublic = interaction.options.getBoolean('public') ?? false;
    const flags = isPublic ? undefined : MessageFlags.Ephemeral;

    await interaction.deferReply({ flags });

    const capabilitiesUrl = process.env.CAPABILITIES_URL || 'http://localhost:47324';
    try {
      const res = await fetch(`${capabilitiesUrl}/stack-talk`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question,
          askedBy: interaction.user.id,
          deep,
          scope: {
            userId: person?.id,
            guildId: thisServer ? interaction.guildId ?? undefined : undefined,
          },
        }),
        signal: AbortSignal.timeout(240_000),
      });
      const data = (await res.json()) as {
        success: boolean;
        error?: string;
        answer?: string;
        model?: string;
        packTokens?: number;
        memoriesIncluded?: number;
        memoriesInScope?: number;
        memoriesMatched?: number;
        ms?: number;
      };
      if (!data.success) {
        await interaction.editReply(`📚 stack-talk failed: ${data.error ?? res.status}`);
        return;
      }

      const scopeNote = [person ? `about ${person.username}` : '', thisServer ? 'this server' : '']
        .filter(Boolean)
        .join(', ');
      const footer =
        `-# 📚 ${data.model} · ${data.memoriesIncluded}/${data.memoriesInScope} memories` +
        ` (~${Math.round((data.packTokens ?? 0) / 1000)}k tok, ${data.memoriesMatched} keyword hits)` +
        `${scopeNote ? ` · ${scopeNote}` : ''} · ${Math.round((data.ms ?? 0) / 1000)}s`;
      const chunks = chunkForDiscord(`**${question}**\n\n${data.answer || '(no answer)'}\n\n${footer}`);

      await interaction.editReply(chunks[0]);
      for (const chunk of chunks.slice(1)) {
        await interaction.followUp({ content: chunk, flags });
      }
    } catch (error) {
      logger.error('stack-talk command failed:', error);
      await interaction
        .editReply(`📚 stack-talk failed: ${error instanceof Error ? error.message : String(error)}`)
        .catch(() => {});
    }
  },
};
