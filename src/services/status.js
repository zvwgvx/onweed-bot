// Bot status message: a "Status Report" embed kept fresh in config.botStatusChannelId.
// Sections: Bot Status (CPU/memory/uptime), Environment (versions/platform) and Websocket (ping/shard/state).
import os from 'node:os';
import { createRequire } from 'node:module';
import { MessageFlags, version as discordVersion } from 'discord.js';
import { config } from '../config.js';
import { COLORS } from '../constants.js';
import { getInstallMessage, setInstallMessage } from '../db.js';
import { developerCreditLine } from '../utils/credit.js';
import { baseEmbed } from '../utils/embeds.js';

export const STATUS_MESSAGE_KEY = 'status';
export const STATUS_REFRESH_MS = 60_000;

const require = createRequire(import.meta.url);
const pkg = require('../../package.json');

// ---------- Metrics ----------

let prevCpu = null;

function cpuSample() {
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    for (const t of Object.values(cpu.times)) total += t;
    idle += cpu.times.idle;
  }
  return { idle, total };
}

// Average CPU usage since the previous call (delta between two samples).
function cpuUsagePercent() {
  const now = cpuSample();
  if (!prevCpu) {
    prevCpu = now;
    return 0;
  }
  const idle = now.idle - prevCpu.idle;
  const total = now.total - prevCpu.total;
  prevCpu = now;
  if (total <= 0) return 0;
  return Math.max(0, Math.min(100, ((total - idle) / total) * 100));
}

function formatBytes(n) {
  const gb = n / 1024 ** 3;
  return gb >= 1 ? `${gb.toFixed(2)} GB` : `${Math.round(n / 1024 ** 2)} MB`;
}

function formatUptime(secondsTotal) {
  const s = Math.floor(secondsTotal);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d) return `${d}d ${h}h ${m}m ${sec}s`;
  if (h) return `${h}h ${m}m ${sec}s`;
  if (m) return `${m}m ${sec}s`;
  return `${sec}s`;
}

const WS_STATES = {
  0: 'Connected',
  1: 'Connecting',
  2: 'Reconnecting',
  3: 'Idle',
  4: 'Nearly ready',
  5: 'Disconnected',
  6: 'Waiting for guilds',
  7: 'Identifying',
  8: 'Resuming',
};

// ---------- Card ----------

const section = (title, lines) => `**${title}**\n\`\`\`\n${lines.join('\n')}\n\`\`\``;

export function buildStatusEmbed(client) {
  const cores = os.cpus().length;
  const totalMem = os.totalmem();

  const description = [
    // Credit line is the first content line, right below the embed title.
    developerCreditLine(),
    section('[ • ] Bot Status', [
      `CPU Cores · ${cores} cores`,
      `CPU Usage · ${cpuUsagePercent().toFixed(2)}%`,
      `Mem Max · ${formatBytes(totalMem)}`,
      `Mem Use · ${formatBytes(totalMem - os.freemem())}`,
      `Uptime · ${formatUptime(process.uptime())}`,
    ]),
    section('[ • ] Environment', [
      `Node JS · ${process.version}`,
      `Discord JS · ${discordVersion}`,
      `Platform · ${os.platform()} ${os.arch()}`,
      `Bot · ${pkg.name} v${pkg.version}`,
    ]),
    section('[ • ] Websocket', [
      `Ping · ${client.ws.ping}ms`,
      `Shards · ${client.ws.shards.size}`,
      `State · ${WS_STATES[client.ws.status] ?? 'Unknown'}`,
    ]),
  ]
    .filter(Boolean)
    .join('\n\n');

  return baseEmbed(COLORS.info).setTitle('Status Report').setDescription(description);
}

export function buildStatusPayload(client) {
  return { embeds: [buildStatusEmbed(client)] };
}

// Edits the stored status message, or posts a new one when missing.
export async function refreshStatusMessage(client) {
  const channelId = config.botStatusChannelId;
  if (!channelId) return null;

  const guild = client.guilds.cache.get(config.guildId);
  if (!guild) return null;

  const channel = await guild.channels.fetch(channelId).catch(() => null);
  if (!channel || !channel.isTextBased()) {
    console.warn(`[status] bot-status channel ${channelId} not found or not text-based.`);
    return null;
  }

  const payload = buildStatusPayload(client);
  const stored = getInstallMessage(guild.id, STATUS_MESSAGE_KEY);

  if (stored?.message_id) {
    const message = await channel.messages.fetch(stored.message_id).catch(() => null);
    if (message && message.author.id === client.user.id) {
      // The old card was a Components V2 container. That flag can never be removed,
      // so it is replaced once by the embed version instead of edited in place.
      if (!message.flags.has(MessageFlags.IsComponentsV2)) {
        await message.edit(payload);
        return message;
      }
      await message.delete().catch(() => null);
    }
  }

  const sent = await channel.send(payload);
  setInstallMessage(guild.id, STATUS_MESSAGE_KEY, channel.id, sent.id);
  return sent;
}

// Refreshes the card every minute (ping/uptime/memory move continuously).
export function startStatusLoop(client) {
  return setInterval(() => {
    refreshStatusMessage(client).catch((err) => console.error('[status] Refresh failed:', err.message));
  }, STATUS_REFRESH_MS);
}
