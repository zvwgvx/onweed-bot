import { Events } from 'discord.js';
import { config } from '../config.js';
import { logDeletedMessage } from '../services/auditlog.js';

export const name = Events.MessageDelete;

// Deleted messages (text, images, attachments) land in the audit log channel,
// with the deleting moderator resolved from the Discord audit log.
export async function execute(message, client) {
  if (!message?.guild || message.guild.id !== config.guildId) return;
  try {
    await logDeletedMessage(client, message);
  } catch (err) {
    console.error('[messageDelete] Failed to log the deleted message:', err);
  }
}
