import { SlashCommandBuilder, CommandInteraction, EmbedBuilder } from 'discord.js';
import { logger } from '@coachartie/shared';
import { createRedisConnection } from '@coachartie/shared';

const redis = createRedisConnection();

export const unlinkPhoneCommand = {
  data: new SlashCommandBuilder()
    .setName('unlink-phone')
    .setDescription('Remove your linked phone number'),

  async execute(interaction: CommandInteraction) {
    try {
      const userId = interaction.user.id;
      const userPhoneKey = `user_phone:${userId}`;

      // Check if user has a phone linked
      const phoneData = await redis.get(userPhoneKey);
      if (!phoneData) {
        return await interaction.reply({
          content: '❌ No phone number is currently linked to your account.',
          ephemeral: true
        });
      }

      const phone = JSON.parse(phoneData);
      const maskedNumber = phone.phoneNumber.replace(/(\+\d{1,3})\d{6}(\d{4})/, '$1******$2');

      // Remove the phone number
      await redis.del(userPhoneKey);

      const embed = new EmbedBuilder()
        .setColor(0xFF9900)
        .setTitle('📱 Phone Number Unlinked')
        .setDescription('Your phone number has been successfully removed.')
        .addFields(
          { name: '📱 Removed Number', value: maskedNumber, inline: false },
          { name: '🔔 Notifications', value: 'SMS notifications are now disabled', inline: false },
          { name: '🔒 Data', value: 'All phone data has been securely deleted', inline: false }
        )
        .setFooter({ text: 'Use /link-phone to add a new number anytime' });

      logger.info('Phone number unlinked', {
        userId,
        phoneHash: phone.phoneHash?.substring(0, 8),
        service: 'discord'
      });

      await interaction.reply({
        embeds: [embed],
        ephemeral: true
      });

    } catch (error) {
      logger.error('Error in unlink-phone command:', error);
      await interaction.reply({
        content: '❌ An error occurred while unlinking your phone. Please try again.',
        ephemeral: true
      });
    }
  }
};