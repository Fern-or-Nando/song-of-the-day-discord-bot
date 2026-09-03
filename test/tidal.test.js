const test = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { TIDAL_METADATA_SOURCE, isTidalUrl, publicTidalUrl, readTidalDom, fetchTidalMetadata } = require('../src/tidal');
const { fetchMetadata, metadataForDisplay } = require('../src/sotd-service');
const { fakeTidalBrowser } = require('./helpers/tidal-browser');

let browser;
test.before(async () => { browser = await chromium.launch({ headless: true, chromiumSandbox: true }); });
test.after(async () => { if (browser) await browser.close(); });
async function extract(html, options) {
  const page = await browser.newPage();
  try {
    await page.setContent(html);
    return await page.evaluate(readTidalDom, options);
  } finally { await page.close(); }
}
function content(title = 'Thinking About You', artist = 'Faye Webster', code = '8517573', className = '_link_anything') {
  return `<main><div><h1 class="wave-text-body-bold _descriptionHeading_changed" data-test="content-title">${title}</h1>` +
    `<span data-test="artist-link"><a class="${className}" draggable="false" href="/artist/${code}" rel="noreferrer" target="_self">${artist}</a></span></div></main>`;
}
const metadata = { title: 'Thinking About You', artist: 'Faye Webster' };
const expected = { ...metadata, metadataSource: TIDAL_METADATA_SOURCE };
const url = 'https://tidal.com/track/329221161/u';

test('Tidal selectors ignore changing CSS class and artist code', async () => {
  assert.deepEqual(await extract(content()), metadata);
  assert.deepEqual(await extract(content('Thinking About You', 'Faye Webster', '123456789', 'totally-different')), metadata);
});

test('renders nested text and entities without splitting song or artist names', async () => {
  assert.deepEqual(await extract(content('Stand by Me - <span>Live &amp; Acoustic</span>', 'R&amp;B Band - One')), {
    title: 'Stand by Me - Live & Acoustic', artist: 'R&B Band - One'
  });
});

test('uses nearby artists, not navigation, related sections, external lookalikes or hidden links', async () => {
  const html = '<nav><a href="/artist/0">Navigation</a></nav><main><div><h1 data-test="content-title">Dreams</h1>' +
    '<a href="https://evil.test/artist/1">Wrong</a><a hidden href="/artist/2">Hidden</a>' +
    '<aside><a href="/artist/3">Aside</a></aside><a href="/artist/4">Fleetwood Mac</a>' +
    '<section><h2>Related artists</h2><a href="/artist/5">Other Band</a></section></div></main>';
  assert.deepEqual(await extract(html), { title: 'Dreams', artist: 'Fleetwood Mac' });
});

test('joins multiple credited artists once, regardless of their IDs', async () => {
  const html = '<main><div><h1 data-test="content-title">Song</h1><a href="/artist/1">Artist A</a>' +
    '<a href="https://tidal.com/artist/2">Artist B</a><a href="/artist/1">Artist A</a></div></main>';
  assert.deepEqual(await extract(html), { title: 'Song', artist: 'Artist A, Artist B' });
});

test('missing heading is not guessed from title or social metadata; absent artist is omitted', async () => {
  assert.equal(await extract('<title>Wrong by Artist on Tidal</title><meta property="og:title" content="Wrong"><h1>Other heading</h1>'), null);
  assert.deepEqual(await extract('<main><div><h1 data-test="content-title">Song</h1></div><aside><a href="/artist/1">Wrong</a></aside></main>'), {
    title: 'Song', artist: null
  });
  assert.equal(await extract('<div><h1 data-test="content-title">Song</h1></div>', { requireArtist: true }), null);
});

test('works with elements inserted by JavaScript, not just server HTML', async () => {
  const page = await browser.newPage();
  try {
    await page.setContent('<main></main>');
    await page.evaluate(() => setTimeout(() => {
      document.querySelector('main').innerHTML = '<div><h1 data-test="content-title">Dynamic Song</h1><a href="/artist/42">Dynamic Artist</a></div>';
    }, 20));
    const value = await page.waitForFunction(readTidalDom, { requireArtist: true });
    assert.deepEqual(await value.jsonValue(), { title: 'Dynamic Song', artist: 'Dynamic Artist' });
  } finally { await page.close(); }
});

