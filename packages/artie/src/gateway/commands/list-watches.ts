import { MessageFlags, SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder } from 'discord.js';
import { logger } from '@coachartie/shared';
import { describeEvents, listGuildWatches } from '../services/github-watches.js';

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
      const watches = listGuildWatches(guildId, channelOnly ? interaction.channelId : undefined);
      if (watches.length === 0) {
        return interaction.reply({
          content: `📭 No repos watched ${channelOnly ? 'in this channel' : 'in this server'}. \`/watch-repo\` adds one.`,
          flags: MessageFlags.Ephemeral,
        });
      }

      const active = watches.filter((w) => w.isActive);
      const paused = watches.filter((w) => !w.isActive);
      const line = (w: (typeof watches)[number]) =>
        `• \`${w.repo}\` → <#${w.channelId}> · ${describeEvents(w.events)}`;

      const embed = new EmbedBuilder()
        .setColor(0x1f6feb)
        .setTitle(`👀 GitHub watches${channelOnly ? ' (this channel)' : ''}`)
        .setDescription(`${active.length} active · ${paused.length} paused`);
      // Embed field values cap at 1024 chars; chunk long lists across fields.
      const addList = (label: string, rows: typeof watches) => {
        let chunk = '';
        let part = 1;
        for (const text of rows.map(line)) {
          if (chunk.length + text.length + 1 > 1000) {
            embed.addFields({ name: part === 1 ? label : `${label} (cont.)`, value: chunk });
            chunk = '';
            part++;
          }
          chunk += `${text}\n`;
        }
        if (chunk) embed.addFields({ name: part === 1 ? label : `${label} (cont.)`, value: chunk });
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
