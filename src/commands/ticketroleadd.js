import { MessageFlags, PermissionsBitField, SlashCommandBuilder } from 'discord.js';
import { config } from '../config.js';
import { COLORS } from '../constants.js';
import { sendModLog } from '../services/log.js';
import { addTicketStaffRole, ticketStaffRoleIds } from '../services/tickets.js';
import { baseEmbed, errorEmbed, successEmbed } from '../utils/embeds.js';
import { ensureModerator, roleAssignabilityError } from '../utils/permissions.js';

export const data = new SlashCommandBuilder()
  .setName('ticketroleadd')
  .setDescription('Permanently grant a role access to every ticket (extra ticket-staff role)')
  .addRoleOption((o) => o.setName('role').setDescription('Role that can view and manage every ticket').setRequired(true));

export async function execute(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  if (!(await ensureModerator(interaction, PermissionsBitField.Flags.ManageGuild, 'Manage Server'))) return;

  const role = interaction.options.getRole('role', true);

  const roleError = roleAssignabilityError(interaction.guild, role);
  if (roleError) return interaction.editReply({ embeds: [errorEmbed(roleError)] });

  const result = await addTicketStaffRole(
    interaction.guild,
    role,
    `Ticket staff role added by ${interaction.user.tag}`,
  ).catch((err) => {
    console.error('[ticketroleadd] Failed:', err.message);
    return { error: `Could not update the ticket staff roles: ${err.message}` };
  });
  if (result?.error) return interaction.editReply({ embeds: [errorEmbed(result.error)] });

  const staff = ticketStaffRoleIds();
  const lines = [
    `<@&${role.id}> can now view and manage every **open and future** ticket.`,
    `Ticket staff roles: ${staff.map((id) => `<@&${id}>`).join(', ') || '(none)'}` +
      (config.modRoleId ? ` + <@&${config.modRoleId}> (mod)` : ''),
    result.stats.ok
      ? `Access re-applied to **${result.stats.ok}** open ticket(s)${result.stats.failed ? `, **${result.stats.failed}** failed` : ''}.`
      : 'No open tickets to update - new tickets get the allow when they are created.',
    `Remove it again with \`/ticketroleremove\`. Temporary single-ticket access stays with \`/add\`.`,
  ];

  await sendModLog(
    interaction.guild,
    baseEmbed(COLORS.audit)
      .setTitle('Ticket Staff Updated')
      .setDescription(`**Added:** <@&${role.id}>\n**By:** <@${interaction.user.id}>`)
      .setTimestamp(Date.now()),
  );
  await interaction.editReply({ embeds: [successEmbed(lines.join('\n'), 'Ticket staff updated')] });
}
