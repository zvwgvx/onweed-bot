import { Events } from 'discord.js';
import { config } from '../config.js';
import { applyMuteOverwrite, applyMutedCmdsOverwrite } from '../services/mutes.js';
import { applyGateOverwriteForNewChannel } from '../services/verify.js';
import { applyTrapOpenOverwrite } from '../services/trap.js';

export const name = Events.ChannelCreate;

// Applies the Muted role restrictions to newly created channels.
// The muted-commands channel is kept open for muted users instead, and the
// do-not-type channel stays open to everyone so the trap keeps catching bots.
// The verification gate additionally hides new channels from unverified members.
export async function execute(channel, client) {
  if (!channel.guild || channel.guild.id !== config.guildId) return;
  try {
    if (config.doNotType?.channelId && channel.id === config.doNotType.channelId) {
      await applyTrapOpenOverwrite(channel, 'Keep the do-not-type channel open to everyone');
    }
    await applyGateOverwriteForNewChannel(channel).catch((err) =>
      console.error('[channelCreate] Failed to apply the verification gate:', err.message),
    );
    if (!config.muteRoleId) return;
    const role = await channel.guild.roles.fetch(config.muteRoleId).catch(() => null);
    if (!role) return;
    if (config.mutedBotCmdsChannelId && channel.id === config.mutedBotCmdsChannelId) {
      await applyMutedCmdsOverwrite(channel, role, 'Keep the muted-commands channel open');
    } else {
      await applyMuteOverwrite(channel, role, 'Apply Muted role restrictions to new channel');
    }
  } catch (err) {
    console.error('[channelCreate] Failed to apply the mute overwrite:', err.message);
  }
}
