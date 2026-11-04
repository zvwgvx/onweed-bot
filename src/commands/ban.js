import { MessageFlags, PermissionsBitField, SlashCommandBuilder } from 'discord.js';
import { MAX_BAN_MS } from '../constants.js';
import { createCase, getActiveCases, hideCase } from '../db.js';
import { logCase } from '../services/log.js';
import { sendPunishmentDm } from '../services/notify.js';
import { scheduleCase } from '../services/scheduler.js';
import { formatDuration, parseDuration } from '../utils/duration.js';
import { buildActionEmbed, errorEmbed } from '../utils/embeds.js';
import { canModerateMember, ensureBotPermissions, ensureModerator } from '../utils/permissions.js';

export const data = new SlashCommandBuilder()
  .setName('ban')
  .setDescription('Ban a user (supports temporary bans)')
  .addUserOption((o) => o.setName('user').setDescription('The user to ban').setRequired(true))
  .addStringOption((o) =>
    o.setName('duration').setDescription('Duration: 1d, 7d, 30d, perm (omit = permanent)'),
  )
  .addStringOption((o) => o.setName('reason').setDescription('Reason for the ban'))
  .addIntegerOption((o) =>
    o
      .setName('delete_messages')
      .setDescription('Delete recent messages from this user')
      .addChoices(
        { name: 'Do not delete', value: 0 },
        { name: 'Last hour', value: 3600 },
        { name: 'Last 6 hours', value: 21600 },
        { name: 'Last 24 hours', value: 86400 },
      ),
  );

export async function execute(interaction, client) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  if (!(await ensureModerator(interaction, PermissionsBitField.Flags.BanMembers, 'Ban Members', { modRoleAllowed: false }))) return;
  if (!(await ensureBotPermissions(interaction, PermissionsBitField.Flags.BanMembers, 'Ban Members'))) return;

  const user = interaction.options.getUser('user');
  if (user.id === client.user.id) {
    await interaction.editReply({ embeds: [errorEmbed('I cannot ban myself.')] });
    return;
  }

  const member = interaction.options.getMember('user');
  if (member && !(await canModerateMember(interaction, member))) return;

  const existing = await interaction.guild.bans.fetch(user.id).catch(() => null);
  if (existing) {
    await interaction.editReply({ embeds: [errorEmbed(`<@${user.id}> is already banned.`)] });
    return;
  }

  let durationMs;
  try {
    durationMs = parseDuration(interaction.options.getString('duration'));
  } catch (err) {
    await interaction.editReply({ embeds: [errorEmbed(err.message)] });
    return;
  }
  if (durationMs && durationMs > MAX_BAN_MS) {
    await interaction.editReply({ embeds: [errorEmbed(`Maximum ban duration is ${formatDuration(MAX_BAN_MS)}.`)] });
    return;
  }

  const reason = interaction.options.getString('reason');
  const deleteMessageSeconds = interaction.options.getInteger('delete_messages') ?? 0;
  const caseRow = createCase({
    guildId: interaction.guildId,
    userId: user.id,
    moderatorId: interaction.user.id,
    type: 'ban',
    reason,
    durationMs,
  });
  // DM before the ban: after it the bot may no longer share a guild with the user.
  await sendPunishmentDm(user, { guild: interaction.guild, caseRow, clientId: client.user.id });

  try {
    await interaction.guild.bans.create(user.id, {
      deleteMessageSeconds,
      reason: `Case #${caseRow.case_number} by ${interaction.user.tag}${reason ? `: ${reason}` : ''}`.slice(0, 512),
    });
  } catch (err) {
    hideCase(caseRow.id);
    await interaction.editReply({ embeds: [errorEmbed(`Could not ban: ${err.message}`)] });
    return;
  }

  if (durationMs) scheduleCase(caseRow.id);
  await logCase(interaction.guild, caseRow, { clientId: client.user.id });
  await interaction.editReply({
    embeds: [
      buildActionEmbed({
        action: 'ban',
        target: user,
        durationMs,
        reason,
        guildName: interaction.guild.name,
      }),
    ],
  });
}
