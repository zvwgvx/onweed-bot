// Prefix command dispatcher. Usage: =mute <target> [duration] [reason]
// Every slash command has a prefix equivalent here.
import { PermissionsBitField } from 'discord.js';
import { config } from '../config.js';
import { COLORS, HISTORY_PAGE_SIZE, MAX_BAN_MS, MAX_MUTE_MS, WARNINGS_PAGE_SIZE } from '../constants.js';
import {
  countActiveByType,
  createCase,
  getActiveCases,
  getCaseByNumber,
  hideCase,
  listCases,
  setActiveCasesStatus,
} from '../db.js';
import { applyWarnEscalation } from '../services/escalation.js';
import {
  INSTALL_DELAYING_STATUSES,
  buildSetupSummaryEmbed,
  runInstall,
  runUninstall,
} from '../services/install.js';
import { logCase } from '../services/log.js';
import { applyMute, applyMuteOverwritesAll, ensureMuteRole, removeMute } from '../services/mutes.js';
import { sendPunishmentDm } from '../services/notify.js';
import { cancelCaseTimer, scheduleCase } from '../services/scheduler.js';
import {
  addSelfRoleEntry,
  isSelfRolesEnabled,
  refreshSelfRolesPanelMessage,
  removeSelfRoleEntry,
} from '../services/selfroles.js';
import { restartProcess } from '../services/restart.js';
import { sendModLog } from '../services/log.js';
import { purgeMessages, describePurge, buildPurgeLogEmbed, isPurgeBlockedChannel } from '../services/purge.js';
import {
  addTicketStaffRole,
  addToTicket,
  canManageTicket,
  closeTicket,
  getTicketForChannel,
  removeFromTicket,
  removeTicketStaffRole,
  renameTicket,
  isTicketStaff,
  ticketStaffRoleIds,
} from '../services/tickets.js';
import { formatDuration, parseDuration } from '../utils/duration.js';
import { canUseDuringLockdown, isCommandAllowed, lockdownEmbed } from '../utils/lockdown.js';
import {
  baseEmbed,
  buildActionEmbed,
  buildCaseEmbed,
  buildPunishmentsEmbed,
  errorEmbed,
  infoEmbed,
  successEmbed,
  truncate,
  ts,
} from '../utils/embeds.js';
import { paginateMessage } from '../utils/paginate.js';
import {
  canModerateMemberMessage,
  canSelfView,
  ensureModeratorMessage,
  isAdministrator,
  resolveRole,
  roleAssignabilityError,
  selfViewDeniedText,
} from '../utils/permissions.js';

const ALIASES = {
  mute: 'mute',
  unmute: 'unmute',
  kick: 'kick',
  ban: 'ban',
  unban: 'unban',
  warn: 'warn',
  history: 'history',
  puns: 'history',
  h: 'history',
  punishments: 'history',
  case: 'case',
  warnings: 'warnings',
  setup: 'setup',
  install: 'install',
  uninstall: 'uninstall',
  rename: 'rename',
  close: 'close',
  add: 'add',
  remove: 'remove',
  addrole: 'addrole',
  removerole: 'removerole',
  purge: 'purge',
  addselfrole: 'addselfrole',
  removeselfrole: 'removeselfrole',
  ticketroleadd: 'ticketroleadd',
  ticketroleremove: 'ticketroleremove',
  restart: 'restart',
  help: 'help',
};

const DURATION_TOKEN = /^(?:\d+[smhdw])+$|^perm(?:anent|anently)?$/i;
const HISTORY_TYPES = ['all', 'warn', 'mute', 'kick', 'ban', 'unmute', 'unban', 'note'];

const looksLikeDuration = (token) => DURATION_TOKEN.test(token);

// Resolves a target from a mention, a raw user ID, or an exact username / global name /
// display name. Partial matches are rejected on purpose: a moderation action must never
// guess (e.g. `=ban the ai` must not fall back to the first member starting with "the").
async function resolveTarget(guild, input) {
  const clean = String(input ?? '').trim();
  if (!clean) return null;
  const mention = clean.match(/^<@!?(\d{17,20})>$/);
  const id = mention ? mention[1] : /^\d{17,20}$/.test(clean) ? clean : null;

  if (id) {
    const member = await guild.members.fetch(id).catch(() => null);
    if (member) return member;
    return (await guild.client.users.fetch(id).catch(() => null)) ?? null;
  }

  const results = await guild.members.fetch({ query: clean, limit: 100 }).catch(() => null);
  if (!results?.size) return null;
  return uniqueExactMatch(results, clean);
}

// Only exact name matches count; two members sharing the name stay unresolved (ambiguous).
function uniqueExactMatch(members, input) {
  const lower = input.toLowerCase();
  const matches = members.filter((m) =>
    [m.user.username, m.user.globalName, m.displayName].filter(Boolean).some((name) => name.toLowerCase() === lower),
  );
  return matches.size === 1 ? matches.first() : null;
}

// Resolves `<target> [rest...]` with support for names containing spaces: the longest
// prefix of args that matches a member name wins (`=ban the ai` -> member "the ai"),
// and the remaining tokens become the duration/reason.
async function resolveTargetArgs(guild, args) {
  const first = args[0];
  if (!first) return null;

  if (/^<@!?\d{17,20}>$/.test(first) || /^\d{17,20}$/.test(first)) {
    const target = await resolveTarget(guild, first);
    return target ? { target, rest: args.slice(1) } : null;
  }

  const results = await guild.members.fetch({ query: first, limit: 100 }).catch(() => null);
  if (!results?.size) return null;

  for (let length = Math.min(args.length, 4); length >= 1; length--) {
    const target = uniqueExactMatch(results, args.slice(0, length).join(' '));
    if (target) return { target, rest: args.slice(length) };
  }
  return null;
}

// args here are the tokens AFTER the target: [duration] [reason...].
function parseDurationArgs(args) {
  if (args[0] && looksLikeDuration(args[0])) {
    return { durationInput: args[0], reason: args.slice(1).join(' ').trim() || null };
  }
  return { durationInput: null, reason: args.join(' ').trim() || null };
}

const isMember = (target) => typeof target?.roles !== 'undefined';
const toUser = (target) => (isMember(target) ? target.user : target);

// ---------- Commands ----------

