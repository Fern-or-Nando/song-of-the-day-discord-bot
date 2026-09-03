const { PollLayoutType } = require('discord.js');
const { findCollectingRunForUser, getGuild, updateGuild } = require('./storage');
const { nextDaily } = require('./schedule');
const { SONG_SELECTION_PROMPT, RUN_ENDED, songLabel, songChosen, songAnnouncement, runStarted } = require('./messages');
const { APPLE_METADATA_SOURCE, isAppleMusicUrl, fetchAppleMetadata } = require('./apple-music');
const { SPOTIFY_METADATA_SOURCE, isSpotifyUrl, fetchSpotifyMetadata } = require('./spotify');
const { YOUTUBE_MUSIC_METADATA_SOURCE, isYouTubeMusicUrl, fetchYouTubeMusicMetadata } = require('./youtube-music');
const { TIDAL_METADATA_SOURCE, isTidalUrl, fetchTidalMetadata } = require('./tidal');

const VALID_SITES = 'Spotify, Apple Music, YouTube Music, or Tidal';
const DAY = 24 * 60 * 60 * 1000;

function validateSongUrl(input) {
  try {
    const url = new URL(input.trim());
    if (/\s/.test(input.trim()) || url.username || url.password) return null;
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    const host = url.hostname.toLowerCase();
    const valid = host === 'open.spotify.com' || host === 'spotify.link' || host === 'music.apple.com' ||
      host === 'music.youtube.com' || host === 'youtu.be' || host === 'tidal.com' ||
      host === 'listen.tidal.com' || host === 'link.tidal.com';
    return valid ? url.toString() : null;
  } catch { return null; }
}

function decodeHtml(value = '') {
  return value.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#x27;/g, "'");
}

function cleanServiceText(value = '') {
  return value
    .replace(/\s+(?:on|from)\s+(?:Spotify|Apple Music|TIDAL|YouTube Music)\b.*$/i, '')
    .replace(/\s*(?:[|·•]|\s[-–—]\s)\s*(?:Spotify|Apple Music|TIDAL|YouTube Music)\b.*$/i, '')
    .replace(/\s*\((?:Spotify|Apple Music|TIDAL|YouTube Music)\)\s*$/i, '')
    .trim();
}

function splitTitle(raw) {
  const clean = cleanServiceText(raw);
  const appleStyle = clean.match(/^(.+?)\s+by\s+(.+)$/i);
  if (appleStyle) {
    return { title: appleStyle[1].trim(), artist: cleanServiceText(appleStyle[2]) || null };
  }
  const parts = clean.split(/\s+[-–—]\s+/);
  if (parts.length >= 2) return { title: parts[0].trim(), artist: parts.slice(1).join(' - ').trim() };
  return { title: clean || 'Song', artist: null };
}

function cleanMetadata(title, artist) {
  const parsed = splitTitle(title || 'Song');
  let cleanedArtist = cleanServiceText(artist || parsed.artist || '');
  if (/^(Spotify|Apple Music|TIDAL|YouTube Music|Unknown\s*artist)$/i.test(cleanedArtist)) cleanedArtist = '';
  return { title: cleanServiceText(parsed.title) || 'Song', artist: cleanedArtist || null };
}

async function fetchMetadata(url) {
  const parsed = new URL(url);
  try {
    if (isAppleMusicUrl(url)) return await fetchAppleMetadata(url);
    if (isSpotifyUrl(url)) return await fetchSpotifyMetadata(url);
    if (isYouTubeMusicUrl(url)) return await fetchYouTubeMusicMetadata(url);
    if (isTidalUrl(url)) return await fetchTidalMetadata(url);
    let endpoint = null;
    if (parsed.hostname === 'youtu.be') endpoint = `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`;
    if (endpoint) {
      const response = await fetch(endpoint, { signal: AbortSignal.timeout(10_000) });
      if (response.ok) {
        const data = await response.json();
        const result = splitTitle(data.title || '');
        if (data.author_name && !result.artist) result.artist = data.author_name;
        return cleanMetadata(result.title, result.artist);
      }
    }

    const response = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 SOTDDiscordBot/1.0' }, signal: AbortSignal.timeout(10_000) });
    const html = await response.text();
    const title = decodeHtml(html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)/i)?.[1] ||
      html.match(/<title[^>]*>([^<]+)/i)?.[1] || 'Unknown song');
    const description = decodeHtml(html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)/i)?.[1] || '');
    const result = splitTitle(title);
    const artistMatch = description.match(/(?:by|from)\s+([^.,|]+)/i);
    if (!result.artist && artistMatch) result.artist = artistMatch[1].trim();
    return cleanMetadata(result.title, result.artist);
  } catch (error) {
    console.warn(`Could not fetch metadata for ${url}: ${error.message}`);
    return { title: 'Song', artist: null };
  }
}

function providerMetadataSource(url) {
  if (isAppleMusicUrl(url)) return APPLE_METADATA_SOURCE;
  if (isSpotifyUrl(url)) return SPOTIFY_METADATA_SOURCE;
  if (isYouTubeMusicUrl(url)) return YOUTUBE_MUSIC_METADATA_SOURCE;
  if (isTidalUrl(url)) return TIDAL_METADATA_SOURCE;
  return null;
}

