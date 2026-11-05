# Guildframe

**Guildframe** - the frame of a guild: an all-in-one Discord bot covering **moderation** (role-based mutes, warnings, punishment history, mod log / audit log), a **do-not-type channel trap** to catch bots/selfbots, a **verification gate** (verify channel + Verify button), **tickets**, **dynamic voice rooms**, **welcome cards** and **live server stats** cards.

## 🔒 Current status: LOCKDOWN

The bot is currently **disabled by its developer (zvwgvx)** while nobody maintains it - `src/utils/lockdown.js` holds the master switch. Every interactive surface (all slash + prefix commands, the self-role panel) answers with a red **Bot Disabled** embed; only **verify**, **voice** (create-voice rooms) and **tickets** keep working, including the in-ticket commands (`close` / `add` / `rename`). One whitelist account (user ID `1320303839701897230` in `LOCKDOWN.bypassUserIds`) keeps full access to every command while the lockdown is up and acts as a **bot superuser**: every internal permission gate (moderator checks, ticket staff checks, role-hierarchy caller limits) is skipped for them - no mod role needed; Discord-level limits that bind the bot itself still apply. Passive automation (welcome cards, stats/status panels, mute-expiry timers) still runs. A new maintainer flips `LOCKDOWN.enabled` to `false` in that one file and restarts.

- **Stack:** Node.js + discord.js v14
- **Database:** SQLite via the built-in `node:sqlite` module (no native modules, no DB server)
- **Commands:** Slash commands (global) + prefix commands (`=`)
- **Language:** all code, comments, embeds and messages in English

## Features

