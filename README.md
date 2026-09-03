# Song of the Day Discord Bot

A run-based Discord bot that collects one song by DM from every member of a selected role, randomizes the submitted songs, and posts one song with a 10-to-1 poll at the selected daily time.

## Commands

- `/assign-sotd-role role:@Role` — chooses the participant/notification role.
- `/assign-sotd-channel channel:#Channel` — chooses the text channel or active thread where songs and polls are posted.
- `/start-sotd-run` — asks for the song-selection end date/time and the daily announcement time.
- `/skip-song-selection` — closes submissions immediately, excludes non-submitters, and schedules submitted songs for the next daily posting time.
- `/skip-person` — skips the active song and immediately posts the next scheduled song.
- `/end-run` — immediately ends the active run.

All commands require the **Manage Server** permission. A posting destination must be assigned before starting a run.

## Revised run setup

`/start-sotd-run` uses two short setup steps:

1. Song-selection deadline: enter the **month** (`1–12`) and **day** (`1–31`) in separate number inputs, then choose the **hour** (`1–12`) and **AM/PM** from dropdowns.
2. Click **Choose announcement time**, then choose the daily announcement **hour** (`1–12`) and **AM/PM** from dropdowns. Submitting this second form starts selection and sends invitations.

There is no year or minute input. Both times are on the hour: **12 AM is midnight**, **12 PM is noon**. The deadline uses the next future occurrence of the chosen month/day/hour. A date already passed rolls into the following year; February 29 waits for the next leap year. Invalid dates such as April 31 are rejected. The resolved full date/time is shown before the announcement step, so a date never silently moves to another year while you finish setup. Draft setups expire after 15 minutes or a bot restart; reopen the command if necessary. Cancel does not create a run or send invitations.

Both times use Central time (`America/Chicago`) by default, shown alongside the dropdowns. To change it without adding another question, set `SOTD_TIMEZONE` to an IANA timezone in your private `.env`, then restart. The timezone is saved with each run, so changing the setting does not alter existing runs. A deadline at a nonexistent daylight-saving hour asks you to choose another hour; a repeated hour uses its next future occurrence.

Discord limits a modal to five components and does not allow opening another modal directly from a modal submission, so the two forms are connected with a button. See [Discord's interaction limits](https://docs.discord.com/developers/interactions/receiving-and-responding#interaction-response-object-modal).

As soon as the final participant's song is saved, selection closes automatically and the submitted songs are shuffled. The bot mentions the role in the configured channel/thread: `Everyone has submitted a song. Song selection has ended. The Song of the Day run has started! The first song will be announced {date and time}.` The first song waits for the next occurrence of the selected daily time, even if that is before the original selection deadline. No song or poll is posted early. Replacements are no longer accepted once everyone has submitted.

`/skip-song-selection` replaces `/end-song-selection`. It closes collection early and excludes non-submitters. The first song waits for the next chosen daily posting time rather than posting immediately. `/skip-person` still posts the next song immediately; subsequent posts return to the daily schedule.

The roster includes all non-bot role members, even members whose DMs fail. Failed deliveries are counted in a separate private follow-up to the manager. These members can open a DM with the bot to submit before the deadline. Automatic early closure requires submissions from the full roster. It happens directly on the last submission; the scheduler also recovers completed collection after a restart and retries a failed run-start announcement without reshuffling the queue.

Daily timing follows the selected timezone: daylight-saving changes can produce 23- or 25-hour intervals, while Discord polls last 24 hours. A skipped song's already-posted poll remains available until its normal expiry. Ending a run cancels future posts but does not delete existing polls. If the bot restarts late, it posts the due song once and resumes the daily schedule without flooding missed days.

Keep only one bot process running against the data directory. Preserve `data/storage.json` on a persistent server disk. Writes are replaced atomically; corrupt storage stops processing rather than silently erasing runs. Existing runs without a daily-time setting retain their previous 24-hour schedule. Public metadata lookup is best-effort; if no artist is available, only the title is displayed. Simultaneous runs in multiple servers sharing participants are not recommended: a plain DM is associated with the first collecting run for that person.

After updating, stop the old bot with Ctrl+C, then run `npm.cmd start`. No command re-registration is needed for the dropdown setup. Reopen any start form that was already open before the restart. Existing runs keep their saved schedules; automatic closure when everyone submits is unchanged. This update does not alter your private `.env` or publish code to GitHub.

## How a run works

1. The start confirmation shows the selection deadline as a Discord date/time in the viewer's timezone. The bot finds every non-bot member with the configured role and DMs the song-selection prompt.
2. DM replies must contain only an HTTPS/HTTP song link from Spotify, Apple Music, YouTube Music, or Tidal. Each member has one song in the queue; another valid link replaces their title, artist, and listening link while selection is open. Closed selection cannot be changed by DM.
3. If the collection window is longer than 24 hours, non-submitters receive a reminder when 24 hours remain.
4. When everyone submits, at the deadline, or when selection is skipped manually, submitted songs are shuffled. Non-submitters are omitted. The bot announces the first posting date/time; an empty run ends instead.
5. The bot posts the submitter, title, artist, link, and a native Discord poll with options `10` through `1`.
6. At the selected daily time it posts the next scheduled song. The run ends at the next scheduled time after the final song.

State is stored in `data/storage.json`, so timers survive bot restarts. The scheduler checks due work every 30 seconds.