async function muteCommand(message, args, client) {
  if (!ensureModeratorMessage(message, PermissionsBitField.Flags.ManageRoles, 'Manage Roles')) return;
  if (!message.guild.members.me.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
    return message.reply({ embeds: [errorEmbed('The bot is missing the **Manage Roles** permission.')] });
  }

  const resolved = await resolveTargetArgs(message.guild, args);
  if (!resolved) return message.reply({ embeds: [errorEmbed('No member matched that exactly. Mention them, use their user ID, or type their exact username / display name.')] });
  const target = resolved.target;
  if (!isMember(target)) return message.reply({ embeds: [errorEmbed('That user is not in this server.')] });
  if (!canModerateMemberMessage(message, target)) return;

  const { durationInput, reason } = parseDurationArgs(resolved.rest);
  let durationMs;
  try {
    durationMs = parseDuration(durationInput);
  } catch (err) {
    return message.reply({ embeds: [errorEmbed(err.message)] });
  }
  if (durationMs && durationMs > MAX_MUTE_MS) {
    return message.reply({ embeds: [errorEmbed(`Maximum mute duration is ${formatDuration(MAX_MUTE_MS)}.`)] });
  }

  const active = getActiveCases(message.guild.id, target.id, 'mute');
  if (active.length) {
    return message.reply({
      embeds: [errorEmbed(`<@${target.id}> is already muted (Case #${active[0].case_number}). Use \`${config.prefix}unmute\` first.`)],
    });
  }

  try {
    const { caseRow } = await applyMute(message.guild, target, {
      moderatorId: message.author.id,
      reason,
      durationMs,
      clientId: client.user.id,
    });
    await message.reply({
      embeds: [
        buildActionEmbed({
          action: 'mute',
          target: target.user,
          durationMs,
          reason,
          guildName: message.guild.name,
        }),
      ],
    });
  } catch (err) {
    console.error('[prefix:mute]', err);
    await message.reply({ embeds: [errorEmbed(`Could not mute: ${err.message}`)] });
  }
}

async function unmuteCommand(message, args, client) {
  if (!ensureModeratorMessage(message, PermissionsBitField.Flags.ManageRoles, 'Manage Roles')) return;

  const resolved = await resolveTargetArgs(message.guild, args);
  if (!resolved) return message.reply({ embeds: [errorEmbed('No member matched that exactly. Mention them, use their user ID, or type their exact username / display name.')] });
  const target = resolved.target;

  const reason = resolved.rest.join(' ').trim() || null;
  try {
    const caseRow = await removeMute(message.guild, {
      userId: target.id,
      member: isMember(target) ? target : null,
      moderatorId: message.author.id,
      reason,
      clientId: client.user.id,
    });
    if (!caseRow) return message.reply({ embeds: [errorEmbed(`<@${target.id}> is not muted.`)] });
    await message.reply({
      embeds: [
        buildActionEmbed({
          action: 'unmute',
          target: toUser(target),
          reason,
          guildName: message.guild.name,
        }),
      ],
    });
  } catch (err) {
    console.error('[prefix:unmute]', err);
    await message.reply({ embeds: [errorEmbed(`Could not unmute: ${err.message}`)] });
  }
}

async function kickCommand(message, args, client) {
  if (!ensureModeratorMessage(message, PermissionsBitField.Flags.KickMembers, 'Kick Members', { modRoleAllowed: false })) return;
  if (!message.guild.members.me.permissions.has(PermissionsBitField.Flags.KickMembers)) {
    return message.reply({ embeds: [errorEmbed('The bot is missing the **Kick Members** permission.')] });
  }

  const resolved = await resolveTargetArgs(message.guild, args);
  if (!resolved) return message.reply({ embeds: [errorEmbed('No member matched that exactly. Mention them, use their user ID, or type their exact username / display name.')] });
  const target = resolved.target;
  if (!isMember(target)) return message.reply({ embeds: [errorEmbed('That user is not in this server.')] });
  if (!canModerateMemberMessage(message, target)) return;

  const reason = resolved.rest.join(' ').trim() || null;
  const caseRow = createCase({
    guildId: message.guild.id,
    userId: target.id,
    moderatorId: message.author.id,
    type: 'kick',
    reason,
  });
  await sendPunishmentDm(target, { guild: message.guild, caseRow, clientId: client.user.id });
  try {
    await target.kick(`Case #${caseRow.case_number} by ${message.author.tag}${reason ? `: ${reason}` : ''}`.slice(0, 512));
  } catch (err) {
    hideCase(caseRow.id);
    return message.reply({ embeds: [errorEmbed(`Could not kick: ${err.message}`)] });
  }
  await logCase(message.guild, caseRow, { clientId: client.user.id });
  await message.reply({
    embeds: [
      buildActionEmbed({
        action: 'kick',
        target: target.user,
        reason,
        guildName: message.guild.name,
      }),
    ],
  });
}

async function banCommand(message, args, client) {
  if (!ensureModeratorMessage(message, PermissionsBitField.Flags.BanMembers, 'Ban Members', { modRoleAllowed: false })) return;
  if (!message.guild.members.me.permissions.has(PermissionsBitField.Flags.BanMembers)) {
    return message.reply({ embeds: [errorEmbed('The bot is missing the **Ban Members** permission.')] });
  }

  const resolved = await resolveTargetArgs(message.guild, args);
  if (!resolved) return message.reply({ embeds: [errorEmbed('No member matched that exactly. Mention them, use their user ID, or type their exact username / display name.')] });
  const target = resolved.target;
  if (target.id === client.user.id) return message.reply({ embeds: [errorEmbed('I cannot ban myself.')] });
  if (isMember(target) && !canModerateMemberMessage(message, target)) return;

  const existing = await message.guild.bans.fetch(target.id).catch(() => null);
  if (existing) return message.reply({ embeds: [errorEmbed(`<@${target.id}> is already banned.`)] });

  const { durationInput, reason } = parseDurationArgs(resolved.rest);
  let durationMs;
  try {
    durationMs = parseDuration(durationInput);
  } catch (err) {
    return message.reply({ embeds: [errorEmbed(err.message)] });
  }
  if (durationMs && durationMs > MAX_BAN_MS) {
    return message.reply({ embeds: [errorEmbed(`Maximum ban duration is ${formatDuration(MAX_BAN_MS)}.`)] });
  }

  const caseRow = createCase({
    guildId: message.guild.id,
    userId: target.id,
    moderatorId: message.author.id,
    type: 'ban',
    reason,
    durationMs,
  });
  // DM before the ban: after it the bot may no longer share a guild with the user.
  await sendPunishmentDm(target, { guild: message.guild, caseRow, clientId: client.user.id });
  try {
    await message.guild.bans.create(target.id, {
      deleteMessageSeconds: 0,
      reason: `Case #${caseRow.case_number} by ${message.author.tag}${reason ? `: ${reason}` : ''}`.slice(0, 512),
    });
  } catch (err) {
    hideCase(caseRow.id);
    return message.reply({ embeds: [errorEmbed(`Could not ban: ${err.message}`)] });
  }
  if (durationMs) scheduleCase(caseRow.id);
  await logCase(message.guild, caseRow, { clientId: client.user.id });
  await message.reply({
    embeds: [
      buildActionEmbed({
        action: 'ban',
        target: toUser(target),
        durationMs,
        reason,
        guildName: message.guild.name,
      }),
    ],
  });
}

