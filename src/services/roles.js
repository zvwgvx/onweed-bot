// Role management (created by =install / /install):
// - Member: basic access - view plus normal chat (special categories are configured in Discord).
//   With verification enabled it is granted by the Verify button (services/verify.js);
//   otherwise it is assigned to every human join.
// - Bots: shared role for bot accounts.
// - Bot ("Moderation Bot" by default): dedicated role for this bot, meant to sit at the top.
import { PermissionsBitField } from 'discord.js';
import { config, updateFileConfig } from '../config.js';

// The subset of permissions the bot itself has via the invite, so role creation never gets rejected.
const MEMBER_PERMISSIONS = [
  PermissionsBitField.Flags.ViewChannel,
  PermissionsBitField.Flags.SendMessages,
  PermissionsBitField.Flags.ReadMessageHistory,
];

// The hidden role that carries the bot's powers. With Administrator the bot bypasses the
// role-hierarchy checks, so this role's position in the list no longer matters.
const BOT_PERMISSIONS = [PermissionsBitField.Flags.Administrator];

const NO_PERMISSIONS = [];

const ROLE_DEFS = {
  member: { idKey: 'memberRoleId', nameKey: 'memberRoleName', permissions: MEMBER_PERMISSIONS, color: 0x57f287 },
  bots: { idKey: 'botsRoleId', nameKey: 'botsRoleName', permissions: NO_PERMISSIONS, color: 0x3498db },
  // Visible bot identity role - carries no permissions by itself (placed below Member).
  bot: { idKey: 'botRoleId', nameKey: 'botRoleName', permissions: NO_PERMISSIONS, color: 0x5865f2 },
  // Hidden role that actually carries the bot's powers (not hoisted, no colour).
  botPerms: {
    idKey: 'botPermsRoleId',
    nameKey: 'botPermsRoleName',
    permissions: BOT_PERMISSIONS,
    color: null,
    hoist: false,
  },
};

// Generic find-or-create. New roles spawn at the bottom; creation order in the installer
// (this bot > Bots > Muted > Member) gives them a sane relative hierarchy.
async function ensureRole(guild, kind, { createIfMissing = true, reason = 'Role setup' } = {}) {
  const { idKey, nameKey, permissions, color, hoist = false } = ROLE_DEFS[kind];
  const id = config[idKey];
  const name = config[nameKey];

  let role = id ? await guild.roles.fetch(id).catch(() => null) : null;
  if (!role) {
    role =
      guild.roles.cache.find(
        (r) => !r.managed && r.name.toLowerCase() === String(name).toLowerCase(),
      ) ?? null;
  }
  if (!role && !createIfMissing) return null;
  if (!role) {
    // Only include the keys that carry values: colourless roles (and empty permission
    // sets) must be omitted entirely - newer discord.js converts them to numbers and
    // rejects null with 'Unable to convert "null" to a number'.
    const options = { name, hoist: Boolean(hoist), mentionable: false, reason };
    if (color !== null && color !== undefined) options.color = color;
    if (permissions?.length) options.permissions = permissions;
    role = await guild.roles.create(options);
    console.log(`[roles] Created the "${role.name}" role (${role.id}).`);
  }
  if (config[idKey] !== role.id) {
    updateFileConfig({ [idKey]: role.id });
    console.log(`[roles] Saved ${idKey}=${role.id} to config.json.`);
  }
  return role;
}

export const ensureMemberRole = (guild, opts) => ensureRole(guild, 'member', opts);
export const ensureBotsRole = (guild, opts) => ensureRole(guild, 'bots', opts);
export const ensureBotRole = (guild, opts) => ensureRole(guild, 'bot', opts);
export const ensureBotPermsRole = (guild, opts) => ensureRole(guild, 'botPerms', opts);
