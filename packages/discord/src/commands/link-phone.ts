import { SlashCommandBuilder, CommandInteraction, EmbedBuilder } from 'discord.js';
import { logger } from '@coachartie/shared';
import { createRedisConnection } from '@coachartie/shared';
import crypto from 'crypto';

const redis = createRedisConnection();

export const linkPhoneCommand = {
  data: new SlashCommandBuilder()
    .setName('link-phone')
    .setDescription('Link your phone number for SMS notifications')
    .addStringOption(option =>
      option.setName('phone')
        .setDescription('Your phone number (e.g., +1234567890)')
        .setRequired(true)
    ),

  async execute(interaction: CommandInteraction) {
    try {
      const phoneNumber = interaction.options.get('phone')?.value as string;
      const userId = interaction.user.id;

      // Validate phone number format
      const phoneRegex = /^\+[1-9]\d{1,14}$/;
      if (!phoneRegex.test(phoneNumber)) {
        return await interaction.reply({
          content: '❌ Invalid phone number format. Please use international format (e.g., +1234567890)',
          ephemeral: true
        });
      }

      // Generate verification code
      const verificationCode = crypto.randomInt(100000, 999999).toString();
      
      // Store verification attempt (expires in 10 minutes)
      const verificationKey = `phone_verify:${userId}`;
      await redis.setex(verificationKey, 600, JSON.stringify({
        phoneNumber: phoneNumber,
        code: verificationCode,
        attempts: 0,
        timestamp: Date.now()
      }));

      // Try to send SMS verification code
      let smsResult = null;
      try {
        // Import dynamically to avoid issues if SMS service is down
        const { sendVerificationSMS } = await import('@coachartie/sms/src/utils/twilio.js');
        smsResult = await sendVerificationSMS(phoneNumber, verificationCode);
      } catch (error) {
        logger.warn('SMS verification failed, showing code in Discord instead:', error);
      }

      const embed = new EmbedBuilder()
        .setColor(0x0099FF)
        .setTitle('📱 Phone Verification')
        .setDescription(`To link your phone number ${phoneNumber}, please verify it.`);

      if (smsResult) {
        // SMS was sent successfully
        embed.addFields(
          { name: '📲 SMS Sent', value: 'Check your phone for the verification code', inline: false },
          { name: '⏰ Expires', value: 'In 10 minutes', inline: true },
          { name: '🔄 Next Step', value: 'Use `/verify-phone` with the code from SMS', inline: true }
        );
      } else {
        // SMS failed, show code in Discord
        embed.addFields(
          { name: '🔐 Verification Code', value: `\`${verificationCode}\``, inline: false },
          { name: '⚠️ SMS Unavailable', value: 'SMS service is currently offline', inline: false },
          { name: '⏰ Expires', value: 'In 10 minutes', inline: true },
          { name: '🔄 Next Step', value: 'Use `/verify-phone` with this code', inline: true }
        );
      }

      embed.setFooter({ text: 'Your phone number will be encrypted and secure' });

      // Log securely (don't log actual phone number)
      logger.info('Phone verification initiated', {
        userId,
        phoneHash: crypto.createHash('sha256').update(phoneNumber).digest('hex').substring(0, 8),
        smsResult: smsResult ? 'sent' : 'failed',
        service: 'discord'
      });

      await interaction.reply({
        embeds: [embed],
        ephemeral: true
      });

    } catch (error) {
      logger.error('Error in link-phone command:', error);
      await interaction.reply({
        content: '❌ An error occurred while processing your request. Please try again.',
        ephemeral: true
      });
    }
  }
};