async function unbanCommand(message, args, client) {
  if (!ensureModeratorMessage(message, PermissionsBitField.Flags.BanMembers, 'Ban Members')) return;

  const userId = (args[0] ?? '').trim();
  if (!/^\d{17,20}$/.test(userId)) {
    return message.reply({ embeds: [errorEmbed(`Usage: \`${config.prefix}unban <user id> [reason]\``)] });
  }
  const existing = await message.guild.bans.fetch(userId).catch(() => null);
  if (!existing) return message.reply({ embeds: [errorEmbed(`<@${userId}> is not banned.`)] });

  const reason = args.slice(1).join(' ').trim() || null;
  for (const c of getActiveCases(message.guild.id, userId, 'ban')) cancelCaseTimer(c.id);
  setActiveCasesStatus(message.guild.id, userId, 'ban', 'removed');

  try {
    await message.guild.bans.remove(
      userId,
      `Unban by ${message.author.tag}${reason ? `: ${reason}` : ''}`.slice(0, 512),
    );
  } catch (err) {
    return message.reply({ embeds: [errorEmbed(`Could not unban: ${err.message}`)] });
  }

  const caseRow = createCase({
    guildId: message.guild.id,
    userId,
    moderatorId: message.author.id,
    type: 'unban',
    reason,
  });
  await logCase(message.guild, caseRow, { clientId: client.user.id });
  await message.reply({
    embeds: [
      buildActionEmbed({ action: 'unban', target: existing.user, reason, guildName: message.guild.name }),
    ],
  });
}

async function warnCommand(message, args, client) {
  if (!ensureModeratorMessage(message, PermissionsBitField.Flags.ManageMessages, 'Manage Messages')) return;

  const resolved = await resolveTargetArgs(message.guild, args);
  if (!resolved) return message.reply({ embeds: [errorEmbed('No member matched that exactly. Mention them, use their user ID, or type their exact username / display name.')] });
  const target = resolved.target;

  const reason = resolved.rest.join(' ').trim() || null;
  const caseRow = createCase({
    guildId: message.guild.id,
    userId: target.id,
    moderatorId: message.author.id,
    type: 'warn',
    reason,
  });
  await logCase(message.guild, caseRow, { clientId: client.user.id });
  await sendPunishmentDm(target, { guild: message.guild, caseRow, clientId: client.user.id });

  const activeWarns = countActiveByType(message.guild.id, target.id, 'warn');
  const embed = buildActionEmbed({
    action: 'warn',
    target: toUser(target),
    reason,
    guildName: message.guild.name,
  });
  embed.addFields({ name: 'Active warnings', value: String(activeWarns), inline: true });

  try {
    const escalated = await applyWarnEscalation(message.guild, target.id, client);
    if (escalated) {
      embed.addFields({
        name: 'Automatic mute',
        value: `Reached ${escalated.threshold} warning(s) - mute applied (Case #${escalated.caseRow.case_number}).`,
      });
    }
  } catch (err) {
    console.error('[prefix:warn] Escalation failed:', err);
  }

  await message.reply({ embeds: [embed] });
}

async function historyCommand(message, args, client) {
  const inMutedCmds = Boolean(config.mutedBotCmdsChannelId && message.channelId === config.mutedBotCmdsChannelId);

  // No target: the caller's own history (members holding the Member role may
  // use this; in the muted-commands channel it is always allowed). A target
  // other than the caller still needs a moderator.
  let target;
  let type = 'all';
  if (!args[0]) {
    if (!canSelfView(message.member) && !inMutedCmds) {
      return message.reply({ embeds: [errorEmbed(selfViewDeniedText(), 'Lookup denied')] });
    }
    target = message.member;
  } else {
    // Try the full string first (names may end in a case-type word); otherwise treat
    // the trailing token as the optional type: `=history the ai warn`.
    target = await resolveTarget(message.guild, args.join(' '));
    if (!target) {
      const last = (args[args.length - 1] ?? '').toLowerCase();
      if (HISTORY_TYPES.includes(last)) {
        type = last;
        target = await resolveTarget(message.guild, args.slice(0, -1).join(' '));
      }
    }
    if (!target) {
      return message.reply({ embeds: [errorEmbed('No member matched that exactly. Mention them, use their user ID, or type their exact username / display name.')] });
    }
    if (target.id !== message.author.id) {
      if (!ensureModeratorMessage(message, PermissionsBitField.Flags.ManageMessages, 'Manage Messages')) return;
    } else if (!canSelfView(message.member) && !inMutedCmds) {
      return message.reply({ embeds: [errorEmbed(selfViewDeniedText(), 'Lookup denied')] });
    }
  }

  const user = toUser(target);
  const { total } = listCases({ guildId: message.guild.id, userId: user.id, type, limit: 1 });
  if (!total) return message.reply({ embeds: [infoEmbed('Punishments', `No records found for ${user.username}.`)] });

  const totalPages = Math.ceil(total / HISTORY_PAGE_SIZE);
  const render = (page) =>
    buildPunishmentsEmbed({
      user,
      cases: listCases({
        guildId: message.guild.id,
        userId: user.id,
        type,
        limit: HISTORY_PAGE_SIZE,
        offset: page * HISTORY_PAGE_SIZE,
      }).rows,
      page,
      totalPages,
      total,
      guildName: message.guild.name,
      clientId: client.user.id,
    });

  const sent = await message.reply({ embeds: [render(0)] });
  await paginateMessage(sent, { totalPages, render, authorId: message.author.id });
}

