const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { nextDaily, selectionDeadline } = require('../src/schedule');
// Isolated storage: never touch the real roster or credentials.
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'sotd-test-')));
const { getGuild, updateGuild } = require('../src/storage');
const { finishCollection, schedulerTick, handleDm } = require('../src/sotd-service');
const { buildCommands } = require('../src/commands');
const { SPOTIFY_METADATA_SOURCE } = require('../src/spotify');
const { YOUTUBE_MUSIC_METADATA_SOURCE } = require('../src/youtube-music');
const { TIDAL_METADATA_SOURCE } = require('../src/tidal');
const { chromium } = require('playwright');
const { fakeTidalBrowser } = require('./helpers/tidal-browser');
const sent = [];
const channel = { send: async payload => { sent.push(payload); return { id: 'message' }; }, isTextBased: () => true };
const client = {
  guilds: { cache: new Map([['guild', { id: 'guild' }]]), fetch: async () => ({ channels: { fetch: async () => channel } }) },
  channels: { fetch: async () => channel }, users: { fetch: async () => ({ send: async payload => sent.push(payload) }) }
};
client.guilds.cache.map = fn => [...client.guilds.cache.values()].map(fn);
function setup(submissions = { a: { title: 'Song', artist: 'Artist', url: 'https://open.spotify.com/track/abc', metadataSource: SPOTIFY_METADATA_SOURCE } }) {
  sent.length = 0;
  updateGuild('guild', () => ({ roleId: 'role', run: {
    id: 'run', status: 'collecting', roleId: 'role', channelId: 'channel',
    participantIds: ['a', 'b'], submissions, dailyTime: '18:00', timezone: 'America/Chicago',
    startedAt: new Date().toISOString(), collectionEndsAt: new Date(Date.now() + 3600000).toISOString(), reminderSent: true
  } }));
}
test('date/time deadlines accept local Central time or an explicit offset, not hours', () => {
  const now = Date.parse('2026-09-03T12:00:00Z');
  assert.equal(selectionDeadline('2026-09-05 18:00', now).toISOString(), '2026-09-05T23:00:00.000Z');
  assert.equal(selectionDeadline('2026-09-05T18:00-05:00', now).toISOString(), '2026-09-05T23:00:00.000Z');
  assert.equal(selectionDeadline('2026-09-05T18:00', now).toISOString(), '2026-09-05T23:00:00.000Z');
  assert.throws(() => selectionDeadline('48', now));
  assert.throws(() => selectionDeadline('0', now));
});
test('daily time follows daylight saving timezone', () => {
  assert.equal(nextDaily('18:00', 'America/Chicago', Date.parse('2026-09-03T12:00Z')), '2026-09-03T23:00:00.000Z');
  assert.equal(nextDaily('18:00', 'America/Chicago', Date.parse('2026-12-03T12:00Z')), '2026-12-04T00:00:00.000Z');
  assert.throws(() => nextDaily('25:00', 'America/Chicago'));
});
test('close selection excludes non-submitters, waits, posts poll, then ends', async () => {
  setup();
  assert.deepEqual(await finishCollection(client, 'guild'), { submittedCount: 1, excludedCount: 1 });
  assert.equal(getGuild('guild').run.status, 'waiting');
  assert.equal(sent.length, 1);
  assert.match(sent[0].content, /run has started! The first song will be announced <t:\d+:F>/);
  sent.length = 0;
  updateGuild('guild', guild => { guild.run.nextPostAt = new Date(0).toISOString(); return guild; });
  await schedulerTick(client);
  assert.deepEqual(sent[0].poll.answers.map(a => a.text), ['10','9','8','7','6','5','4','3','2','1']);
  assert.equal(sent[0].poll.question.text, 'Song - Artist');
  assert.equal(sent[0].content, '<@&role> song of the day is Song - Artist choosen by <@a>\nhttps://open.spotify.com/track/abc');
  assert.deepEqual(sent[0].allowedMentions, { roles: ['role'], users: ['a'] });
  await schedulerTick(client);
  assert.equal(sent.length, 1);
  updateGuild('guild', guild => { guild.run.nextPostAt = new Date(0).toISOString(); return guild; });
  await schedulerTick(client);
  assert.equal(getGuild('guild').run.status, 'ended');
  assert.equal(sent[1], "That's all folks");
  await schedulerTick(client);
  assert.equal(sent.length, 2);
});
test('no submissions ends run; everyone submitted notice only once', async () => {
  setup({});
  await finishCollection(client, 'guild');
  assert.equal(getGuild('guild').run.status, 'ended');
  assert.deepEqual(sent, ["That's all folks"]);
  setup({ a: {}, b: {} });
  await schedulerTick(client);
  await schedulerTick(client);
  assert.equal(sent.length, 1);
  assert.match(sent[0].content, /Everyone has submitted/);
  assert.equal(getGuild('guild').run.status, 'waiting');
  assert.equal(getGuild('guild').run.schedule.length, 2);
  assert.equal(getGuild('guild').run.startAnnouncementPending, false);
});
test('new slash command serializes', () => {
  assert.ok(buildCommands().some(command => command.name === 'skip-song-selection'));
});

