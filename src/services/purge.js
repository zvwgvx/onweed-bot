// Message purge helpers.
// 1) purgeRecentMessages: deletes every message a user sent across the server within a
//    recent window (used when the do-not-type trap kicks someone).
// 2) purgeMessages: the =purge / /purge channel command - removes the most recent
//    messages of a channel, optionally limited to a single author.
import { PermissionsBitField } from 'discord.js';
import { config } from '../config.js';
import { COLORS } from '../constants.js';
import { baseEmbed } from '../utils/embeds.js';

// ---------- Server-wide user purge (do-not-type kick follow-up) ----------

const PAGE_SIZE = 100;
const MAX_PAGES = 15; // safety cap: 1500 most recent messages scanned per channel

// Walks pages backwards and collects the user's messages until they fall outside the window.
async function collectRecentMessages(channel, userId, windowStart) {
  const collected = [];
  let cursor;

  for (let page = 0; page < MAX_PAGES; page++) {
    const batch = await channel.messages
      .fetch({ limit: PAGE_SIZE, ...(cursor ? { before: cursor } : {}) })
      .catch(() => null);
    if (!batch?.size) break;

    let outsideWindow = false;
    for (const message of batch.values()) {
      cursor = message.id;
      if (message.createdTimestamp < windowStart) {
        outsideWindow = true;
        break;
      }
      if (message.author?.id === userId) collected.push(message);
    }
    if (outsideWindow) break;
  }

  return collected;
}

function usableChannel(channel, me, { fetchThreads = false } = {}) {
  if (!channel.isTextBased()) return false;
  if (me && !channel.permissionsFor(me)?.has([PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.ManageMessages])) {
    return false;
  }
  if (!fetchThreads && channel.isThread()) return false;
  return true;
}

// Returns { skipped, deleted, channels } - how many messages were deleted in how many channels.
export async function purgeRecentMessages(guild, userId, { windowMs = 30 * 60 * 1000 } = {}) {
  if (!windowMs || windowMs <= 0) return { skipped: true, deleted: 0, channels: 0 };

  const windowStart = Date.now() - windowMs;
  const me = guild.members.me;

  const main = guild.channels.cache.filter((c) => usableChannel(c, me) && !c.isThread());

  // Include active threads (text/forum parents) so nothing is missed.
  const threads = [];
  for (const channel of main.values()) {
    if (typeof channel.threads?.fetchActive !== 'function') continue;
    const active = await channel.threads.fetchActive().catch(() => null);
    if (!active) continue;
    for (const thread of active.threads.values()) {
      if (usableChannel(thread, me, { fetchThreads: true })) threads.push(thread);
    }
  }

  let deleted = 0;
  let channelsTouched = 0;
  for (const channel of [...main.values(), ...threads]) {
    const collected = await collectRecentMessages(channel, userId, windowStart);
    if (!collected.length) continue;

    let channelDeleted = 0;
    for (let i = 0; i < collected.length; i += PAGE_SIZE) {
      const removed = await channel
        .bulkDelete(collected.slice(i, i + PAGE_SIZE), true) // true = silently skip too-old messages
        .catch(() => null);
      if (removed) channelDeleted += removed.size;
    }
    if (channelDeleted) {
      deleted += channelDeleted;
      channelsTouched++;
      console.log(`[purge] Deleted ${channelDeleted} message(s) in #${channel.name}.`);
    }
  }

  return { skipped: false, deleted, channels: channelsTouched };
}

// ---------- Channel purge (=purge / /purge) ----------

// Just under Discord's 14-day bulk-delete limit (clock skew safety margin).
const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000 - 30 * 60 * 1000;

const BULK_CHUNK = 100; // Discord API hard cap per bulk-delete call

// Removes up to `amount` (1-1000) recent messages from `channel` - the newest ones,
// or (with targetUserId) only that user's messages. Pinned messages are never
// removed; messages older than 14 days are skipped (the API rejects them).
// Returns { deleted, requested, ranOut } - ranOut means the start of the channel was
// reached (or nothing else matched within the age limit), so `deleted` may be lower.
export async function purgeMessages(channel, { amount, targetUserId = null } = {}) {
  const requested = Math.min(Math.max(1, Math.floor(Number(amount))), 1000);
  let remaining = requested;
  let deleted = 0;
  let ranOut = false;
  let cursor = null;

  while (remaining > 0) {
    const options = { limit: BULK_CHUNK };
    if (cursor) options.before = cursor;
    const fetched = await channel.messages.fetch(options).catch(() => null);
    if (!fetched || fetched.size === 0) {
      ranOut = true;
      break;
    }
    cursor = fetched.last().id;

    const batch = [];
    for (const message of fetched.values()) {
      if (remaining === 0) break;
      if (message.pinned) continue;
      if (targetUserId && message.author.id !== targetUserId) continue;
      if (Date.now() - message.createdTimestamp > MAX_AGE_MS) continue;
      batch.push(message);
      remaining -= 1;
    }

    if (batch.length) {
      const removed = await channel.bulkDelete(batch, true).catch((err) => {
        console.error('[purge] Bulk delete failed:', err.message);
        return null;
      });
      deleted += removed ? removed.size : 0;
    }

    // The fetch window was shorter than requested: the start of the channel is reached.
    if (remaining > 0 && fetched.size < BULK_CHUNK) {
      ranOut = true;
      break;
    }
  }

  return { deleted, requested, ranOut };
}

// Reply text for both command variants.
export function describePurge(result, { targetUserId = null } = {}) {
  const lines = [`Removed **${result.deleted}** message(s) ${targetUserId ? `from <@${targetUserId}> ` : ''}in this channel.`];
  if (result.deleted < result.requested) {
    lines.push(
      result.ranOut
        ? 'No more matching messages - the start of the channel (or the 14-day bulk-delete limit) was reached.'
        : 'Some messages were skipped - bulk delete only works on messages younger than 14 days, and pinned messages are kept.',
    );
  }
  return lines.join('\n');
}

// Audit embed for the mod log (no case entry - purging is not a punishment).
export function buildPurgeLogEmbed({ channelId, moderatorId, targetUserId = null, deleted }) {
  return baseEmbed(COLORS.gray)
    .setTitle('Purge')
    .setDescription(
      [
        `**Channel:** <#${channelId}>`,
        `**By:** <@${moderatorId}>`,
        `**Message filter:** ${targetUserId ? `<@${targetUserId}> only` : 'all senders (newest first)'}`,
        `**Removed:** ${deleted}`,
      ].join('\n'),
    )
    .setTimestamp(Date.now());
}

// The do-not-type trap channel keeps its messages as evidence - purge is refused there.
export function isPurgeBlockedChannel(channelId) {
  return Boolean(config.doNotType?.channelId && channelId === config.doNotType.channelId);
}
