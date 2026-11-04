import { config } from '../config.js';
import { COLORS } from '../constants.js';
import { createCase, hideCase } from '../db.js';
import { applyMute } from '../services/mutes.js';
import { sendKickNotice } from '../services/notices.js';
import { purgeRecentMessages } from '../services/purge.js';
import { logCase, sendModLog } from '../services/log.js';
import { sendPunishmentDm } from '../services/notify.js';
import { onTrapCaught } from '../services/trap.js';
import { buildAuditEmbed, truncate } from '../utils/embeds.js';

// Handles messages posted in the "do not type" channel (used to catch bots/selfbots).
// config.doNotType.action: "kick" (default) | "alert" | "mute" | "ban".
export async function handleDoNotType(message, client) {
  const guild = message.guild;
  const isBotAuthor = message.author.bot;
  const configuredAction = String(config.doNotType?.action ?? 'kick').toLowerCase();
  const action = !isBotAuthor && ['mute', 'kick', 'ban'].includes(configuredAction) ? configuredAction : 'alert';

  const fields = [
    { name: 'Author', value: `${message.author} (${message.author.id})`, inline: true },
    { name: 'Channel', value: `<#${message.channelId}>`, inline: true },
  ];
  const preview = message.content ? `> ${truncate(message.content, 500)}` : '(no text content)';
  const description = [
    `<@${message.author.id}> posted a message in the do-not-type channel.`,
    preview,
    `[Jump to message](${message.url})`,
  ].join('\n');

  // Optional automatic action (skipped for real bot accounts - alert only).
  if (action !== 'alert') {
    try {
      const member = await guild.members.fetch(message.author.id).catch(() => null);
      if (action === 'mute' && member) {
        const { caseRow } = await applyMute(guild, member, {
          moderatorId: client.user.id,
          reason: 'Posted in the do-not-type channel',
          durationMs: null,
          clientId: client.user.id,
        });
        fields.push({ name: 'Action', value: `Muted (Case #${caseRow.case_number})`, inline: true });
      } else if (action === 'kick' && member) {
        const caseRow = createCase({
          guildId: guild.id,
          userId: member.id,
          moderatorId: client.user.id,
          type: 'kick',
          reason: 'Posted in the do-not-type channel',
        });

        // DM the rejoin notice before the kick - without a shared server the
        // DM would be impossible afterwards.
        const noticed = await sendKickNotice({ member, guild, caseNumber: caseRow.case_number });

        await member.kick(`Case #${caseRow.case_number} | Posted in the do-not-type channel`);

        // Wipe the user's chat history from the configured window, server-wide.
        const purgeMinutes = Number(config.doNotType?.purgeMinutes ?? 30);
        const purge = await purgeRecentMessages(guild, member.id, {
          windowMs: purgeMinutes * 60 * 1000,
        }).catch((err) => {
          console.error('[doNotType] Message purge failed:', err.message);
          return null;
        });

        await logCase(guild, caseRow, { clientId: client.user.id });
        fields.push({ name: 'Action', value: `Kicked (Case #${caseRow.case_number})`, inline: true });
        fields.push({
          name: 'Notice',
          value: noticed
            ? `${config.botName} notified the user by DM with the rejoin link.`
            : 'DM delivery failed - the user could not be notified.',
          inline: true,
        });
        if (purge && !purge.skipped) {
          fields.push({
            name: 'History cleanup',
            value: `Deleted ${purge.deleted} message(s) from the last ${purgeMinutes} minutes in ${purge.channels} channel(s).`,
            inline: false,
          });
        } else if (!purge && purgeMinutes > 0) {
          fields.push({
            name: 'History cleanup',
            value: 'Failed - the bot needs the Manage Messages permission on the affected channels.',
            inline: false,
          });
        }
      } else if (action === 'ban') {
        const caseRow = createCase({
          guildId: guild.id,
          userId: message.author.id,
          moderatorId: client.user.id,
          type: 'ban',
          reason: 'Posted in the do-not-type channel',
        });
        // DM before the ban: after it the bot may no longer share a guild with the user.
        await sendPunishmentDm(message.author, {
          guild,
          caseRow,
          clientId: client.user.id,
        });
        try {
          await guild.bans.create(message.author.id, {
            reason: `Case #${caseRow.case_number} | Posted in the do-not-type channel`,
          });
        } catch (err) {
          hideCase(caseRow.id);
          throw err;
        }
        await logCase(guild, caseRow, { clientId: client.user.id });
        fields.push({ name: 'Action', value: `Banned (Case #${caseRow.case_number})`, inline: true });
      }
    } catch (err) {
      console.error('[doNotType] Automatic action failed:', err.message);
      fields.push({ name: 'Action', value: `Failed: ${err.message}`, inline: true });
    }
  }

  const content = config.modRoleId ? `<@&${config.modRoleId}>` : undefined;
  await sendModLog(
    guild,
    buildAuditEmbed({
      title: 'Do-Not-Type Channel Alert',
      description,
      color: COLORS.error,
      fields,
    }),
    { content },
  );

  // Update the persistent warning message counters.
  await onTrapCaught(message, action, client);
}
