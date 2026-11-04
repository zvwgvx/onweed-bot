// Ticket system: the panel posts one button per ticket type (general tickets / guild
// applications); each type spawns a private channel into its own category, visible
// only to the ticket owner, the configured staff role and the bot.
// In-ticket commands (slash and prefix): rename, close, add, remove.
import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  ContainerBuilder,
  MessageFlags,
  PermissionsBitField,
  Role,
  TextDisplayBuilder,
} from 'discord.js';
import { config, updateFileConfig } from '../config.js';
import { COLORS } from '../constants.js';
import {
  closeTicketRow,
  createTicketRow,
  getInstallMessage,
  getOpenTicketByOwner,
  getTicketByChannel,
  listTicketChannelIds,
  setInstallMessage,
} from '../db.js';
import { baseEmbed, buildAuditEmbed, ts, truncate } from '../utils/embeds.js';
import { sendModLog } from './log.js';

export const TICKET_PANEL_MESSAGE_KEY = 'ticket_panel';
export const TICKET_BUTTON_ID = 'ticket_open';
export const TICKET_CLOSE_BUTTON_ID = 'ticket_close';

// Posted automatically in every guild application ticket so the applicant can copy
// the format and fill it in (one field per line).
export const APPLICATION_TEMPLATE = [
  'IGN ·',
  'Region ·',
  'Level ·',
  'FKDR ·',
  'Wins ·',
  'Hours per week ·',
  'Previous guilds ·',
  'Why OnWEED -',
];

// The application card: explanation + the template inside a code block, which is the
// easiest thing to select and copy in the Discord client.
function buildApplicationEmbed() {
  return baseEmbed(COLORS.info)
    .setTitle('Guild Application')
    .setDescription(
      [
        'Fill in the template below and send it in this ticket.',
        'Copy the block, replace every dot with your answer:',
        '',
        '```',
        ...APPLICATION_TEMPLATE,
        '```',
      ].join('\n'),
    )
    .setFooter({ text: `${config.botName ?? 'Guildframe'} • incomplete applications may be denied` });
}

// Ticket types: each spawns into its own category (auto-created by /install and
// written back to config.json) and follows the per-type one-open-ticket rule.
export const TICKET_TYPES = {
  general: {
    key: 'general',
    label: 'General Ticket',
    buttonStyle: ButtonStyle.Primary,
    channelPrefix: 'ticket-',
    categoryIdKey: 'generalCategoryId',
    categoryNameKey: 'generalCategoryName',
    defaultCategoryName: 'General Tickets',
  },
  application: {
    key: 'application',
    label: 'Guild Application',
    buttonStyle: ButtonStyle.Success,
    channelPrefix: 'application-',
    categoryIdKey: 'applicationCategoryId',
    categoryNameKey: 'applicationCategoryName',
    defaultCategoryName: 'Guild Applications',
  },
};

// Panel button ids carry the type suffix: `ticket_open` (legacy = general) and
// `ticket_open:general` / `ticket_open:application`.
export function parseTicketButtonType(customId) {
  if (!customId.startsWith(TICKET_BUTTON_ID)) return null;
  const key = customId.slice(TICKET_BUTTON_ID.length).replace(/^:/, '') || 'general';
  return TICKET_TYPES[key] ? key : null;
}

// Creation entries accept a flags array for role-type overwrites (verified
// against the live API) - creator ownership is applied separately via edit.
const TICKET_MEMBER_ALLOW = [
  PermissionsBitField.Flags.ViewChannel,
  PermissionsBitField.Flags.SendMessages,
  PermissionsBitField.Flags.ReadMessageHistory,
  PermissionsBitField.Flags.AttachFiles,
  PermissionsBitField.Flags.EmbedLinks,
];

// The flag boolean form for permissionOverwrites.edit(): passing a flags array
// as allow through edit() resolves to an EMPTY overwrite on member entries -
// only the flag boolean form ({ ViewChannel: true, ... }) is reliable there.
const TICKET_MEMBER_FLAGS = {
  ViewChannel: true,
  SendMessages: true,
  ReadMessageHistory: true,
  AttachFiles: true,
  EmbedLinks: true,
};

