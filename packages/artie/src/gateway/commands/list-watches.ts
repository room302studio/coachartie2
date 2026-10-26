import { MessageFlags, SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder } from 'discord.js';
import { logger } from '../../shared/logger.js';
import { describeEvents, listGuildWatches } from '../watchers/github/watch-list.js';

/**
 * Format watch scope label.
 */
function scopeLabel(channelOnly: boolean): string {
  if (channelOnly) {
    return 'in this channel';
  }
  return 'in this server';
}

/**
 * Format watch scope suffix for title.
 */
function scopeSuffix(channelOnly: boolean): string {
  if (channelOnly) {
    return ' (this channel)';
  }
  return '';
}

/**
 * Format field label for continuation.
 */
function fieldLabel(label: string, part: number): string {
  if (part === 1) {
    return label;
  }
  return `${label} (cont.)`;
}

export const listWatchesCommand = {
  data: new SlashCommandBuilder()
    .setName('list-watches')
    .setDescription('List the GitHub repos Artie watches in this server, and what each one posts')
    .addBooleanOption((option) =>
      option
        .setName('channel-only')
        .setDescription('Only show watches posting to this channel')
        .setRequired(false)
    ),

  async execute(interaction: ChatInputCommandInteraction) {
    const guildId = interaction.guildId;
    if (!guildId) {
      return interaction.reply({
        content: '❌ This command only works in a server.',
        flags: MessageFlags.Ephemeral,
      });
    }
    const channelOnly = interaction.options.getBoolean('channel-only') ?? false;

    try {
      let watchChannelFilter: string | undefined;
      if (channelOnly) {
        watchChannelFilter = interaction.channelId;
      } else {
        watchChannelFilter = undefined;
      }
      const watches = listGuildWatches(guildId, watchChannelFilter);
      if (watches.length === 0) {
        return interaction.reply({
          content: `📭 No repos watched ${scopeLabel(channelOnly)}. \`/watch-repo\` adds one.`,
          flags: MessageFlags.Ephemeral,
        });
      }

      const active = watches.filter((w) => w.isActive);
      const paused = watches.filter((w) => !w.isActive);
      const line = (w: (typeof watches)[number]) =>
        `• \`${w.repo}\` → <#${w.channelId}> · ${describeEvents(w.events)}`;

      const embed = new EmbedBuilder()
        .setColor(0x1f6feb)
        .setTitle(`👀 GitHub watches${scopeSuffix(channelOnly)}`)
        .setDescription(`${active.length} active · ${paused.length} paused`);
      // Embed field values cap at 1024 chars; chunk long lists across fields.
      const addList = (label: string, rows: typeof watches) => {
        let chunk = '';
        let part = 1;
        for (const text of rows.map(line)) {
          if (chunk.length + text.length + 1 > 1000) {
            embed.addFields({ name: fieldLabel(label, part), value: chunk });
            chunk = '';
            part++;
          }
          chunk += `${text}\n`;
        }
        if (chunk) embed.addFields({ name: fieldLabel(label, part), value: chunk });
      };
      if (active.length) addList('▶️ Active', active);
      if (paused.length) addList('⏸️ Paused', paused);
      embed.setFooter({ text: '/watch-repo adds or changes one · /unwatch-repo pauses' });

      await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    } catch (error) {
      logger.error('Error in list-watches command:', error);
      await interaction.reply({
        content: '❌ Could not list watches. Check the logs.',
        flags: MessageFlags.Ephemeral,
      });
    }
  },
};