async function caseCommand(message, args, client) {
  const sub = (args[0] ?? '').toLowerCase();

  // =case delete <number> [reason] (mirrors /case delete)
  if (sub === 'delete') {
    if (!ensureModeratorMessage(message, PermissionsBitField.Flags.ManageGuild, 'Manage Server')) return;

    const number = Number.parseInt(args[1] ?? '', 10);
    if (!Number.isInteger(number) || number < 1) {
      return message.reply({ embeds: [errorEmbed(`Usage: \`${config.prefix}case delete <number> [reason]\``)] });
    }
    const caseRow = getCaseByNumber(message.guild.id, number);
    if (!caseRow || caseRow.hidden) return message.reply({ embeds: [errorEmbed('Case not found.')] });

    hideCase(caseRow.id);
    const reason = args.slice(2).join(' ').trim() || null;
    const noteCase = createCase({
      guildId: message.guild.id,
      userId: caseRow.user_id,
      moderatorId: message.author.id,
      type: 'note',
      reason: `Deleted Case #${caseRow.case_number} (${caseRow.type})${reason ? `: ${reason}` : ''}`,
    });
    await logCase(message.guild, noteCase, { clientId: client.user.id });
    return message.reply({ embeds: [buildCaseEmbed(noteCase, { clientId: client.user.id })] });
  }

  // =case <number> / =case view <number> (mirrors /case view)
  if (!ensureModeratorMessage(message, PermissionsBitField.Flags.ManageMessages, 'Manage Messages')) return;

  const number = Number.parseInt((sub === 'view' ? args[1] : args[0]) ?? '', 10);
  if (!Number.isInteger(number) || number < 1) {
    return message.reply({ embeds: [errorEmbed(`Usage: \`${config.prefix}case <number>\``)] });
  }
  const caseRow = getCaseByNumber(message.guild.id, number);
  if (!caseRow || caseRow.hidden) return message.reply({ embeds: [errorEmbed('Case not found.')] });
  await message.reply({ embeds: [buildCaseEmbed(caseRow, { clientId: client.user.id })] });
}

// =warnings list <user|empty=you> | =warnings clear <user> [reason] (mirrors /warnings)
async function warningsCommand(message, args, client) {
  const sub = (args[0] ?? '').toLowerCase();
  if (sub !== 'list' && sub !== 'clear') {
    return message.reply({
      embeds: [
        errorEmbed(
          `Usage: \`${config.prefix}warnings list <user|empty for you>\` or \`${config.prefix}warnings clear <user> [reason]\``,
        ),
      ],
    });
  }

  let target;
  let clearReason = null;
  if (sub === 'clear') {
    if (!ensureModeratorMessage(message, PermissionsBitField.Flags.ManageMessages, 'Manage Messages')) return;
    if (!args[1]) {
      return message.reply({
        embeds: [errorEmbed(`Usage: \`${config.prefix}warnings clear <user> [reason]\``)],
      });
    }
  } else if (!args[1]) {
    // No user given: view your own warnings (members included).
    if (!canSelfView(message.member)) {
      return message.reply({ embeds: [errorEmbed(selfViewDeniedText(), 'Lookup denied')] });
    }
    target = message.member;
  } else {
    if (!ensureModeratorMessage(message, PermissionsBitField.Flags.ManageMessages, 'Manage Messages')) return;
  }

  if (sub === 'clear' || args[1]) {
    const resolved = await resolveTargetArgs(message.guild, args.slice(1));
    if (!resolved) {
      return message.reply({ embeds: [errorEmbed('No member matched that exactly. Mention them, use their user ID, or type their exact username / display name.')] });
    }
    target = resolved.target;
    if (sub === 'clear') clearReason = resolved.rest.join(' ').trim() || null;
  }
  const user = toUser(target);

  if (sub === 'list') {
    const { total } = listCases({ guildId: message.guild.id, userId: user.id, type: 'warn', limit: 1 });
    if (!total) return message.reply({ embeds: [infoEmbed('Warnings', `${user.username} has no warnings.`)] });

    const totalPages = Math.ceil(total / WARNINGS_PAGE_SIZE);
    const render = (page) => {
      const { rows } = listCases({
        guildId: message.guild.id,
        userId: user.id,
        type: 'warn',
        limit: WARNINGS_PAGE_SIZE,
        offset: page * WARNINGS_PAGE_SIZE,
      });
      const lines = rows.map((r) => {
        const status = r.status === 'active' ? 'Active' : 'Cleared';
        const reason = truncate(r.reason || 'No reason provided', 120);
        return `**#${r.case_number}** • ${ts(r.created_at, 'R')} • ${status} • by <@${r.moderator_id}>\n> ${reason}`;
      });
      return baseEmbed()
        .setTitle(`Warnings • ${user.username}`)
        .setDescription(lines.join('\n\n'))
        .setFooter({ text: `Page ${page + 1}/${totalPages} • Total: ${total}` })
        .setTimestamp(Date.now());
    };

    const sent = await message.reply({ embeds: [render(0)] });
    await paginateMessage(sent, { totalPages, render, authorId: message.author.id });
    return;
  }

  // clear
  const activeCount = countActiveByType(message.guild.id, user.id, 'warn');
  if (!activeCount) {
    return message.reply({ embeds: [infoEmbed('Warnings', `${user.username} has no active warnings.`)] });
  }

  setActiveCasesStatus(message.guild.id, user.id, 'warn', 'removed');
  const caseRow = createCase({
    guildId: message.guild.id,
    userId: user.id,
    moderatorId: message.author.id,
    type: 'note',
    reason: `Cleared ${activeCount} active warning(s)${clearReason ? `: ${clearReason}` : ''}`,
  });
  await logCase(message.guild, caseRow, { clientId: client.user.id });
  await message.reply({ embeds: [buildCaseEmbed(caseRow, { clientId: client.user.id })] });
}

