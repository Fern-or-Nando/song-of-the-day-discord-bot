# Song of the Day Discord Bot

A run-based Discord bot that collects one song by DM from every member of a selected role, randomizes the submitted songs, and posts one song with a 10-to-1 poll every 24 hours.

## Commands

- `/assign-sotd-role role:@Role` — chooses the participant/notification role.
- `/assign-sotd-channel channel:#Channel` — chooses the text channel or active thread where songs and polls are posted.
- `/start-sotd-run` — opens a form asking how many hours members have to submit.
- `/skip-song-selection` — closes submissions immediately, excludes non-submitters, and schedules submitted songs for the next daily posting time.
- `/skip-person` — skips the active song and immediately posts the next scheduled song.
- `/end-run` — immediately ends the active run.

All commands require the **Manage Server** permission. A posting destination must be assigned before starting a run.

## Revised run setup

`/start-sotd-run` opens a form with three fields:

- Selection duration in hours (`48`) **or** an explicit end date/time with offset (`2026-09-05T18:00-05:00`). Offset-free dates are rejected to avoid timezone ambiguity.
- Daily posting time, in 24-hour format (`18:00`).
- An IANA timezone (`America/Chicago`).

`/skip-song-selection` replaces `/end-song-selection`. It closes collection early and excludes non-submitters. The first song waits for the next chosen daily posting time rather than posting immediately. `/skip-person` still posts the next song immediately; subsequent posts return to the daily schedule.

The roster includes all non-bot role members, even members whose DMs fail. Failed deliveries are counted in a separate private follow-up to the manager. These members can open a DM with the bot to submit before the deadline. Everyone-submitted notifications require submissions from the full roster and are checked every 30 seconds. They mention the role and explain `/skip-song-selection`.

Daily timing follows the selected timezone: daylight-saving changes can produce 23- or 25-hour intervals, while Discord polls last 24 hours. A skipped song's already-posted poll remains available until its normal expiry. Ending a run cancels future posts but does not delete existing polls. If the bot restarts late, it posts the due song once and resumes the daily schedule without flooding missed days.

Keep only one bot process running against the data directory. Preserve `data/storage.json` on a persistent server disk. Writes are replaced atomically; corrupt storage stops processing rather than silently erasing runs. Existing runs without a daily-time setting retain their previous 24-hour schedule. Public metadata lookup is best-effort; if no artist is available, only the title is displayed. Simultaneous runs in multiple servers sharing participants are not recommended: a plain DM is associated with the first collecting run for that person.

After updating, stop the old bot with Ctrl+C, run `npm.cmd run register`, then `npm.cmd start`. Registration replaces the old command name in Discord. This update does not alter credentials or publish code to GitHub.

## How a run works

1. The start confirmation shows the selection deadline as a Discord date/time in the viewer's timezone. The bot finds every non-bot member with the configured role and DMs the song-selection prompt.
2. DM replies must contain only an HTTPS/HTTP song link from Spotify, Apple Music, YouTube Music, or Tidal. Each member has one song in the queue; another valid link replaces their title, artist, and listening link while selection is open. Closed selection cannot be changed by DM.
3. If the collection window is longer than 24 hours, non-submitters receive a reminder when 24 hours remain.
4. At the deadline, submitted songs are shuffled. Members who did not submit are omitted.
5. The bot posts the submitter, title, artist, link, and a native Discord poll with options `10` through `1`.
6. Every 24 hours it posts the next scheduled song. The run ends after the final song.

State is stored in `data/storage.json`, so timers survive bot restarts. The scheduler checks due work every 30 seconds.

### Bot messages

- Start confirmation: `Starting Song Selection - Song selection ends {date and time}`.
- Initial DM and invalid-link reply: `Song selection please provide just the link to the song link from tidal, spotify, apple music or youtube music`.
- First or replacement submission: `Song choosen {song title} - {artist name}`.
- Daily announcement: `@Role song of the day is {song title} - {artist name} choosen by @User`, with the listening link on the next line and the existing 10-to-1 poll.
- Run completion (including manual end or skipping the final person): `That's all folks`.

The spelling `choosen` is intentional. If metadata has no artist, the title appears alone without an unknown-artist label. Restart the bot to load these wording changes; slash-command registration is not needed.

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
npm.cmd run install:browser
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

### Apple Music song names

Apple Music links use an Apple-only document-name parser. It reads the HTML `<title>` that supplies the document name in the browser's Accessibility inspector, not `og:title`, descriptions, or an Apple API. The expected format is `Song Title - Song by Artist Name - Apple Music`; the bot displays `Song Title - Artist Name`. English metadata is requested, and invisible direction marks, nonbreaking spaces, and encoded punctuation are handled. Hyphens and "by" within actual names are preserved.