const section = (title, lines) => `**${title}**\n\`\`\`\n${lines.join('\n')}\n\`\`\``;

// ---------- Panel ----------

function buildTicketPanelContainer() {
  const row = new ActionRowBuilder().addComponents(
    ...Object.values(TICKET_TYPES).map((type) =>
      new ButtonBuilder()
        .setCustomId(`${TICKET_BUTTON_ID}:${type.key}`)
        .setLabel(type.label)
        .setStyle(type.buttonStyle),
    ),
  );

  return new ContainerBuilder()
    .setAccentColor(COLORS.info)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent('## Tickets'))
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        section('[ • ] Support', [
          'Press a button below to open a private ticket.',
          'Only you and the ticket staff can see the channel.',
        ]),
      ),
    )
    .addActionRowComponents(row);
}

export const buildTicketPanelPayload = () => ({
  components: [buildTicketPanelContainer()],
  flags: MessageFlags.IsComponentsV2,
});

// Edits the stored panel message, or posts a new one when missing.
export async function refreshTicketPanelMessage(client) {
  const channelId = config.tickets.panelChannelId;
  if (!channelId) return null;

  const guild = client.guilds.cache.get(config.guildId);
  if (!guild) return null;

  const channel = await guild.channels.fetch(channelId).catch(() => null);
  if (!channel || !channel.isTextBased()) {
    console.warn(`[tickets] ticket panel channel ${channelId} not found or not text-based.`);
    return null;
  }

  const payload = buildTicketPanelPayload();
  const stored = getInstallMessage(guild.id, TICKET_PANEL_MESSAGE_KEY);

  if (stored?.message_id) {
    const message = await channel.messages.fetch(stored.message_id).catch(() => null);
    if (message && message.author.id === client.user.id) {
      await message.edit(payload).catch(() => {});
      return message;
    }
  }

  const sent = await channel.send(payload);
  setInstallMessage(guild.id, TICKET_PANEL_MESSAGE_KEY, channel.id, sent.id);
  return sent;
}

// ---------- Helpers ----------

// Staff = the configured ticket staff role, any of the extra staff roles, the mod role,
// or an administrator. staffRoleId is the legacy single-role field; staffRoleIds is the
// extensible list that can add more managing roles.
export const ticketStaffRoleIds = () =>
  [...new Set([config.tickets.staffRoleId, ...(config.tickets.staffRoleIds ?? [])].filter(Boolean))];

export function isTicketStaff(member) {
  if (member.permissions?.has?.(PermissionsBitField.Flags.Administrator)) return true;
  if (ticketStaffRoleIds().some((id) => member.roles?.cache?.has?.(id))) return true;
  if (config.modRoleId && member.roles?.cache?.has?.(config.modRoleId)) return true;
  return false;
}

// Every role that gets an allow overwrite on ticket channels: the staff roles + the mod
// role (deduped, only when the role exists and is not integration-managed). /install
// grants these to all open ticket channels as well.
export function ticketAccessRoleIds(guild) {
  return [...new Set([...ticketStaffRoleIds(), config.modRoleId].filter(Boolean))].filter((id) => {
    const role = guild?.roles?.cache?.get(id);
    return Boolean(role) && !role.managed;
  });
}

// The ticket row for a channel (only open tickets are actionable).
export function getTicketForChannel(guildId, channelId) {
  const row = getTicketByChannel(guildId, channelId);
  return row?.status === 'open' ? row : null;
}

// Owner of the ticket or staff - allowed to close the ticket.
export function canManageTicket(ticket, member) {
  if (!member) return false;
  return member.id === ticket.owner_id || isTicketStaff(member);
}

const sanitizeTicketName = (name, prefix = 'ticket-') =>
  `${prefix}${String(name)
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, '-')
    .replace(/^-+|-+$/g, '')}`
    .slice(0, 100)
    .replace(/-+$/, '') || prefix.replace(/-+$/, '');

// ---------- Categories ----------