test('24-hour reminders target only non-submitters and do not repeat', async () => {
  setup();
  updateGuild('guild', guild => { guild.run.reminderSent = false; return guild; });
  await schedulerTick(client);
  await schedulerTick(client);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /24-hour reminder/);
});

test('failed send retries same song without advancing queue', async () => {
  setup();
  await finishCollection(client, 'guild');
  sent.length = 0;
  updateGuild('guild', guild => { guild.run.nextPostAt = new Date(0).toISOString(); return guild; });
  const original = channel.send;
  channel.send = async () => { throw new Error('temporary outage'); };
  await assert.rejects(schedulerTick(client), /temporary outage/);
  assert.equal(getGuild('guild').run.currentIndex, 0);
  channel.send = original;
  await schedulerTick(client);
  assert.equal(sent.length, 1);
  assert.equal(getGuild('guild').run.currentIndex, 0);
});

test('Apple document-name fields survive DM storage, queueing, and the poll', async t => {
  setup({});
  let requests = 0;
  t.mock.method(global, 'fetch', async () => {
    requests += 1;
    return new Response('<title>Stand by Me - Live - Song by Band - One - Apple&nbsp;Music</title>');
  });
  const replies = [];
  await handleDm({ author: { id: 'a' }, content: 'https://music.apple.com/us/song/123', reply: async message => replies.push(message) });
  assert.equal(getGuild('guild').run.submissions.a.title, 'Stand by Me - Live');
  assert.equal(getGuild('guild').run.submissions.a.artist, 'Band - One');
  assert.equal(replies[0], 'Song choosen Stand by Me - Live - Band - One');
  assert.doesNotMatch(replies[0], /Apple|Song by/);
  await finishCollection(client, 'guild');
  sent.length = 0;
  updateGuild('guild', guild => { guild.run.nextPostAt = new Date(0).toISOString(); return guild; });
  await schedulerTick(client);
  assert.equal(sent[0].poll.question.text, 'Stand by Me - Live - Band - One');
  assert.equal(requests, 1);
});

test('old queued Apple metadata is re-read from the document name before posting', async t => {
  setup({ a: { url: 'https://music.apple.com/us/song/123', title: 'Wrong on Apple Music', artist: 'Song by Wrong' } });
  t.mock.method(global, 'fetch', async () => new Response('<title>Dreams - Song by Fleetwood Mac - Apple Music</title>'));
  await finishCollection(client, 'guild');
  sent.length = 0;
  updateGuild('guild', guild => { guild.run.nextPostAt = new Date(0).toISOString(); return guild; });
  await schedulerTick(client);
  assert.equal(sent[0].poll.question.text, 'Dreams - Fleetwood Mac');
  assert.equal(getGuild('guild').run.schedule[0].artist, 'Fleetwood Mac');
});

test('Spotify document-name fields survive DM storage, queueing, and the poll', async t => {
  setup({});
  let requests = 0;
  t.mock.method(global, 'fetch', async () => {
    requests += 1;
    return new Response('<title>Stand by Me - Live - song and lyrics by Band - One | Spotify</title>');
  });
  const replies = [];
  const url = 'https://open.spotify.com/track/abc?si=share';
  await handleDm({ author: { id: 'a' }, content: url, reply: async message => replies.push(message) });
  assert.equal(getGuild('guild').run.submissions.a.title, 'Stand by Me - Live');
  assert.equal(getGuild('guild').run.submissions.a.artist, 'Band - One');
  assert.equal(getGuild('guild').run.submissions.a.metadataSource, SPOTIFY_METADATA_SOURCE);
  assert.equal(replies[0], 'Song choosen Stand by Me - Live - Band - One');
  assert.doesNotMatch(replies[0], /Spotify|song and lyrics by/);
  await finishCollection(client, 'guild');
  sent.length = 0;
  updateGuild('guild', guild => { guild.run.nextPostAt = new Date(0).toISOString(); return guild; });
  await schedulerTick(client);
  assert.equal(sent[0].poll.question.text, 'Stand by Me - Live - Band - One');
  assert.ok(sent[0].content.includes(url));
  assert.equal(requests, 1);
});

