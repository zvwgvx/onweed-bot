import { Events } from 'discord.js';
import { config } from '../config.js';
import { COLORS } from '../constants.js';
import { getActiveCases, setCaseStatus } from '../db.js';
import { ensureMuteRole } from '../services/mutes.js';
import { sendModLog } from '../services/log.js';
import { sendPunishmentDm } from '../services/notify.js';
import { isVerifyEnabled, sendVerifyNotification } from '../services/verify.js';
import { sendPunishmentArrival, sendWelcome } from '../services/welcome.js';
import { buildAuditEmbed } from '../utils/embeds.js';

export const name = Events.GuildMemberAdd;

// Temporary cases whose duration ran out while the member was away are expired on
// the spot, so a rejoin never re-applies a punishment that is already over (the
// scheduler does the same from its boot restore; this covers the gap in between).
function liveCases(cases) {
  const now = Date.now();
  return cases.filter((c) => {
    if (!c.expires_at || c.expires_at > now) return true;
    setCaseStatus(c.id, 'expired');
    return false;
  });
}

// Bots get the Bots role on join. Humans get the Member role from the Verify button
// in the verify channel; without verification configured it is still auto-assigned.
export async function execute(member, client) {
  if (member.guild.id !== config.guildId) return;

  // Bots role for bot accounts; bot accounts are never welcomed or punished.
  if (member.user.bot) {
    if (config.botsRoleId) {
      await member.roles
        .add(config.botsRoleId, 'Bots role on join')
        .catch((err) => console.error('[guildMemberAdd] Failed to add the bots role:', err.message));
    }
    return;
  }

  if (config.memberRoleId && !isVerifyEnabled()) {
    await member.roles
      .add(config.memberRoleId, 'Member role on join')
      .catch((err) => console.error('[guildMemberAdd] Failed to add the member role:', err.message));
  }

  // Decide whether a punishment has to be re-applied before posting anything, so the
  // arrivals channel gets the enforcement card instead of the normal welcome card.
  const activeBans = liveCases(getActiveCases(member.guild.id, member.id, 'ban'));
  const activeMutes = activeBans.length
    ? []
    : liveCases(getActiveCases(member.guild.id, member.id, 'mute'));

  // Ban: the person can only rejoin after an out-of-band unban (which never touched
  // the case), so enforce the active ban again.
  if (activeBans.length) {
    const caseRow = activeBans[0];
    // DM first: once banned, the bot may no longer share a guild with the user and
    // therefore can no longer open a DM channel with them.
    await sendPunishmentDm(member, {
      guild: member.guild,
      caseRow,
      clientId: client.user.id,
      reapplied: true,
    });

    try {
      await member.guild.members.ban(member.id, {
        reason: `Re-apply ban - Case #${caseRow.case_number}`,
      });
    } catch (err) {
      console.error('[guildMemberAdd] Failed to re-apply the ban:', err);
      // The ban could not be enforced - fall back to a normal rejoin.
      await sendWelcome(member);
      await sendVerifyNotification(member);
      return;
    }

    await sendPunishmentArrival(member, caseRow);
    await sendModLog(
      member.guild,
      buildAuditEmbed({
        title: 'Ban Re-applied',
        description: `<@${member.id}> rejoined while a ban case was active (Case #${caseRow.case_number}). They have been banned again.`,
        color: COLORS.ban,
      }),
    );
    return;
  }

  // Mute: hand the mute role back to the rejoiner.
  if (activeMutes.length) {
    const caseRow = activeMutes[0];
    try {
      const role = await ensureMuteRole(member.guild, { reason: 'Re-apply mute on rejoin' });
      await member.roles.add(role, `Re-apply mute - Case #${caseRow.case_number}`);
    } catch (err) {
      console.error('[guildMemberAdd] Failed to re-apply the mute:', err);
      // The mute could not be enforced - fall back to a normal rejoin.
      await sendWelcome(member);
      await sendVerifyNotification(member);
      return;
    }

    await sendPunishmentArrival(member, caseRow);
    await sendPunishmentDm(member, {
      guild: member.guild,
      caseRow,
      clientId: client.user.id,
      reapplied: true,
    });
    await sendModLog(
      member.guild,
      buildAuditEmbed({
        title: 'Mute Re-applied',
        description: `<@${member.id}> rejoined while a mute case was active (Case #${caseRow.case_number}). The mute has been applied again.`,
        color: COLORS.mute,
      }),
    );
    await sendVerifyNotification(member);
    return;
  }

  // Normal rejoin: welcome card, then the verification notice.
  await sendWelcome(member);
  await sendVerifyNotification(member);
}
