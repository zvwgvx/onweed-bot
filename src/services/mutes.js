// Mute business logic: manages the Muted role + per-channel overwrites, role assign/remove, cases, timers.
import { ChannelType } from 'discord.js';
import { config, updateFileConfig } from '../config.js';
import { createCase, getActiveCases, hideCase, setActiveCasesStatus, setCaseStatus } from '../db.js';
import { logCase } from './log.js';
import { sendPunishmentDm } from './notify.js';
import { cancelCaseTimer, scheduleCase } from './scheduler.js';

// Finds or creates the Muted role (config.muteRoleId takes priority; the created role id is persisted).
export async function ensureMuteRole(guild, { createIfMissing = true, reason = 'Mute role setup' } = {}) {
  let role = config.muteRoleId ? await guild.roles.fetch(config.muteRoleId).catch(() => null) : null;

  if (!role) {
    role =
      guild.roles.cache.find(
        (r) => !r.managed && r.name.toLowerCase() === String(config.muteRoleName).toLowerCase(),
      ) ?? null;
  }
  if (!role && !createIfMissing) return null;
  if (!role) {
    role = await guild.roles.create({
      name: config.muteRoleName,
      color: null, // no colour - muted usernames keep their default (black) colour
      hoist: false,
      mentionable: false,
      permissions: [],
      reason,
    });
    console.log(`[mute] Created the "${role.name}" role (${role.id}).`);
  }
  if (config.muteRoleId !== role.id) {
    updateFileConfig({ muteRoleId: role.id });
    console.log(`[mute] Saved muteRoleId=${role.id} to config.json.`);
  }
  return role;
}

// Channel overwrite applied to every channel for the Muted role. Voice channels also
// carry a text chat, so the text restrictions apply there too (not just Speak/Stream).
export function muteOverwriteOptions(channel) {
  const text = {
    SendMessages: false,
    SendMessagesInThreads: false,
    AddReactions: false,
    CreatePublicThreads: false,
    CreatePrivateThreads: false,
    SendVoiceMessages: false,
    SendPolls: false,
  };
  if (channel.isVoiceBased()) return { ...text, Speak: false, Stream: false };
  return { ...text, Speak: false };
}

// The "muted bot commands" channel is the one place muted users may still talk/use commands.
export function mutedCmdsOverwriteOptions(channel) {
  if (channel.isVoiceBased()) return { ViewChannel: true, Connect: true, Speak: true };
  return {
    ViewChannel: true,
    SendMessages: true,
    SendMessagesInThreads: true,
    AddReactions: false,
    ReadMessageHistory: true,
    UseApplicationCommands: true,
  };
}

// @everyone is locked out of the muted-commands channel; muted users/staff/the bot keep explicit allows.
export function mutedCmdsEveryoneOptions(channel) {
  if (channel.isVoiceBased()) return { ViewChannel: false, Connect: false, SendMessages: false };
  return {
    ViewChannel: false,
    SendMessages: false,
    AddReactions: false,
    CreatePublicThreads: false,
    CreatePrivateThreads: false,
  };
}

export async function applyMutedCmdsOverwrite(channel, role, reason = 'Allow muted users to use commands here') {
  const guild = channel.guild;

  // Hide the channel from everyone else.
  await channel.permissionOverwrites.edit(guild.roles.everyone, mutedCmdsEveryoneOptions(channel), { reason });

  // Muted users keep full access (view + chat + slash commands).
  await channel.permissionOverwrites.edit(role, mutedCmdsOverwriteOptions(channel), { reason });

  // Staff keeps access to watch what muted users are doing there.
  if (config.modRoleId && config.modRoleId !== role.id) {
    const modRole = guild.roles.cache.get(config.modRoleId) ?? (await guild.roles.fetch(config.modRoleId).catch(() => null));
    if (modRole) {
      await channel.permissionOverwrites.edit(
        modRole,
        channel.isVoiceBased()
          ? { ViewChannel: true, Connect: true, Speak: true }
          : { ViewChannel: true, SendMessages: true, ReadMessageHistory: true, UseApplicationCommands: true },
        { reason },
      );
    }
  }

  // The bot must still be able to post/refresh its notice in the sealed channel.
  // Never fall back to @everyone here - an allow for @everyone would unseal the channel.
  const botRole =
    (config.botRoleId ? guild.roles.cache.get(config.botRoleId) : null) ?? guild.members.me?.roles.highest ?? null;
  if (botRole && botRole.id !== role.id && botRole.id !== guild.id) {
    await channel.permissionOverwrites.edit(
      botRole,
      { ViewChannel: true, SendMessages: true, EmbedLinks: true, ReadMessageHistory: true },
      { reason },
    );
  }
}

export async function applyMuteOverwrite(channel, role, reason = 'Apply Muted role restrictions') {
  await channel.permissionOverwrites.edit(role, muteOverwriteOptions(channel), { reason });
}

// Applies the overwrite to every existing channel (categories are skipped).
// The muted-commands channel is excluded and explicitly kept open for muted users.
export async function applyMuteOverwritesAll(guild, role) {
  let ok = 0;
  let failed = 0;
  for (const channel of guild.channels.cache.values()) {
    if (channel.type === ChannelType.GuildCategory) continue;
    try {
      if (config.mutedBotCmdsChannelId && channel.id === config.mutedBotCmdsChannelId) {
        await applyMutedCmdsOverwrite(channel, role);
      } else {
        await applyMuteOverwrite(channel, role);
      }
      ok += 1;
    } catch {
      failed += 1;
    }
  }
  return { ok, failed };
}

// Applies a mute: assigns the role, creates the case, logs it and schedules the timer.
export async function applyMute(guild, member, { moderatorId, reason = null, durationMs = null, clientId = null }) {
  const role = await ensureMuteRole(guild);
  const caseRow = createCase({
    guildId: guild.id,
    userId: member.id,
    moderatorId,
    type: 'mute',
    reason,
    durationMs,
  });
  try {
    await member.roles.add(role, `Mute - Case #${caseRow.case_number}${reason ? ` | ${reason}` : ''}`);
  } catch (err) {
    setCaseStatus(caseRow.id, 'removed');
    hideCase(caseRow.id);
    throw err;
  }
  if (durationMs) scheduleCase(caseRow.id);
  await logCase(guild, caseRow, { clientId });
  await sendPunishmentDm(member, { guild, caseRow, clientId });
  return { caseRow, role };
}

// Removes a mute: takes the role away, closes active mute cases, creates the unmute case.
// Returns the unmute case, or null when there is nothing to do.
export async function removeMute(guild, { userId, member = null, moderatorId, reason = null, clientId = null }) {
  const activeMutes = getActiveCases(guild.id, userId, 'mute');
  const hasRole = Boolean(config.muteRoleId && member?.roles?.cache?.has(config.muteRoleId));
  if (!activeMutes.length && !hasRole) return null;

  for (const c of activeMutes) cancelCaseTimer(c.id);
  setActiveCasesStatus(guild.id, userId, 'mute', 'removed');

  if (member && config.muteRoleId && member.roles.cache.has(config.muteRoleId)) {
    await member.roles
      .remove(config.muteRoleId, `Unmute${reason ? ` | ${reason}` : ''}`)
      .catch((err) => console.error(`[mute] Failed to remove the Muted role from ${userId}:`, err.message));
  }

  const caseRow = createCase({
    guildId: guild.id,
    userId,
    moderatorId,
    type: 'unmute',
    reason,
  });
  await logCase(guild, caseRow, { clientId });
  return caseRow;
}
