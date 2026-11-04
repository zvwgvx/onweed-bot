// Direct-message notifications for moderation actions. DMs are best effort: a closed
// inbox or a blocked bot never fails or delays the punishment itself.
import { TYPE_META } from '../constants.js';
import { formatDurationCompact } from '../utils/duration.js';
import { baseEmbed, rel, truncate, ts } from '../utils/embeds.js';

const ACTION_TITLES = {
  warn: 'Warning Received',
  mute: 'You Have Been Muted',
  kick: 'You Have Been Kicked',
  ban: 'You Have Been Banned',
};

const ACTION_SENTENCES = {
  warn: 'You have received a warning in',
  mute: 'You have been muted in',
  kick: 'You have been kicked from',
  ban: 'You have been banned from',
};

const REAPPLY_TITLES = {
  mute: 'Mute Re-applied',
  ban: 'Ban Re-applied',
};

const targetUser = (target) => target?.user ?? target;

// One embed for every punishment: action, case number, duration/expiry, reason and
// who applied it. `reapplied` switches the wording for the rejoin enforcement path.
export function buildPunishmentDm({ guild, caseRow, clientId = null, reapplied = false }) {
  const type = caseRow.type;
  const meta = TYPE_META[type] ?? TYPE_META.note;
  const title = reapplied
    ? (REAPPLY_TITLES[type] ?? 'Punishment Re-applied')
    : (ACTION_TITLES[type] ?? 'Moderation Notice');
  const description = reapplied
    ? `Case #${caseRow.case_number} (${meta.label}) is still active, so it was applied again when you rejoined **${guild.name}**.`
    : `${ACTION_SENTENCES[type] ?? 'An action was applied to you in'} **${guild.name}**.`;

  const lines = [description];
  if (type === 'ban') {
    lines.push(
      caseRow.expires_at
        ? `You can rejoin after ${ts(caseRow.expires_at, 'F')} (${rel(caseRow.expires_at)}).`
        : 'This ban is permanent.',
    );
  } else if (type === 'mute' && !caseRow.expires_at) {
    lines.push('This mute is permanent.');
  }

  const embed = baseEmbed(meta.color)
    .setTitle(title)
    .setDescription(lines.join('\n'))
    .setTimestamp(Date.now());

  embed.addFields({ name: 'Case', value: `#${caseRow.case_number}`, inline: true });

  const duration = formatDurationCompact(caseRow.duration_ms);
  if (duration) embed.addFields({ name: 'Duration', value: duration, inline: true });
  if (caseRow.expires_at) {
    embed.addFields({
      name: 'Expires',
      value: `${ts(caseRow.expires_at, 'F')} (${rel(caseRow.expires_at)})`,
      inline: true,
    });
  }

  if (caseRow.reason) embed.addFields({ name: 'Reason', value: truncate(caseRow.reason, 400) });

  embed.addFields({
    name: 'Moderator',
    value:
      caseRow.moderator_id === 'system' || caseRow.moderator_id === clientId
        ? 'Automatic'
        : `<@${caseRow.moderator_id}>`,
    inline: true,
  });

  embed.setFooter({ text: guild.name, iconURL: guild.iconURL({ size: 64 }) ?? undefined });
  return embed;
}

// Returns true when the DM was delivered, false when it was skipped or blocked.
export async function sendPunishmentDm(target, { guild, caseRow, clientId = null, reapplied = false }) {
  const user = targetUser(target);
  if (!user || user.bot) return false;

  try {
    await user.send({ embeds: [buildPunishmentDm({ guild, caseRow, clientId, reapplied })] });
    return true;
  } catch (err) {
    console.warn(`[notify] Could not DM ${user.id} about case #${caseRow.case_number}: ${err.message}`);
    return false;
  }
}
