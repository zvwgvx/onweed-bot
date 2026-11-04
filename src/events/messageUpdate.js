import { Events } from 'discord.js';
import { config } from '../config.js';
import { logEditedMessage } from '../services/auditlog.js';

export const name = Events.MessageUpdate;

// Member message edits are reported to the audit log channel (before/after).
// Bot and webhook messages are skipped, as are embed-only (link preview) changes.
export async function execute(oldMessage, newMessage, client) {
  if (!newMessage?.guild || newMessage.guild.id !== config.guildId) return;
  try {
    await logEditedMessage(client, oldMessage, newMessage);
  } catch (err) {
    console.error('[messageUpdate] Failed to log the edited message:', err);
  }
}
