const test = require('node:test');
const assert = require('node:assert/strict');
const { SPOTIFY_METADATA_SOURCE, isSpotifyUrl, parseSpotifyDocumentName, parseSpotifyHtml, fetchSpotifyMetadata } = require('../src/spotify');
const { fetchMetadata, metadataForDisplay } = require('../src/sotd-service');

const url = 'https://open.spotify.com/track/5TDZyWDfbQFQJabbPwImVY?si=share';
const documentHtml = '<html><head><meta property="og:title" content="Wrong on Spotify">' +
  '<meta property="og:description" content="Song by the wrong artist">' +
  '<title>Dreams - 2004 Remaster - song and lyrics by Fleetwood Mac | Spotify</title></head></html>';
const expected = { title: 'Dreams - 2004 Remaster', artist: 'Fleetwood Mac', metadataSource: SPOTIFY_METADATA_SOURCE };

test('reads the Spotify document name rather than the social preview', () => {
  assert.deepEqual(parseSpotifyHtml(documentHtml), { title: 'Dreams - 2004 Remaster', artist: 'Fleetwood Mac' });
});

test('supports both song by and song and lyrics by labels', () => {
  for (const label of ['song by', 'song and lyrics by', 'Song By', 'Song And Lyrics By']) {
    assert.deepEqual(parseSpotifyDocumentName(`Dreams - ${label} Fleetwood Mac | Spotify`), {
      title: 'Dreams', artist: 'Fleetwood Mac'
    });
  }
});

test('normalizes invisible marks, whitespace and dash variants', () => {
  assert.deepEqual(parseSpotifyDocumentName('\u200eDreams\u00a0\u2014 Song\nby Fleetwood Mac |\u00a0Spotify'), {
    title: 'Dreams', artist: 'Fleetwood Mac'
  });
});

test('keeps hyphens, by, pipe characters and service words inside real names', () => {
  assert.deepEqual(parseSpotifyDocumentName('Stand by Me - Live | Mix - song by Jay-Z, Band - One | Spotify'), {
    title: 'Stand by Me - Live | Mix', artist: 'Jay-Z, Band - One'
  });
  assert.deepEqual(parseSpotifyDocumentName('On Spotify - song by Spotify Band | Spotify'), {
    title: 'On Spotify', artist: 'Spotify Band'
  });
});

test('decodes named and numeric entities exactly once', () => {
  assert.deepEqual(parseSpotifyHtml('<title>&#8206;Rock &amp; Roll &#8211; song by R&amp;B &quot;Band&quot; &#124; Spotify</title>'), {
    title: 'Rock & Roll', artist: 'R&B "Band"'
  });
  assert.deepEqual(parseSpotifyHtml('<title>&amp;quot; - song by Band | Spotify</title>'), {
    title: '&quot;', artist: 'Band'
  });
});

test('rejects album, playlist, missing, blocked or unrecognized document names', () => {
  for (const name of ['Spotify', 'Access denied', 'Rumours - album by Fleetwood Mac | Spotify',
    'Favorites - playlist by User | Spotify', 'Dreams - Fleetwood Mac | Spotify', 'Dreams - song by | Spotify',
    ' - song by Band | Spotify', 'Dreams - song by Fleetwood Mac | Apple Music']) {
    assert.equal(parseSpotifyDocumentName(name), null, name);
  }
  assert.equal(parseSpotifyHtml('<meta property="og:title" content="Dreams - song by Fleetwood Mac | Spotify">'), null);
});

test('requests the English track page without oEmbed and keeps share parameters', async () => {
  const result = await fetchSpotifyMetadata(url.replace('/track/', '/intl-de/track/'), async (requestUrl, options) => {
    const request = new URL(requestUrl);
    assert.equal(request.pathname, '/intl-en/track/5TDZyWDfbQFQJabbPwImVY');
    assert.equal(request.searchParams.get('si'), 'share');
    assert.equal(options.headers['accept-language'], 'en-US,en;q=0.9');
    assert.equal(options.redirect, 'manual');
    assert.ok(options.signal);
    return new Response(documentHtml);
  });
  assert.deepEqual(result, expected);
});

test('follows spotify.link and relative redirects only within Spotify music hosts', async () => {
  const requests = [];
  assert.deepEqual(await fetchSpotifyMetadata('https://spotify.link/example', async request => {
    requests.push(request);
    if (requests.length === 1) return new Response(null, { status: 302, headers: { location: url } });
    if (requests.length === 2) return new Response(null, { status: 307, headers: { location: '/intl-en/track/abc' } });
    return new Response(documentHtml);
  }), expected);
  assert.equal(requests.length, 3);
  for (const location of ['https://example.com/song', 'http://open.spotify.com/track/abc',
    'https://open.spotify.com.evil.test/track/abc', 'https://user@open.spotify.com/track/abc',
    'https://open.spotify.com:8080/track/abc']) {
    await assert.rejects(fetchSpotifyMetadata(url, async () => new Response(null, {
      status: 302, headers: { location }
    })), /outside/);
  }
});

test('rejects unsafe input, unresolved short links, non-track pages and redirect loops', async () => {
  for (const badUrl of ['https://example.com/track/abc', 'ftp://open.spotify.com/track/abc', 'https://user@open.spotify.com/track/abc']) {
    await assert.rejects(fetchSpotifyMetadata(badUrl, () => assert.fail('Should not fetch')), /Expected/);
  }
  for (const otherUrl of ['https://open.spotify.com/album/abc', 'https://spotify.link/example']) {
    await assert.rejects(fetchSpotifyMetadata(otherUrl, async () => new Response(documentHtml)), /song page/);
  }
  await assert.rejects(fetchSpotifyMetadata(url, async () => new Response(null, {
    status: 302, headers: { location: url }
  })), /Too many/);
  await assert.rejects(fetchSpotifyMetadata(url, async () => new Response(null, { status: 302 })), /no destination/);
  assert.equal(isSpotifyUrl('https://open.spotify.com.evil.test'), false);
});

test('errors, unexpected names and timeouts never fall back to branded metadata', async t => {
  t.mock.method(global, 'fetch', async () => new Response('<title>Access denied</title><meta property="og:title" content="Wrong | Spotify">'));
  t.mock.method(console, 'warn', () => {});
  assert.deepEqual(await fetchMetadata(url), { title: 'Song', artist: null });
  await assert.rejects(fetchSpotifyMetadata(url, async () => new Response('Blocked', { status: 403 })), /403/);
  await assert.rejects(fetchSpotifyMetadata(url, async () => { throw new Error('Timeout'); }), /Timeout/);
});

test('Spotify-only dispatch refreshes old entries and preserves verified names', async t => {
  let requests = 0;
  t.mock.method(global, 'fetch', async request => {
    requests += 1;
    assert.doesNotMatch(request, /oembed/);
    return new Response(documentHtml);
  });
  assert.deepEqual(await fetchMetadata(url), expected);
  assert.deepEqual(await metadataForDisplay({ url, title: 'Wrong | Spotify', artist: 'song by Wrong' }), expected);
  assert.deepEqual(await metadataForDisplay({ url, ...expected }), expected);
  assert.equal(requests, 2);
});
