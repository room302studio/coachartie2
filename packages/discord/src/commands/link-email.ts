import { SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder } from 'discord.js';
import { logger } from '@coachartie/shared';
import { linkUserEmail } from '../utils/email-lookup.js';

export const linkEmailCommand = {
  data: new SlashCommandBuilder()
    .setName('link-email')
    .setDescription('Link your email address for Coach Artie to send you emails')
    .addStringOption((option) =>
      option
        .setName('email')
        .setDescription('Your email address (e.g., you@example.com)')
        .setRequired(true)
    ),

  async execute(interaction: ChatInputCommandInteraction) {
    try {
      const email = interaction.options.get('email')?.value as string;
      const userId = interaction.user.id;

      // Validate email format
      const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
      if (!emailRegex.test(email)) {
        return await interaction.reply({
          content: '❌ Invalid email format. Please provide a valid email address.',
          ephemeral: true,
        });
      }

      // Link the email (no verification needed - they control their Discord account)
      await linkUserEmail(userId, email);

      const embed = new EmbedBuilder()
        .setColor(0x00ff00)
        .setTitle('✅ Email Linked Successfully')
        .setDescription(`Your email has been linked to Coach Artie!`)
        .addFields(
          { name: '📧 Email', value: email, inline: false },
          {
            name: '🤖 What can Artie do?',
            value: 'Artie can now email you when you ask (e.g., "email me this later")',
            inline: false,
          },
          {
            name: '🔒 Privacy',
            value: 'Your email is stored securely and only used when you explicitly request it',
            inline: false,
          }
        )
        .setFooter({ text: 'Use /unlink-email to remove your email at any time' });

      await interaction.reply({
        embeds: [embed],
        ephemeral: true,
      });

      logger.info('Email linked via Discord command', { userId, email: email.substring(0, 3) + '***' });
    } catch (error) {
      logger.error('Error in link-email command:', error);
      await interaction.reply({
        content: '❌ An error occurred while linking your email. Please try again.',
        ephemeral: true,
      });
    }
  },
};
