const test = require('node:test');
const assert = require('node:assert/strict');
const { YOUTUBE_MUSIC_METADATA_SOURCE, isYouTubeMusicUrl, parseYouTubeMusicHtml, fetchYouTubeMusicMetadata } = require('../src/youtube-music');
const { fetchMetadata, metadataForDisplay } = require('../src/sotd-service');

const url = 'https://music.youtube.com/watch?v=PgagPdVM7bk&si=share';
const html = '<html><head><title>Wrong - song by Wrong | YouTube Music</title>' +
  '<meta property="og:description" content="Band - One">' +
  '<meta property="og:title" content="Stand by Me - Live"></head></html>';
const expected = { title: 'Stand by Me - Live', artist: 'Band - One', metadataSource: YOUTUBE_MUSIC_METADATA_SOURCE };

test('YouTube Music reads the requested OG fields directly without splitting real names', () => {
  assert.deepEqual(parseYouTubeMusicHtml(html), { title: 'Stand by Me - Live', artist: 'Band - One' });
});

test('OG attributes can appear in either order, with either quote style, multiline or unquoted', () => {
  assert.deepEqual(parseYouTubeMusicHtml("<META content='Dreams' data-extra='ignored' PROPERTY='og:title'>\n" +
    '<meta\nCONTENT="Fleetwood Mac"\n property="og:description"/>'), { title: 'Dreams', artist: 'Fleetwood Mac' });
  assert.deepEqual(parseYouTubeMusicHtml('<meta content=Dreams property=og:title><meta property=og:description content=Band>'), {
    title: 'Dreams', artist: 'Band'
  });
});

test('decodes entities once and handles quotes, greater-than signs, unicode and whitespace', () => {
  assert.deepEqual(parseYouTubeMusicHtml('<meta property="og:title" content="&#8206;Rock &amp; Roll > &quot;Live&quot;">' +
    '<meta content="R&amp;B&nbsp;Band\n&#x2014; Beyoncé" property="og:description">'), {
    title: 'Rock & Roll > "Live"', artist: 'R&B Band — Beyoncé'
  });
  assert.deepEqual(parseYouTubeMusicHtml('<meta property="og:title" content="&amp;quot;">'), { title: '&quot;', artist: null });
});

test('does not treat strings, comments, lookalike attributes, or document titles as OG fields', () => {
  const fake = '<meta property="og:title" content="Wrong">';
  const ignored = '<!--' + fake + '--><script>const example = `' + fake + '`;</script>' +
    '<style>/* ' + fake + ' */</style><title>' + fake + '</title><textarea>' + fake + '</textarea>' +
    "<div data-example='" + fake + "'></div>" +
    '<meta data-property="og:title" content="Wrong"><meta name="og:title" content="Wrong">';
  assert.equal(parseYouTubeMusicHtml(ignored), null);
  assert.deepEqual(parseYouTubeMusicHtml(ignored + html), { title: expected.title, artist: expected.artist });
});

test('missing or empty title is unusable; missing artist displays title only; first value wins', () => {
  for (const page of ['', '<title>Dreams</title>', '<meta property="og:title" content="">',
    '<meta property="og:title" content="YouTube Music">', '<meta property="og:description" content="Band">']) {
    assert.equal(parseYouTubeMusicHtml(page), null);
  }
  assert.deepEqual(parseYouTubeMusicHtml('<meta property="og:title" content="Dreams"><meta property="og:description" content=" ">'), {
    title: 'Dreams', artist: null
  });
  assert.deepEqual(parseYouTubeMusicHtml(html + '<meta property="og:title" content="Wrong"><meta property="og:description" content="Wrong">'), {
    title: expected.title, artist: expected.artist
  });
});

test('fetch reads the Music page and preserves video/share parameters, without oEmbed', async () => {
  assert.deepEqual(await fetchYouTubeMusicMetadata(url, async (request, options) => {
    assert.equal(request, url);
    assert.equal(options.redirect, 'manual');
    assert.equal(options.headers['accept-language'], 'en-US,en;q=0.9');
    assert.ok(options.signal);
    return new Response(html);
  }), expected);
});

test('follows same-site Music song redirects only, not regular YouTube or consent pages', async () => {
  let calls = 0;
  assert.deepEqual(await fetchYouTubeMusicMetadata(url, async () => ++calls === 1
    ? new Response(null, { status: 302, headers: { location: '/watch?v=other' } })
    : new Response(html)), expected);
  for (const location of ['https://www.youtube.com/watch?v=abc', 'https://consent.youtube.com/',
    'http://music.youtube.com/watch?v=abc', 'https://music.youtube.com.evil.test/watch?v=abc',
    'https://user@music.youtube.com/watch?v=abc', 'https://music.youtube.com:8080/watch?v=abc']) {
    await assert.rejects(fetchYouTubeMusicMetadata(url, async () => new Response(null, {
      status: 302, headers: { location }
    })), /outside/);
  }
  await assert.rejects(fetchYouTubeMusicMetadata(url, async () => new Response(null, {
    status: 302, headers: { location: '/playlist?list=abc' }
  })), /song page/);
});

test('rejects invalid inputs, redirect loops and missing redirect destinations', async () => {
  for (const invalid of ['https://www.youtube.com/watch?v=abc', 'https://youtu.be/abc', 'ftp://music.youtube.com/watch?v=abc',
    'https://user@music.youtube.com/watch?v=abc', 'https://music.youtube.com/watch', 'https://music.youtube.com/playlist?list=abc']) {
    await assert.rejects(fetchYouTubeMusicMetadata(invalid, () => assert.fail('Must not fetch')), /Expected/);
  }
  await assert.rejects(fetchYouTubeMusicMetadata(url, async () => new Response(null, {
    status: 302, headers: { location: url }
  })), /Too many/);
  await assert.rejects(fetchYouTubeMusicMetadata(url, async () => new Response(null, { status: 302 })), /no destination/);
  assert.equal(isYouTubeMusicUrl('https://youtu.be/abc'), false);
  assert.equal(isYouTubeMusicUrl('https://www.youtube.com/watch?v=abc'), false);
  assert.equal(isYouTubeMusicUrl('https://music.youtube.com.evil.test'), false);
});

test('HTTP errors, timeouts and missing OG metadata do not fall back to another lookup', async t => {
  let calls = 0;
  t.mock.method(global, 'fetch', async () => { calls += 1; return new Response('<title>Dreams - Fleetwood Mac</title>'); });
  t.mock.method(console, 'warn', () => {});
  assert.deepEqual(await fetchMetadata(url), { title: 'Song', artist: null });
  assert.equal(calls, 1);
  await assert.rejects(fetchYouTubeMusicMetadata(url, async () => new Response('Blocked', { status: 403 })), /403/);
  await assert.rejects(fetchYouTubeMusicMetadata(url, async () => { throw new Error('Timeout'); }), /Timeout/);
});

test('Music-only dispatch refreshes legacy metadata and preserves verified OG fields', async t => {
  let calls = 0;
  t.mock.method(global, 'fetch', async request => {
    calls += 1;
    assert.equal(new URL(request).hostname, 'music.youtube.com');
    return new Response(html);
  });
  assert.deepEqual(await fetchMetadata(url), expected);
  assert.deepEqual(await metadataForDisplay({ url, title: 'Wrong', artist: 'Uploader' }), expected);
  assert.deepEqual(await metadataForDisplay({ url, ...expected }), expected);
  assert.equal(calls, 2);
});