test('old queued Spotify metadata is refreshed before posting and cached', async t => {
  setup({ a: { url: 'https://spotify.link/example', title: 'Wrong | Spotify', artist: 'song by Wrong' } });
  let requests = 0;
  t.mock.method(global, 'fetch', async request => {
    requests += 1;
    return request.startsWith('https://spotify.link/')
      ? new Response(null, { status: 302, headers: { location: 'https://open.spotify.com/track/abc' } })
      : new Response('<title>Dreams - 2004 Remaster - song by Fleetwood Mac | Spotify</title>');
  });
  await finishCollection(client, 'guild');
  sent.length = 0;
  updateGuild('guild', guild => { guild.run.nextPostAt = new Date(0).toISOString(); return guild; });
  await schedulerTick(client);
  assert.equal(sent[0].poll.question.text, 'Dreams - 2004 Remaster - Fleetwood Mac');
  const song = getGuild('guild').run.schedule[0];
  assert.equal(song.artist, 'Fleetwood Mac');
  assert.equal(song.metadataSource, SPOTIFY_METADATA_SOURCE);
  assert.equal(song.url, 'https://spotify.link/example');
  assert.equal(requests, 2);
});

test('YouTube Music OG title and artist survive DM, storage, queue and poll unchanged', async t => {
  setup({});
  let requests = 0;
  t.mock.method(global, 'fetch', async () => {
    requests += 1;
    return new Response('<meta property="og:title" content="Stand by Me - Live"><meta content="Band - One" property="og:description">');
  });
  const replies = [];
  const url = 'https://music.youtube.com/watch?v=abc&si=share';
  await handleDm({ author: { id: 'a' }, content: url, reply: async message => replies.push(message) });
  const song = getGuild('guild').run.submissions.a;
  assert.equal(song.title, 'Stand by Me - Live');
  assert.equal(song.artist, 'Band - One');
  assert.equal(song.metadataSource, YOUTUBE_MUSIC_METADATA_SOURCE);
  assert.equal(replies[0], 'Song choosen Stand by Me - Live - Band - One');
  await finishCollection(client, 'guild');
  sent.length = 0;
  updateGuild('guild', guild => { guild.run.nextPostAt = new Date(0).toISOString(); return guild; });
  await schedulerTick(client);
  assert.equal(sent[0].poll.question.text, 'Stand by Me - Live - Band - One');
  assert.ok(sent[0].content.includes(url));
  assert.equal(requests, 1);
});

test('old queued YouTube Music entries are re-read from OG fields and cached', async t => {
  setup({ a: { url: 'https://music.youtube.com/watch?v=abc', title: 'Wrong', artist: 'Uploader' } });
  t.mock.method(global, 'fetch', async () => new Response('<meta content="Dreams" property="og:title"><meta property="og:description" content="Fleetwood Mac">'));
  await finishCollection(client, 'guild');
  sent.length = 0;
  updateGuild('guild', guild => { guild.run.nextPostAt = new Date(0).toISOString(); return guild; });
  await schedulerTick(client);
  assert.equal(sent[0].poll.question.text, 'Dreams - Fleetwood Mac');
  const song = getGuild('guild').run.schedule[0];
  assert.equal(song.artist, 'Fleetwood Mac');
  assert.equal(song.metadataSource, YOUTUBE_MUSIC_METADATA_SOURCE);
});

