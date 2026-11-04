import { MessageFlags, PermissionsBitField, SlashCommandBuilder } from 'discord.js';
import { sendModLog } from '../services/log.js';
import { buildActionEmbed, errorEmbed } from '../utils/embeds.js';
import { canModerateMember, ensureBotPermissions, ensureModerator, roleAssignabilityError } from '../utils/permissions.js';

export const data = new SlashCommandBuilder()
  .setName('addrole')
  .setDescription('Give a member a role')
  .addUserOption((o) => o.setName('user').setDescription('The member to give the role').setRequired(true))
  .addRoleOption((o) => o.setName('role').setDescription('The role to give').setRequired(true))
  .addStringOption((o) => o.setName('reason').setDescription('Reason for the audit log'));

// Audit-log reason string (Discord caps it at 512 chars).
const auditReason = (reason, by) => `${reason || 'Role added'} (by ${by})`.slice(0, 512);

export async function execute(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  if (!(await ensureModerator(interaction, PermissionsBitField.Flags.ManageRoles, 'Manage Roles'))) return;
  if (!(await ensureBotPermissions(interaction, PermissionsBitField.Flags.ManageRoles, 'Manage Roles'))) return;

  const user = interaction.options.getUser('user', true);
  const role = interaction.options.getRole('role', true);
  const reason = interaction.options.getString('reason');

  const roleError = roleAssignabilityError(interaction.guild, role);
  if (roleError) return interaction.editReply({ embeds: [errorEmbed(roleError)] });

  // Hierarchy for the caller: only administrators may manage roles at or above their own.
  if (
    !interaction.member.permissions.has(PermissionsBitField.Flags.Administrator) &&
    role.position >= interaction.member.roles.highest.position
  ) {
    return interaction.editReply({
      embeds: [errorEmbed(`The **${role.name}** role is at or above your highest role.`)],
    });
  }

  const target = await interaction.guild.members.fetch(user.id).catch(() => null);
  if (!target) return interaction.editReply({ embeds: [errorEmbed('That user is not in this server.')] });
  if (!(await canModerateMember(interaction, target))) return;

  if (target.roles.cache.has(role.id)) {
    return interaction.editReply({
      embeds: [errorEmbed(`<@${target.id}> already has the **${role.name}** role.`)],
    });
  }

  try {
    await target.roles.add(role, auditReason(reason, interaction.user.tag));
  } catch (err) {
    console.error('[addrole] Failed to add the role:', err.message);
    return interaction.editReply({ embeds: [errorEmbed(`Could not give the role: ${err.message}`)] });
  }

  const embed = buildActionEmbed({
    action: 'addrole',
    target: target.user,
    roleId: role.id,
    reason,
    guildName: interaction.guild.name,
  });
  await sendModLog(interaction.guild, embed);
  await interaction.editReply({ embeds: [embed] });
}
