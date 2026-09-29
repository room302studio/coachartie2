import {
  ChatInputCommandInteraction,
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import { logger, isOwner, dmPairingService } from '@coachartie/shared';

/**
 * /pairing — manage who may DM Artie (the DM gate). Owner-only; works in a server or in a DM
 * with Artie. The phone alert for a new pairing request points here: approving through the
 * slash command is deterministic and free, where "tell Artie: pairing approve <code>" runs
 * a full model turn.
 */
export const pairingCommand = {
  data: new SlashCommandBuilder()
    .setName('pairing')
    .setDescription('Manage who can DM Artie (owner only)')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand((s) => s.setName('list').setDescription('Pending requests and the allowlist'))
    .addSubcommand((s) =>
      s
        .setName('approve')
        .setDescription('Approve a pairing request by its code')
        .addStringOption((o) => o.setName('code').setDescription('6-digit code').setRequired(true))
    )
    .addSubcommand((s) =>
      s
        .setName('deny')
        .setDescription('Deny a pairing request by its code')
        .addStringOption((o) => o.setName('code').setDescription('6-digit code').setRequired(true))
    )
    .addSubcommand((s) =>
      s
        .setName('allow')
        .setDescription('Let someone DM Artie without a code')
        .addUserOption((o) => o.setName('user').setDescription('Who').setRequired(true))
    )
    .addSubcommand((s) =>
      s
        .setName('revoke')
        .setDescription("Remove someone's DM access")
        .addUserOption((o) => o.setName('user').setDescription('Who').setRequired(true))
    ),

  async execute(interaction: ChatInputCommandInteraction) {
    const reply = (content: string) =>
      interaction.reply({ content, flags: MessageFlags.Ephemeral });
    if (!isOwner(interaction.user.id)) return reply('Only the owner can manage DM pairing.');

    const by = interaction.user.id;
    try {
      switch (interaction.options.getSubcommand()) {
        case 'list': {
          const pending = dmPairingService.listPending('discord');
          const allowed = dmPairingService.listAllowed('discord');
          const embed = new EmbedBuilder()
            .setColor(0x5865f2)
            .setTitle('🔐 DM pairing')
            .addFields(
              {
                name: `Pending (${pending.length})`,
                value:
                  pending
                    .map(
                      (p) =>
                        `• \`${p.code}\` ${p.username ?? p.userId} <@${p.userId}>` +
                        (p.firstMessage ? ` — "${p.firstMessage.slice(0, 60)}"` : '')
                    )
                    .join('\n')
                    .slice(0, 1024) || 'none',
              },
              {
                name: `Allowed (${allowed.length}, plus you)`,
                value:
                  allowed
                    .map((a) => `• ${a.username ?? a.userId} <@${a.userId}>`)
                    .join('\n')
                    .slice(0, 1024) || 'nobody else',
              }
            );
          return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
        }
        case 'approve': {
          const code = interaction.options.getString('code', true).trim();
          const r = dmPairingService.approve(code, by, 'approved via /pairing');
          return reply(
            r.success
              ? `✅ Approved ${r.username ?? r.userId} (<@${r.userId}>). They can DM Artie now.`
              : `❌ ${r.error}`
          );
        }
        case 'deny': {
          const code = interaction.options.getString('code', true).trim();
          const r = dmPairingService.deny(code, by);
          return reply(r.success ? `🚫 Denied \`${code}\`.` : `❌ ${r.error}`);
        }
        case 'allow': {
          const user = interaction.options.getUser('user', true);
          dmPairingService.addToAllowlist('discord', user.id, user.username, by, 'allowed via /pairing');
          return reply(`✅ ${user.username} (<@${user.id}>) can DM Artie now.`);
        }
        case 'revoke': {
          const user = interaction.options.getUser('user', true);
          const r = dmPairingService.revoke('discord', user.id, by);
          return reply(
            r.success ? `🔒 Revoked DM access for ${user.username} (<@${user.id}>).` : `❌ ${r.error}`
          );
        }
        default:
          return reply('Unknown subcommand.');
      }
    } catch (error) {
      logger.error('Error in /pairing:', error);
      return reply('❌ Pairing command failed (nothing changed). Check the logs.');
    }
  },
};
