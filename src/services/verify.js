// Verification: the verify channel is the only channel unverified members can see.
// The bot keeps a Verification embed + button there; pressing the button grants the
// Member (verified) role, which carries the unlock allows on every other channel.
// In gate mode (config.verify.gate) /install denies @everyone ViewChannel on all
// other channels/categories, so nobody can view anything until they are verified.
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType } from 'discord.js';
import { config, updateFileConfig } from '../config.js';
import { COLORS } from '../constants.js';
import { getInstallMessage, listTicketChannelIds, listVoiceChannelIds, setInstallMessage } from '../db.js';
import { baseEmbed } from '../utils/embeds.js';
import { ensureMemberRole } from './roles.js';

export const VERIFY_MESSAGE_KEY = 'verify';
export const VERIFY_BUTTON_ID = 'verify_button';

// Verification is enabled once a verify channel is configured (or created by /install).
export const isVerifyEnabled = () => Boolean(config.verify?.channelId);

// Channel-wide lockout switch: on (default), every channel except the verify channel
// is hidden from @everyone until members press the Verify button.
export const isGateEnabled = () => isVerifyEnabled() && config.verify?.gate !== false;

// The gate never touches these channels: the verify channel itself stays open to
// @everyone (it must be the only thing unverified members can see), the do-not-type
// channel stays open so the trap keeps catching bots, and the muted-commands channel
// keeps its own locked-down overwrites.
function gateExcludedIds() {
  return new Set(
    [config.verify?.channelId, config.doNotType?.channelId, config.mutedBotCmdsChannelId].filter(Boolean),
  );
}

// ---------- Verify channel + message ----------

// Finds or creates the verify channel (config.verify.channelId takes priority; the
// found/created channel id is persisted back, like the auto-created roles).
export async function ensureVerifyChannel(guild, { reason = 'Verify channel setup' } = {}) {
  const name = String(config.verify?.channelName || 'verify');
  let channel = config.verify?.channelId
    ? await guild.channels.fetch(config.verify.channelId).catch(() => null)
    : null;
  if (!channel) {
    const pool = (await guild.channels.fetch().catch(() => null)) ?? guild.channels.cache;
    channel = pool.find((c) => c.isTextBased() && c.name.toLowerCase() === name.toLowerCase()) ?? null;
  }
  if (!channel) {
    channel = await guild.channels.create({ name, type: ChannelType.GuildText, reason });
    console.log(`[verify] Created the "#${channel.name}" channel (${channel.id}).`);
  }
  if (config.verify?.channelId !== channel.id) {
    updateFileConfig({ verify: { channelId: channel.id } });
    console.log(`[verify] Saved verify.channelId=${channel.id} to config.json.`);
  }
  // The verify channel must stay open to @everyone (sending is denied - the button is the gate).
  await channel.permissionOverwrites.edit(
    guild.roles.everyone,
    { ViewChannel: true, SendMessages: false },
    { reason },
  );
  return channel;
}

function buildVerifyPayload(guild) {
  const lines = [
    `Welcome to **${guild.name}**.`,
    '',
    'This is the only channel you can see for now.',
    'Press the button below to verify and unlock the rest of the server.',
    '',
    'By verifying you confirm that you have read and accept the server rules.',
  ];
  const embed = baseEmbed(COLORS.success)
    .setTitle('Verification')
    .setDescription(lines.join('\n'))
    .setFooter({ text: guild.name });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(VERIFY_BUTTON_ID).setLabel('Verify').setStyle(ButtonStyle.Success),
  );
  return { embeds: [embed], components: [row] };
}

// Edits the stored Verification message, or posts a new one when missing. Safe to call often.
export async function refreshVerifyMessage(client) {
  const channelId = config.verify?.channelId;
  if (!channelId) return null;

  const guild = client.guilds.cache.get(config.guildId);
  if (!guild) return null;

  const channel = await guild.channels.fetch(channelId).catch(() => null);
  if (!channel || !channel.isTextBased()) {
    console.warn(`[verify] verify channel ${channelId} not found or not text-based.`);
    return null;
  }

  const payload = buildVerifyPayload(guild);
  const stored = getInstallMessage(guild.id, VERIFY_MESSAGE_KEY);

  if (stored?.message_id) {
    const message = await channel.messages.fetch(stored.message_id).catch(() => null);
    if (message && message.author.id === client.user.id) {
      await message.edit(payload).catch(() => {});
      return message;
    }
  }

  const sent = await channel.send(payload);
  setInstallMessage(guild.id, VERIFY_MESSAGE_KEY, channel.id, sent.id);
  return sent;
}

// ---------- Join notification (DM first, channel ping only as a fallback) ----------

