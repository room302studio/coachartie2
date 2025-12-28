import { SlashCommandBuilder, CommandInteraction, EmbedBuilder } from 'discord.js';
import { logger, isRedisAvailable, hasRedisBeenChecked } from '@coachartie/shared';

// Lazy-load Redis connection to avoid errors at startup
let redis: any = null;
function getRedis() {
  if (!redis) {
    const { createRedisConnection } = require('@coachartie/shared');
    redis = createRedisConnection();
  }
  return redis;
}

export const unlinkPhoneCommand = {
  data: new SlashCommandBuilder()
    .setName('unlink-phone')
    .setDescription('Remove your linked phone number'),

  async execute(interaction: CommandInteraction) {
    try {
      // Check Redis availability
      if (hasRedisBeenChecked() && !isRedisAvailable()) {
        return await interaction.reply({
          content: '❌ Service temporarily unavailable. Please try again later.',
          ephemeral: true,
        });
      }

      const userId = interaction.user.id;
      const userPhoneKey = `user_phone:${userId}`;

      // Check if user has a phone linked
      const phoneData = await getRedis().get(userPhoneKey);
      if (!phoneData) {
        return await interaction.reply({
          content: '❌ No phone number is currently linked to your account.',
          ephemeral: true,
        });
      }

      const phone = JSON.parse(phoneData);
      const maskedNumber = phone.phoneNumber.replace(/(\+\d{1,3})\d{6}(\d{4})/, '$1******$2');

      // Remove the phone number
      await getRedis().del(userPhoneKey);

      const embed = new EmbedBuilder()
        .setColor(0xff9900)
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
        service: 'discord',
      });

      await interaction.reply({
        embeds: [embed],
        ephemeral: true,
      });
    } catch (error) {
      logger.error('Error in unlink-phone command:', error);
      await interaction.reply({
        content: '❌ An error occurred while unlinking your phone. Please try again.',
        ephemeral: true,
      });
    }
  },
};
