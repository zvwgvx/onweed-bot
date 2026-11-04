import { MessageFlags, PermissionsBitField, SlashCommandBuilder } from 'discord.js';
import { countActiveByType, createCase } from '../db.js';
import { applyWarnEscalation } from '../services/escalation.js';
import { logCase } from '../services/log.js';
import { sendPunishmentDm } from '../services/notify.js';
import { buildActionEmbed } from '../utils/embeds.js';
import { ensureModerator } from '../utils/permissions.js';

export const data = new SlashCommandBuilder()
  .setName('warn')
  .setDescription('Warn a user')
  .addUserOption((o) => o.setName('user').setDescription('The user to warn').setRequired(true))
  .addStringOption((o) => o.setName('reason').setDescription('Reason for the warning'));

export async function execute(interaction, client) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  if (!(await ensureModerator(interaction, PermissionsBitField.Flags.ManageMessages, 'Manage Messages'))) {
    return;
  }

  const user = interaction.options.getUser('user');
  const reason = interaction.options.getString('reason');
  const guild = interaction.guild;

  const caseRow = createCase({
    guildId: guild.id,
    userId: user.id,
    moderatorId: interaction.user.id,
    type: 'warn',
    reason,
  });
  await logCase(guild, caseRow, { clientId: client.user.id });
  await sendPunishmentDm(user, { guild, caseRow, clientId: client.user.id });

  const activeWarns = countActiveByType(guild.id, user.id, 'warn');
  const embed = buildActionEmbed({
    action: 'warn',
    target: user,
    reason,
    guildName: guild.name,
  });
  embed.addFields({ name: 'Active warnings', value: String(activeWarns), inline: true });

  try {
    const escalated = await applyWarnEscalation(guild, user.id, client);
    if (escalated) {
      embed.addFields({
        name: 'Automatic mute',
        value: `Reached ${escalated.threshold} warning(s) - mute applied (Case #${escalated.caseRow.case_number}).`,
      });
    }
  } catch (err) {
    console.error('[warn] Escalation failed:', err);
  }

  await interaction.editReply({ embeds: [embed] });
}
