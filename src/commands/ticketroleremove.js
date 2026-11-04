import { MessageFlags, PermissionsBitField, SlashCommandBuilder } from 'discord.js';
import { COLORS } from '../constants.js';
import { sendModLog } from '../services/log.js';
import { removeTicketStaffRole, ticketStaffRoleIds } from '../services/tickets.js';
import { baseEmbed, errorEmbed, successEmbed } from '../utils/embeds.js';
import { ensureModerator, roleAssignabilityError } from '../utils/permissions.js';

export const data = new SlashCommandBuilder()
  .setName('ticketroleremove')
  .setDescription('Remove a permanent ticket-staff role (extra list; legacy staff and mod roles stay in config)')
  .addRoleOption((o) =>
    o.setName('role').setDescription('Ticket-staff role to remove from the permanent list').setRequired(true),
  );

export async function execute(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  if (!(await ensureModerator(interaction, PermissionsBitField.Flags.ManageGuild, 'Manage Server'))) return;

  const role = interaction.options.getRole('role', true);

  const roleError = roleAssignabilityError(interaction.guild, role);
  if (roleError) return interaction.editReply({ embeds: [errorEmbed(roleError)] });

  const result = await removeTicketStaffRole(
    interaction.guild,
    role,
    `Ticket staff role removed by ${interaction.user.tag}`,
  ).catch((err) => {
    console.error('[ticketroleremove] Failed:', err.message);
    return { error: `Could not update the ticket staff roles: ${err.message}` };
  });
  if (result?.error) return interaction.editReply({ embeds: [errorEmbed(result.error)] });

  const remaining = ticketStaffRoleIds();
  const lines = [];
  if (result.revoked) {
    lines.push(`<@&${role.id}> no longer manages tickets.`);
    lines.push(
      result.ok
        ? `Access revoked on **${result.ok}** open ticket(s)${result.failed ? `, ${result.failed} failed` : ''}.`
        : 'No open tickets needed an update.',
    );
  } else {
    // The role is still the legacy staff role or the mod role - only the config
    // entry was removed, so its overwrites on open tickets stay untouched.
    lines.push(`<@&${role.id}> was removed from the extensible list, but it still manages tickets via the legacy staff or mod role.`);
  }
  lines.push(
    remaining.length
      ? `Extensible staff list now: ${remaining.map((id) => `<@&${id}>`).join(', ')}.`
      : 'The extensible staff list is now empty.',
  );

  await sendModLog(
    interaction.guild,
    baseEmbed(COLORS.audit)
      .setTitle('Ticket Staff Updated')
      .setDescription(`**Removed:** <@&${role.id}>\n**By:** <@${interaction.user.id}>`)
      .setTimestamp(Date.now()),
  );
  await interaction.editReply({ embeds: [successEmbed(lines.join('\n'), 'Ticket staff updated')] });
}