// ---------- Ticket commands (rename / close / add / remove) ----------

// Resolves @user (member is preferred, raw user on fallback) or @role from one token.
async function resolveTicketTarget(guild, input) {
  if (!input) return null;
  const userMatch = input.match(/^<@!?(\d{17,20})>$/) ?? (/^\d{17,20}$/.test(input) ? [null, input] : null);
  if (userMatch) {
    const member = await guild.members.fetch(userMatch[1]).catch(() => null);
    if (member) return member;
    return (await guild.client.users.fetch(userMatch[1]).catch(() => null)) ?? null;
  }
  const roleMatch = input.match(/^<@&(\d{17,20})>$/);
  if (roleMatch) return (await guild.roles.fetch(roleMatch[1]).catch(() => null)) ?? null;
  return null;
}

const ticketGuard = (message, { staffOnly = false } = {}) => {
  const ticket = getTicketForChannel(message.guild.id, message.channelId);
  if (!ticket) {
    message.reply({ embeds: [errorEmbed('This channel is not an open ticket.')] });
    return null;
  }
  const allowed = staffOnly ? isTicketStaff(message.member) : canManageTicket(ticket, message.member);
  if (!allowed) {
    const text = staffOnly
      ? 'Only ticket staff can do that in this ticket.'
      : 'Only the ticket owner or staff can do that in this ticket.';
    message.reply({ embeds: [errorEmbed(text)] });
    return null;
  }
  return ticket;
};

// =rename <new name> (staff only)
async function renameCommand(message, args) {
  const ticket = ticketGuard(message, { staffOnly: true });
  if (!ticket) return;

  const name = args.join(' ').trim();
  if (!name) return message.reply({ embeds: [errorEmbed('Usage: `rename <new name>`')] });

  const result = await renameTicket(message.guild, ticket, name, message.member);
  if (result?.error) return message.reply({ embeds: [errorEmbed(result.error)] });
  return message.reply({ embeds: [successEmbed('Ticket renamed.', 'Ticket')] });
}

// =close [note]
async function closeTicketCommand(message, args, client) {
  const ticket = ticketGuard(message);
  if (!ticket) return;

  const note = args.join(' ').trim() || null;
  const result = await closeTicket(message.guild, ticket, message.member, note, client);
  if (result?.error) return message.reply({ embeds: [errorEmbed(result.error)] });
  return message.reply({
    embeds: [successEmbed('Ticket closed. The channel is now archived and hidden from everyone except staff.', 'Ticket')],
  });
}

// =add <@user|@role> (staff only)
async function addTicketCommand(message, args) {
  const ticket = ticketGuard(message, { staffOnly: true });
  if (!ticket) return;

  const target = await resolveTicketTarget(message.guild, args[0]);
  if (!target) return message.reply({ embeds: [errorEmbed('Usage: `add <@user|@role>`')] });
  if (target.bot) {
    return message.reply({ embeds: [errorEmbed('Bot accounts cannot be added to tickets.')] });
  }
  // Never add a role while a user mention was intended, and never add the @everyone-ish roles.
  if (target.members && target.id === message.guild.roles.everyone.id) {
    return message.reply({ embeds: [errorEmbed('Use a specific role - @everyone cannot be added.')] });
  }

  const result = await addToTicket(message.guild, ticket, target, message.member);
  if (result?.error) return message.reply({ embeds: [errorEmbed(result.error)] });
  return message.reply({ embeds: [successEmbed('Access granted.', 'Ticket')] });
}

// =remove <@user|@role> (staff only)
async function removeTicketCommand(message, args) {
  const ticket = ticketGuard(message, { staffOnly: true });
  if (!ticket) return;

  const target = await resolveTicketTarget(message.guild, args[0]);
  if (!target) return message.reply({ embeds: [errorEmbed('Usage: `remove <@user|@role>`')] });
  if (target.id === ticket.owner_id) {
    return message.reply({ embeds: [errorEmbed('The ticket owner cannot be removed from their own ticket.')] });
  }

  const result = await removeFromTicket(message.guild, ticket, target, message.member);
  if (result?.error) return message.reply({ embeds: [errorEmbed(result.error)] });
  return message.reply({ embeds: [successEmbed('Access revoked.', 'Ticket')] });
}

// ---------- Role / self-role / ticket-staff / restart commands ----------

// =addrole <@user|user id> <@role|role id> [reason...] (mirrors /addrole)
async function addroleCommand(message, args) {
  if (!ensureModeratorMessage(message, PermissionsBitField.Flags.ManageRoles, 'Manage Roles')) return;
  if (!message.guild.members.me.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
    return message.reply({ embeds: [errorEmbed('The bot is missing the **Manage Roles** permission.')] });
  }

  const resolved = await resolveTargetArgs(message.guild, args);
  if (!resolved) return message.reply({ embeds: [errorEmbed('No member matched that exactly. Mention them, use their user ID, or type their exact username / display name.')] });
  const target = resolved.target;
  if (!isMember(target)) return message.reply({ embeds: [errorEmbed('That user is not in this server.')] });
  if (!canModerateMemberMessage(message, target)) return;

  const role = await resolveRole(message.guild, resolved.rest[0]);
  const roleError = roleAssignabilityError(message.guild, role);
  if (roleError) return message.reply({ embeds: [errorEmbed(roleError)] });

  // Hierarchy for the caller: only administrators may manage roles at or above their own.
  if (!isAdministrator(message.member) && role.position >= message.member.roles.highest.position) {
    return message.reply({ embeds: [errorEmbed(`The **${role.name}** role is at or above your highest role.`)] });
  }
  if (target.roles.cache.has(role.id)) {
    return message.reply({ embeds: [errorEmbed(`<@${target.id}> already has the **${role.name}** role.`)] });
  }

  const reason = resolved.rest.slice(1).join(' ').trim() || null;
  try {
    await target.roles.add(role, `${reason || 'Role added'} (by ${message.author.tag})`.slice(0, 512));
  } catch (err) {
    console.error('[prefix:addrole]', err);
    return message.reply({ embeds: [errorEmbed(`Could not add the role: ${err.message}`)] });
  }

  const embed = buildActionEmbed({
    action: 'addrole',
    target: toUser(target),
    roleId: role.id,
    reason,
    guildName: message.guild.name,
  });
  await sendModLog(message.guild, embed);
  await message.reply({ embeds: [embed] });
}

