import { MessageFlags, PermissionsBitField, SlashCommandBuilder } from 'discord.js';
import { config } from '../config.js';
import { isSelfRolesEnabled, refreshSelfRolesPanelMessage, removeSelfRoleEntry } from '../services/selfroles.js';
import { errorEmbed, successEmbed } from '../utils/embeds.js';
import { ensureModerator } from '../utils/permissions.js';

export const data = new SlashCommandBuilder()
  .setName('removeselfrole')
  .setDescription('Remove a role from the self-role panel')
  .addRoleOption((o) => o.setName('role').setDescription('The role to remove from the panel').setRequired(true));

export async function execute(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  if (!(await ensureModerator(interaction, PermissionsBitField.Flags.ManageGuild, 'Manage Server'))) return;

  const role = interaction.options.getRole('role', true);
  const result = removeSelfRoleEntry(role, interaction.guild);
  if (result?.error) return interaction.editReply({ embeds: [errorEmbed(result.error)] });

  // The channel may not exist yet (panel not installed) - refresh is a no-op then.
  const panel = await refreshSelfRolesPanelMessage(interaction.client).catch(() => null);
  const name = result.name ?? role.name;
  const note = panel
    ? `The panel in <#${config.selfRoles.channelId}> was refreshed - **${result.entries}** role(s) remain.`
    : isSelfRolesEnabled()
      ? 'The panel could not be refreshed automatically - run `/install` to post it.'
      : 'The panel is not posted yet - run `/install` to create the self-role channel and post it.';

  await interaction.editReply({
    embeds: [
      successEmbed(
        `Removed **${name}** from the self-role panel (**${result.entries}** role(s) remaining).\n${note}`,
        'Self role removed',
      ),
    ],
  });
}
