import { MessageFlags, PermissionsBitField, SlashCommandBuilder } from 'discord.js';
import { createCase, hideCase } from '../db.js';
import { logCase } from '../services/log.js';
import { sendPunishmentDm } from '../services/notify.js';
import { buildActionEmbed, errorEmbed } from '../utils/embeds.js';
import { canModerateMember, ensureBotPermissions, ensureModerator } from '../utils/permissions.js';

export const data = new SlashCommandBuilder()
  .setName('kick')
  .setDescription('Kick a member from the server')
  .addUserOption((o) => o.setName('user').setDescription('The member to kick').setRequired(true))
  .addStringOption((o) => o.setName('reason').setDescription('Reason for the kick'));

export async function execute(interaction, client) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  if (!(await ensureModerator(interaction, PermissionsBitField.Flags.KickMembers, 'Kick Members', { modRoleAllowed: false }))) return;
  if (!(await ensureBotPermissions(interaction, PermissionsBitField.Flags.KickMembers, 'Kick Members'))) return;

  const member = interaction.options.getMember('user');
  if (!member) {
    await interaction.editReply({ embeds: [errorEmbed('That user is not in this server.')] });
    return;
  }
  if (!(await canModerateMember(interaction, member))) return;

  const reason = interaction.options.getString('reason');
  const caseRow = createCase({
    guildId: interaction.guildId,
    userId: member.id,
    moderatorId: interaction.user.id,
    type: 'kick',
    reason,
  });
  await sendPunishmentDm(member, {
    guild: interaction.guild,
    caseRow,
    clientId: client.user.id,
  });

  try {
    await member.kick(
      `Case #${caseRow.case_number} by ${interaction.user.tag}${reason ? `: ${reason}` : ''}`.slice(0, 512),
    );
  } catch (err) {
    hideCase(caseRow.id);
    await interaction.editReply({ embeds: [errorEmbed(`Could not kick: ${err.message}`)] });
    return;
  }

  await logCase(interaction.guild, caseRow, { clientId: client.user.id });
  await interaction.editReply({
    embeds: [
      buildActionEmbed({
        action: 'kick',
        target: member.user,
        reason,
        guildName: interaction.guild.name,
      }),
    ],
  });
}
