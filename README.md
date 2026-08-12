# Song of the Day Discord Bot

A run-based Discord bot that collects one song by DM from every member of a selected role, randomizes the submitted songs, and posts one song with a 10-to-1 poll every 24 hours.

## Commands

- `/assign-sotd-role role:@Role` — chooses the participant/notification role.
- `/assign-sotd-channel channel:#Channel` — chooses the text channel or active thread where songs and polls are posted.
- `/start-sotd-run` — opens a form asking how many hours members have to submit.
- `/end-song-selection` — closes submissions immediately, excludes non-submitters, and starts the submitted-song schedule.
- `/skip-person` — skips the active song and immediately posts the next scheduled song.
- `/end-run` — immediately ends the active run.

All commands require the **Manage Server** permission. A posting destination must be assigned before starting a run.

## How a run works

1. The bot finds every non-bot member with the configured role and DMs them the deadline.
2. DM replies must contain only an HTTPS/HTTP song link from Spotify, Apple Music, YouTube Music, or Tidal. Each member gets one submission.
3. If the collection window is longer than 24 hours, non-submitters receive a reminder when 24 hours remain.
4. At the deadline, submitted songs are shuffled. Members who did not submit are omitted.
5. The bot posts the submitter, title, artist, link, and a native Discord poll with options `10` through `1`.
6. Every 24 hours it posts the next scheduled song. The run ends after the final song.

State is stored in `data/storage.json`, so timers survive bot restarts. The scheduler checks due work every 30 seconds.

## Discord setup

1. Create an application and bot at the [Discord Developer Portal](https://discord.com/developers/applications).
2. On the bot page, enable both privileged intents:
   - **Server Members Intent** (to find all members with the role)
   - **Message Content Intent** (to read song links sent by DM)
3. Invite the bot with the `bot` and `applications.commands` scopes. Give it permission to view/send messages, create polls, and mention the chosen role. The role must be mentionable or the bot must have **Mention @everyone, @here, and All Roles**.
4. Copy `.env.example` to `.env` and enter the bot token and application ID. Add a development server ID if you want commands to register immediately.
5. Install and start:

```powershell
npm.cmd install
npm.cmd run register
npm.cmd start
```

Guild commands appear immediately. Global commands (when `DISCORD_GUILD_ID` is omitted) can take time to propagate.

## Environment

```dotenv
DISCORD_TOKEN=your_bot_token
DISCORD_CLIENT_ID=your_application_id
DISCORD_GUILD_ID=your_test_server_id
```

The server ID is optional. Never commit the real `.env` file or bot token.

## Operational notes

- Users can disable DMs from server members. The start confirmation reports how many invites failed, and those members are not placed in the run.
- Metadata is read from each music service's public embed/page metadata. If a service blocks that lookup, the bot still preserves the link and labels unavailable fields as unknown.
- Only one run can be active per server. If the bot was offline when a deadline passed, the overdue action occurs after it reconnects.
