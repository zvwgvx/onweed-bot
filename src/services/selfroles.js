// Self-roles: a toggle-button panel built from config.selfRoles.roles (one entry per
// role: roleId, optional label and style). Pressing a button grants the role, pressing
// it again removes it - the panel itself stays a single static message. When a member
// verifies, they are pinged here to grab their roles.
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  ContainerBuilder,
  MessageFlags,
  TextDisplayBuilder,
} from 'discord.js';
import { config, updateFileConfig } from '../config.js';
import { COLORS } from '../constants.js';
import { getInstallMessage, setInstallMessage } from '../db.js';
import { baseEmbed } from '../utils/embeds.js';
import { applyGateOverwrite, gateAllowRoles, isGateEnabled } from './verify.js';

export const SELF_ROLES_MESSAGE_KEY = 'self_roles';
export const SELF_ROLE_BUTTON_PREFIX = 'selfrole_';

// Discord's hard limit across all button rows of one message.
const MAX_SELF_ROLES = 25;

const BUTTON_STYLES = new Set(['Primary', 'Secondary', 'Success', 'Danger']);

// Self roles are enabled once a channel is configured and at least one entry has a roleId.
export function isSelfRolesEnabled() {
  const roles = Array.isArray(config.selfRoles?.roles) ? config.selfRoles.roles : [];
  return Boolean(config.selfRoles?.channelId) && roles.some((entry) => entry?.roleId);
}

// ---------- Channel + entries ----------

// Finds or creates the self-role channel (config.selfRoles.channelId takes priority;
// the found/created channel id is persisted back, like the verify channel).
export async function ensureSelfRolesChannel(guild, { reason = 'Self-role channel setup' } = {}) {
  const name = String(config.selfRoles?.channelName || 'self-role');
  let channel = config.selfRoles?.channelId
    ? await guild.channels.fetch(config.selfRoles.channelId).catch(() => null)
    : null;
  if (!channel) {
    const pool = (await guild.channels.fetch().catch(() => null)) ?? guild.channels.cache;
    channel = pool.find((c) => c.isTextBased() && c.name.toLowerCase() === name.toLowerCase()) ?? null;
  }
  if (!channel) {
    channel = await guild.channels.create({ name, type: ChannelType.GuildText, reason });
    console.log(`[selfroles] Created the "#${channel.name}" channel (${channel.id}).`);
  }
  if (config.selfRoles?.channelId !== channel.id) {
    updateFileConfig({ selfRoles: { channelId: channel.id } });
    console.log(`[selfroles] Saved selfRoles.channelId=${channel.id} to config.json.`);
  }
  // Part of the member area: keep it sealed for @everyone when the verify gate is on
  // (verified members keep access via the Member role allow).
  if (isGateEnabled()) {
    const allowRoles = await gateAllowRoles(guild);
    if (allowRoles.length) {
      await applyGateOverwrite(channel, allowRoles, 'Apply the verification gate to the self-role channel');
    }
  }
  return channel;
}

// Resolves the configured entries against the live guild roles (missing/managed roles
// are skipped). Button label falls back to the role name; style defaults to Secondary.
export function buildSelfRoleEntries(guild) {
  const roles = Array.isArray(config.selfRoles?.roles) ? config.selfRoles.roles : [];
  const entries = [];
  for (const entry of roles.slice(0, MAX_SELF_ROLES)) {
    if (!entry?.roleId) continue;
    const role = guild.roles.cache.get(entry.roleId) ?? null;
    if (!role || role.managed) continue;
    const label = String(entry.label?.trim() || role.name).slice(0, 80);
    const style = BUTTON_STYLES.has(entry.style) ? ButtonStyle[entry.style] : ButtonStyle.Secondary;
    entries.push({ role, label, style });
  }
  return entries;
}

// ---------- Config management (selfrole add/remove commands) ----------

// Adds a role entry to config.selfRoles.roles and persists it to config.json (the panel
// message itself is refreshed by the calling command). Returns { entries } or { error }.
export function addSelfRoleEntry(role, { label } = {}) {
  const roles = Array.isArray(config.selfRoles?.roles) ? config.selfRoles.roles : [];
  if (roles.some((entry) => entry?.roleId === role.id)) {
    return { error: `The **${role.name}** role is already on the self-role panel.` };
  }
  if (roles.length >= MAX_SELF_ROLES) {
    return { error: `The self-role panel is already at its limit of **${MAX_SELF_ROLES}** roles.` };
  }
  const entry = { roleId: role.id };
  if (label?.trim()) entry.label = label.trim().slice(0, 80);
  updateFileConfig({ selfRoles: { roles: [...roles, entry] } });
  return { entries: roles.length + 1 };
}

// Removes a role entry from config.selfRoles.roles. Accepts a Role or a raw roleId, so
// entries whose role was deleted from the server can still be removed. Returns
// { entries, name? } or { error }.
export function removeSelfRoleEntry(role, guild = null) {
  const roleId = typeof role === 'string' ? role : role?.id;
  if (!roleId) return { error: 'That role does not exist. Mention it (`<@&role>`) or provide a role ID.' };
  const roles = Array.isArray(config.selfRoles?.roles) ? config.selfRoles.roles : [];
  const next = roles.filter((entry) => entry?.roleId !== roleId);
  if (next.length === roles.length) {
    return { error: `<@&${roleId}> is not on the self-role panel.` };
  }
  updateFileConfig({ selfRoles: { roles: next } });
  const name = typeof role !== 'string' && role?.name ? role.name : (guild?.roles?.cache?.get(roleId)?.name ?? null);
  return { entries: next.length, name };
}