// The "Verification required" card. The DM variant carries its own Verify button
// (verification happens without ever opening the channel); the channel fallback
// variant points at the Verify panel below instead.
function buildVerificationRequiredEmbed(guild, userId, { inDm = false } = {}) {
  return baseEmbed(COLORS.warn)
    .setTitle('Verification required')
    .setDescription(
      [
        `Welcome to **${guild.name}**, <@${userId}>.`,
        'You cannot see any other channel yet.',
        inDm
          ? 'Press the **Verify** button below to unlock the rest of the server.'
          : 'Press the **Verify** button on the verification message below to unlock the rest of the server.',
      ].join('\n'),
    )
    .setFooter({ text: guild.name });
}

// Announces verification to a joining human: the card goes straight to their DMs -
// private, with a Verify button inside, so the verify channel no longer collects one
// ping per join that every unverified member can read. Only when the DM cannot be
// delivered (DMs closed) is a ping posted in the verify channel - and it is removed
// again once that member verifies (sweepVerifyPings).
export async function sendVerifyNotification(member) {
  if (!isVerifyEnabled() || member.user?.bot) return { sent: false };
  // Already verified (rejoiners, manual assignment) - nothing to announce.
  if (config.memberRoleId && member.roles.cache.has(config.memberRoleId)) return { sent: false };

  try {
    await member.send({
      embeds: [buildVerificationRequiredEmbed(member.guild, member.id, { inDm: true })],
      components: [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(VERIFY_BUTTON_ID).setLabel('Verify').setStyle(ButtonStyle.Success),
        ),
      ],
    });
    return { sent: true };
  } catch (err) {
    console.error(`[verify] DM to ${member.id} failed (${err.message}) - falling back to the channel ping.`);
  }

  const channel = await member.guild.channels.fetch(config.verify.channelId).catch(() => null);
  if (!channel || !channel.isTextBased()) return { sent: false };
  await channel
    .send({
      content: `<@${member.id}>`,
      embeds: [buildVerificationRequiredEmbed(member.guild, member.id)],
      allowedMentions: { users: [member.id], roles: [] },
    })
    .catch((err) => console.error('[verify] Failed to post the fallback ping:', err.message));
  return { sent: false };
}

// Deletes a member's fallback ping from the verify channel after they verify, so the
// channel keeps only the static Verification panel. Scans recent messages for ones
// mentioning the (now verified) member; the panel message itself is never touched.
export async function sweepVerifyPings(member) {
  if (!isVerifyEnabled()) return 0;
  const channel = await member.guild.channels.fetch(config.verify.channelId).catch(() => null);
  if (!channel || !channel.isTextBased()) return 0;

  const messages = await channel.messages.fetch({ limit: 50 }).catch(() => null);
  if (!messages) return 0;

  const panelId = getInstallMessage(member.guild.id, VERIFY_MESSAGE_KEY)?.message_id ?? null;
  let deleted = 0;
  for (const message of messages.values()) {
    // Only the bot's own fallback pings are removed; staff messages mentioning the
    // member (help delivery etc.) and the panel are left alone.
    if (message.author?.id !== member.client.user.id) continue;
    if (message.id === panelId) continue;
    if (!message.mentions?.users?.has?.(member.id)) continue;
    await message.delete().catch(() => {});
    deleted += 1;
  }
  if (deleted) console.log(`[verify] Removed ${deleted} fallback ping(s) for ${member.id}.`);
  return deleted;
}

// ---------- The Verify button ----------

// Grants the Member (verified) role. Works for presses in the verify channel and for
// the Verify button inside the DM card: in the DM there is no guild/member on the
// interaction, so membership is resolved against the configured guild. No overwrite
// changes are needed - the role already carries the allows that unlock the gate.
export async function verifyMember(interaction) {
  if (!isVerifyEnabled()) {
    return { error: 'Verification is not configured yet - ask the staff to run `/install`.' };
  }

  let guild = interaction.guild;
  let member = interaction.member;
  if (!guild || !member) {
    guild = interaction.client.guilds.cache.get(config.guildId) ?? null;
    member = guild ? await guild.members.fetch(interaction.user.id).catch(() => null) : null;
  }
  if (!guild) return { error: 'Verification is not configured yet - ask the staff to run `/install`.' };
  if (!member) return { error: 'Could not resolve your membership. Are you still in the server?' };

  const reason = `Verified via the Verify button (${interaction.user.id})`;
  const role = config.memberRoleId
    ? await guild.roles.fetch(config.memberRoleId).catch(() => null)
    : await ensureMemberRole(guild, { reason }).catch(() => null);
  if (!role) return { error: 'The verified role does not exist - ask the staff to run `/install`.' };

  if (member.roles.cache.has(role.id)) return { already: true, member };

  try {
    await member.roles.add(role, reason);
  } catch (err) {
    console.error(`[verify] Failed to add the role to ${interaction.user.id}:`, err.message);
    return { error: 'Could not assign the verified role - try again in a moment.' };
  }
  return { verified: true, role, member };
}