async function metadataForDisplay(song) {
  const source = providerMetadataSource(song.url);
  if (!source) return cleanMetadata(song.title, song.artist);
  // Do not split verified provider metadata again: hyphens and "by" may be part
  // of the actual song or artist name. Refresh legacy entries before posting.
  if (song.metadataSource === source) {
    return { title: song.title, artist: song.artist, metadataSource: song.metadataSource };
  }
  return fetchMetadata(song.url);
}

function shuffle(items) {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

// A slower lookup for an earlier DM must not overwrite a newer choice.
const pendingSubmissions = new Map();

function allSongsSubmitted(run) {
  return run.participantIds.length > 0 && run.participantIds.every(id => run.submissions[id]);
}

async function handleDm(message, client = message.client) {
  const found = findCollectingRunForUser(message.author.id);
  if (!found) return;
  const [guildId, guildData] = found;
  if (Date.now() >= new Date(guildData.run.collectionEndsAt).getTime()) {
    await message.reply('The submission window for that Song of the Day run has closed.');
    return;
  }
  const url = validateSongUrl(message.content);
  if (!url) {
    await message.reply(SONG_SELECTION_PROMPT);
    return;
  }
  const key = JSON.stringify([guildId, guildData.run.id, message.author.id]);
  const request = Symbol();
  pendingSubmissions.set(key, request);
  try {
    const fetchedMetadata = await fetchMetadata(url);
    if (pendingSubmissions.get(key) !== request) return;
    const metadata = providerMetadataSource(url) ? fetchedMetadata : cleanMetadata(fetchedMetadata.title, fetchedMetadata.artist);
    let accepted = false;
    updateGuild(guildId, (guild) => {
      if (guild.run?.status === 'collecting' && guild.run.id === guildData.run.id &&
          Date.now() < Date.parse(guild.run.collectionEndsAt)) {
        guild.run.submissions[message.author.id] = { url, ...metadata, submittedAt: new Date().toISOString() };
        accepted = true;
      }
      return guild;
    });
    if (!accepted) {
      await message.reply('The submission window for that Song of the Day run has closed.');
      return;
    }
    // Close synchronously before sending replies so the last submission locks
    // the queue immediately, even if Discord takes time to acknowledge the DM.
    const closing = allSongsSubmitted(getGuild(guildId).run) ? finishCollection(client, guildId) : null;
    await Promise.all([closing, message.reply(songChosen(metadata))]);
  } finally {
    if (pendingSubmissions.get(key) === request) pendingSubmissions.delete(key);
  }
}

const posting = new Set();
async function postCurrent(client, guildId) {
  if (posting.has(guildId)) return false;
  posting.add(guildId);
  try { return await sendCurrent(client, guildId); }
  finally { posting.delete(guildId); }
}

async function sendCurrent(client, guildId) {
  const guildData = getGuild(guildId);
  const run = guildData.run;
  if (!run || run.status !== 'presenting' || run.currentIndex >= run.schedule.length) return false;
  const guild = await client.guilds.fetch(guildId);
  const channel = await guild.channels.fetch(run.channelId);
  const item = run.schedule[run.currentIndex];
  const metadata = await metadataForDisplay(item);
  const fresh = getGuild(guildId).run;
  if (fresh?.status !== 'presenting' || fresh.id !== run.id || fresh.currentIndex !== run.currentIndex) return false;
  if (metadata.metadataSource && metadata.metadataSource === providerMetadataSource(item.url)) {
    updateGuild(guildId, guild => {
      Object.assign(guild.run.schedule[run.currentIndex], metadata);
      return guild;
    });
  }
  const question = songLabel(metadata).slice(0, 300);
  const roleId = run.roleId || guildData.roleId;
  const message = await channel.send({
    content: songAnnouncement(roleId, item.userId, metadata, item.url),
    allowedMentions: { roles: [roleId], users: [item.userId] },
    poll: {
      question: { text: question },
      answers: Array.from({ length: 10 }, (_, i) => ({ text: String(10 - i) })),
      allowMultiselect: false,
      duration: 24,
      layoutType: PollLayoutType.Default
    }
  });
  updateGuild(guildId, (guild) => {
    if (guild.run?.status === 'presenting' && guild.run.id === run.id && guild.run.currentIndex === run.currentIndex) {
      guild.run.messageId = message.id;
      guild.run.nextPostAt = run.dailyTime ? nextDaily(run.dailyTime, run.timezone) : new Date(Date.now() + DAY).toISOString();
    }
    return guild;
  });
  return true;
}

const announcing = new Set();
async function announceRunStarted(client, guildId) {
  if (announcing.has(guildId)) return false;
  announcing.add(guildId);
  try {
    const data = getGuild(guildId);
    const run = data.run;
    if (!run?.startAnnouncementPending || !['waiting', 'presenting'].includes(run.status)) return true;
    const channel = await client.channels.fetch(run.channelId);
    const fresh = getGuild(guildId).run;
    if (fresh?.id !== run.id || !['waiting', 'presenting'].includes(fresh.status)) return false;
    const roleId = run.roleId || data.roleId;
    await channel.send({
      content: runStarted(roleId, run.firstPostAt, run.allSubmittedAtClose),
      allowedMentions: { roles: [roleId] }
    });
    updateGuild(guildId, guild => {
      if (guild.run?.id === run.id) guild.run.startAnnouncementPending = false;
      return guild;
    });
    return true;
  } finally {
    announcing.delete(guildId);
  }
}

async function finishCollection(client, guildId) {
  const data = getGuild(guildId);
  if (data.run?.status !== 'collecting') return null;
  const schedule = shuffle(Object.entries(data.run.submissions).map(([userId, song]) => ({ userId, ...song })));
  const excludedCount = data.run.participantIds.filter((userId) => !data.run.submissions[userId]).length;
  const closedAt = new Date().toISOString();
  const firstPostAt = schedule.length ? (data.run.dailyTime ? nextDaily(data.run.dailyTime, data.run.timezone) : closedAt) : null;
  updateGuild(guildId, (guild) => {
    guild.run.status = schedule.length ? (guild.run.dailyTime ? 'waiting' : 'presenting') : 'ended';
    guild.run.schedule = schedule;
    guild.run.currentIndex = 0;
    guild.run.nextPostAt = guild.run.dailyTime ? firstPostAt : null;
    guild.run.firstPostAt = firstPostAt;
    guild.run.selectionClosedAt = closedAt;
    guild.run.allSubmittedAtClose = allSongsSubmitted(guild.run);
    guild.run.startAnnouncementPending = schedule.length > 0;
    guild.run.endedAt = schedule.length ? null : closedAt;
    return guild;
  });
  if (schedule.length) await announceRunStarted(client, guildId);
  if (schedule.length && !data.run.dailyTime) await postCurrent(client, guildId);
  if (!schedule.length) {
    const channel = await client.channels.fetch(data.run.channelId).catch(() => null);
    if (channel?.isTextBased()) await channel.send(RUN_ENDED);
  }
  return { submittedCount: schedule.length, excludedCount };
}

async function schedulerTick(client) {
  const guildIds = client.guilds.cache.map((guild) => guild.id);
  for (const guildId of guildIds) {
    let data = getGuild(guildId);
    let run = data.run;
    if (!run || run.status === 'ended') continue;
    if (run.startAnnouncementPending) {
      if (!await announceRunStarted(client, guildId)) continue;
      data = getGuild(guildId);
      run = data.run;
      if (!run || run.status === 'ended') continue;
    }
    if (run.status === 'collecting') {
      const deadline = new Date(run.collectionEndsAt).getTime();
      // Recover completed collection after a restart, including older runs.
      if (allSongsSubmitted(run) || Date.now() >= deadline) {
        await finishCollection(client, guildId);
        continue;
      }
      const reminder = deadline - DAY;
      if (!run.reminderSent && Date.now() >= reminder && Date.now() < deadline) {
        const missing = run.participantIds.filter((id) => !run.submissions[id]);
        for (const id of missing) {
          const current = getGuild(guildId).run;
          if (current?.id !== run.id || current.status !== 'collecting') break;
          if (current.submissions[id]) continue;
          const user = await client.users.fetch(id).catch(() => null);
          const latest = getGuild(guildId).run;
          if (latest?.id !== run.id || latest.status !== 'collecting' || Date.now() >= deadline) break;
          if (latest.submissions[id]) continue;
          if (user) await user.send(`Song selection ends <t:${Math.floor(deadline / 1000)}:R>. This is your 24-hour reminder to submit a song link.`).catch(() => null);
        }
        updateGuild(guildId, (guild) => { if (guild.run?.id === run.id) guild.run.reminderSent = true; return guild; });
      }
      if (Date.now() >= deadline) await finishCollection(client, guildId);
    } else if (run.status === 'waiting' && Date.now() >= Date.parse(run.nextPostAt)) {
      updateGuild(guildId, guild => { guild.run.status = 'presenting'; guild.run.nextPostAt = null; return guild; });
      await postCurrent(client, guildId);
    } else if (run.status === 'presenting' && !run.nextPostAt) {
      await postCurrent(client, guildId);
    } else if (run.status === 'presenting' && Date.now() >= new Date(run.nextPostAt).getTime()) {
      const nextIndex = run.currentIndex + 1;
      if (nextIndex >= run.schedule.length) {
        updateGuild(guildId, (guild) => { guild.run.status = 'ended'; guild.run.endedAt = new Date().toISOString(); return guild; });
        const channel = await client.channels.fetch(run.channelId).catch(() => null);
        if (channel?.isTextBased()) await channel.send(RUN_ENDED);
      } else {
        updateGuild(guildId, (guild) => { guild.run.currentIndex = nextIndex; guild.run.nextPostAt = null; return guild; });
        await postCurrent(client, guildId);
      }
    }
  }
}

module.exports = { DAY, VALID_SITES, cleanMetadata, fetchMetadata, metadataForDisplay, finishCollection, handleDm, postCurrent, schedulerTick, validateSongUrl };