test('Tidal element text survives DM, queue and poll while original link is preserved', async t => {
  setup({});
  const { browserType, calls } = fakeTidalBrowser({ title: 'Stand by Me - Live', artist: 'Band - One' });
  t.mock.method(chromium, 'launch', browserType.launch);
  const replies = [];
  const url = 'https://listen.tidal.com/track/329221161';
  await handleDm({ author: { id: 'a' }, content: url, reply: async message => replies.push(message) });
  const song = getGuild('guild').run.submissions.a;
  assert.equal(song.title, 'Stand by Me - Live');
  assert.equal(song.artist, 'Band - One');
  assert.equal(song.metadataSource, TIDAL_METADATA_SOURCE);
  assert.equal(replies[0], 'Song choosen Stand by Me - Live - Band - One');
  await finishCollection(client, 'guild');
  sent.length = 0;
  updateGuild('guild', guild => { guild.run.nextPostAt = new Date(0).toISOString(); return guild; });
  await schedulerTick(client);
  assert.equal(sent[0].poll.question.text, 'Stand by Me - Live - Band - One');
  assert.ok(sent[0].content.includes(url));
  assert.equal(calls.launches, 1);
});

test('old queued Tidal metadata is refreshed from the rendered elements and cached', async t => {
  setup({ a: { url: 'https://tidal.com/track/329221161/u', title: 'Wrong on Tidal', artist: 'Wrong' } });
  t.mock.method(chromium, 'launch', fakeTidalBrowser({ title: 'Thinking About You', artist: 'Faye Webster' }).browserType.launch);
  await finishCollection(client, 'guild');
  sent.length = 0;
  updateGuild('guild', guild => { guild.run.nextPostAt = new Date(0).toISOString(); return guild; });
  await schedulerTick(client);
  assert.equal(sent[0].poll.question.text, 'Thinking About You - Faye Webster');
  assert.equal(getGuild('guild').run.schedule[0].metadataSource, TIDAL_METADATA_SOURCE);
});

test('a new DM replaces the song, artist and link and queues only the latest choice', async t => {
  setup({});
  t.mock.method(global, 'fetch', async url => new Response(url.includes('spotify')
    ? '<title>First Song - song by First Artist | Spotify</title>'
    : '<title>New Song - Song by New Artist - Apple Music</title>'));
  const replies = [];
  const dm = content => handleDm({ author: { id: 'a' }, content, reply: async message => replies.push(message) });
  await dm('https://open.spotify.com/track/abc');
  const newUrl = 'https://music.apple.com/us/song/123';
  await dm(newUrl);
  assert.deepEqual(replies, ['Song choosen First Song - First Artist', 'Song choosen New Song - New Artist']);
  const submissions = getGuild('guild').run.submissions;
  assert.deepEqual(Object.keys(submissions), ['a']);
  assert.equal(submissions.a.title, 'New Song');
  assert.equal(submissions.a.artist, 'New Artist');
  assert.equal(submissions.a.url, newUrl);
  await finishCollection(client, 'guild');
  sent.length = 0;
  assert.equal(getGuild('guild').run.schedule.length, 1);
  updateGuild('guild', guild => { guild.run.nextPostAt = new Date(0).toISOString(); return guild; });
  await schedulerTick(client);
  assert.equal(sent[0].content, `<@&role> song of the day is New Song - New Artist choosen by <@a>\n${newUrl}`);
  assert.equal(sent[0].poll.question.text, 'New Song - New Artist');
});

test('invalid DMs use the selection prompt and never erase an existing choice', async t => {
  setup();
  const previous = getGuild('guild').run.submissions.a;
  const fetchMock = t.mock.method(global, 'fetch', async () => { throw new Error('Invalid input should not fetch metadata'); });
  const replies = [];
  const invalidInputs = ['hello', 'https://example.com/song', 'my song https://open.spotify.com/track/abc',
    'https://open.spotify.com/track/abc https://open.spotify.com/track/def'];
  for (const id of ['a', 'b']) {
    for (const content of invalidInputs) {
      await handleDm({ author: { id }, content, reply: async message => replies.push(message) });
    }
  }
  assert.deepEqual(replies, Array(8).fill('Song selection please provide just the link to the song link from tidal, spotify, apple music or youtube music'));
  assert.deepEqual(getGuild('guild').run.submissions, { a: previous });
  assert.equal(fetchMock.mock.callCount(), 0);
});

