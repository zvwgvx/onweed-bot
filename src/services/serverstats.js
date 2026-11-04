// Server stats message: a "Server Report" embed kept fresh in config.serverStatsChannelId.
// Sections: Members (all/humans/bots), Online (live presence counts) and Server (boosts/channels/roles/created).
// Optionally keeps a voice channel (config.serverStatsVoiceChannelId) named "All Members: N".
import { GatewayIntentBits, IntentsBitField, MessageFlags } from 'discord.js';
import { config } from '../config.js';
import { COLORS } from '../constants.js';
import { getInstallMessage, setInstallMessage } from '../db.js';
import { developerCreditLine } from '../utils/credit.js';
import { baseEmbed } from '../utils/embeds.js';

export const SERVER_STATS_MESSAGE_KEY = 'server_stats';
export const SERVER_STATS_REFRESH_MS = 60_000;

// Discord allows only 2 channel-name edits per 10 minutes per channel - throttle hard.
const VOICE_RENAME_COOLDOWN_MS = 10 * 60_000;
let lastVoiceSyncAt = 0;

const section = (title, lines) => `**${title}**\n\`\`\`\n${lines.join('\n')}\n\`\`\``;

// ---------- Counting ----------

async function collectMemberStats(guild, hasPresenceIntent) {
  // Fetch the full member list so the numbers do not depend on the gateway cache.
  const members = await guild.members.fetch().catch(() => null);
  const list = members ?? guild.members.cache;
  if (!list.size) return null;

  let humans = 0;
  let bots = 0;
  for (const member of list.values()) {
    if (member.user.bot) bots++;
    else humans++;
  }

  // Discord only sends presences for online/idle/dnd members - a missing presence is offline.
  const status = { online: 0, idle: 0, dnd: 0, offline: 0 };
  for (const member of list.values()) {
    if (member.user.bot) continue; // statuses are reported for humans only
    const state = guild.presences.cache.get(member.id)?.status ?? null;
    if (state === 'online') status.online++;
    else if (state === 'idle') status.idle++;
    else if (state === 'dnd') status.dnd++;
    else status.offline++;
  }

  return { total: list.size, humans, bots, hasPresence: hasPresenceIntent, ...status };
}

// ---------- Card ----------

export function buildServerStatsEmbed(stats) {
  const onlineLines = stats.hasPresence
    ? [`Online · ${stats.online}`, `Idle · ${stats.idle}`, `Do Not Disturb · ${stats.dnd}`, `Offline · ${stats.offline}`]
    : ['Online · unavailable', 'Enable the Presence Intent in the Developer Portal for live counts.'];

  const description = [
    // Credit line is the first content line, right below the embed title.
    developerCreditLine(),
    section('[ • ] Members', [
      `All Members · ${stats.total}`,
      `Humans · ${stats.humans}`,
      `Bots · ${stats.bots}`,
    ]),
    section('[ • ] Online', onlineLines),
    section('[ • ] Server', [
      `Boosts · ${stats.boosts} (Tier ${stats.boostTier})`,
      `Channels · ${stats.textChannels} text · ${stats.voiceChannels} voice`,
      `Roles · ${stats.roles}`,
      `Created · ${stats.createdAt}`,
    ]),
  ]
    .filter(Boolean)
    .join('\n\n');

  return baseEmbed(COLORS.info).setTitle('Server Report').setDescription(description);
}

export function buildServerStatsPayload(stats) {
  return { embeds: [buildServerStatsEmbed(stats)] };
}

export async function collectServerStats(guild, client = null) {
  // Deterministic intent check instead of relying on whether some presence happens to be cached.
  const hasPresenceIntent = client
    ? new IntentsBitField(client.options.intents).has(GatewayIntentBits.GuildPresences)
    : guild.presences.cache.size > 0;
  const stats = await collectMemberStats(guild, hasPresenceIntent);
  if (!stats) return null;
  stats.boosts = guild.premiumSubscriptionCount ?? 0;
  stats.boostTier = guild.premiumTier;
  stats.textChannels = guild.channels.cache.filter((c) => c.isTextBased() && !c.isVoiceBased()).size;
  stats.voiceChannels = guild.channels.cache.filter((c) => c.isVoiceBased()).size;
  stats.roles = guild.roles.cache.size - 1; // excluding @everyone
  stats.createdAt = guild.createdAt.toISOString().slice(0, 10);
  return stats;
}

// Keeps the optional voice channel named "All Members: N" (heavily throttled).
export async function syncMembersVoiceChannel(guild, total) {
  const voiceId = config.serverStatsVoiceChannelId;
  if (!voiceId) return;
  const now = Date.now();
  if (now - lastVoiceSyncAt < VOICE_RENAME_COOLDOWN_MS) return;
  lastVoiceSyncAt = now;

  const channel = await guild.channels.fetch(voiceId).catch(() => null);
  if (!channel) {
    console.warn(`[serverStats] All-Members voice channel ${voiceId} not found.`);
    return;
  }
  const name = `All Members: ${total}`;
  if (channel.name !== name) {
    await channel.setName(name, 'Server stats sync').catch((err) =>
      console.warn('[serverStats] Failed to rename the All-Members channel:', err.message),
    );
  }
}

// Edits the stored stats message, or posts a new one when missing.
export async function refreshServerStatsMessage(client) {
  const channelId = config.serverStatsChannelId;
  if (!channelId) return null;

  const guild = client.guilds.cache.get(config.guildId);
  if (!guild) return null;

  const channel = await guild.channels.fetch(channelId).catch(() => null);
  if (!channel || !channel.isTextBased()) {
    console.warn(`[serverStats] server-stats channel ${channelId} not found or not text-based.`);
    return null;
  }

  const stats = await collectServerStats(guild, client);
  if (!stats) {
    console.warn('[serverStats] Member list is not available yet.');
    return null;
  }

  const payload = buildServerStatsPayload(stats);
  const stored = getInstallMessage(guild.id, SERVER_STATS_MESSAGE_KEY);

  if (stored?.message_id) {
    const message = await channel.messages.fetch(stored.message_id).catch(() => null);
    if (message && message.author.id === client.user.id) {
      // The old card was a Components V2 container. That flag can never be removed,
      // so it is replaced once by the embed version instead of edited in place.
      if (!message.flags.has(MessageFlags.IsComponentsV2)) {
        await message.edit(payload).catch(() => {});
        await syncMembersVoiceChannel(guild, stats.total).catch(() => {});
        return message;
      }
      await message.delete().catch(() => null);
    }
  }

  const sent = await channel.send(payload);
  setInstallMessage(guild.id, SERVER_STATS_MESSAGE_KEY, channel.id, sent.id);
  await syncMembersVoiceChannel(guild, stats.total).catch(() => {});
  return sent;
}

// Refreshes the card every minute (member counts move continuously).
export function startServerStatsLoop(client) {
  return setInterval(() => {
    refreshServerStatsMessage(client).catch((err) =>
      console.error('[serverStats] Refresh failed:', err.message),
    );
  }, SERVER_STATS_REFRESH_MS);
}
