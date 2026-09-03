const test = require('node:test');
const assert = require('node:assert/strict');
const { APPLE_METADATA_SOURCE, parseAppleDocumentName, parseAppleHtml, fetchAppleMetadata } = require('../src/apple-music');
const { fetchMetadata, metadataForDisplay } = require('../src/sotd-service');

const url = 'https://music.apple.com/us/album/dreams/594061854?i=594061856';
const documentHtml = '<html><head><meta property="og:title" content="Wrong on Apple Music">' +
  '<meta property="og:description" content="Song by the wrong artist">' +
  '<title>\u200eDreams - Song by Fleetwood Mac - Apple\u00a0Music</title></head></html>';
const expected = { title: 'Dreams', artist: 'Fleetwood Mac', metadataSource: APPLE_METADATA_SOURCE };

test('parses the Apple accessibility document-name format, not social metadata', () => {
  assert.deepEqual(parseAppleHtml(documentHtml), { title: 'Dreams', artist: 'Fleetwood Mac' });
});

test('normalizes invisible characters, nonbreaking spaces, dash variants, and case', () => {
  assert.deepEqual(parseAppleDocumentName('\u200eDreams \u2014 song by Fleetwood Mac \u2013 apple\u00a0music'), {
    title: 'Dreams', artist: 'Fleetwood Mac'
  });
});

test('preserves hyphens, by, and service words within real song and artist names', () => {
  assert.deepEqual(parseAppleDocumentName('Stand by Me - Live - Song by Jay-Z - Live Band - Apple Music'), {
    title: 'Stand by Me - Live', artist: 'Jay-Z - Live Band'
  });
  assert.deepEqual(parseAppleDocumentName('On Apple Music - Song by The Band - Apple Music'), {
    title: 'On Apple Music', artist: 'The Band'
  });
});

test('decodes title entities once, including numeric direction marks and punctuation', () => {
  assert.deepEqual(parseAppleHtml('<title>&#8206;Rock &amp; Roll &#8212; Song by R&amp;B &quot;Band&quot; &#x2014; Apple&nbsp;Music</title>'), {
    title: 'Rock & Roll', artist: 'R&B "Band"'
  });
  assert.deepEqual(parseAppleHtml('<title>&amp;quot; - Song by Band - Apple Music</title>'), {
    title: '&quot;', artist: 'Band'
  });
});

test('rejects albums, missing document names, blocked pages and the old format', () => {
  for (const name of ['Apple Music', 'Access denied', 'Rumours - Album by Fleetwood Mac - Apple Music',
    'Dreams by Fleetwood Mac on Apple Music', ' - Song by Band - Apple Music']) {
    assert.equal(parseAppleDocumentName(name), null);
  }
  assert.equal(parseAppleHtml('<meta property="og:title" content="Dreams - Song by Fleetwood Mac - Apple Music">'), null);
});

test('fetch uses document title and preserves album track selection while requesting English', async () => {
  const result = await fetchAppleMetadata(url, async (requestUrl, options) => {
    const parsed = new URL(requestUrl);
    assert.equal(parsed.searchParams.get('i'), '594061856');
    assert.equal(parsed.searchParams.get('l'), 'en-US');
    assert.equal(options.headers['accept-language'], 'en-US,en;q=0.9');
    assert.equal(options.redirect, 'manual');
    return new Response(documentHtml);
  });
  assert.deepEqual(result, expected);
});

test('follows Apple redirects but rejects external or excessive redirects', async () => {
  let calls = 0;
  assert.deepEqual(await fetchAppleMetadata(url, async () => ++calls === 1
    ? new Response(null, { status: 302, headers: { location: '/us/song/594061856' } })
    : new Response(documentHtml)), expected);
  await assert.rejects(fetchAppleMetadata(url, async () => new Response(null, {
    status: 302, headers: { location: 'https://example.com' }
  })), /outside/);
  await assert.rejects(fetchAppleMetadata(url, async () => new Response(null, {
    status: 302, headers: { location: url }
  })), /Too many/);
});

test('errors or unexpected names never fall back to branded OG metadata', async t => {
  t.mock.method(global, 'fetch', async () => new Response('<title>Access denied</title><meta property="og:title" content="Wrong on Apple Music">'));
  t.mock.method(console, 'warn', () => {});
  assert.deepEqual(await fetchMetadata(url), { title: 'Song', artist: null });
  await assert.rejects(fetchAppleMetadata(url, async () => new Response('Blocked', { status: 403 })), /403/);
  await assert.rejects(fetchAppleMetadata(url, async () => { throw new Error('Timeout'); }), /Timeout/);
});

test('Apple-only dispatch and cached display preserve a verified title unchanged', async t => {
  let calls = 0;
  t.mock.method(global, 'fetch', async () => { calls += 1; return new Response(documentHtml); });
  assert.deepEqual(await fetchMetadata(url), expected);
  assert.deepEqual(await metadataForDisplay({ url, title: 'Wrong on Apple Music', artist: 'Wrong' }), expected);
  const saved = { url, title: 'Stand by Me - Live', artist: 'Band - One', metadataSource: APPLE_METADATA_SOURCE };
  assert.deepEqual(await metadataForDisplay(saved), {
    title: saved.title, artist: saved.artist, metadataSource: APPLE_METADATA_SOURCE
  });
  assert.equal(calls, 2);
});

test('YouTube short links keep their previous lookup path', async t => {
  t.mock.method(global, 'fetch', async requestUrl => {
    if (requestUrl.includes('/oembed')) return Response.json({ title: 'Dreams - Fleetwood Mac' });
    return new Response('<meta property="og:title" content="Dreams - Fleetwood Mac">');
  });
  for (const otherUrl of ['https://youtu.be/abc']) {
    assert.deepEqual(await fetchMetadata(otherUrl), { title: 'Dreams', artist: 'Fleetwood Mac' });
  }
});
