// ============================================================================
// GLOBAL LOCKDOWN
//
// The bot has been handed over to no maintainer and is therefore disabled for
// maintenance. While `enabled` is true, every interactive surface refuses
// requests with a red warning embed (see lockdownEmbed):
//   - all slash commands not listed in allowedCommands
//   - all prefix commands not listed in allowedCommands
//   - the self-role panel buttons
// Accounts in bypassUserIds keep FULL access to everything while the lockdown
// stays on. The only systems that keep working for everyone else are the ones
// in `allowed`: verify, voice (create-voice) and tickets - including their
// in-ticket commands (close / add / rename).
//
// A new maintainer simply sets `enabled: false` here (or deletes this module)
// and restarts. No other code needs to change.
// ============================================================================
import { COLORS } from '../constants.js';
import { baseEmbed } from './embeds.js';

export const LOCKDOWN = {
  enabled: true,
  developer: 'zvwgvx',
  // The single account allowed to use the bot while it is locked down.
  bypassUserIds: new Set(['1320303839701897230']),
  // Systems that stay fully functional while the lockdown is on.
  allowed: new Set(['verify', 'voice', 'ticket']),
  // Command names (slash command names + prefix command keys) that remain usable.
  allowedCommands: new Set(['close', 'add', 'rename']),
};

export const isCommandAllowed = (name) => LOCKDOWN.allowedCommands.has(name);

export const isFeatureAllowed = (key) => LOCKDOWN.allowed.has(key);

// The bypass whitelist doubles as the bot's superuser list: these accounts skip every
// internal permission gate (moderator checks, ticket staff checks, role-hierarchy
// caller limits) - no mod role is needed for them. Discord-level limits that bind the
// BOT itself (its own role position, managed roles, moderating the owner) still apply.
export const isBotSuperuser = (userId) => LOCKDOWN.bypassUserIds.has(userId);

// True when the account may use the locked-down surfaces: everyone while the
// lockdown is off, only the bypass whitelist while it is on.
export const canUseDuringLockdown = (userId) =>
  !LOCKDOWN.enabled || LOCKDOWN.bypassUserIds.has(userId);

// Red warning embed shown for every locked action.
export const lockdownEmbed = () =>
  baseEmbed(COLORS.error)
    .setTitle('Bot Disabled')
    .setDescription(
      `This bot has been disabled by its developer **${LOCKDOWN.developer}** until another maintainer takes over.`,
    )
    .addFields(
      { name: 'Still working', value: 'Verify • Voice • Ticket', inline: true },
      { name: 'Locked', value: 'All other commands & features', inline: true },
    );