// =removerole <@user|user id> <@role|role id> [reason...] (mirrors /removerole)
async function removeroleCommand(message, args) {
  if (!ensureModeratorMessage(message, PermissionsBitField.Flags.ManageRoles, 'Manage Roles')) return;
  if (!message.guild.members.me.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
    return message.reply({ embeds: [errorEmbed('The bot is missing the **Manage Roles** permission.')] });
  }

  const resolved = await resolveTargetArgs(message.guild, args);
  if (!resolved) return message.reply({ embeds: [errorEmbed('No member matched that exactly. Mention them, use their user ID, or type their exact username / display name.')] });
  const target = resolved.target;
  if (!isMember(target)) return message.reply({ embeds: [errorEmbed('That user is not in this server.')] });
  if (!canModerateMemberMessage(message, target)) return;

  const role = await resolveRole(message.guild, resolved.rest[0]);
  const roleError = roleAssignabilityError(message.guild, role);
  if (roleError) return message.reply({ embeds: [errorEmbed(roleError)] });

  // Hierarchy for the caller: only administrators may manage roles at or above their own.
  if (!isAdministrator(message.member) && role.position >= message.member.roles.highest.position) {
    return message.reply({ embeds: [errorEmbed(`The **${role.name}** role is at or above your highest role.`)] });
  }
  if (!target.roles.cache.has(role.id)) {
    return message.reply({ embeds: [errorEmbed(`<@${target.id}> does not have the **${role.name}** role.`)] });
  }

  const reason = resolved.rest.slice(1).join(' ').trim() || null;
  try {
    await target.roles.remove(role, `${reason || 'Role removed'} (by ${message.author.tag})`.slice(0, 512));
  } catch (err) {
    console.error('[prefix:removerole]', err);
    return message.reply({ embeds: [errorEmbed(`Could not remove the role: ${err.message}`)] });
  }

  const embed = buildActionEmbed({
    action: 'removerole',
    target: toUser(target),
    roleId: role.id,
    reason,
    guildName: message.guild.name,
  });
  await sendModLog(message.guild, embed);
  await message.reply({ embeds: [embed] });
}

// =addselfrole <@role|role id> [label...] (mirrors /addselfrole)
async function addselfroleCommand(message, args) {
  if (!ensureModeratorMessage(message, PermissionsBitField.Flags.ManageGuild, 'Manage Server')) return;

  const role = await resolveRole(message.guild, args[0]);
  const roleError = roleAssignabilityError(message.guild, role);
  if (roleError) return message.reply({ embeds: [errorEmbed(roleError)] });

  const result = addSelfRoleEntry(role, { label: args.slice(1).join(' ').trim() || null });
  if (result?.error) return message.reply({ embeds: [errorEmbed(result.error)] });

  // The channel may not exist yet (panel not installed) - refresh is a no-op then.
  const panel = await refreshSelfRolesPanelMessage(message.client).catch(() => null);
  const note = panel
    ? `The panel in <#${config.selfRoles.channelId}> was refreshed - it now shows **${result.entries}** role(s).`
    : isSelfRolesEnabled()
      ? 'The panel could not be refreshed automatically - run `install` to post it.'
      : 'The panel is not posted yet - running `install` creates the self-role channel and posts it.';
  return message.reply({
    embeds: [
      successEmbed(
        `Added **${role.name}** to the self-role panel (**${result.entries}** role(s) total).\n${note}`,
        'Self role added',
      ),
    ],
  });
}

// =removeselfrole <@role|role id> (mirrors /removeselfrole). Raw ids work too, so
// entries whose role was deleted from the server can still be removed.
async function removeselfroleCommand(message, args) {
  if (!ensureModeratorMessage(message, PermissionsBitField.Flags.ManageGuild, 'Manage Server')) return;

  const raw = String(args[0] ?? '').trim();
  const roleId = raw.match(/^<@&(\d{17,20})>$/)?.[1] ?? (/^\d{17,20}$/.test(raw) ? raw : null);
  if (!roleId) {
    return message.reply({ embeds: [errorEmbed(`Usage: \`${config.prefix}removeselfrole <@role|role id>\``)] });
  }

  const result = removeSelfRoleEntry(roleId, message.guild);
  if (result?.error) return message.reply({ embeds: [errorEmbed(result.error)] });

  // The channel may not exist yet (panel not installed) - refresh is a no-op then.
  const panel = await refreshSelfRolesPanelMessage(message.client).catch(() => null);
  const label = result.name ?? `<@&${roleId}>`;
  const note = panel
    ? `The panel in <#${config.selfRoles.channelId}> was refreshed - **${result.entries}** role(s) remain.`
    : isSelfRolesEnabled()
      ? 'The panel could not be refreshed automatically - run `install` to post it.'
      : 'The panel is not posted yet - running `install` posts it with the configured roles.';
  return message.reply({
    embeds: [
      successEmbed(
        `Removed **${label}** from the self-role panel (**${result.entries}** role(s) remaining).\n${note}`,
        'Self role removed',
      ),
    ],
  });
}

// =ticketroleadd <@role|role id> - permanently grant a role access to every ticket
// (config.tickets.staffRoleIds; temporary single-ticket access stays =add/=remove).
async function ticketroleaddCommand(message, args) {
  if (!ensureModeratorMessage(message, PermissionsBitField.Flags.ManageGuild, 'Manage Server')) return;

  const role = await resolveRole(message.guild, args[0]);
  const roleError = roleAssignabilityError(message.guild, role);
  if (roleError) return message.reply({ embeds: [errorEmbed(roleError)] });

  const result = await addTicketStaffRole(
    message.guild,
    role,
    `Ticket staff role added by ${message.author.tag}`,
  ).catch((err) => {
    console.error('[prefix:ticketroleadd]', err);
    return { error: `Could not update the ticket staff roles: ${err.message}` };
  });
  if (result?.error) return message.reply({ embeds: [errorEmbed(result.error)] });

  const lines = [
    `<@&${role.id}> can now view and manage every **open and future** ticket.`,
    `Ticket staff roles: ${ticketStaffRoleIds().map((id) => `<@&${id}>`).join(', ') || '(none)'}` +
      (config.modRoleId ? ` + <@&${config.modRoleId}> (mod)` : ''),
    result.stats.ok
      ? `Access re-applied to **${result.stats.ok}** open ticket(s)${result.stats.failed ? `, **${result.stats.failed}** failed` : ''}.`
      : 'No open tickets to update - new tickets get the allow when they are created.',
    `Remove it again with \`${config.prefix}ticketroleremove\`.`,
  ];

  await sendModLog(
    message.guild,
    baseEmbed(COLORS.audit)
      .setTitle('Ticket Staff Updated')
      .setDescription(`**Added:** <@&${role.id}>\n**By:** <@${message.author.id}>`)
      .setTimestamp(Date.now()),
  );
  return message.reply({ embeds: [successEmbed(lines.join('\n'), 'Ticket staff updated')] });
}