| Area | Details |
| --- | --- |
| Mute | Assign/remove the `Muted` role with per-channel restrictions. Temporary (`=mute 123 3d spam`) or permanent (`=mute 123 spam`). Expiry is scheduled and restored after restarts. Muted members who rejoin get re-muted automatically. |
| Warnings | `=warn`, `/warnings list`, `/warnings clear`. Optional automatic mute when a user reaches the configured warning threshold (`warnEscalation` in config.json). |
| Punishment history | `=puns <user>` / `=h` / `=history` / `=punishments` and `/history` `/punishments` - paginated embeds in the `Punishments • user • Page x of y` style with Previous/Next buttons. |
| Mod log | Every bot action (including automatic ones) is logged to `modLogChannelId` as a case embed. |
| Punishment DMs | Every warn, mute, kick and ban sends the member a private **embed** with the action, case number, reason, duration/expiry and moderator - including automatic warning escalations, do-not-type enforcement and punishments re-applied on rejoin. DMs are best effort: a closed inbox never blocks or delays the punishment. |
| Message audit log | A Carl-bot/Dyno style `audit-log` channel: **Message Deleted** cards (text, images, attachments, deleting moderator resolved from the Discord audit log), member **Message Edited** cards (before/after) and **Bulk Delete** summaries. `/install` adopts an existing `audit-log` channel or creates one sealed to the mod role + bot; point it at an existing channel with `auditLogChannelId`. Bot-internal deletions skip the card (they audit through their own mod-log embeds). |
| Audit log | Ban / unban / kick / timeout / manual Muted-role changes performed directly in Discord are caught via the audit log and logged with the executor. |
| Temp ban | `/ban user duration:` or `=ban <user> <duration> [reason]` - unbanned automatically on expiry. Punishments stay in force across rejoins: while a mute or ban case is active, the member is patched again the moment they come back (re-mute / re-ban, audited in the mod log as `Mute Re-applied` / `Ban Re-applied`). The arrivals channel posts a **Mute Re-applied** / **Ban Re-applied** card instead of the normal welcome card, and the returning member receives a **DM** explaining the re-applied punishment. A ban can only be lifted with `=unban`, which expires the case. |
| Role management | `=addrole <user> <@role|role id> [reason]` / `=removerole ...` (and the slash forms) give/remove a role from a member: Manage Roles, member hierarchy checks, the role must exist, not be `@everyone`/integration-managed and sit below the bot's highest role. Every change is audited in the mod log (**Role Added / Role Removed** cards, no case entry). |
| Do-not-type trap | Any message posted in `doNotType.channelId` is logged with a mod-role ping and the author is auto-**kicked** by default (`action: kick`; alternatives `alert` / `mute` / `ban` - never applied to real bot accounts, those only trigger the alert). The channel always stays **open to `@everyone`** so bots, selfbots and people without the Member role are caught too. A kicked user also has **every message they sent in the last 30 minutes purged server-wide** (`doNotType.purgeMinutes`, 0 = off). A persistent **Warning** sticker with live counter buttons (Caught / Muted / Kicked / Banned) is kept in the channel automatically. |
| Muted-commands channel | `mutedBotCmdsChannelId` is **visible to muted users and staff only** (`@everyone` is locked out; muted users + mods + the bot keep explicit allows) so muted users can still use bot commands there (`=puns` / `/history` on themselves, `=help`). A notice embed is kept in the channel automatically. |
| Roles | `/install` creates the whole role stack: **Muted** (above Member, hidden look), **Member**, **Bots** and the visible bot identity role - both below Member with stripped permissions - plus the hidden **Bot Perms** role (`Administrator`). With verification enabled, **Member** is granted by the Verify button instead of being assigned on join (see *Verification*). |
| Verification | A `verify` text channel (found or created by `/install`) holds a single **Verification** embed with a **Verify** button. Pressing it grants the `memberRoleId` ("Community" by default) and an ephemeral confirmation ("You are verified"). While unverified, members can only view the verify channel (+ the do-not-type trap channel, which must stay open for everyone): `/install` denies `@everyone` ViewChannel on every other channel/category, with explicit allows for the Member, mod and Bots roles. Every human join gets **two pointers**: the arrivals welcome card points at the verify channel and the newcomer receives a **private DM** - a **Verification required** card with the **Verify button inside the DM** (nothing is posted in the verify channel, so no join pings pile up in front of the panel). If DMs are closed, the bot posts the ping in the verify channel as a fallback and deletes it automatically once that member verifies. New channels are gated automatically (`channelCreate`) and the gate keeps ticket/voiceroom/muted-commands locks untouched. Set `verify.gate: false` and re-run `/install` to lift it again. |
| Self roles | A **self-role panel** in `selfRoles.channelId` (found or created by `/install`): toggle buttons built from `selfRoles.roles` (up to 25 entries - roleId, optional label and button style). Pressing a button grants the role, pressing it again removes it (ephemeral confirmation). The panel is refreshed by `/install` and restored on startup. Right after a member verifies, they are pinged here with a **Grab your roles** embed pointing at the panel. Entries are managed from Discord with `=addselfrole` / `=removeselfrole` - no config editing needed. |
| Bot status | A live **Status Report** embed in `botStatusChannelId`: the optional `developerCredit` line first, then Bot Status (CPU cores/usage, memory, uptime), Environment (Node.js / discord.js / platform / bot version) and Websocket (ping, shards, state). Refreshed every minute. |
| Server stats | A live **Server Report** card in `serverStatsChannelId`: Members (All / Humans / Bots), Online (live counts - needs the Presence Intent) and Server (Boosts, Channels, Roles, Created date). Optionally keeps a voice channel (`serverStatsVoiceChannelId`) automatically renamed to `All Members: N` (throttled to Discord's 2-renames/10-minutes limit). |
| Tickets | Panel in `tickets.panelChannelId` with **one button per ticket type** - **General Ticket** (blue) and **Guild Application** (green). Each type spawns its ticket channel into its own category (`General Tickets` / `Guild Applications`, auto-created by `/install` and written back to config.json), visible only to the opener and the ticket staff roles (`tickets.staffRoleId` + the extensible `tickets.staffRoleIds` list + the mod role). The opener is welcomed with a type-titled card, opener and staff roles are mentioned and the only button is **Close Ticket**. Guild Application tickets also auto-post the application template. `rename` / `add` / `remove` are ticket-staff only; `close` also works for the owner. On close the channel is **deleted** - the record survives only in `tickets.logChannelId`, which receives a closure card (opener, closer, note) plus an **HTML transcript** attachment. One **open ticket per user and type** - closed ones never block a new one. Extra permanent staff roles: `=ticketroleadd` / `=ticketroleremove` manage `staffRoleIds` from Discord and update every open ticket instantly. |
| Create Voice | A lobby voice channel (`createVoice.lobbyChannelId`) that spawns a personal voice channel on join, in the same category. The room is named after the joiner with a per-guild sequence number (`<username>'s VC · 01`) and the owner gets full control through a panel in its text chat: **Rename Room** (modal dialog) and **Set Private/Set Public** for locking or opening the room, a **User Limit** select and an **Invite a member** select that grants access, announces it in the room chat and **DMs a direct invite link** to the invited user (the room owner kicks people with Discord's built-in voice controls). Ownership passes to the first remaining member when the owner leaves; the channel is deleted when it empties. Needs the `GuildVoiceStates` intent (enabled in the code, not privileged). |
| Welcome | Every human join posts a card in `welcome.channelId`: a mention line ("Welcome to \<server\>!"), an embed with the username heading, a rules reminder, a details block (user ID, verification status or auto-assigned role, join date) and the new member count in the footer, with the member's avatar as the thumbnail. Bots are not welcomed. |
| Restart | `=restart` / `/restart` (Manage Server): the bot spawns a **fresh copy of its own process** (same script, flags and environment, detached) and exits; the replacement boots seconds later, automatically re-runs the full `/install` setup (`GUILDFRAME_AUTO_INSTALL=1`) and posts an **Auto-Install (Restart)** summary to the mod log. Under `node --watch` the watcher is stopped too - the bot keeps running as an independent process. |
| Install / Uninstall | `/install` checks every configured role/channel, applies the setup and posts/refreshes the setup messages (overwrites existing ones). `/uninstall` deletes those messages again. |

## Requirements

- **Node.js >= 23.4** (Node 24+ recommended; needs `node:sqlite` and `--env-file`)
- A Discord application ([Developer Portal](https://discord.com/developers/applications))

## Configuration

Configuration is split in two files:

### `.env` - secrets only

```env
DISCORD_TOKEN=__REDACTED__
CLIENT_ID=__REDACTED__
```

### `config.json` - everything else

```jsonc
{
  "prefix": "=",                  // prefix for text commands
  "guildId": "123...",            // your server ID (the bot only works here)
  "botName": "Guildframe",        // display name used in DM notices and panels
  "developerCredit": "",          // optional first line on the status cards, e.g. "DEVELOPED BY @HANDLE"
  "muteRoleId": "123...",         // Muted role ID (leave empty to auto-create on first mute)
  "muteRoleName": "Muted",        // name used when the bot creates the role
  "modRoleId": "123...",          // role allowed to use moderation commands
  "modLogChannelId": "123...",    // channel receiving all logs
  "auditLogChannelId": "123...",  // Carl-bot style message audit log (leave empty; /install finds or creates "audit-log")
  "memberRoleId": "123...",       // Member role ID (leave empty; /install auto-creates it)
  "memberRoleName": "Member",     // name used when the bot creates the member role
  "botsRoleId": "123...",         // shared role for bot accounts (auto-created by /install)
  "botsRoleName": "Bots",         // name used when the bot creates the bots role
  "botRoleId": "123...",          // visible bot identity role (no powers, below Member)
  "botRoleName": "Moderation Bot", // name used when the bot creates its own role
  "botPermsRoleId": "123...",     // hidden Administrator role (auto-created, position does not matter)
  "botPermsRoleName": "Bot Perms", // name used when the bot creates the hidden perms role
  "mutedBotCmdsChannelId": "123...", // channel muted users can still talk in to use commands
  "botStatusChannelId": "123...", // channel receiving the live "Status Report" card
  "serverStatsChannelId": "123...", // channel receiving the live "Server Report" card
  "serverStatsVoiceChannelId": "123...", // optional voice channel auto-renamed to "All Members: N"
  "doNotType": {
    "channelId": "123...",        // the "do not type here" channel
    "action": "kick",             // kick (default) | alert | mute | ban
    "purgeMinutes": 30,           // wipe the kicked user's messages from the last N minutes (0 = off)
    "rejoinUrl": "https://discord.sentialab.org"  // link DM-ed to kicked users as a rejoin option
  },
  "tickets": {
    "panelChannelId": "",          // channel hosting the panel (one button per ticket type)
    "staffRoleId": "",             // legacy single staff role that can see and manage every ticket
    "staffRoleIds": [],            // extensible list of extra ticket-staff roles (managed with /ticketroleadd)
    "generalCategoryId": "",       // category general tickets spawn in (leave empty; /install finds or creates it)
    "generalCategoryName": "General Tickets",       // name used when /install creates the category
    "applicationCategoryId": "",   // category guild applications spawn in (leave empty; /install finds or creates it)
    "applicationCategoryName": "Guild Applications", // name used when /install creates the category
    "logChannelId": "",            // tickets log: closure summary + HTML transcript for every closed ticket
    "archiveCategoryId": "",       // legacy archive category (no new tickets are archived; /install only maintains it)
    "archiveCategoryName": "Ticket Archive" // name used when /install creates the archive category
  },
  "createVoice": {
    "lobbyChannelId": ""           // voice channel users join to spawn a personal voice channel
  },
  "welcome": {
    "channelId": ""                // welcome card posted here when a human member joins
  },
  "verify": {
    "channelId": "",               // verify channel (leave empty; /install finds or creates it and stores the ID)
    "channelName": "verify",       // name used when /install creates the channel
    "gate": true                   // true = unverified members can only view the verify channel
  },
  "selfRoles": {
    "channelId": "",               // self-role channel (leave empty; /install finds or creates it and stores the ID)
    "channelName": "self-role",    // name used when /install creates the channel
    "roles": []                    // entries: { "roleId": "", "label": "", "style": "Primary" } (managed with /addselfrole / /removeselfrole, max 25)
  },
  "warnEscalation": {
    "threshold": 0,               // active warnings needed to auto-mute (0 = off)
    "duration": "1h"              // auto-mute duration
  }
}
```

`config.json` is read at startup and **written back** when the bot auto-creates roles/channels, so `muteRoleId`, `memberRoleId`, `botsRoleId`, `botRoleId` and `verify.channelId` fill themselves in.

## Setup

### 1. Create the bot

1. Developer Portal -> **New Application**.
2. **Bot** tab -> **Reset Token** -> copy the token into `.env`.
3. **Bot** tab -> enable **Server Members Intent**, **Message Content Intent** and **Presence Intent** (Presence is needed for the live online counts on the Server Report card).
4. **General Information** tab -> copy the **Application ID** into `.env`.

### 2. Invite the bot

```
https://discord.com/oauth2/authorize?client_id=YOUR_CLIENT_ID&permissions=8&scope=bot%20applications.commands
```

Grants **Administrator**. That is intentional: an Administrator bot ignores Discord's role-position limits, so the hidden perms role can rest at the bottom of the role list while the visible bot roles stay below Member. (Alternative: invite with the granular permission set and drag the perms role above Member instead.)

> `/install` creates the roles above and tries to fix their order automatically; with Administrator the bot can manage every role, so no manual dragging is required. Assign the hidden **Bot Perms** role to the bot once (or re-invite with the Administrator link so `/install` can do it).

### 3. Run

```bash
npm install
cp .env.example .env          # fill in DISCORD_TOKEN + CLIENT_ID
# edit config.json: guildId, modLogChannelId, modRoleId, doNotType.channelId...
npm run deploy                # register global slash commands
npm start
```

### 4. In the server

```
/install
```

Checks every configured role/channel, creates the role stack (Muted, Member, Bots, bot identity, hidden Bot Perms) when missing, finds or creates the `verify` channel, the two ticket categories and the self-role channel, applies the channel restrictions and the verification gate, posts the setup messages (the Warning sticker in the do-not-type channel, the notice in the muted-commands channel, the Status Report card in the bot-status channel, the Server Report card in the server-stats channel, the Verification message in the verify channel and the self-role panel) and prints a summary embed. The embed includes the server the bot operates in, one status row per role/channel and a final **Report** field listing everything that is not ready yet (`Not set` / `Failed`). Re-running it overwrites/refreshes everything. `/uninstall` deletes the setup messages again.

## Commands

### Prefix (`=`)

| Command | Description |
| --- | --- |
| `=mute <uid\|mention\|name> <duration> [reason]` | Mute a member. Duration: `5m`, `2h`, `3d`, `1d12h`, `perm`. Omit duration = permanent. |
| `=unmute <user> [reason]` | Remove the mute. |
| `=kick <user> [reason]` | Kick a member. |
| `=ban <user> [duration] [reason]` | Ban (duration optional = temp ban). |
| `=unban <user id> [reason]` | Remove a ban. |
| `=warn <user> [reason]` | Warn a member. |
| `=warnings list [user|empty=you]` / `=warnings clear <user> [reason]` | View / clear warnings. |
| `=puns` / `=h` / `=history` / `=punishments [user] [type]` | Punishment history with page buttons (empty user = your own; members may self-lookup). |
| `=case <number>` / `=case delete <number> [reason]` | View / hide a case. |
| `=purge [user] <amount>` | Remove recent messages (newest first) in this channel; with a user, only their messages there. Cap 1000, only under 14 days old, pinned are kept. |
| `=rename <new name>` | Rename this ticket (in ticket channels). |
| `=close [note]` | Close this ticket - the channel is deleted and the transcript goes to the ticket log. |
| `=add <@user|@role>` | Grant ticket access. |
| `=remove <@user|@role>` | Revoke ticket access. |
| `=addrole <user> <@role\|role id> [reason]` | Give a member a role (mod-log entry, no case). |
| `=removerole <user> <@role\|role id> [reason]` | Remove a role from a member (mod-log entry, no case). |
| `=addselfrole <@role\|role id> [label]` | Add a role to the self-role panel (persists to config.json, panel refreshed instantly). |
| `=removeselfrole <@role\|role id>` | Remove a role from the self-role panel (raw id works even for deleted roles). |
| `=ticketroleadd <@role\|role id>` | Permanently grant a role access to all open and future tickets. |
| `=ticketroleremove <@role\|role id>` | Remove that permanent ticket-staff role again. |
| `=restart` | Restart the bot; it boots on its own and automatically re-runs the full setup. |
| `=setup` | Create the Muted role + apply channel restrictions. |
| `=install` | Full setup check: roles, channels, restrictions, setup messages. |
| `=uninstall` | Delete the setup messages the bot posted in channels. |
| `=help` | List prefix commands. |

> Every slash command has a prefix equivalent (`=install` = `/install`, ...).

Examples:

```
=mute 134029771369230409 14d Negative Use of Disabilities
=mute @GreedNot 5m spam
=mute GreedNot perm ban evasion
=puns 803207908203429938
```

Targets accept a **user ID**, a **mention** (`<@123...>`) or an **exact username / global name / display name** (case-insensitive; names with spaces work, e.g. `=ban the ai 7d`). Partial or prefix matches are never guessed - a miss reports no match instead of picking the closest member. Roles accept a **`<@&123...>` mention** or a **role ID**.

### Slash (global)

| Command | Description |
| --- | --- |
| `/mute user duration: reason:` | Mute (same rules as prefix). |
| `/unmute user reason:` | Unmute. |
| `/kick user reason:` | Kick. |
| `/ban user duration: reason: delete_messages:` | Ban / temp ban. |
| `/unban user_id reason:` | Unban. |
| `/warn user reason:` | Warn. |
| `/history user type:` and `/punishments user type:` | Punishment history (`user` optional - omit to see your own; members holding the Member role may self-lookup, other users need a moderator). |
| `/case view|delete number:` | View or hide a case. |
| `/purge amount: user:` | Bulk-remove the newest messages in this channel (optionally only one user's messages). |
| `/warnings list|clear user:` | Manage warnings (`list` without `user` shows your own warnings). |
| `/rename name:` | Rename this ticket channel (owner/staff only, in ticket channels). |
| `/close note:` | Close this ticket - the channel is deleted and the transcript goes to the ticket log. |
| `/add user: / role:` | Grant a user or role access to this ticket. |
| `/remove user: / role:` | Revoke ticket access. |
| `/addrole user role: reason:` | Give a member a role (mod-log entry, no case). |
| `/removerole user role: reason:` | Remove a role from a member (mod-log entry, no case). |
| `/addselfrole role: label:` | Add a role to the self-role panel (label optional, panel refreshed instantly). |
| `/removeselfrole role:` | Remove a role from the self-role panel. |
| `/ticketroleadd role:` | Permanently grant a role access to all open and future tickets (`staffRoleIds`). |
| `/ticketroleremove role:` | Remove a permanent ticket-staff role again. |
| `/restart` | Restart the bot; the new process auto-runs the full setup. |
| `/setup` | Create Muted role + apply channel restrictions. |
| `/install` | Full setup check: roles, channels, restrictions, setup messages. |
| `/uninstall` | Delete the setup messages the bot posted in channels. |

Note: inside the muted-commands channel, muted users can run `/history` / `/punishments` (and `=puns`) on **themselves** without moderator permissions. Everywhere else, members holding the configured **Member role** may also use `/history` `/punishments` `/warnings list` (and the prefix forms) **on themselves** - leaving the user empty shows the caller's own record; looking up another user still requires a moderator, as does `=warnings clear`.

> Users with the configured `modRoleId` (or Administrators) can use every command **except `/ban`, `=ban`, `/kick`, `=kick`** - those require the real Discord **Ban Members** / **Kick Members** permission. All other commands fall back to the matching Discord permission (Manage Roles, Manage Messages, Manage Server).

## How it works

### Cases

- Every action creates a numbered case (`Case #12`, per server) - including automatic mutes, unmutes, unbans and notes.
- `status` is `active`, `expired` (timer ran out) or `removed` (undone early / cleared). History shows the label next to `**Status:**`.
- `/case delete` sets `hidden = 1` - the case disappears from history but stays in the database.

### Roles

`/install` makes sure these roles exist, ordered top to bottom in the role list:
1. **Muted** (`muteRoleName`) - positioned **above Member** so it wins over member roles, but kept invisible: no colour (muted usernames stay their default colour) and never shown separately. Chatting is denied via channel overwrites.
2. **Member** (`memberRoleName`) - basic access: `View Channels`, `Send Messages`, `Read Message History`. Granted by the Verify button when verification is enabled; assigned to every human join otherwise. Restricted categories/channels stay configured by you in Discord.
3. **Bots** (`botsRoleName`) - shared role for bot accounts, **below Member**. Assigned to every bot already in the server and to every bot that joins later.
4. **Bot identity role** (`botRoleName`, e.g. `SENTIA`) - the visible bot role, **below Member** - `/install` strips its permissions **and un-hoists it**, so the bot no longer gets its own group at the top of the member list; it appears under the normal online section.
5. **Bot Perms** (`botPermsRoleName`, default `Bot Perms`) - **hidden, colourless, not hoisted** role that carries exactly one permission: **Administrator**. Because the bot ignores role positions as Administrator, this role can rest at the very bottom of the list; it never shows in member profiles.

### Verification

- `verify.channelId` (empty by default) is found or created by `/install` (name from `verify.channelName`, default `verify`; the ID is written back to `config.json`). The channel stays open to `@everyone` but only staff can type in it - the button carries the gate.
- The bot keeps a single **Verification** embed in the channel: green accent, `{server name}` footer, and one **Verify** button. It is posted/refreshed by `/install`, restored on startup and removed by `/uninstall`.
- Pressing **Verify** grants the `memberRoleId` and answers with an ephemeral **Verified** card ("the rest of the server is unlocked"); pressing it while verified answers **Already verified**. Bots that somehow press it, and members without a configured verified role, get an error. There is no slash/prefix equivalent on purpose: the button is the gate.
- Every human join still gets **two pointers**: the arrivals welcome card carries the pointer line ("<#verify> is the only channel you can see right now - press **Verify** there...", clickable channel mention), and the newcomer receives a **private DM** - a **Verification required** card that carries its own **Verify button**, so verification can happen without ever visiting the channel (the press is resolved against the configured guild). Bots and members that are already verified are skipped. With DMs open, **nothing is posted in the verify channel** - unverified members never see other people's join pings there.
- **DMs closed?** Fallback: the old **Verification required** ping is posted in the verify channel (the panel itself stays untouched) and is **deleted automatically once that member verifies** - a sweep checks the last 50 messages and removes only bot-authored ones mentioning that member, so staff replies are never touched. The channel keeps just the static panel; no more wall of join pings.
- While `verify.gate` is `true` (default), `/install` denies `@everyone` **ViewChannel** (plus **Connect** on voice channels) on every other channel and category, and gives explicit allows to the Member (verified), mod and Bots roles - so other bot accounts and staff never get locked out. Muted members are unaffected by the gate: the Muted role keeps its restriction allows and the muted-commands channel keeps its own seal (both are skipped by the gate).
- The gate is re-applied to channels created later by the `channelCreate` event. It leaves alone channels that already manage their own `@everyone` overwrite (ticket channels, locked spawned voice rooms) plus the always-open do-not-type channel.
- Disabling: set `verify.gate: false` and re-run `/install` - the install then removes the `View Channel`/`Connect` deny bits from `@everyone` server-wide (the muted-commands seal, ticket channels and spawned voice rooms are skipped). Caution: this also lifts an unrelated `@everyone` view lock an admin may have set manually.
- New humans therefore stop getting the Member role on join while verification is enabled; the welcome card shows **Awaiting verification (press Verify in #verify)** instead of the auto-assigned role. Bots still get the Bots role on join.

### Self roles

- `selfRoles.roles` drives the panel: one entry per role - `{ "roleId": "...", "label": "...", "style": "Primary" }` - label falls back to the role name, style to `Secondary` (any of `Primary` / `Secondary` / `Success` / `Danger`). Roles that are gone or integration-managed are skipped silently. The first **25 usable entries** are shown (Discord's button limit), packed 5 per row.
- `selfRoles.channelId` is found or created by `/install` (name from `selfRoles.channelName`, default `self-role`; the ID is written back to config.json). With the verify gate on, the channel is sealed for `@everyone` like every other member-area channel - verified members keep access via the Member role allow.
- The panel is a Components V2 card ("Self Roles", `[ • ] Roles` section style, no emoji) - toggle buttons only: pressing grants the role, pressing again removes it. Every press answers with an ephemeral **Role added / Role removed** card. The panel is posted/refreshed by `/install`, restored on startup and removed by `/uninstall` (it is a tracked setup message).
- Right after a **first-time verification** the bot posts a **Grab your roles** ping in the self-role channel: the new member is mentioned ("you are verified", "press the role buttons to give yourself the roles"). The ping messages accumulate like any channel message (staff can delete them); the panel itself is never re-posted.
- Toggling is limited to the configured roles; buttons whose role was removed from the config answer with "no longer configured - run `/install`".
- Entries are managed from Discord: `=addselfrole <@role> [label]` / `/addselfrole role: label:` appends an entry to `selfRoles.roles` in config.json (button label defaults to the role name), `=removeselfrole` / `/removeselfrole` deletes one - raw IDs work, so entries whose role was already deleted can be cleaned up. Both refresh the panel message immediately; `/install` is only needed when the self-role channel does not exist yet.

### Mute

- A role alone cannot remove permissions, so the bot denies `Send Messages`, `Add Reactions`, `Create Threads`, `Speak`, ... via **channel overwrites** for the Muted role (`/install` / `/setup` apply them everywhere; new channels are handled by the `channelCreate` event).
- Temporary mutes are stored with `expires_at` and re-scheduled on boot; expiring mutes have the role removed automatically and the case marked `expired`.

### Rejoin policy

- Punishments do not reset when someone leaves: `guildMemberAdd` re-applies every still-active case when the member returns. Mutes hand the Muted role back (**Mute Re-applied** audit); active ban cases re-ban the returner (**Ban Re-applied**) - they could only have rejoined via a manual out-of-band unban, since an in-band `=unban` always expires the case first.
- The arrivals channel gets a dedicated **Mute Re-applied** / **Ban Re-applied** card (with case number, reason and expiry) instead of the normal welcome card, and the member is sent the matching DM before the ban is enforced (afterwards the bot may no longer share a guild with them).
- Cases whose duration ran out while the member was away are marked `expired` on the spot and never re-applied (covers the window around a bot restart). Warnings are records without runtime state, so they simply stay counted towards the warning threshold.

### Muted-commands channel

- `mutedBotCmdsChannelId` is **sealed for everyone else**: `@everyone` loses `View Channel` / `Send Messages` there, while the Muted role keeps explicit allows (view + chat + slash commands), the mod role keeps read/write access and the bot itself can still post its notice.
- The bot keeps a notice embed in that channel ("You are muted ... use `=puns` to view your own history").
- Self-service: inside that channel only, a muted user can run `=puns` / `=h` / `=history` / `=punishments` (no arguments = themselves) and `/history` `/punishments` on themselves without any moderator permission. Everything else still requires permissions.
- Re-run `/install` after changing `mutedBotCmdsChannelId`; the `channelCreate` event reshuffles the same restrictions if it is ever recreated.

### Logging

- Bot actions -> full case embed in the mod log channel (the examples in this README).
- Out-of-band actions (ban/kick/unban/timeout/manual Muted role changes done in the Discord UI) -> caught via `guildAuditLogEntryCreate` and logged with the executor, tagged `(out of band)`.
- Do-not-type channel messages -> alert embed with a ping to `modRoleId`, plus the optional automatic action.

### Audit log channel (message events)

- A dedicated Carl-bot/Dyno style channel (`auditLogChannelId`) receives pure message-event cards, separate from the mod log's case embeds:
  - **Message Deleted** (red) - author, channel, full text, every attachment as a link with the first image embedded inline, embed/sticker counts and a `Deleted by` field: the deleting moderator when the Discord audit log shows one (with the reason they attached), otherwise `Author (self-delete)`.
  - **Message Edited** (yellow) - member edits with Before/After and a jump link. Bot/webhook messages and link-preview-only changes are skipped.
  - **Bulk Delete** (purple) - manual channel purges with the count, executor, up to five affected users and the message timeframe.
- Deletions executed by the bot itself (the verify-ping sweep, `=purge`, the do-not-type history purge) are skipped here - they already audit through their own mod-log cards.
- `/install` adopts an existing `audit-log` channel by name or creates one in the mod log's category, sealed with `@everyone` (deny View/Send) and a read-only allow for the mod role; the notice embed in it is tracked and cleaned by uninstall. Leave `auditLogChannelId` empty to let `/install` handle it.

### Purge

- `=purge <amount>` / `/purge amount:` removes the newest messages of the current channel; `=purge <@user|user id> <amount>` / `/purge amount: user:` restricts the removal to **that person's messages in that channel**. Needs **Manage Messages** for the caller and for the bot in that channel.
- Range 1-1000, automatically chunked into Discord's 100-message bulk-delete calls. Bulk delete only works on messages **younger than 14 days**; pinned messages are never removed and the scan stops at the start of the channel - the reply reports what was actually removed versus requested.
- Targets may be members or users who already left (messages stay, the user themselves must not be in the server anymore). Every purge audits to the mod log (**Purge** embed with channel, moderator, optional user filter and the removed count) - no case entry. The do-not-type trap channel is off-limits: its messages are the evidence trail for the catches.

### Do-not-type channel

- The channel must be **typeable by everyone to work**: `/install` grants `@everyone` an explicit allow (`View Channel`, `Send Messages`, `Read Message History`), so bots, selfbots and brand-new joins without the Member role all trigger the catch. The bot itself also gets an explicit allow to keep posting the Warning sticker. users with the Muted role stay blocked (they are muted already).
- On startup (and after every catch) the bot posts/updates a **Warning** message in `doNotType.channelId`:
  `Warning` + "DO NOT POST MESSAGES IN THIS CHANNEL, you will be {muted/kicked/banned} from {server} if you do so!" + "This channel is used to catch bots that spam our server."
- Below it, counter buttons track `Caught`, `Muted`, `Kicked`, `Banned` (counters persist in the database; action buttons appear once used). No emoji anywhere in the UI.
- Every caught message is logged to the mod log channel with the author, content preview and a jump link.
- When the trap action is `kick`, the author is kicked and the bot then **purges every message they sent in the last `purgeMinutes` minutes** (default 30) across all channels and active threads it can manage (needs Manage Messages). The result ("Deleted N message(s) from the last 30 minutes in M channel(s).") is shown in the alert embed's `History cleanup` field.
- Before the kick, SENTIA **DMs the member a Kick Notice** embed: it explains the automatic kick (with the case number), states that the do-not-type channel is a detection trap, and offers the rejoin link from `doNotType.rejoinUrl` (default `https://discord.sentialab.org`) for anyone who typed there by accident. The mod-log entry gains a `Notice` field showing whether the DM was delivered.

### Tickets

- Each ticket **type** spawns into its own category: `general` -> `generalCategoryName` (default `General Tickets`), `application` -> `applicationCategoryName` (default `Guild Applications`). `/install` - and the button as a fallback - finds or creates the category and writes its ID back to config.json; new tickets no longer land in the panel's own category.
- `tickets.panelChannelId` hosts the panel: a Components V2 card ("Tickets") with **one button per ticket type** - `General Ticket` (blue) and `Guild Application` (green) - nothing else.
- The button creates the ticket as a **text channel in the type's category**, named for its type (`ticket-<username>` / `application-<username>`, sanitized), with overwrites: `@everyone` denied, the opener and every ticket staff role allowed (view/write/attach/embed). Ticket staff = `tickets.staffRoleId` + `tickets.staffRoleIds` (extensible role list) + the mod role - all can see and manage every ticket; `/install` re-applies their allows to all open ticket channels when the config changes.
- One open ticket **per user and type** - pressing a button points to the existing open ticket of that type; the other type's button still opens a new one.
- Welcome card in the new channel: titled after the type (`General Ticket` / `Guild Application`, green accent) - "Welcome @user." - opener and staff roles mentioned - footer note "pinging staff can result in a permanent ticket ban" - the only button is **Close Ticket** (no claim button).
- **Guild Application tickets auto-post the application template** right after the welcome card: a ping to the opener plus a **Guild Application** embed that explains the format and shows the template in a **code block** - `IGN ·`, `Region ·`, `Level ·`, `FKDR ·`, `Wins ·`, `Hours per week ·`, `Previous guilds ·`, `Why OnWEED -` - so every applicant copies the same layout and fills in the answers. The template lives in `APPLICATION_TEMPLATE` (services/tickets.js).
- Permissions: `rename` / `add` / `remove` are **ticket-staff only**; `close` is owner or staff (also via the button).
- Inside the ticket (owner or staff): `/rename` (sanitized, keeps the type's `ticket-` / `application-` prefix), `/add` and `/remove` for users or roles, `/close [note]`: marks the row closed, announces it, writes a **Ticket Closed** entry to the mod log (with the type label and the note) and **deletes the channel** (the transcript is the surviving record).
- **Delete on close (archive feature removed):** closing a ticket sends the transcript to the ticket log and then deletes the channel. Only **legacy archives** remain: channels archived while the feature still existed stay in `tickets.archiveCategoryId`, still read-only (the `@everyone` deny includes `SendMessages`, the bot deletes any new message there - **including administrators**, whose Administrator permission bypasses channel overwrites); `/install` re-seals them (idempotent).
- **Tickets log** in `tickets.logChannelId`: every closure posts a **Ticket Closed** card (type, opener, closer, opened/closed timestamps, note, channel link) with an **HTML transcript** attachment of up to 1000 messages (authors, timestamps, content, attachment links) - the sole record once the channel is deleted. The bot-internal fallback still audits to the mod log.
- Everything is stored in the `tickets` table (type, owner, status, who closed, note, timestamps).
- **Permanent staff roles:** `=ticketroleadd <@role>` / `/ticketroleadd role:` appends the role to `tickets.staffRoleIds` (persisted to config.json) and grants it - together with the other staff roles - access to every **open ticket right away, plus every future one** (`applyTicketStaffOverwrites`). `=ticketroleremove` / `/ticketroleremove` deletes the entry again and revokes its overwrite on open tickets; if the role still manages tickets as the legacy `staffRoleId` or the mod role, only the config entry is removed and the overwrites stay. Both commands audit to the mod log. Different from `add` / `remove`, which grants a single user/role access to **one ticket only** (temporary).

### Create Voice

- `createVoice.lobbyChannelId` is the trigger channel (for example named `Create Voice`). Joining it spawns a personal voice channel **named after the joiner with a per-guild sequence number** (`<username>'s VC · 01`, `· 02`, ...) in the **same category** and moves the joiner there; joining again reconnects that member to their own channel instead of spawning a second one. A database number column survives restarts so the sequence keeps increasing.
- The new channel's text chat carries a **Voice Channel** panel (plain embed, no emoji) with the current owner, privacy and user limit plus four controls:
  - `Rename Room` - opens a modal dialog; the owner can rename the room freely (the number suffix is only in the auto-generated name).
  - `Set Private` / `Set Public` - private denies `@everyone` view and connect while the owner and invited members keep access; public removes the `@everyone` restriction.
  - `User Limit` select - Unlimited, 2, 3, 4, 5, 6, 8, 10.
  - `Invite a member` select - up to five at once; each invited member receives access, an announcement in the room chat and a **DM from SENTIA with a direct invite link**. If the member has DMs closed, the reply notes the failed delivery - access still works. Kicking someone out is left to the room owner via Discord's own voice controls (right-click the member, Disconnect).
- Panel use is restricted to the **channel owner or staff** (ticket staff role / mod role / administrator). Speak permission is never force-granted, so a server-wide mute stays effective.
- When the owner leaves, ownership transfers to the first remaining member and the panel re-renders. When the channel empties, it is **deleted automatically** and its row is removed from the `voice_channels` table.
- Requires the `GuildVoiceStates` gateway intent - included in the code and not privileged, no Developer Portal change needed.

### Welcome channel

- `welcome.channelId` receives a card on every human join (bots are skipped): a mention line - `<@member>, Welcome to <server>!` - followed by the embed: green accent, **Welcome, \<username\>** heading, "Please read the rules and enjoy your stay.", a `Details` block with the `User ID` (mono), the auto-assigned role and the join date (`<t:F>` with a relative suffix), and the footer "We now have N members!" with the server icon.
- The member's avatar appears as the embed thumbnail. With verification enabled the card also carries a pointer line to the verify channel (clickable `<#verify>` mention) and the Details block shows **Awaiting verification (press Verify in #verify)** - no role is assigned; otherwise the Member role is assigned on join before the card is posted (existing behavior).

### Bot status channel

- The bot keeps a **Status Report** embed (`[ • ]` section style, no emoji) in `botStatusChannelId` and edits it every minute. When `developerCredit` is set, that line is shown first, right below the embed title:
  `Bot Status` (CPU cores/usage, Mem Max, Mem Use, Uptime) - `Environment` (Node JS, Discord JS, Platform, Bot version) - `Websocket` (Ping, Shards, State).
- Posted/refreshed by `/install`, restored on startup, removed by `/uninstall`. Keeping only these three sections is intentional (no queue/arena/plugin noise).

### Server stats channel

- The same report style in `serverStatsChannelId`, titled **Server Report** (with the same optional `developerCredit` first line) and edited every minute:
  `Members` (All Members, Humans, Bots) - `Online` (Online, Idle, Do Not Disturb, Offline - live from presences; enable the **Presence Intent** in the Developer Portal, otherwise it says unavailable) - `Server` (Boosts + Tier, Channels text/voice, Roles, Created date).
- Optional: put the ID of the "All Members" voice channel into `serverStatsVoiceChannelId` and the bot renames it to `All Members: {total}` whenever the count changes (respecting Discord's rename rate limit, so up to 10 minutes late).

### Restart

- `=restart` / `/restart` (Manage Server) replies with a **Restart** card, then the bot spawns a **fresh copy of its own process** - same entry script, runtime flags (plus `--env-file`, so `.env` values carry over) and inherited environment, spawned `detached` with `stdio: 'inherit'` so logs continue in the same terminal - and exits. The replacement boots seconds later.
- The new instance boots with `GUILDFRAME_AUTO_INSTALL=1`: after login it immediately re-runs the entire `/install` setup (config re-checked, all setup messages refreshed) and posts an **Auto-Install (Restart)** summary embed to the mod log. The flag is cleared at boot so it never leaks to child processes.
- Under `node --watch` (`npm run dev`) the supervisor is detected via the parent process command line (`ps -o command= -p <ppid>` containing both `node` and `--watch` - the watched process's own `execArgv` never carries the `--watch` flag) and **terminated** after the new process is spawned: the watcher does not restart apps on exit and would otherwise fire a duplicate instance on the next file change. The bot keeps running as an independent process in the same terminal; stop it manually (`Ctrl+C` on the process or its logged pid) and start `npm run dev` again to return to watch mode.

## Project structure

```
config.json               # bot configuration (IDs, prefix, traps)
.env                      # secrets only (token, client id)
src/
├── index.js              # boot: intents, loaders, login
├── deploy-commands.js    # global slash command registration
├── config.js             # .env + config.json loader (writes role IDs back)
├── constants.js          # colors, type metadata, statuses, limits
├── db.js                 # SQLite schema + queries (cases, punishments)
├── commands/             # slash commands
├── events/               # ready, interactionCreate, messageCreate, guildMemberAdd, voiceStateUpdate,
│                         # guildAuditLogEntryCreate, channelCreate
├── prefix/
│   ├── handler.js        # =commands dispatcher (mute, puns, ...)
│   └── doNotType.js      # do-not-type channel trap
├── services/
│   ├── mutes.js          # Muted role + overwrites + assign/remove
│   ├── roles.js           # Member / Bots / Moderation Bot roles (auto-created, assigned on join)
│   ├── install.js        # /install + /uninstall (setup checks, setup messages)
│   ├── status.js          # bot status card (Bot Status / Environment / Websocket)
│   ├── serverstats.js     # server stats card (Members / Online / Server) + All-Members voice sync
│   ├── tickets.js         # ticket system (panel, open/rename/add/remove/close)
│   ├── verify.js           # verification gate (verify channel, Verify button, channel-wide lock)
│   ├── selfroles.js        # self-role toggle panel (config-driven roles) + post-verify ping
│   ├── createvoice.js     # create-voice lobby (spawn personal VC, privacy/limit/invite panel)
│   ├── welcome.js         # welcome + punishment-rejoin cards posted when a human member joins
│   ├── notify.js          # punishment DM embeds (warn / mute / kick / ban, rejoin enforcement)
│   ├── trap.js           # do-not-type Warning message + counters
│   ├── scheduler.js      # temp mute/ban timers (restored on boot)
│   ├── escalation.js     # auto-mute on warning threshold
│   ├── restart.js        # self-restart helper (=restart -> fresh process + auto-install)
│   ├── historyCommand.js # shared /history + /punishments implementation
│   └── log.js            # mod log sender
└── utils/                # duration, embeds, permissions, paginate, loaders
data/bot.sqlite           # database (auto-created, gitignored)
```

## Operational notes

- **Muted role deleted?** The bot recreates it (and updates `muteRoleId` in config.json) on the next mute; run `/install` to re-sync channel overwrites.
- **Changed config IDs?** Run `/install` again - it re-checks everything and refreshes/overwrites the setup messages.
- **Want the server open again (no verify gate)?** Set `verify.gate` to `false`, run `/install` once (it lifts the view locks), then set it back to `true` when needed - the lift skips the muted-commands seal, tickets and voice rooms.
- **Logs not sent?** Check `modLogChannelId` and that the bot can Send Messages + Embed Links there.
- **Backup:** copy `data/bot.sqlite` (plus `-wal` while running).
- **Slash commands missing?** Global commands can take up to an hour to appear; re-run `npm run deploy`.

## Production deployment (NBI Core 01)

- **Host:** `ssh ubnt-server.public` (Ubuntu 24.04, user `zvwgvx`)
- **Deployment dir:** `/home/zvwgvx/onweed-bot` (code, `.env`, `config.json` and the SQLite database in `data/`)
- **Runtime:** Node 24 LTS in `/opt/node24/bin/node` (the system Node v18 is left untouched; the bot needs >= 23.4 for `node:sqlite`)
- **Service:** `onweed-discord-bot` (unit at `/etc/systemd/system/onweed-discord-bot.service`, `Restart=always` - a crash or a self-restart boots the bot back automatically)

```bash
systemctl status onweed-discord-bot      # state
journalctl -u onweed-discord-bot -f      # live logs
sudo systemctl restart onweed-discord-bot
```

- **Update flow:** run the bot only once per instance - rsync the project to `/home/zvwgvx/onweed-bot`, run `PATH=/opt/node24/bin:$PATH npm run deploy` once per slash-command change, then `sudo systemctl restart onweed-discord-bot`.
- The `=restart` command stays correct under systemd: the process exits (code 0) and systemd immediately replaces it via `Restart=always`, so no duplicate instances or orphaned processes appear.
- When switching where the bot runs, stop the other instance first: two live processes on one Discord token post every moderation action twice.

## Roadmap ideas

- [ ] Message log (edit/delete)
- [ ] Appeal flow / DM notifications
- [ ] Rule database (rule IDs in cases)
- [ ] Web dashboard
