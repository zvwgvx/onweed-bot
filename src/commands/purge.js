import { MessageFlags, PermissionsBitField, SlashCommandBuilder } from 'discord.js';
import { config } from '../config.js';
import { purgeMessages, describePurge, buildPurgeLogEmbed, isPurgeBlockedChannel } from '../services/purge.js';
import { sendModLog } from '../services/log.js';
import { errorEmbed, successEmbed } from '../utils/embeds.js';
import { ensureModerator } from '../utils/permissions.js';

export const data = new SlashCommandBuilder()
  .setName('purge')
  .setDescription('Bulk-remove recent messages in this channel (newest first, optionally one user only)')
  .addIntegerOption((o) =>
    o
      .setName('amount')
      .setDescription('How many messages to remove (1-1000, newest first)')
      .setMinValue(1)
      .setMaxValue(1000)
      .setRequired(true),
  )
  .addUserOption((o) => o.setName('user').setDescription('Only remove messages from this user'));

export async function execute(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  if (!(await ensureModerator(interaction, PermissionsBitField.Flags.ManageMessages, 'Manage Messages'))) return;

  const channel = await interaction.client.channels.fetch(interaction.channelId).catch(() => null);
  if (!channel || !channel.isTextBased()) {
    return interaction.editReply({ embeds: [errorEmbed('Purge works in text channels only.')] });
  }
  if (!interaction.guild.members.me.permissionsIn(channel).has(PermissionsBitField.Flags.ManageMessages)) {
    return interaction.editReply({
      embeds: [errorEmbed('The bot is missing the **Manage Messages** permission in this channel.')],
    });
  }
  if (isPurgeBlockedChannel(channel.id)) {
    return interaction.editReply({
      embeds: [errorEmbed('The do-not-type trap channel keeps its messages as evidence - purge is disabled there.')],
    });
  }

  const amount = interaction.options.getInteger('amount', true);
  const user = interaction.options.getUser('user');

  const result = await purgeMessages(channel, { amount, targetUserId: user?.id ?? null }).catch((err) => {
    console.error('[purge] Failed:', err.message);
    return null;
  });
  if (!result) {
    return interaction.editReply({ embeds: [errorEmbed('Could not purge - try again in a moment.')] });
  }

  await sendModLog(
    interaction.guild,
    buildPurgeLogEmbed({
      channelId: channel.id,
      moderatorId: interaction.user.id,
      targetUserId: user?.id ?? null,
      deleted: result.deleted,
    }),
  );
  await interaction.editReply({ embeds: [successEmbed(describePurge(result, { targetUserId: user?.id ?? null }), 'Purge')] });
}