test('track forms normalize to the public share page while IDs and query parameters are retained', () => {
  for (const value of ['https://tidal.com/track/329221161', 'https://tidal.com/browse/track/329221161',
    'https://listen.tidal.com/track/329221161', url]) assert.equal(publicTidalUrl(value), url);
  assert.equal(publicTidalUrl(`${url}?ref=share`), `${url}?ref=share`);
  assert.equal(publicTidalUrl('https://link.tidal.com/example'), 'https://link.tidal.com/example');
  for (const value of ['https://tidal.com.evil.test/track/1', 'https://tidal.com/album/1',
    'ftp://tidal.com/track/1', 'https://user@tidal.com/track/1', 'https://tidal.com:8080/track/1']) assert.throws(() => publicTidalUrl(value));
  assert.equal(isTidalUrl('https://tidal.com.evil.test'), false);
});

test('fetch uses a fresh headless sandboxed browser and closes it on success', async () => {
  const { browserType, calls } = fakeTidalBrowser(metadata);
  assert.deepEqual(await fetchTidalMetadata(url, browserType), expected);
  assert.equal(calls.launch.headless, true);
  assert.equal(calls.launch.chromiumSandbox, true);
  assert.equal(calls.context.acceptDownloads, false);
  assert.equal(calls.context.serviceWorkers, 'block');
  assert.equal(calls.closed, 1);
});

test('network guard rejects external navigation and private subrequests and skips media', async () => {
  const { browserType, calls, frame } = fakeTidalBrowser(metadata);
  await fetchTidalMetadata(url, browserType);
  async function route(target, navigation = false, type = 'script') {
    let action;
    await calls.route({
      request: () => ({ url: () => target, isNavigationRequest: () => navigation, frame: () => frame, resourceType: () => type }),
      abort: async () => { action = 'abort'; }, continue: async () => { action = 'continue'; },
      fulfill: async () => { action = 'redirect'; }
    });
    return action;
  }
  assert.equal(await route('https://example.com/', true), 'abort');
  assert.equal(await route('https://127.0.0.1/'), 'abort');
  assert.equal(await route('https://resources.tidal.com/image.jpg', false, 'image'), 'abort');
  assert.equal(await route('https://tidal.com/assets/app.js'), 'continue');
  assert.equal(await route('https://tidal.com/track/329221161', true), 'redirect');
});

test('closes browsers after blocked, missing, or timed-out pages and does not poison the queue', async () => {
  const timeout = Object.assign(new Error('Timeout'), { name: 'TimeoutError' });
  for (const options of [{ status: 403 }, { gotoError: timeout }, { waitError: timeout }]) {
    const { browserType, calls } = fakeTidalBrowser(null, options);
    await assert.rejects(fetchTidalMetadata(url, browserType));
    assert.equal(calls.closed, 1);
  }
  assert.deepEqual(await fetchTidalMetadata(url, fakeTidalBrowser(metadata).browserType), expected);
});

test('Tidal-only dispatch refreshes legacy songs and keeps verified fields intact', async t => {
  const { browserType, calls } = fakeTidalBrowser(metadata);
  t.mock.method(chromium, 'launch', browserType.launch);
  t.mock.method(global, 'fetch', () => assert.fail('Must not use generic HTML metadata'));
  assert.deepEqual(await fetchMetadata(url), expected);
  assert.deepEqual(await metadataForDisplay({ url, title: 'Wrong on Tidal', artist: 'Wrong' }), expected);
  assert.deepEqual(await metadataForDisplay({ url, ...expected }), expected);
  assert.equal(calls.launches, 2);
});

test('failed Tidal lookup uses safe fallback instead of old branded metadata', async t => {
  t.mock.method(chromium, 'launch', fakeTidalBrowser(null).browserType.launch);
  t.mock.method(console, 'warn', () => {});
  assert.deepEqual(await fetchMetadata(url), { title: 'Song', artist: null });
});
