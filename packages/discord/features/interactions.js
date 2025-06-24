import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { logger } from '../utils/logger.js';

/**
 * Creates a row of buttons for message interactions
 * @param {Array} buttons - Array of button configs
 * @returns {ActionRowBuilder}
 */
export function createButtonRow(buttons) {
  const row = new ActionRowBuilder();

  buttons.forEach(btn => {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(btn.id)
        .setLabel(btn.label)
        .setStyle(btn.style || ButtonStyle.Primary)
        .setDisabled(btn.disabled || false)
    );
  });

  return row;
}

/**
 * Adds reaction buttons to a message
 * @param {Message} message - Discord message to add buttons to
 * @param {string} content - Content above buttons
 * @param {Array} buttons - Button configs
 */
export async function addMessageButtons(message, content, buttons) {
  try {
    const row = createButtonRow(buttons);
    await message.reply({
      content,
      components: [row],
    });
  } catch (error) {
    logger.error('Failed to add message buttons:', error);
    throw error;
  }
}

// Update select menu creation helper to follow Discord API limits
export const createSelectMenu = (options, customId = 'llm_select') => {
  // Improved emoji extraction regex
  const emojiRegex = /^(\p{Emoji}+)?\s*(.*)$/u;

  return {
    type: 3, // SELECT_MENU type
    customId,
    placeholder: 'Make a selection...',
    options: options
      .slice(0, 25) // Discord limit: max 25 options
      .map((option, index) => {
        // Extract emoji and text using the new regex
        const [, emoji = '', text = ''] = option.match(emojiRegex) || [];

        // Clean up the text
        const cleanText = text.trim() || `Option ${index + 1}`;

        // Ensure label meets Discord requirements (1-100 chars)
        const label =
          cleanText.length > 100
            ? cleanText.substring(0, 97) + '...'
            : cleanText;

        // Create a unique but readable value
        const value = `${index + 1}_${cleanText
          .toLowerCase()
          .replace(/[^a-z0-9]/g, '_')
          .substring(0, 90)}`;

        // Build the option object
        const selectOption = {
          label,
          value,
        };

        // Only add emoji if one was found
        if (emoji) {
          selectOption.emoji = emoji.trim();
        }

        // Add description if the original text was truncated
        if (cleanText.length > 100) {
          selectOption.description = cleanText.substring(0, 100);
        }

        return selectOption;
      })
      .filter(option => option.label.length > 0), // Remove any empty options
  };
};
