/**
 * /scribe — the voice meeting scribe. start/stop are owner-only (shared/config/owner.ts);
 * anyone may run status. Guild-gated to Room 302 Studio only
 * (shared/config/guilds.ts's SCRIBE_ALLOWED_GUILD_IDS/isScribeAllowedGuild) — every other
 * guild, Subway Builder included, gets a polite refusal rather than silently failing later.
 */
import {
  ChannelType,
  ChatInputCommandInteraction,
  MessageFlags,
  SlashCommandBuilder,
  type VoiceBasedChannel,
} from 'discord.js';
import { logger } from '../../shared/logger.js';
import { getErrorMessage } from '../../shared/errors.js';
import { isOwner } from '../../shared/config/owner.js';
import { isScribeAllowedGuild } from '../../shared/config/guilds.js';
import {
  startVoiceScribeSession,
  stopVoiceScribeSession,
  getActiveVoiceSession,
  ensureVoiceStateListener,
} from '../voice/scribe-session.js';

export const ANNOUNCE_TEXT =
  '📝 Artie is taking notes on this call. Opted-out people (`/artie-optout`) are never ' +
  'transcribed. `/scribe stop` ends it.';

function elapsedMinutes(startedAt: number): number {
  return Math.round((Date.now() - startedAt) / 60_000);
}

async function handleStart(interaction: ChatInputCommandInteraction): Promise<void> {
  const guildId = interaction.guildId;
  if (!guildId || !interaction.guild) {
    await interaction.reply({ content: '❌ This only works in a server.', flags: MessageFlags.Ephemeral });
    return;
  }
  if (!isScribeAllowedGuild(guildId)) {
    await interaction.reply({
      content: "❌ Scribe mode isn't approved for this server — Room 302 Studio only.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (!isOwner(interaction.user.id)) {
    await interaction.reply({
      content: '🚫 Only EJ can start a scribe session.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const channelOption = interaction.options.getChannel('channel');
  let voiceChannel: VoiceBasedChannel | null = null;
  if (channelOption) {
    const resolved = interaction.guild.channels.cache.get(channelOption.id);
    if (resolved && 'members' in resolved) {
      voiceChannel = resolved as VoiceBasedChannel;
    }
  } else {
    const voiceState = interaction.guild.voiceStates.cache.get(interaction.user.id);
    voiceChannel = voiceState?.channel ?? null;
  }

  if (!voiceChannel) {
    await interaction.reply({
      content: '❌ Join a voice channel first, or pass `channel`.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply();

  ensureVoiceStateListener(interaction.client);
  const result = await startVoiceScribeSession({
    client: interaction.client,
    channel: voiceChannel,
    textChannelId: interaction.channelId,
    startedBy: interaction.user.id,
  });

  if (!result.ok) {
    await interaction.editReply(`❌ ${result.reason}`);
    return;
  }

  await interaction.editReply(`✅ Joined **${voiceChannel.name}**. Session \`${result.sessionId}\`.`);
  try {
    if (interaction.channel && 'send' in interaction.channel) {
      await interaction.channel.send(ANNOUNCE_TEXT);
    }
  } catch (error) {
    logger.warn('🎙️ Scribe join-announcement failed:', getErrorMessage(error));
  }
}

async function handleStop(interaction: ChatInputCommandInteraction): Promise<void> {
  const guildId = interaction.guildId;
  if (!guildId) {
    await interaction.reply({ content: '❌ This only works in a server.', flags: MessageFlags.Ephemeral });
    return;
  }
  if (!isOwner(interaction.user.id)) {
    await interaction.reply({
      content: '🚫 Only EJ can stop a scribe session.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply();
  const result = await stopVoiceScribeSession(guildId, 'manual-stop');
  if (!result.ok) {
    await interaction.editReply(`❌ ${result.reason}`);
    return;
  }

  let note = '';
  if (typeof result.pendingCount === 'number' && result.pendingCount > 0) {
    note = ` ${result.pendingCount} GitHub action(s) are waiting on approval.`;
  }
  await interaction.editReply(`✅ Stopped. Summary is posting to this channel.${note}`);
}

async function handleStatus(interaction: ChatInputCommandInteraction): Promise<void> {
  const guildId = interaction.guildId;
  if (!guildId) {
    await interaction.reply({ content: '❌ This only works in a server.', flags: MessageFlags.Ephemeral });
    return;
  }
  const session = getActiveVoiceSession(guildId);
  if (!session) {
    await interaction.reply({ content: '📭 No scribe session is running.', flags: MessageFlags.Ephemeral });
    return;
  }
  await interaction.reply({
    content:
      `📝 Active in <#${session.voiceChannelId}>, started by <@${session.startedBy}> ` +
      `${elapsedMinutes(session.startedAt)}m ago. ${session.utteranceCount} utterance(s) so far.`,
    flags: MessageFlags.Ephemeral,
  });
}

export const scribeCommand = {
  data: new SlashCommandBuilder()
    .setName('scribe')
    .setDescription('Voice meeting scribe: join, listen, transcribe, summarize')
    .addSubcommand((s) =>
      s
        .setName('start')
        .setDescription('Start taking notes in a voice channel (owner only)')
        .addChannelOption((o) =>
          o
            .setName('channel')
            .setDescription('Voice channel (default: the one you are in)')
            .addChannelTypes(ChannelType.GuildVoice)
            .setRequired(false)
        )
    )
    .addSubcommand((s) => s.setName('stop').setDescription('Stop and post the summary (owner only)'))
    .addSubcommand((s) => s.setName('status').setDescription('Is scribe mode running right now?')),

  async execute(interaction: ChatInputCommandInteraction) {
    const subcommand = interaction.options.getSubcommand();
    try {
      if (subcommand === 'start') {
        await handleStart(interaction);
        return;
      }
      if (subcommand === 'stop') {
        await handleStop(interaction);
        return;
      }
      await handleStatus(interaction);
    } catch (error) {
      logger.error(`/scribe ${subcommand} failed:`, getErrorMessage(error));
      const content = `❌ Something went wrong: ${getErrorMessage(error)}`;
      if (interaction.replied || interaction.deferred) {
        await interaction.editReply(content).catch(() => {});
      } else {
        await interaction.reply({ content, flags: MessageFlags.Ephemeral }).catch(() => {});
      }
    }
  },
};
