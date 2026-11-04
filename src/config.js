// Configuration loader.
// Secrets come from .env (DISCORD_TOKEN, CLIENT_ID); everything else lives in config.json.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const CONFIG_PATH = path.resolve(process.env.CONFIG_PATH || './config.json');

const DEFAULT_FILE_CONFIG = {
  prefix: '=',
  guildId: '',
  muteRoleId: '',
  muteRoleName: 'Muted',
  modRoleId: '',
  modLogChannelId: '',
  auditLogChannelId: '',
  botRoleId: '',
  botRoleName: 'Moderation Bot',
  botPermsRoleId: '',
  botPermsRoleName: 'Bot Perms',
  botsRoleId: '',
  botsRoleName: 'Bots',
  memberRoleId: '',
  memberRoleName: 'Member',
  mutedBotCmdsChannelId: '',
  botStatusChannelId: '',
  serverStatsChannelId: '',
  serverStatsVoiceChannelId: '',
  tickets: {
    panelChannelId: '',
    staffRoleId: '',
    staffRoleIds: [],
    generalCategoryId: '',
    generalCategoryName: 'General Tickets',
    applicationCategoryId: '',
    applicationCategoryName: 'Guild Applications',
    logChannelId: '',
    archiveCategoryId: '',
    archiveCategoryName: 'Ticket Archive',
  },
  createVoice: { lobbyChannelId: '' },
  welcome: { channelId: '' },
  verify: { channelId: '', channelName: 'verify', gate: true },
  selfRoles: { channelId: '', channelName: 'self-role', roles: [] },
  botName: 'Guildframe',
  developerCredit: '',
  doNotType: { channelId: '', action: 'kick', purgeMinutes: 30, rejoinUrl: 'https://discord.sentialab.org' },
  warnEscalation: { threshold: 0, duration: '1h' },
};

function loadFileConfig() {
  try {
    const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
    return { ...DEFAULT_FILE_CONFIG, ...raw, doNotType: { ...DEFAULT_FILE_CONFIG.doNotType, ...raw.doNotType }, warnEscalation: { ...DEFAULT_FILE_CONFIG.warnEscalation, ...raw.warnEscalation }, tickets: { ...DEFAULT_FILE_CONFIG.tickets, ...raw.tickets }, createVoice: { ...DEFAULT_FILE_CONFIG.createVoice, ...raw.createVoice }, welcome: { ...DEFAULT_FILE_CONFIG.welcome, ...raw.welcome }, verify: { ...DEFAULT_FILE_CONFIG.verify, ...raw.verify }, selfRoles: { ...DEFAULT_FILE_CONFIG.selfRoles, ...raw.selfRoles } };
  } catch (err) {
    if (err.code === 'ENOENT') {
      console.warn('[config] config.json not found, falling back to defaults. Copy config.example.json to config.json.');
      return { ...DEFAULT_FILE_CONFIG };
    }
    throw new Error(`[config] Failed to parse ${CONFIG_PATH}: ${err.message}`);
  }
}

export const fileConfig = loadFileConfig();

export const config = {
  token: process.env.DISCORD_TOKEN?.trim() || '',
  clientId: process.env.CLIENT_ID?.trim() || '',
  dbPath: process.env.DB_PATH?.trim() || './data/bot.sqlite',
  configPath: CONFIG_PATH,
  ...fileConfig,
};

// Persist a patch (top-level or nested one level) back to config.json.
export function updateFileConfig(patch) {
  for (const [key, value] of Object.entries(patch)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      config[key] = { ...(config[key] ?? {}), ...value };
    } else {
      config[key] = value;
    }
  }
  const { token, clientId, dbPath, configPath, ...fileOnly } = config;
  writeFileSync(CONFIG_PATH, `${JSON.stringify(fileOnly, null, 2)}\n`);
}

export function assertConfig({ requireGuild = false } = {}) {
  const missing = [];
  if (!config.token) missing.push('DISCORD_TOKEN (in .env)');
  if (!config.clientId) missing.push('CLIENT_ID (in .env)');
  if (requireGuild && !/^\d{17,20}$/.test(String(config.guildId))) {
    missing.push('guildId (in config.json)');
  }
  if (missing.length) {
    throw new Error(`Missing configuration: ${missing.join(', ')}.`);
  }
}
