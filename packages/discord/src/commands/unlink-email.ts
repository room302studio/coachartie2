import { SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder } from 'discord.js';
import { logger } from '@coachartie/shared';
import { unlinkUserEmail, getUserEmail } from '../utils/email-lookup.js';

export const unlinkEmailCommand = {
  data: new SlashCommandBuilder()
    .setName('unlink-email')
    .setDescription('Unlink your email address from Coach Artie'),

  async execute(interaction: ChatInputCommandInteraction) {
    try {
      const userId = interaction.user.id;

      // Check if email is linked
      const linkedEmail = await getUserEmail(userId);
      if (!linkedEmail) {
        return await interaction.reply({
          content: '❌ You don\'t have an email linked. Use `/link-email` to link one.',
          ephemeral: true,
        });
      }

      // Unlink the email
      await unlinkUserEmail(userId);

      const embed = new EmbedBuilder()
        .setColor(0xff9900)
        .setTitle('🔓 Email Unlinked')
        .setDescription('Your email has been removed from Coach Artie.')
        .addFields({
          name: '📧 Removed',
          value: linkedEmail.email,
          inline: false,
        })
        .setFooter({ text: 'You can link a new email anytime with /link-email' });

      await interaction.reply({
        embeds: [embed],
        ephemeral: true,
      });

      logger.info('Email unlinked via Discord command', { userId });
    } catch (error) {
      logger.error('Error in unlink-email command:', error);
      await interaction.reply({
        content: '❌ An error occurred while unlinking your email. Please try again.',
        ephemeral: true,
      });
    }
  },
};
