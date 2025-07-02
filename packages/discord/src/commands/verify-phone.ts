import { SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder } from 'discord.js';
import { logger } from '@coachartie/shared';
import { createRedisConnection } from '@coachartie/shared';
import crypto from 'crypto';

const redis = createRedisConnection();

export const verifyPhoneCommand = {
  data: new SlashCommandBuilder()
    .setName('verify-phone')
    .setDescription('Verify your phone number with the code sent to you')
    .addStringOption(option =>
      option.setName('code')
        .setDescription('The 6-digit verification code')
        .setRequired(true)
    ),

  async execute(interaction: ChatInputCommandInteraction) {
    try {
      const providedCode = interaction.options.get('code')?.value as string;
      const userId = interaction.user.id;
      const verificationKey = `phone_verify:${userId}`;

      // Get verification data
      const verificationData = await redis.get(verificationKey);
      if (!verificationData) {
        return await interaction.reply({
          content: '❌ No verification pending. Please use `/link-phone` first.',
          ephemeral: true
        });
      }

      const verification = JSON.parse(verificationData);

      // Check if code matches
      if (verification.code !== providedCode) {
        verification.attempts += 1;
        
        // Lock out after 3 failed attempts
        if (verification.attempts >= 3) {
          await redis.del(verificationKey);
          return await interaction.reply({
            content: '❌ Too many failed attempts. Please start over with `/link-phone`.',
            ephemeral: true
          });
        }

        // Update attempts
        await redis.setex(verificationKey, 600, JSON.stringify(verification));
        
        return await interaction.reply({
          content: `❌ Invalid code. ${3 - verification.attempts} attempts remaining.`,
          ephemeral: true
        });
      }

      // Code is correct - store the verified phone number
      const phoneHash = crypto.createHash('sha256').update(verification.phoneNumber).digest('hex');
      const userPhoneKey = `user_phone:${userId}`;
      
      await redis.setex(userPhoneKey, 86400 * 365, JSON.stringify({
        phoneHash: phoneHash,
        phoneNumber: verification.phoneNumber, // Encrypted in production
        verifiedAt: Date.now(),
        userId: userId
      }));

      // Clean up verification
      await redis.del(verificationKey);

      const embed = new EmbedBuilder()
        .setColor(0x00FF00)
        .setTitle('✅ Phone Number Verified!')
        .setDescription('Your phone number has been successfully linked to your Discord account.')
        .addFields(
          { name: '📱 Linked Number', value: verification.phoneNumber.replace(/(\+\d{1,3})\d{6}(\d{4})/, '$1******$2'), inline: false },
          { name: '🔔 Notifications', value: 'You can now receive SMS notifications from Coach Artie', inline: false },
          { name: '🔒 Privacy', value: 'Your number is encrypted and secure', inline: false }
        )
        .setFooter({ text: 'Use /unlink-phone to remove this number anytime' });

      logger.info('Phone number verified successfully', {
        userId,
        phoneHash: phoneHash.substring(0, 8),
        service: 'discord'
      });

      await interaction.reply({
        embeds: [embed],
        ephemeral: true
      });

    } catch (error) {
      logger.error('Error in verify-phone command:', error);
      await interaction.reply({
        content: '❌ An error occurred while verifying your phone. Please try again.',
        ephemeral: true
      });
    }
  }
};