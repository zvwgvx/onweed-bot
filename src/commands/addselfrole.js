import { MessageFlags, PermissionsBitField, SlashCommandBuilder } from 'discord.js';
import { config } from '../config.js';
import { addSelfRoleEntry, isSelfRolesEnabled, refreshSelfRolesPanelMessage } from '../services/selfroles.js';
import { errorEmbed, successEmbed } from '../utils/embeds.js';
import { ensureModerator, roleAssignabilityError } from '../utils/permissions.js';

export const data = new SlashCommandBuilder()
  .setName('addselfrole')
  .setDescription('Add a role to the self-role panel')
  .addRoleOption((o) => o.setName('role').setDescription('The role to add to the panel').setRequired(true))
  .addStringOption((o) =>
    o.setName('label').setDescription('Optional button label (defaults to the role name)').setMaxLength(80),
  );

export async function execute(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  if (!(await ensureModerator(interaction, PermissionsBitField.Flags.ManageGuild, 'Manage Server'))) return;

  const role = interaction.options.getRole('role', true);
  const label = interaction.options.getString('label');

  const roleError = roleAssignabilityError(interaction.guild, role);
  if (roleError) return interaction.editReply({ embeds: [errorEmbed(roleError)] });

  const result = addSelfRoleEntry(role, { label });
  if (result?.error) return interaction.editReply({ embeds: [errorEmbed(result.error)] });

  // The channel may not exist yet (panel not installed) - refresh is a no-op then.
  const panel = await refreshSelfRolesPanelMessage(interaction.client).catch(() => null);
  const note = panel
    ? `The panel in <#${config.selfRoles.channelId}> was refreshed and now shows **${result.entries}** role(s).`
    : isSelfRolesEnabled()
      ? 'The panel could not be refreshed automatically - run `/install` to post it.'
      : 'The panel is not posted yet - run `/install` to create the self-role channel and post it.';

  await interaction.editReply({
    embeds: [
      successEmbed(`Added **${role.name}** to the self-role panel (**${result.entries}** role(s) total).\n${note}`, 'Self role added'),
    ],
  });
}