// ---------- Panel ----------

const section = (title, lines) => `**${title}**\n\`\`\`\n${lines.join('\n')}\n\`\`\``;

function buildSelfRolesPanelContainer(entries) {
  // Toggle buttons, packed 5 per row (entries are already capped at 25).
  const rows = [];
  for (let i = 0; i < entries.length; i += 5) {
    rows.push(
      new ActionRowBuilder().addComponents(
        entries.slice(i, i + 5).map((entry) =>
          new ButtonBuilder()
            .setCustomId(`${SELF_ROLE_BUTTON_PREFIX}${entry.role.id}`)
            .setLabel(entry.label)
            .setStyle(entry.style),
        ),
      ),
    );
  }

  let container = new ContainerBuilder()
    .setAccentColor(COLORS.info)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent('## Self Roles'))
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        section('[ • ] Roles', [
          'Toggle any role below.',
          'Press the same button again to remove it.',
        ]),
      ),
    );
  for (const row of rows) container = container.addActionRowComponents(row);
  return container;
}

function buildSelfRolesPayload(entries) {
  return {
    components: [buildSelfRolesPanelContainer(entries)],
    flags: MessageFlags.IsComponentsV2,
  };
}

// Edits the stored panel message, or posts a new one when missing. Requires at least
// one usable role - otherwise nothing is posted and null is returned.
export async function refreshSelfRolesPanelMessage(client) {
  if (!isSelfRolesEnabled()) return null;

  const guild = client.guilds.cache.get(config.guildId);
  if (!guild) return null;

  const channel = await guild.channels.fetch(config.selfRoles.channelId).catch(() => null);
  if (!channel || !channel.isTextBased()) {
    console.warn(`[selfroles] self-role channel ${config.selfRoles.channelId} not found or not text-based.`);
    return null;
  }

  const entries = buildSelfRoleEntries(guild);
  if (!entries.length) {
    console.warn('[selfroles] no usable self-role entries (roles missing/managed) - panel not posted.');
    return null;
  }

  const payload = buildSelfRolesPayload(entries);
  const stored = getInstallMessage(guild.id, SELF_ROLES_MESSAGE_KEY);

  if (stored?.message_id) {
    const message = await channel.messages.fetch(stored.message_id).catch(() => null);
    if (message && message.author.id === client.user.id) {
      await message.edit(payload).catch(() => {});
      return message;
    }
  }

  const sent = await channel.send(payload);
  setInstallMessage(guild.id, SELF_ROLES_MESSAGE_KEY, channel.id, sent.id);
  return sent;
}

// ---------- Toggles + join ping ----------

// A self-role button press: grants the role when missing, removes it when held.
export async function toggleSelfRole(interaction) {
  if (!isSelfRolesEnabled()) {
    return { error: 'Self roles are not configured - ask the staff to set up `selfRoles` in config.json.' };
  }
  const roleId = interaction.customId.slice(SELF_ROLE_BUTTON_PREFIX.length);
  const configured = (config.selfRoles.roles ?? []).some((entry) => entry?.roleId === roleId);
  if (!configured) {
    return { error: 'That role button is no longer configured - run `/install` to refresh the panel.' };
  }
  const role = await interaction.guild.roles.fetch(roleId).catch(() => null);
  if (!role) return { error: 'That role no longer exists - run `/install` to refresh the panel.' };
  if (role.managed) {
    return { error: `The **${role.name}** role is managed by an integration and cannot be self-assigned.` };
  }

  const member = interaction.member;
  const held = member.roles.cache.has(role.id);
  try {
    if (held) await member.roles.remove(role, `Self-role removed (${interaction.user.id})`);
    else await member.roles.add(role, `Self-role added (${interaction.user.id})`);
  } catch (err) {
    console.error(`[selfroles] Failed to toggle ${role.id} for ${interaction.user.id}:`, err.message);
    return { error: 'Could not toggle that role - try again in a moment.' };
  }
  return { removed: held, role };
}

// Ping posted in the self-role channel right after a member verifies, pointing them
// at the panel below. Each verification adds one removable ping message.
export async function sendSelfRolePing(member) {
  if (!isSelfRolesEnabled() || member.user?.bot) return;

  const channel = await member.guild.channels.fetch(config.selfRoles.channelId).catch(() => null);
  if (!channel || !channel.isTextBased()) return;

  const embed = baseEmbed(COLORS.success)
    .setTitle('Grab your roles')
    .setDescription(
      [
        `Welcome to **${member.guild.name}**, <@${member.id}> - you are verified.`,
        'This channel holds the self-role panel below.',
        'Press the role buttons to give yourself the roles you want.',
      ].join('\n'),
    )
    .setFooter({ text: member.guild.name });

  await channel
    .send({
      content: `<@${member.id}>`,
      embeds: [embed],
      allowedMentions: { users: [member.id], roles: [] },
    })
    .catch((err) => console.error('[selfroles] Failed to post the self-role ping:', err.message));
}
