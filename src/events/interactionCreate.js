import { Events, MessageFlags } from 'discord.js';
import { config } from '../config.js';
import { errorEmbed, successEmbed } from '../utils/embeds.js';
import { isConfiguredGuild } from '../utils/permissions.js';
import { TICKET_BUTTON_ID, TICKET_CLOSE_BUTTON_ID, TICKET_TYPES, canManageTicket, closeTicket, getTicketForChannel, openTicket, parseTicketButtonType } from '../services/tickets.js';
import { VERIFY_BUTTON_ID, sweepVerifyPings, verifyMember } from '../services/verify.js';
import { SELF_ROLE_BUTTON_PREFIX, sendSelfRolePing, toggleSelfRole } from '../services/selfroles.js';
import {
  CV_INVITE_ID,
  CV_LIMIT_ID,
  CV_PRIVACY_ID,
  CV_RENAME_ID,
  CV_RENAME_MODAL_ID,
  applyVoiceRename,
  inviteVoiceMembers,
  requestVoiceRename,
  setVoiceLimit,
  toggleVoicePrivacy,
} from '../services/createvoice.js';

export const name = Events.InteractionCreate;

// Shared verification flow for the Verify button (verify channel panel and DM card).
// In DMs there is no guild on the interaction - verifyMember resolves the membership
// against the configured guild; the reply stays a normal DM message (a DM channel is
// private by definition, so ephemeral is not needed).
async function handleVerifyInteraction(interaction, client, { fromDm = false } = {}) {
  const result = await verifyMember(interaction).catch((err) => {
    console.error('[verify] Verification failed:', err.message);
    return { error: 'Verification failed. Try again in a moment.' };
  });
  const embed = result?.error
    ? errorEmbed(result.error)
    : result?.already
      ? successEmbed('You are already verified - nothing to do.', 'Already verified')
      : successEmbed('You are verified - the rest of the server is unlocked.', 'Verified');
  const options = { embeds: [embed] };
  if (!fromDm) options.flags = MessageFlags.Ephemeral;
  await interaction.reply(options).catch(() => {});

  const member = result?.member ?? interaction.member;
  if (result?.verified && member) {
    // First-time verification only: point the new member at the self-role panel and
    // remove their fallback ping from the verify channel (if the DM failed on join).
    await sendSelfRolePing(member).catch(() => {});
    await sweepVerifyPings(member).catch(() => {});
  }
}

