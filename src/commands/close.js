import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { canManageTicket, closeTicket, getTicketForChannel } from '../services/tickets.js';
import { errorEmbed } from '../utils/embeds.js';

export const data = new SlashCommandBuilder()
  .setName('close')
  .setDescription('Close this ticket; the channel is deleted and a transcript is saved to the ticket log')
  .addStringOption((o) => o.setName('note').setDescription('Optional closing note (shown to staff in the log)').setMaxLength(500));

export async function execute(interaction, client) {
  const ticket = getTicketForChannel(interaction.guildId, interaction.channelId);
  if (!ticket) {
    return interaction.reply({ embeds: [errorEmbed('This channel is not an open ticket.')], flags: MessageFlags.Ephemeral });
  }
  if (!canManageTicket(ticket, interaction.member)) {
    return interaction.reply({
      embeds: [errorEmbed('Only the ticket owner or staff can close this ticket.')],
      flags: MessageFlags.Ephemeral,
    });
  }

  const result = await closeTicket(
    interaction.guild,
    ticket,
    interaction.member,
    interaction.options.getString('note'),
    client,
  );
  if (result?.error) {
    return interaction.reply({ embeds: [errorEmbed(result.error)], flags: MessageFlags.Ephemeral });
  }
  return interaction.reply({
    embeds: [successEmbed(`Ticket closed${interaction.options.getString('note') ? ' with a note' : ''}. The channel has been deleted - the transcript went to the ticket log.`)],
    flags: MessageFlags.Ephemeral,
  });
}