test('a slower earlier DM cannot overwrite a later song choice', async t => {
  setup();
  let resolveOlder;
  t.mock.method(global, 'fetch', url => url.endsWith('/older')
    ? new Promise(resolve => { resolveOlder = resolve; })
    : Promise.resolve(new Response('<title>Newest Song - song by New Artist | Spotify</title>')));
  const replies = [];
  const dm = content => handleDm({ author: { id: 'a' }, content, reply: async message => replies.push(message) });
  const older = dm('https://open.spotify.com/track/older');
  try {
    await dm('https://open.spotify.com/track/newest');
  } finally {
    resolveOlder(new Response('<title>Older Song - song by Old Artist | Spotify</title>'));
    await older;
  }
  assert.equal(getGuild('guild').run.submissions.a.url, 'https://open.spotify.com/track/newest');
  assert.deepEqual(replies, ['Song choosen Newest Song - New Artist']);
});

test('expired selection rejects replacements without fetching metadata', async t => {
  setup();
  const previous = getGuild('guild').run.submissions.a;
  updateGuild('guild', guild => { guild.run.collectionEndsAt = new Date(0).toISOString(); return guild; });
  const fetchMock = t.mock.method(global, 'fetch', async () => { throw new Error('Closed selection should not fetch metadata'); });
  const replies = [];
  await handleDm({ author: { id: 'a' }, content: 'https://open.spotify.com/track/new', reply: async message => replies.push(message) });
  assert.deepEqual(getGuild('guild').run.submissions.a, previous);
  assert.deepEqual(replies, ['The submission window for that Song of the Day run has closed.']);
  assert.equal(fetchMock.mock.callCount(), 0);
});

test('closing selection during a replacement lookup preserves the queued song', async t => {
  setup();
  const previous = getGuild('guild').run.submissions.a;
  let finishLookup;
  t.mock.method(global, 'fetch', () => new Promise(resolve => { finishLookup = resolve; }));
  const replies = [];
  const pending = handleDm({ author: { id: 'a' }, content: 'https://open.spotify.com/track/new', reply: async message => replies.push(message) });
  try {
    await finishCollection(client, 'guild');
  } finally {
    finishLookup(new Response('<title>Too Late - song by Artist | Spotify</title>'));
    await pending;
  }
  assert.deepEqual(getGuild('guild').run.submissions.a, previous);
  assert.equal(getGuild('guild').run.schedule[0].url, previous.url);
  assert.deepEqual(replies, ['The submission window for that Song of the Day run has closed.']);
});

test('last DM instantly closes selection, announces the first time, then posts each song daily', async t => {
  let now = Date.parse('2026-09-03T22:30:00Z');
  t.mock.method(Date, 'now', () => now);
  setup();
  t.mock.method(global, 'fetch', async () => new Response('<title>Final Song - song by Final Artist | Spotify</title>'));
  const replies = [];
  await handleDm({ author: { id: 'b' }, content: 'https://open.spotify.com/track/final', reply: async message => {
    assert.equal(getGuild('guild').run.status, 'waiting', 'queue closes before the DM acknowledgment');
    replies.push(message);
  } }, client);
  let run = getGuild('guild').run;
  assert.deepEqual(replies, ['Song choosen Final Song - Final Artist']);
  assert.equal(run.firstPostAt, '2026-09-03T23:00:00.000Z');
  assert.ok(Date.parse(run.firstPostAt) < Date.parse(run.collectionEndsAt), 'early completion can announce before the original deadline');
  assert.deepEqual(run.schedule.map(item => item.userId).sort(), ['a', 'b']);
  assert.equal(sent.length, 1);
  assert.match(sent[0].content, /Everyone has submitted a song.*run has started!/);
  assert.ok(sent[0].content.includes(`<t:${Date.parse(run.firstPostAt) / 1000}:F>`));
  assert.deepEqual(sent[0].allowedMentions, { roles: ['role'] });
  assert.ok(!sent[0].poll, 'no song is posted before the chosen announcement time');
  const original = run.submissions.a;
  await handleDm({ author: { id: 'a' }, content: 'https://open.spotify.com/track/toolate', reply: async () => {} }, client);
  assert.deepEqual(getGuild('guild').run.submissions.a, original);
  await schedulerTick(client);
  assert.equal(sent.length, 1);
  now = Date.parse('2026-09-03T23:00:00Z');
  await schedulerTick(client);
  assert.equal(sent.filter(message => message.poll).length, 1);
  now += 86400000;
  await schedulerTick(client);
  assert.equal(sent.filter(message => message.poll).length, 2);
  assert.deepEqual(new Set(sent.filter(message => message.poll).map(message => message.poll.question.text)), new Set(['Song - Artist', 'Final Song - Final Artist']));
  now += 86400000;
  await schedulerTick(client);
  run = getGuild('guild').run;
  assert.equal(run.status, 'ended');
  assert.equal(sent.at(-1), "That's all folks");
});

