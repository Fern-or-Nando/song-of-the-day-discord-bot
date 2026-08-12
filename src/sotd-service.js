const { PollLayoutType } = require('discord.js');
const { findCollectingRunForUser, getGuild, updateGuild } = require('./storage');

const VALID_SITES = 'Spotify, Apple Music, YouTube Music, or Tidal';
const DAY = 24 * 60 * 60 * 1000;

function validateSongUrl(input) {
  try {
    const url = new URL(input.trim());
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

function splitTitle(raw) {
  const clean = raw
    .replace(/\s*(?:[|·•]|\s[-–—]\s)\s*(?:Spotify|Apple Music|TIDAL|YouTube Music)(?:\s.*)?$/i, '')
    .replace(/\s+(?:on|from)\s+(?:Spotify|Apple Music|TIDAL|YouTube Music)\s*$/i, '')
    .trim();
  const parts = clean.split(/\s+[-–—]\s+/);
  if (parts.length >= 2) return { title: parts[0].trim(), artist: parts.slice(1).join(' - ').trim() };
  return { title: clean || 'Song', artist: null };
}

async function fetchMetadata(url) {
  const parsed = new URL(url);
  try {
    let endpoint = null;
    if (parsed.hostname === 'open.spotify.com') endpoint = `https://open.spotify.com/oembed?url=${encodeURIComponent(url)}`;
    if (parsed.hostname === 'music.youtube.com' || parsed.hostname === 'youtu.be') endpoint = `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`;
    if (endpoint) {
      const response = await fetch(endpoint, { signal: AbortSignal.timeout(10_000) });
      if (response.ok) {
        const data = await response.json();
        const result = splitTitle(data.title || '');
        if (data.author_name && !result.artist) result.artist = data.author_name;
        if (result.artist || parsed.hostname !== 'open.spotify.com') return result;
        const page = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 SOTDDiscordBot/1.0' }, signal: AbortSignal.timeout(10_000) });
        const html = await page.text();
        const description = decodeHtml(html.match(/<meta[^>]+(?:property|name)=["'](?:og:description|description)["'][^>]+content=["']([^"']+)/i)?.[1] || '');
        const pieces = description.split(/\s*[·•]\s*/).filter(Boolean);
        if (pieces.length >= 2) result.artist = pieces[1].trim();
        return result;
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
    return result;
  } catch (error) {
    console.warn(`Could not fetch metadata for ${url}: ${error.message}`);
    return { title: 'Song', artist: null };
  }
}

function shuffle(items) {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

async function handleDm(message) {
  const found = findCollectingRunForUser(message.author.id);
  if (!found) return;
  const [guildId, guildData] = found;
  if (Date.now() >= new Date(guildData.run.collectionEndsAt).getTime()) {
    await message.reply('The submission window for that Song of the Day run has closed.');
    return;
  }
  if (guildData.run.submissions[message.author.id]) {
    await message.reply('You have already submitted a song for this run.');
    return;
  }
  const url = validateSongUrl(message.content);
  if (!url) {
    await message.reply(`Please reply with only a link to your song. Valid sites: ${VALID_SITES}.`);
    return;
  }
  const metadata = await fetchMetadata(url);
  updateGuild(guildId, (guild) => {
    if (guild.run?.status === 'collecting') {
      guild.run.submissions[message.author.id] = { url, ...metadata, submittedAt: new Date().toISOString() };
    }
    return guild;
  });
  const artistText = metadata.artist ? ` by **${metadata.artist}**` : '';
  await message.reply(`Thanks! I recorded **${metadata.title}**${artistText}.`);
}

async function postCurrent(client, guildId) {
  const guildData = getGuild(guildId);
  const run = guildData.run;
  if (!run || run.status !== 'presenting' || run.currentIndex >= run.schedule.length) return false;
  const guild = await client.guilds.fetch(guildId);
  const channel = await guild.channels.fetch(run.channelId);
  const item = run.schedule[run.currentIndex];
  const question = (item.artist ? `${item.title} — ${item.artist}` : item.title).slice(0, 300);
  const songDetails = item.artist ? `**${item.title}** by **${item.artist}**` : `**${item.title}**`;
  await channel.send({
    content: `<@&${guildData.roleId}> It is <@${item.userId}>'s Song of the Day!\n${songDetails}\n${item.url}`,
    allowedMentions: { roles: [guildData.roleId], users: [item.userId] },
    poll: {
      question: { text: question },
      answers: Array.from({ length: 10 }, (_, i) => ({ text: String(10 - i) })),
      allowMultiselect: false,
      duration: 24,
      layoutType: PollLayoutType.Default
    }
  });
  updateGuild(guildId, (guild) => {
    if (guild.run?.status === 'presenting') guild.run.nextPostAt = new Date(Date.now() + DAY).toISOString();
    return guild;
  });
  return true;
}

async function finishCollection(client, guildId) {
  const data = getGuild(guildId);
  if (data.run?.status !== 'collecting') return null;
  const schedule = shuffle(Object.entries(data.run.submissions).map(([userId, song]) => ({ userId, ...song })));
  const excludedCount = data.run.participantIds.filter((userId) => !data.run.submissions[userId]).length;
  updateGuild(guildId, (guild) => {
    guild.run.status = schedule.length ? 'presenting' : 'ended';
    guild.run.schedule = schedule;
    guild.run.currentIndex = 0;
    guild.run.nextPostAt = null;
    guild.run.endedAt = schedule.length ? null : new Date().toISOString();
    return guild;
  });
  if (schedule.length) await postCurrent(client, guildId);
  else {
    const channel = await client.channels.fetch(data.run.channelId).catch(() => null);
    if (channel?.isTextBased()) await channel.send('The Song of the Day run ended because no songs were submitted.');
  }
  return { submittedCount: schedule.length, excludedCount };
}

async function schedulerTick(client) {
  const guildIds = client.guilds.cache.map((guild) => guild.id);
  for (const guildId of guildIds) {
    const data = getGuild(guildId);
    const run = data.run;
    if (!run || run.status === 'ended') continue;
    if (run.status === 'collecting') {
      const deadline = new Date(run.collectionEndsAt).getTime();
      const reminder = deadline - DAY;
      if (!run.reminderSent && Date.now() >= reminder && Date.now() < deadline && deadline - new Date(run.startedAt).getTime() > DAY) {
        const missing = run.participantIds.filter((id) => !run.submissions[id]);
        for (const id of missing) {
          const user = await client.users.fetch(id).catch(() => null);
          if (user) await user.send('You have 24 hours left to send your Song of the Day link.').catch(() => null);
        }
        updateGuild(guildId, (guild) => { guild.run.reminderSent = true; return guild; });
      }
      if (Date.now() >= deadline) await finishCollection(client, guildId);
    } else if (run.status === 'presenting' && Date.now() >= new Date(run.nextPostAt).getTime()) {
      const nextIndex = run.currentIndex + 1;
      if (nextIndex >= run.schedule.length) {
        updateGuild(guildId, (guild) => { guild.run.status = 'ended'; guild.run.endedAt = new Date().toISOString(); return guild; });
        const channel = await client.channels.fetch(run.channelId).catch(() => null);
        if (channel?.isTextBased()) await channel.send('The Song of the Day run is complete. Thanks, everyone!');
      } else {
        updateGuild(guildId, (guild) => { guild.run.currentIndex = nextIndex; guild.run.nextPostAt = null; return guild; });
        await postCurrent(client, guildId);
      }
    }
  }
}

module.exports = { DAY, VALID_SITES, finishCollection, handleDm, postCurrent, schedulerTick, validateSongUrl };
