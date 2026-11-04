import { PermissionsBitField, SlashCommandBuilder } from 'discord.js';
import { restartProcess } from '../services/restart.js';
import { successEmbed } from '../utils/embeds.js';
import { ensureModerator } from '../utils/permissions.js';

export const data = new SlashCommandBuilder()
  .setName('restart')
  .setDescription('Restart the bot - it boots back on its own and automatically re-runs the full setup');

export async function execute(interaction) {
  if (!(await ensureModerator(interaction, PermissionsBitField.Flags.ManageGuild, 'Manage Server'))) return;

  await interaction.reply({
    embeds: [
      successEmbed(
        'Restarting... The bot boots back on its own within a few seconds and automatically re-runs the full setup. No action is needed.',
        'Restart',
      ),
    ],
  });

  // Give Discord a moment to deliver the reply before the process exits.
  setTimeout(() => {
    restartProcess({ reason: `/restart by ${interaction.user.tag}` });
  }, 1_000);
}
