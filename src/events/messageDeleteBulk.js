import { Events } from 'discord.js';
import { config } from '../config.js';
import { logBulkDeleted } from '../services/auditlog.js';

export const name = Events.MessageBulkDelete;

// Bulk deletions (a moderator purging from the Discord UI) are summarised in the
// audit log channel. Deletions performed by the bot itself skip this card since
// =purge and the do-not-type purge audit through their own mod-log embeds.
export async function execute(messages, channel, client) {
  if (!channel?.guild || channel.guild.id !== config.guildId) return;
  try {
    await logBulkDeleted(client, channel, messages);
  } catch (err) {
    console.error('[messageDeleteBulk] Failed to log the bulk delete:', err);
  }
}