Both song URLs and album URLs containing a selected song (`?i=...`) are supported. A blocked page, album-only title, or unexpected document-name format is not guessed: the link is preserved and displayed as `Song` with no invented artist. Previously queued Apple songs are re-read using the new parser before posting. Existing Discord messages are not edited. Restart the bot after updating; slash-command registration is not needed for metadata changes.

### Spotify song names

Spotify links also use a provider-specific document-name parser. It reads the page's HTML `<title>` (the source of the Accessibility inspector's document name), not `og:title`, descriptions, oEmbed, or the Spotify API. Both `Song Title - song by Artist Name | Spotify` and Spotify's current `Song Title - song and lyrics by Artist Name | Spotify` format become `Song Title - Artist Name` in submission confirmations and polls. Remaster suffixes, hyphens, and "by" within real names are preserved.

Supported links include `open.spotify.com/track/...`, international `/intl-.../track/...` links, and `spotify.link` URLs that redirect to a Spotify track page. International track pages are requested in English for consistent label parsing. Short-link redirects are followed only within `spotify.link` and `open.spotify.com`; JavaScript-only landing pages are not executed. The submitted listening link is kept unchanged.

Blocked requests, non-track pages, or unexpected document titles use `Song` without an invented artist; no fallback to Spotify's old metadata extraction is attempted. Older queued Spotify songs are refreshed before posting and successful results are saved. Already-posted messages are not edited. Apple Music, YouTube Music, and Tidal lookup behavior is unchanged by this Spotify update. Restart with `npm.cmd start` after stopping the existing process; command registration is not needed.

- Users can disable DMs from server members. A private follow-up reports failed invites; these members remain eligible to submit by opening a DM with the bot.
- Metadata is read from each music service's public embed/page metadata. If a service blocks that lookup, the bot still preserves the link and labels unavailable fields as unknown.
- Only one run can be active per server. If the bot was offline when a deadline passed, the overdue action occurs after it reconnects.

### YouTube Music song names

Only `music.youtube.com/watch?v=...` links use the YouTube Music Open Graph parser. It fetches the page HTML and reads the same meta tags visible in the browser inspector:

- `<meta property="og:title" content="Song Title">` supplies the title.
- `<meta property="og:description" content="Artist Name">` supplies the artist.

These fields are used directly after decoding HTML entities and normalizing whitespace. Titles are not split at hyphens or "by", and the artist is not guessed from the uploader, page title, or oEmbed. If the title itself includes an artist name, that text is retained. Both attribute orders and single/double quotation marks are supported.

A missing description displays the title alone; a missing usable title, blocked request, or consent-page redirect falls back to `Song` with no artist. Previously queued YouTube Music songs are re-read before posting and successful metadata is saved. Already-posted Discord messages are not edited. Spotify, Apple Music, Tidal, and short `youtu.be` links retain their existing lookup behavior. Restart the bot to load this change; no command registration is needed.

### Tidal song names

Tidal alone uses a headless Chromium browser because the requested elements are created by JavaScript. It reads:

- `h1[data-test="content-title"]` for the song title.
- Nearby artist links whose `href` matches `/artist/...` for the artist text.

CSS class names and artist IDs are not hardcoded. Multiple credited artists are joined without duplicates; navigation, hidden links, and later recommendation sections are excluded. The lookup does not split hyphens or guess from page titles, descriptions, or other services' links. Previously queued Tidal entries are refreshed before posting. Existing Discord messages are not edited.

Regular `tidal.com/track/ID`, `/browse/track/ID`, and `listen.tidal.com/track/ID` links are opened as `https://tidal.com/track/ID/u`, the public share page containing these elements. `/u` links work directly; `link.tidal.com` redirects are followed only within the allowed Tidal hosts. Discord still receives the user's original listening link. No Tidal account or playback is needed. Each lookup uses a fresh browser, closes it afterward, and runs one at a time. Missing titles use `Song`; missing artists are omitted.

Install the new dependency and browser once on each machine running the bot:

```powershell
npm.cmd install
npm.cmd run install:browser
```

For a Linux server, install the browser and required OS libraries using `npx playwright install --with-deps chromium --only-shell` (OS dependency installation may require administrator access). Run the bot under a non-root service account with Chromium sandbox support; install the browser for that same account or configure a shared `PLAYWRIGHT_BROWSERS_PATH`. Keep Chromium's sandbox enabled. See [Playwright browser setup](https://playwright.dev/docs/browsers).

After updating, restart the bot; command registration is not needed for this Tidal change. The Spotify, Apple Music, YouTube Music, and `youtu.be` implementations remain unchanged.

Dependency note: `npm audit` currently reports four vulnerabilities in the existing Discord/Undici/WebSocket dependency tree (two moderate, two high). These are not in the new Playwright dependency; no unrelated dependency upgrades were applied as part of the Tidal change. Address them before deploying publicly.