// Finds or creates the per-type ticket category (config.tickets.<idKey> takes
// priority; the found/created category id is persisted back, like the roles/verify channel).
export async function ensureTicketCategory(guild, type, { reason = 'Ticket category setup' } = {}) {
  const name = String(config.tickets?.[type.categoryNameKey] || type.defaultCategoryName);
  let category = config.tickets?.[type.categoryIdKey]
    ? await guild.channels.fetch(config.tickets[type.categoryIdKey]).catch(() => null)
    : null;
  if (!category) {
    const pool = (await guild.channels.fetch().catch(() => null)) ?? guild.channels.cache;
    category =
      pool.find((c) => c.type === ChannelType.GuildCategory && c.name.toLowerCase() === name.toLowerCase()) ?? null;
  }
  if (!category) {
    category = await guild.channels.create({ name, type: ChannelType.GuildCategory, reason });
    console.log(`[tickets] Created the "${category.name}" category (${category.id}).`);
  }
  if (config.tickets?.[type.categoryIdKey] !== category.id) {
    updateFileConfig({ tickets: { [type.categoryIdKey]: category.id } });
    console.log(`[tickets] Saved tickets.${type.categoryIdKey}=${category.id} to config.json.`);
  }
  return category;
}

// ---------- Archive ----------

// Category holding closed tickets: hidden from everyone except ticket staff, found or
// created on demand (and by /install), persisted back to config.json.
export async function ensureArchiveCategory(guild, { reason = 'Ticket archive category setup' } = {}) {
  const name = String(config.tickets?.archiveCategoryName || 'Ticket Archive');
  let category = config.tickets?.archiveCategoryId
    ? await guild.channels.fetch(config.tickets.archiveCategoryId).catch(() => null)
    : null;
  if (!category) {
    const pool = (await guild.channels.fetch().catch(() => null)) ?? guild.channels.cache;
    category =
      pool.find((c) => c.type === ChannelType.GuildCategory && c.name.toLowerCase() === name.toLowerCase()) ?? null;
  }
  if (!category) {
    const overwrites = [{ id: guild.roles.everyone.id, deny: [PermissionsBitField.Flags.ViewChannel] }];
    for (const roleId of ticketAccessRoleIds(guild)) overwrites.push({ id: roleId, allow: [PermissionsBitField.Flags.ViewChannel] });
    category = await guild.channels.create({
      name,
      type: ChannelType.GuildCategory,
      permissionOverwrites: overwrites,
      reason,
    });
    console.log(`[tickets] Created the "${category.name}" category (${category.id}).`);
  }
  if (config.tickets?.archiveCategoryId !== category.id) {
    updateFileConfig({ tickets: { archiveCategoryId: category.id } });
    console.log(`[tickets] Saved tickets.archiveCategoryId=${category.id} to config.json.`);
  }
  return category;
}

// Moves a closed ticket out of the active category, renames it `closed-...` and seals
// it to ticket staff only: the opener and every added user/role lose access, the
// channel itself stays (no deletion) as the original record.
async function archiveTicketChannel(guild, channel, member) {
  const reason = `Ticket archived (closed by ${member.id})`;
  const category = await ensureArchiveCategory(guild, { reason }).catch((err) => {
    console.error('[tickets] Archive category unavailable:', err.message);
    return null;
  });

  const overwrites = [{ id: guild.roles.everyone.id, deny: [PermissionsBitField.Flags.ViewChannel] }];
  for (const roleId of ticketAccessRoleIds(guild)) {
    overwrites.push({
      id: roleId,
      allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.ReadMessageHistory],
    });
  }
  await channel.permissionOverwrites
    .set(overwrites, reason)
    .catch((err) => console.error('[tickets] Failed to seal the archived ticket:', err.message));

  if (category) {
    await channel
      .setParent(category.id, { lockPermissions: false, reason })
      .catch((err) => console.error('[tickets] Failed to move the ticket to the archive:', err.message));
  }

  const base = channel.name.replace(/^closed-/, '');
  const name = `closed-${base}`.slice(0, 100).replace(/-+$/, '');
  await channel.setName(name, reason).catch((err) => console.error('[tickets] Failed to rename the ticket:', err.message));
}

// ---------- Transcript ----------

const TRANSCRIPT_MAX_MESSAGES = 1000;
const transcriptEscape = (text) =>
  String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Walks the channel backwards in pages and returns the messages oldest-first.