test('a one-person roster closes automatically after its first song', async t => {
  setup({});
  updateGuild('guild', guild => { guild.run.participantIds = ['a']; return guild; });
  t.mock.method(global, 'fetch', async () => new Response('<title>Only Song - song by Artist | Spotify</title>'));
  await handleDm({ author: { id: 'a' }, content: 'https://open.spotify.com/track/only', reply: async () => {} }, client);
  assert.equal(getGuild('guild').run.status, 'waiting');
  assert.equal(getGuild('guild').run.schedule.length, 1);
  assert.equal(sent.length, 1);
});

test('failed DM delivery does not remove a participant from the everyone-submitted check', async () => {
  setup();
  updateGuild('guild', guild => { guild.run.failedDmIds = ['b']; return guild; });
  await schedulerTick(client);
  assert.equal(getGuild('guild').run.status, 'collecting');
  assert.equal(sent.length, 0);
});

test('scheduler recovers fully submitted older runs even if the old notice was already sent', async () => {
  setup();
  updateGuild('guild', guild => {
    guild.run.submissions.b = { ...guild.run.submissions.a };
    guild.run.allSubmittedNotified = true;
    guild.run.reminderSent = false;
    return guild;
  });
  await schedulerTick(client);
  await schedulerTick(client);
  assert.equal(getGuild('guild').run.status, 'waiting');
  assert.equal(sent.length, 1);
  assert.match(sent[0].content, /Everyone has submitted/);
  assert.doesNotMatch(sent[0].content, /skip-song-selection/);
});

test('missed run-start notification retries from persisted state without reshuffling or duplicating it', async t => {
  setup();
  updateGuild('guild', guild => { guild.run.submissions.b = { ...guild.run.submissions.a }; return guild; });
  const send = channel.send;
  let failed = false;
  t.mock.method(channel, 'send', async payload => {
    if (!failed) { failed = true; throw new Error('temporary outage'); }
    return send(payload);
  });
  await assert.rejects(finishCollection(client, 'guild'), /temporary outage/);
  const saved = getGuild('guild').run;
  assert.equal(saved.status, 'waiting');
  assert.equal(saved.startAnnouncementPending, true);
  await schedulerTick(client);
  await schedulerTick(client);
  assert.equal(getGuild('guild').run.startAnnouncementPending, false);
  assert.deepEqual(getGuild('guild').run.schedule, saved.schedule);
  assert.equal(sent.length, 1);
});

test('concurrent close requests do not duplicate the run-start message', async () => {
  setup();
  await Promise.all([finishCollection(client, 'guild'), schedulerTick(client), finishCollection(client, 'guild')]);
  assert.equal(getGuild('guild').run.status, 'waiting');
  assert.equal(sent.length, 1);
});

test('deadline still closes partial submissions and schedules only submitted songs', async () => {
  setup();
  updateGuild('guild', guild => { guild.run.collectionEndsAt = new Date(0).toISOString(); return guild; });
  await schedulerTick(client);
  assert.equal(getGuild('guild').run.status, 'waiting');
  assert.deepEqual(getGuild('guild').run.schedule.map(song => song.userId), ['a']);
  assert.match(sent[0].content, /first song will be announced/);
  assert.doesNotMatch(sent[0].content, /Everyone/);
});

test('early closure cancels a reminder whose user lookup was still in flight', async () => {
  setup();
  updateGuild('guild', guild => { guild.run.reminderSent = false; return guild; });
  let reminders = 0;
  const reminderClient = { ...client, users: { fetch: async () => {
    updateGuild('guild', guild => { guild.run.submissions.b = { ...guild.run.submissions.a }; return guild; });
    await finishCollection(client, 'guild');
    return { send: async () => { reminders += 1; } };
  } } };
  await schedulerTick(reminderClient);
  assert.equal(reminders, 0);
  assert.equal(getGuild('guild').run.status, 'waiting');
  assert.equal(sent.length, 1);
});