// ---------- Gate ----------

// The @everyone half of the gate: lose view (and connect on voice channels - hidden
// channels cannot be joined, so the connect deny just makes the lock explicit).
export function gateEveryoneOptions(channel) {
  if (channel.isVoiceBased()) return { ViewChannel: false, Connect: false };
  return { ViewChannel: false };
}

// The verified half: view everywhere (plus connect, so verified members keep joining).
export function gateMemberOptions(channel) {
  if (channel.isVoiceBased()) return { ViewChannel: true, Connect: true };
  return { ViewChannel: true };
}

// Roles that keep explicit allows everywhere the gate locks content: the verified
// (Member) role, the mod role and the Bots role (so bot accounts are never locked out).
export async function gateAllowRoles(guild, memberRole = null) {
  const roles = [];
  for (const id of [memberRole?.id, config.memberRoleId, config.modRoleId, config.botsRoleId].filter(Boolean)) {
    if (roles.some((r) => r.id === id)) continue;
    const role =
      memberRole?.id === id ? memberRole : (guild.roles.cache.get(id) ?? (await guild.roles.fetch(id).catch(() => null)));
    if (role) roles.push(role);
  }
  return roles;
}

// Applies the gate to every existing channel (categories included, so synced channels
// keep inheriting the lock). Returns ok/failed counts.
export async function applyVerifyGate(guild, memberRole, reason = 'Apply the verification gate') {
  const allowRoles = await gateAllowRoles(guild, memberRole);
  if (!allowRoles.length) return { ok: 0, failed: 0, skipped: true };

  const excluded = gateExcludedIds();
  let ok = 0;
  let failed = 0;
  for (const channel of guild.channels.cache.values()) {
    // Channels that already hold an @everyone overwrite manage their own visibility
    // (ticket channels, private voice rooms, the sealed muted-commands channel) - the
    // gate must never add a Member allow that would leak them to verified members.
    if (excluded.has(channel.id) || channel.permissionOverwrites.cache.has(guild.roles.everyone.id)) continue;
    try {
      await applyGateOverwrite(channel, allowRoles, reason);
      ok += 1;
    } catch {
      failed += 1;
    }
  }
  return { ok, failed };
}

// Overwrites a single channel: @everyone loses view, the verified (Member) role plus
// the mod and Bots roles keep explicit allows so staff and bot accounts are never
// locked out with the rest.
export async function applyGateOverwrite(channel, allowRoles, reason = 'Apply the verification gate') {
  const guild = channel.guild;
  await channel.permissionOverwrites.edit(guild.roles.everyone, gateEveryoneOptions(channel), { reason });
  for (const role of allowRoles) {
    await channel.permissionOverwrites.edit(role, gateMemberOptions(channel), { reason });
  }
  return channel;
}

// Called when a channel is created: applies the gate so it starts locked too.
// Channels that manage their own visibility (tickets are created with an @everyone
// overwrite) and the always-open channels are left alone.
export async function applyGateOverwriteForNewChannel(channel) {
  if (!isGateEnabled() || gateExcludedIds().has(channel.id)) return null;
  if (channel.permissionOverwrites.cache.has(channel.guild.roles.everyone.id)) return null;

  const allowRoles = await gateAllowRoles(channel.guild);
  if (!allowRoles.length) return null;
  return applyGateOverwrite(channel, allowRoles, 'Apply the verification gate to the new channel');
}

// Lifts the gate (config.verify.gate set to false): clears the ViewChannel (and voice
// Connect) bits from the @everyone overwrites so the server reopens. The always-open
// channels (verify + trap), the muted-commands seal, ticket channels and spawned voice
// rooms manage their own @everyone overwrites and are left untouched. Re-run via /install.
export async function liftVerifyGate(guild, reason = 'Lift the verification gate') {
  const skip = new Set(
    [
      ...gateExcludedIds(),
      ...listTicketChannelIds(guild.id),
      ...listVoiceChannelIds(guild.id),
    ].filter(Boolean),
  );
  let ok = 0;
  let failed = 0;
  for (const channel of guild.channels.cache.values()) {
    if (skip.has(channel.id)) continue;
    try {
      await channel.permissionOverwrites.edit(
        guild.roles.everyone,
        channel.isVoiceBased() ? { ViewChannel: null, Connect: null } : { ViewChannel: null },
        { reason },
      );
      ok += 1;
    } catch {
      failed += 1;
    }
  }
  return { ok, failed };
}