async function collectTranscriptMessages(channel) {
  const collected = [];
  let before = null;
  while (collected.length < TRANSCRIPT_MAX_MESSAGES) {
    const batch = await channel.messages
      .fetch({ limit: 100, ...(before ? { before } : {}) })
      .catch(() => null);
    if (!batch?.size) break;
    collected.push(...batch.values());
    before = batch.last().id;
    if (batch.size < 100) break;
  }
  return collected.reverse();
}

// Self-contained HTML transcript attachment (no external assets).
async function buildTranscriptFile(channel, ticket, member, note) {
  const messages = await collectTranscriptMessages(channel);
  const type = TICKET_TYPES[ticket.type] ?? TICKET_TYPES.general;

  const rows = messages
    .map((message) => {
      const author = message.author ?? {
        id: message.authorId ?? 'unknown',
        tag: 'Unknown',
        displayAvatarURL: () => null,
      };
      const attachments = [...(message.attachments?.values() ?? [])]
        .map((a) => `<a href="${transcriptEscape(a.url)}">${transcriptEscape(a.name)}</a>`)
        .join(' · ');
      const embeds = message.embeds?.length ? `<div class="note">[${message.embeds.length} embed(s)]</div>` : '';
      const content = message.content
        ? transcriptEscape(message.content).replace(/\n/g, '<br>')
        : '<em class="muted">no text</em>';
      return `<div class="msg"><div class="meta"><span class="author">${transcriptEscape(
        author.tag ?? author.username ?? 'Unknown',
      )}</span> <span class="time">${new Date(message.createdTimestamp).toISOString()}</span></div><div class="content">${content}</div>${
        attachments ? `<div class="files">${attachments}</div>` : ''
      }${embeds}</div>`;
    })
    .join('\n');

  const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>${transcriptEscape(channel.name)} transcript</title>
<style>
  body { background: #1e2124; color: #dcddde; font: 14px/1.5 system-ui, sans-serif; margin: 0; padding: 24px; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  .meta-header { color: #99aab5; margin-bottom: 20px; }
  .msg { padding: 10px 0; border-bottom: 1px solid #2f3136; }
  .meta { margin-bottom: 2px; }
  .author { font-weight: 600; color: #ffffff; }
  .time { color: #72767d; font-size: 12px; }
  .files a { color: #00aff4; }
  .note, .muted { color: #72767d; font-style: italic; }
</style></head>
<body>
<h1>${transcriptEscape(type.label)} • ${transcriptEscape(channel.name)}</h1>
<div class="meta-header">Opened by ${transcriptEscape(ticket.owner_id)} • Closed by ${transcriptEscape(
    member.id,
  )} • ${new Date().toISOString()}</div>
${note ? `<div class="meta-header">Note: ${transcriptEscape(note)}</div>` : ''}
${rows || '<div class="msg"><em class="muted">No messages.</em></div>'}
</body></html>`;

  return new AttachmentBuilder(Buffer.from(html, 'utf8'), { name: `ticket-${channel.name}.html` });
}

// ---------- Ticket log channel ----------

// Posts the closure summary (opener, closer, note, link to the archived channel) plus
// the transcript attachment to tickets.logChannelId. Returns the sent message or null.
async function sendTicketLog(guild, { channel, ticket, member, note, transcript }) {
  const logChannelId = config.tickets?.logChannelId;
  if (!logChannelId) return null;

  const logChannel = await guild.channels.fetch(logChannelId).catch(() => null);
  if (!logChannel || !logChannel.isTextBased()) {
    console.warn(`[tickets] Ticket log channel ${logChannelId} not found or not text-based.`);
    return null;
  }

  const type = TICKET_TYPES[ticket.type] ?? TICKET_TYPES.general;
  const embed = baseEmbed(COLORS.info)
    .setTitle('Ticket Closed')
    .setDescription(`**${type.label}** • <#${channel.id}> (archived, staff-only)`)
    .addFields(
      { name: 'Opened by', value: `<@${ticket.owner_id}>`, inline: true },
      { name: 'Closed by', value: `<@${member.id}>`, inline: true },
      { name: 'Opened', value: ts(ticket.created_at, 'F'), inline: true },
      { name: 'Closed', value: ts(Date.now(), 'F'), inline: true },
    )
    .setFooter({ text: `Ticket row #${ticket.id}` })
    .setTimestamp(Date.now());
  if (note) embed.addFields({ name: 'Note', value: truncate(note, 400) });

  return logChannel
    .send({
      embeds: [embed],
      files: transcript ? [transcript] : [],
      allowedMentions: { parse: [] },
    })
    .catch((err) => {
      console.error('[tickets] Failed to post the ticket log entry:', err.message);
      return null;
    });
}

// ---------- Open ----------

// Creates the ticket channel in the per-type category (auto-created when missing).
// Uses the GuildMember from the button interaction; reply payloads are returned for the caller.
export async function openTicket(interaction, client, typeKey = 'general') {
  const type = TICKET_TYPES[typeKey] ?? TICKET_TYPES.general;
  const guild = interaction.guild;

  const existing = getOpenTicketByOwner(guild.id, interaction.user.id, type.key);
  if (existing) {
    return {
      error: `You already have an open ${type.label.toLowerCase()}: <#${existing.channel_id}>. Close it first or use that one.`,
    };
  }

  const accessRoleIds = ticketAccessRoleIds(guild);

  const overwrites = [{ id: guild.roles.everyone.id, deny: [PermissionsBitField.Flags.ViewChannel] }];
  for (const roleId of accessRoleIds) {
    overwrites.push({ id: roleId, allow: TICKET_MEMBER_ALLOW });
  }

  if (!guild.members.me.permissions.has(PermissionsBitField.Flags.ManageChannels)) {
    return { error: 'The bot is missing the **Manage Channels** permission - a ticket channel cannot be created.' };
  }

  const reason = `${type.label} opened by ${interaction.user.id}`;
  // The panel's own category is the fallback only when the type category cannot be resolved.
  const category = await ensureTicketCategory(guild, type, { reason }).catch(() => null);

  let channel;
  try {
    channel = await guild.channels.create({
      name: sanitizeTicketName(interaction.user.username, type.channelPrefix),
      type: ChannelType.GuildText,
      parent: category?.id ?? interaction.channel?.parentId ?? undefined,
      permissionOverwrites: overwrites,
      reason,
    });
  } catch (err) {
    console.error('[tickets] Channel creation failed:', err.message);
    return { error: `Could not create the ticket channel: ${err.message}` };
  }

  // Owner allow uses the flag-object form - the array form produces an empty
  // overwrite for member entries (verified against the live API).
  await channel.permissionOverwrites
    .edit(interaction.user.id, TICKET_MEMBER_FLAGS, { reason: `Ticket owner: ${interaction.user.id}` })
    .catch((err) => console.error('[tickets] Owner overwrite failed:', err.message));

  const ticket = createTicketRow({
    guildId: guild.id,
    channelId: channel.id,
    ownerId: interaction.user.id,
    type: type.key,
  });

  // Welcome message shown to the opener: mention, staff tag and the Close button only.
  const welcome = baseEmbed(COLORS.success)
    .setTitle(type.label)
    .setDescription(`Welcome <@${interaction.user.id}>.`)
    .setFooter({ text: 'Note: pinging staff can result in a permanent ticket ban' });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(TICKET_CLOSE_BUTTON_ID).setLabel('Close Ticket').setStyle(ButtonStyle.Danger),
  );

  await channel
    .send({
      content: accessRoleIds.length
        ? `<@${interaction.user.id}> ${accessRoleIds.map((id) => `<@&${id}>`).join(' ')}`
        : `<@${interaction.user.id}>`,
      embeds: [welcome],
      components: [row],
      allowedMentions: {
        users: [interaction.user.id],
        roles: accessRoleIds,
      },
    })
    .catch(() => {});

  // Guild applications get the application template right away so the applicant
  // knows exactly what to fill in (embed + copyable code block).
  if (type.key === 'application') {
    await channel
      .send({
        content: `<@${interaction.user.id}>`,
        embeds: [buildApplicationEmbed()],
        allowedMentions: { users: [interaction.user.id] },
      })
      .catch((err) => console.error('[tickets] Failed to post the application template:', err.message));
  }

  return { ticket, channel };
}

// ---------- Rename / Add / Remove / Close ----------

export async function renameTicket(guild, ticket, newName, member) {
  const type = TICKET_TYPES[ticket.type] ?? TICKET_TYPES.general;
  const channel = await guild.channels.fetch(ticket.channel_id).catch(() => null);
  if (!channel) return { error: 'The ticket channel no longer exists.' };

  const clean = sanitizeTicketName(newName, type.channelPrefix)
    .slice(type.channelPrefix.length)
    .replace(/^-+|-+$/g, '');
  if (!clean) return { error: 'The new name produced an empty channel name.' };

  try {
    await channel.setName(sanitizeTicketName(clean, type.channelPrefix), `Ticket renamed by ${member.id}`);
  } catch (err) {
    return { error: `Could not rename the channel: ${err.message}` };
  }

  await channel
    .send({ embeds: [baseEmbed(COLORS.info).setDescription(`Channel renamed by <@${member.id}>.`)] })
    .catch(() => {});
  return { channel };
}

// Accepts a Member, a Role or a raw User, adds it to the ticket overwrites and announces it.
export async function addToTicket(guild, ticket, target, member) {
  const channel = await guild.channels.fetch(ticket.channel_id).catch(() => null);
  if (!channel) return { error: 'The ticket channel no longer exists.' };

  try {
    await channel.permissionOverwrites.edit(
      target.id,
      TICKET_MEMBER_FLAGS,
      { reason: `Added to ticket by ${member.id}` },
    );
  } catch (err) {
    return { error: `Could not update the channel permissions: ${err.message}` };
  }

  const label = target instanceof Role ? `<@&${target.id}>` : `<@${target.id}>`;
  await channel
    .send({ embeds: [baseEmbed(COLORS.info).setDescription(`${label} was added to this ticket by <@${member.id}>.`)] })
    .catch(() => {});
  return { channel };
}

export async function removeFromTicket(guild, ticket, target, member) {
  const channel = await guild.channels.fetch(ticket.channel_id).catch(() => null);
  if (!channel) return { error: 'The ticket channel no longer exists.' };

  // The owner cannot be removed - the ticket would become unusable for them.
  if (target.id === ticket.owner_id) {
    return { error: 'The ticket owner cannot be removed from their own ticket.' };
  }

  try {
    await channel.permissionOverwrites.delete(target.id, `Removed from ticket by ${member.id}`);
  } catch (err) {
    return { error: `Could not update the channel permissions: ${err.message}` };
  }

  const label = target instanceof Role ? `<@&${target.id}>` : `<@${target.id}>`;
  await channel
    .send({
      embeds: [baseEmbed(COLORS.warn).setDescription(`${label} was removed from this ticket by <@${member.id}>.`)],
    })
    .catch(() => {});
  return { channel };
}

// Posts the closing embed, marks the row closed, archives the channel (kept, renamed
// `closed-...`, moved to the archive category and sealed to staff), logs the closure
// with a transcript to the ticket log channel, and audits to the mod log.
export async function closeTicket(guild, ticket, member, note, client) {
  const channel = await guild.channels.fetch(ticket.channel_id).catch(() => null);
  if (!channel) return { error: 'The ticket channel no longer exists.' };

  await closeTicketRow(ticket.id, { closedBy: member.id, note: note ? truncate(note, 500) : null });

  await channel
    .send({
      embeds: [
        baseEmbed(COLORS.warn)
          .setDescription(
            [
              `**Ticket closed** by <@${member.id}>.`,
              note ? `Note: ${truncate(note, 400)}` : null,
              'This channel is now archived - only ticket staff can see it.',
            ]
              .filter(Boolean)
              .join('\n'),
          ),
      ],
    })
    .catch(() => {});

  // Transcript of everything posted before the archive; failures never block the close.
  const transcript = await buildTranscriptFile(channel, ticket, member, note).catch((err) => {
    console.error('[tickets] Failed to build the transcript:', err.message);
    return null;
  });

  await archiveTicketChannel(guild, channel, member);
  await sendTicketLog(guild, { channel, ticket, member, note, transcript });

  const owner = await guild.members.fetch(ticket.owner_id).catch(() => null);
  const typeLabel = TICKET_TYPES[ticket.type]?.label ?? null;
  await sendModLog(
    guild,
    buildAuditEmbed({
      title: 'Ticket Closed',
      description: `Ticket <#${channel.id}>${typeLabel ? ` (${typeLabel})` : ''} - opened by ${
        owner ? `<@${owner.id}>` : `<@${ticket.owner_id}>`
      } - closed by <@${member.id}>. Archived and locked to staff; no messages are deleted.`,
      color: COLORS.warn,
      fields: note ? [{ name: 'Note', value: truncate(note, 400) }] : [],
    }),
  );

  return { closed: true, archived: true, channelId: channel.id };
}

// ---------- Staff role management (=ticketroleadd / =ticketroleremove) ----------

// Permanently adds a role to config.tickets.staffRoleIds and (re-)grants every ticket
// staff role access to all open ticket channels. Returns { stats } or { error }.
export async function addTicketStaffRole(guild, role, reason = 'Add ticket staff role') {
  if (ticketStaffRoleIds().includes(role.id)) {
    return {
      error: `The **${role.name}** role already manages tickets (it is configured as ticket staff or the mod role).`,
    };
  }
  if (role.managed) {
    return { error: `The **${role.name}** role is managed by an integration and cannot be used as ticket staff.` };
  }

  const current = Array.isArray(config.tickets.staffRoleIds) ? config.tickets.staffRoleIds : [];
  updateFileConfig({ tickets: { staffRoleIds: [...current, role.id] } });

  const stats = await applyTicketStaffOverwrites(guild, reason);
  return { stats };
}

// Removes a role from config.tickets.staffRoleIds and revokes its overwrite on all open
// ticket channels - unless the role still grants access another way (legacy
// staffRoleId or the mod role; those are kept and only the config entry is removed).
// Returns { revoked, ok, failed } or { error }.
export async function removeTicketStaffRole(guild, role, reason = 'Remove ticket staff role') {
  const current = Array.isArray(config.tickets.staffRoleIds) ? config.tickets.staffRoleIds : [];
  if (!current.includes(role.id)) {
    return {
      error: `The **${role.name}** role is not in the extensible ticket staff list (tickets.staffRoleIds in config.json).`,
    };
  }
  updateFileConfig({ tickets: { staffRoleIds: current.filter((id) => id !== role.id) } });

  // The role keeps managing tickets when it is still the legacy staff role or the mod
  // role - in that case its overwrites stay untouched.
  const stillAccess = ticketStaffRoleIds().includes(role.id);

  let ok = 0;
  let failed = 0;
  for (const channelId of listTicketChannelIds(guild.id)) {
    const channel = await guild.channels.fetch(channelId).catch(() => null);
    if (!channel) continue; // deleted (already closed) ticket
    if (stillAccess) continue;
    if (!channel.permissionOverwrites.cache.has(role.id)) continue; // nothing to revoke
    try {
      await channel.permissionOverwrites.delete(role.id, reason);
      ok += 1;
    } catch {
      failed += 1;
    }
  }
  return { revoked: !stillAccess, ok, failed };
}

// ---------- Staff access ----------

// Grants every ticket staff role (staffRoleId + staffRoleIds + mod role) access to all
// open ticket channels. Used by /install so config changes reach existing tickets (new
// tickets always get the overwrites at creation time). Skips closed/deleted channels.
export async function applyTicketStaffOverwrites(guild, reason = 'Grant ticket staff access') {
  const roleIds = ticketAccessRoleIds(guild);
  if (!roleIds.length) return { ok: 0, failed: 0, roles: 0 };

  let ok = 0;
  let failed = 0;
  for (const channelId of listTicketChannelIds(guild.id)) {
    const channel = await guild.channels.fetch(channelId).catch(() => null);
    if (!channel) continue; // deleted (already closed) ticket
    try {
      for (const roleId of roleIds) {
        await channel.permissionOverwrites.edit(roleId, TICKET_MEMBER_FLAGS, { reason });
      }
      ok += 1;
    } catch {
      failed += 1;
    }
  }
  return { ok, failed, roles: roleIds.length };
}