// =ticketroleremove <@role|role id> - remove a permanent ticket-staff role
async function ticketroleremoveCommand(message, args) {
  if (!ensureModeratorMessage(message, PermissionsBitField.Flags.ManageGuild, 'Manage Server')) return;

  const role = await resolveRole(message.guild, args[0]);
  const roleError = roleAssignabilityError(message.guild, role);
  if (roleError) return message.reply({ embeds: [errorEmbed(roleError)] });

  const result = await removeTicketStaffRole(
    message.guild,
    role,
    `Ticket staff role removed by ${message.author.tag}`,
  ).catch((err) => {
    console.error('[prefix:ticketroleremove]', err);
    return { error: `Could not update the ticket staff roles: ${err.message}` };
  });
  if (result?.error) return message.reply({ embeds: [errorEmbed(result.error)] });

  const remaining = ticketStaffRoleIds();
  const lines = [];
  if (result.revoked) {
    lines.push(`<@&${role.id}> no longer manages tickets.`);
    lines.push(
      result.ok
        ? `Access revoked on **${result.ok}** open ticket(s)${result.failed ? `, ${result.failed} failed` : ''}.`
        : 'No open tickets needed an update.',
    );
  } else {
    // The role is still the legacy staff role or the mod role - only the config
    // entry was removed, so its overwrites on open tickets stay untouched.
    lines.push(`<@&${role.id}> was removed from the extensible list, but it still manages tickets via the legacy staff or mod role.`);
  }
  lines.push(
    remaining.length
      ? `Extensible staff list now: ${remaining.map((id) => `<@&${id}>`).join(', ')}.`
      : 'The extensible staff list is now empty.',
  );

  await sendModLog(
    message.guild,
    baseEmbed(COLORS.audit)
      .setTitle('Ticket Staff Updated')
      .setDescription(`**Removed:** <@&${role.id}>\n**By:** <@${message.author.id}>`)
      .setTimestamp(Date.now()),
  );
  return message.reply({ embeds: [successEmbed(lines.join('\n'), 'Ticket staff updated')] });
}

// =restart - reboot the bot; the new instance auto-runs the full setup.
async function restartCommand(message) {
  if (!ensureModeratorMessage(message, PermissionsBitField.Flags.ManageGuild, 'Manage Server')) return;
  await message.reply({
    embeds: [
      successEmbed(
        'Restarting... The bot boots back on its own within a few seconds and automatically re-runs the full setup. No action is needed.',
        'Restart',
      ),
    ],
  });
  // Give Discord a moment to deliver the reply before the process exits.
  setTimeout(() => {
    restartProcess({ reason: `restart by ${message.author.tag}` });
  }, 1000);
}

// =purge <amount> - remove the newest messages in this channel.
// =purge <@user|user id> <amount> - only that person's messages here.
async function purgeCommand(message, args) {
  if (!ensureModeratorMessage(message, PermissionsBitField.Flags.ManageMessages, 'Manage Messages')) return;
  if (!message.guild.members.me.permissionsIn(message.channel).has(PermissionsBitField.Flags.ManageMessages)) {
    return message.reply({ embeds: [errorEmbed('The bot is missing the **Manage Messages** permission in this channel.')] });
  }
  if (isPurgeBlockedChannel(message.channelId)) {
    return message.reply({
      embeds: [errorEmbed('The do-not-type trap channel keeps its messages as evidence - purge is disabled here.')],
    });
  }

  // Plain amount mode (=purge 50) vs user mode (=purge <@user|user id|name> 50). The
  // amount is always the last token so multi-word usernames work; everything before
  // it is the target, and members who left still resolve as plain users.
  const amountInput = String(args[args.length - 1] ?? '');
  let targetUserId = null;
  if (args.length > 1) {
    const target = await resolveTarget(message.guild, args.slice(0, -1).join(' '));
    if (!target) {
      return message.reply({
        embeds: [
          errorEmbed(
            `Usage: \`${config.prefix}purge <amount>\` or \`${config.prefix}purge <@user|user id|exact name> <amount>\``,
          ),
        ],
      });
    }
    targetUserId = target.id;
  }

  const amount = Number.parseInt(amountInput, 10);
  if (!Number.isInteger(amount) || amount < 1 || amount > 1000) {
    return message.reply({
      embeds: [errorEmbed(`The amount must be between 1 and 1000 - e.g. \`${config.prefix}purge 50\`.`)],
    });
  }

  const result = await purgeMessages(message.channel, { amount, targetUserId }).catch((err) => {
    console.error('[prefix:purge]', err);
    return null;
  });
  if (!result) return message.reply({ embeds: [errorEmbed('Could not purge - try again in a moment.')] });

  await sendModLog(
    message.guild,
    buildPurgeLogEmbed({
      channelId: message.channelId,
      moderatorId: message.author.id,
      targetUserId,
      deleted: result.deleted,
    }),
  );
  return message.reply({ embeds: [successEmbed(describePurge(result, { targetUserId }), 'Purge')] });
}