export async function execute(interaction, client) {
  // Verify presses from the bot's DMs (the DM card carries the button): run the same
  // verification flow instead of rejecting the interaction with the guild gate below.
  if (!interaction.inGuild()) {
    if (interaction.isButton() && interaction.customId === VERIFY_BUTTON_ID) {
      await handleVerifyInteraction(interaction, client, { fromDm: true });
    }
    return;
  }

  if (!isConfiguredGuild(interaction.guildId)) {
    if (interaction.isRepliable()) {
      const reason = config.guildId
        ? `This bot only operates in the configured server (ID: ${config.guildId}).`
        : 'Open config.json, set `guildId` to your server ID, then restart the bot.';
      await interaction
        .reply({
          embeds: [
            errorEmbed(reason, 'Bot not configured for this server'),
          ],
          flags: MessageFlags.Ephemeral,
        })
        .catch(() => {});
    }
    return;
  }

  // The ticket panel buttons - one per ticket type (general tickets / guild applications).
  if (interaction.isButton() && parseTicketButtonType(interaction.customId) !== null) {
    const typeKey = parseTicketButtonType(interaction.customId);
    const result = await openTicket(interaction, client, typeKey).catch((err) => {
      console.error('[tickets] Open failed:', err.message);
      return { error: 'Opening the ticket failed. Try again in a moment.' };
    });
    const type = TICKET_TYPES[typeKey] ?? TICKET_TYPES.general;
    const embed = result?.error
      ? errorEmbed(result.error)
      : successEmbed(`**${type.label}** created: <#${result.channel.id}>`);
    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral }).catch(() => {});
    return;
  }

  // The "Close Ticket" button inside a ticket (owner or staff).
  if (interaction.isButton() && interaction.customId === TICKET_CLOSE_BUTTON_ID) {
    const ticket = getTicketForChannel(interaction.guildId, interaction.channelId);
    if (!ticket) {
      await interaction.reply({ embeds: [errorEmbed('This channel is not an open ticket.')], flags: MessageFlags.Ephemeral }).catch(() => {});
      return;
    }
    if (!canManageTicket(ticket, interaction.member)) {
      await interaction
        .reply({ embeds: [errorEmbed('Only the ticket owner or staff can close this ticket.')], flags: MessageFlags.Ephemeral })
        .catch(() => {});
      return;
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => {});
    const result = await closeTicket(interaction.guild, ticket, interaction.member, null, client).catch((err) => {
      console.error('[tickets] Close failed:', err.message);
      return { error: 'Closing the ticket failed. Try again in a moment.' };
    });
    const embed = result?.error
      ? errorEmbed(result.error)
      : successEmbed('Ticket closed. The channel is now archived and hidden from everyone except staff.');
    await interaction.editReply({ embeds: [embed] }).catch(() => {});
    return;
  }

  // Create-voice panel actions inside a spawned voice channel.
  if (interaction.isButton() && interaction.customId === CV_RENAME_ID) {
    const result = await requestVoiceRename(interaction).catch((err) => {
      console.error('[voice] Rename request failed:', err.message);
      return { error: 'Could not open the rename dialog. Try again in a moment.' };
    });
    if (result?.error) {
      await interaction.reply({ embeds: [errorEmbed(result.error)], flags: MessageFlags.Ephemeral }).catch(() => {});
    } else {
      await interaction.showModal(result.modal).catch(() => {});
    }
    return;
  }

  if (interaction.isModalSubmit() && interaction.customId === CV_RENAME_MODAL_ID) {
    const result = await applyVoiceRename(interaction).catch((err) => {
      console.error('[voice] Rename failed:', err.message);
      return { error: 'Could not rename the room. Try again in a moment.' };
    });
    const embed = result?.error ? errorEmbed(result.error) : successEmbed(result.success);
    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral }).catch(() => {});
    return;
  }

  if (interaction.isButton() && interaction.customId === CV_PRIVACY_ID) {
    const result = await toggleVoicePrivacy(interaction).catch((err) => {
      console.error('[voice] Privacy toggle failed:', err.message);
      return { error: 'Could not change the privacy. Try again in a moment.' };
    });
    const embed = result?.error ? errorEmbed(result.error) : successEmbed(result.success);
    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral }).catch(() => {});
    return;
  }

  if (interaction.isStringSelectMenu() && interaction.customId === CV_LIMIT_ID) {
    const result = await setVoiceLimit(interaction).catch((err) => {
      console.error('[voice] Limit change failed:', err.message);
      return { error: 'Could not set the user limit. Try again in a moment.' };
    });
    const embed = result?.error ? errorEmbed(result.error) : successEmbed(result.success);
    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral }).catch(() => {});
    return;
  }

  if (interaction.isUserSelectMenu() && interaction.customId === CV_INVITE_ID) {
    const result = await inviteVoiceMembers(interaction).catch((err) => {
      console.error('[voice] Invite failed:', err.message);
      return { error: 'Could not invite members. Try again in a moment.' };
    });
    const embed = result?.error ? errorEmbed(result.error) : successEmbed(result.success);
    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral }).catch(() => {});
    return;
  }

  // The "Verify" button on the verification embed (and the DM card, resolved above).
  if (interaction.isButton() && interaction.customId === VERIFY_BUTTON_ID) {
    await handleVerifyInteraction(interaction, client);
    return;
  }

  // Toggle buttons on the self-role panel (press = grant, press again = remove).
  if (interaction.isButton() && interaction.customId.startsWith(SELF_ROLE_BUTTON_PREFIX)) {
    const result = await toggleSelfRole(interaction).catch((err) => {
      console.error('[selfroles] Toggle failed:', err.message);
      return { error: 'Toggling the role failed. Try again in a moment.' };
    });
    const embed = result?.error
      ? errorEmbed(result.error)
      : result.removed
        ? successEmbed(`Removed the **${result.role.name}** role.`, 'Role removed')
        : successEmbed(`Added the **${result.role.name}** role.`, 'Role added');
    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral }).catch(() => {});
    return;
  }

  // Display-only counter buttons on the do-not-type warning message.
  if (interaction.isButton() && interaction.customId.startsWith('trap_stat_')) {
    const key = interaction.customId.replace('trap_stat_', '');
    await interaction
      .reply({ content: 'This counter is display-only.', flags: MessageFlags.Ephemeral })
      .catch(() => {});
    return;
  }

  if (!interaction.isChatInputCommand()) return;

  const command = client.commands.get(interaction.commandName);
  if (!command) return;

  try {
    await command.execute(interaction, client);
  } catch (err) {
    console.error(`[command:${interaction.commandName}]`, err);
    const embed = errorEmbed('Something went wrong while running this command. Check the bot logs for details.');
    try {
      if (interaction.deferred || interaction.replied) await interaction.editReply({ embeds: [embed] });
      else await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    } catch {
      // interaction already expired
    }
  }
}
