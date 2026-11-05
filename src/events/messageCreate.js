import { Events } from 'discord.js';
import { config } from '../config.js';
import { getTicketByChannel } from '../db.js';
import { handleDoNotType } from '../prefix/doNotType.js';
import { handlePrefixCommand } from '../prefix/handler.js';

export const name = Events.MessageCreate;

export async function execute(message, client) {
  if (!message.guild || message.guild.id !== config.guildId) return;

  // Catch anything posted in the do-not-type channel (including bot accounts).
  if (
    config.doNotType?.channelId &&
    message.channelId === config.doNotType.channelId &&
    message.author.id !== client.user.id
  ) {
    await handleDoNotType(message, client);
    return;
  }

  if (message.author.bot) return;

  // Closed ticket channels accept no new messages from anyone - including
  // administrators, whose Administrator permission bypasses channel overwrites.
  // New closes delete the channel outright (transcript lives in the ticket log);
  // this guard only covers legacy archived channels that still exist - and it
  // runs before prefix handling, so commands are never processed in them.
  // Threads inside a ticket count as the parent ticket channel.
  const ticketChannelId = message.channel?.isThread?.() ? message.channel.parentId : message.channelId;
  const ticket = ticketChannelId ? getTicketByChannel(message.guild.id, ticketChannelId) : null;
  if (ticket && ticket.status !== 'open') {
    await message
      .delete()
      .catch((err) =>
        console.warn(`[tickets] Could not remove a message in archived ticket ${ticketChannelId}: ${err.message}`),
      );
    return;
  }

  if (!message.content.startsWith(config.prefix)) return;
  await handlePrefixCommand(message, client);
}