// =setup (mirrors /setup)
async function setupCommand(message) {
  if (!ensureModeratorMessage(message, PermissionsBitField.Flags.ManageGuild, 'Manage Server')) return;
  if (!message.guild.members.me.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
    return message.reply({ embeds: [errorEmbed('The bot is missing the **Manage Roles** permission.')] });
  }

  const role = await ensureMuteRole(message.guild, { reason: `Setup by ${message.author.id}` });
  const { ok, failed } = await applyMuteOverwritesAll(message.guild, role);

  const lines = [
    `Muted role: <@&${role.id}>`,
    `Applied restrictions to **${ok}** channel(s)${failed ? ` (${failed} failed)` : ''}.`,
    config.modLogChannelId
      ? `Mod log channel: <#${config.modLogChannelId}>`
      : 'Mod log channel: not set - add `modLogChannelId` to config.json',
    '',
    'New channels are automatically restricted. If the Muted role is deleted, the bot recreates it on the next mute.',
  ];
  if (failed) {
    lines.push('Some channels failed: make sure the bot has **Manage Roles** and its role is above the Muted role.');
  }
  await message.reply({ embeds: [successEmbed(lines.join('\n'), 'Setup complete')] });
}

// =install (mirrors /install)
async function installCommand(message, args, client) {
  if (!ensureModeratorMessage(message, PermissionsBitField.Flags.ManageGuild, 'Manage Server')) return;
  if (!message.guild.members.me.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
    return message.reply({ embeds: [errorEmbed('The bot is missing the **Manage Roles** permission.')] });
  }

  const results = await runInstall(client, message.guild, { installerId: message.author.id });
  const pending = results.filter((r) => INSTALL_DELAYING_STATUSES.has(r.status)).length;
  await message.reply({
    embeds: [
      buildSetupSummaryEmbed(results, {
        title: 'Install',
        description: pending
          ? 'Setup finished with open items - check the entries below.'
          : 'Setup complete. The setup messages were posted/refreshed in the configured channels.',
        report: true,
      }),
    ],
  });
}

// =uninstall (mirrors /uninstall)
async function uninstallCommand(message, args, client) {
  if (!ensureModeratorMessage(message, PermissionsBitField.Flags.ManageGuild, 'Manage Server')) return;

  const results = await runUninstall(client, message.guild);
  await message.reply({
    embeds: [
      buildSetupSummaryEmbed(results, {
        title: 'Uninstall',
        description: `Setup messages were removed. Run \`${config.prefix}install\` to post them again.`,
      }),
    ],
  });
}

function helpCommand(message) {
  const p = config.prefix;
  const lines = [
    `**\`${p}mute\` <user> [duration] [reason]** - mute a member (duration: 5m, 3d, perm)`,
    `**\`${p}unmute\` <user> [reason]** - remove the mute`,
    `**\`${p}kick\` <user> [reason]** - kick a member`,
    `**\`${p}ban\` <user> [duration] [reason]** - ban a member (duration optional)`,
    `**\`${p}unban\` <user id> [reason]** - remove a ban`,
    `**\`${p}warn\` <user> [reason]** - warn a member`,
    `**\`${p}warnings list\` [user | empty = you]** | **\`${p}warnings clear\` <user> [reason]** - view / clear warnings`,
    `**\`${p}puns\` | \`${p}h\` | \`${p}history\` | \`${p}punishments\` [user] [type]** - punishment history (empty user = your own)`,
    `**\`${p}case\` <number>** | **\`${p}case delete\` <number> [reason]** - view / hide a case`,
    `**\`${p}setup\`** - create the Muted role + apply channel restrictions`,
    `**\`${p}install\`** - full setup check (roles, channels, setup messages)`,
    `**\`${p}uninstall\`** - delete the setup messages`,
    `**\`${p}rename\` <new name>** - rename this ticket (in ticket channels)`,
    `**\`${p}close\` [note]** - close this ticket (channel is removed)`,
    `**\`${p}add\` <@user|@role>** - grant ticket access`,
    `**\`${p}remove\` <@user|@role>** - revoke ticket access`,
    `**\`${p}addrole\` <user> <@role|role id> [reason]** - give a member a role`,
    `**\`${p}removerole\` <user> <@role|role id> [reason]** - remove a role from a member`,
    `**\`${p}addselfrole\` <@role|role id> [label]** - add a role to the self-role panel`,
    `**\`${p}removeselfrole\` <@role|role id>** - remove a role from the self-role panel`,
    `**\`${p}ticketroleadd\` <@role|role id>** - permanently grant a role access to all tickets`,
    `**\`${p}ticketroleremove\` <@role|role id>** - revoke that permanent ticket-staff access`,
    `**\`${p}purge\` [user] <amount>** - remove recent messages in this channel (optionally one user's only)`,
    `**\`${p}restart\`** - restart the bot and auto-run the full setup`,
  ];
  return message.reply({ embeds: [infoEmbed('Prefix commands', lines.join('\n'))] });
}

const HANDLERS = {
  mute: muteCommand,
  unmute: unmuteCommand,
  kick: kickCommand,
  ban: banCommand,
  unban: unbanCommand,
  warn: warnCommand,
  history: historyCommand,
  case: caseCommand,
  warnings: warningsCommand,
  setup: setupCommand,
  install: installCommand,
  uninstall: uninstallCommand,
  rename: renameCommand,
  close: closeTicketCommand,
  add: addTicketCommand,
  remove: removeTicketCommand,
  addrole: addroleCommand,
  removerole: removeroleCommand,
  purge: purgeCommand,
  addselfrole: addselfroleCommand,
  removeselfrole: removeselfroleCommand,
  ticketroleadd: ticketroleaddCommand,
  ticketroleremove: ticketroleremoveCommand,
  restart: restartCommand,
  help: helpCommand,
};

export async function handlePrefixCommand(message, client) {
  const raw = message.content.slice(config.prefix.length).trim();
  if (!raw) return;

  const [cmdRaw, ...args] = raw.split(/\s+/);
  const command = ALIASES[cmdRaw.toLowerCase()];
  if (!command) return;

  // Global lockdown: every prefix command beyond the kept ticket commands answers
  // with the red disable notice instead of running - except the whitelist user
  // (LOCKDOWN.bypassUserIds), who keeps full access.
  if (!canUseDuringLockdown(message.author.id) && !isCommandAllowed(command)) {
    await message.reply({ embeds: [lockdownEmbed()] }).catch(() => {});
    return;
  }

  try {
    await HANDLERS[command](message, args, client);
  } catch (err) {
    console.error(`[prefix:${command}]`, err);
    await message.reply({ embeds: [errorEmbed('Something went wrong while running this command.')] }).catch(() => {});
  }
}
