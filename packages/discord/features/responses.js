import { EmbedBuilder } from 'discord.js';

/**
 * Creates a consistent embed response
 */
export function createResponseEmbed({
  title,
  description,
  fields = [],
  color = '#0099ff',
}) {
  return new EmbedBuilder()
    .setColor(color)
    .setTitle(title)
    .setDescription(description)
    .addFields(fields)
    .setTimestamp()
    .setFooter({ text: 'Coach Artie' });
}
