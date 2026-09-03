const { chromium } = require('playwright');
const TIDAL_METADATA_SOURCE = 'tidal-content-elements-v1';
const tidalHosts = ['tidal.com', 'listen.tidal.com', 'link.tidal.com'];

function isTidalUrl(value) {
  try { return tidalHosts.includes(new URL(value).hostname.toLowerCase()); }
  catch { return false; }
}

function publicTidalUrl(value) {
  const url = new URL(value);
  if (!isTidalUrl(value) || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port) {
    throw new Error('Expected a public Tidal URL.');
  }
  url.protocol = 'https:';
  if (url.hostname !== 'link.tidal.com' && !/^\/(?:browse\/)?track\/\d+(?:\/u)?\/?$/.test(url.pathname)) {
    throw new Error('Expected a Tidal track link, not an album or artist page.');
  }
  if (url.hostname !== 'link.tidal.com') {
    // /u is Tidal's public share page, where these content elements render
    // without a listener account. Keep the track ID, not its changing CSS.
    const trackId = url.pathname.match(/\/track\/(\d+)/)[1];
    url.hostname = 'tidal.com';
    url.pathname = `/track/${trackId}/u`;
  }
  return url.toString();
}

// Runs inside Chromium against the rendered document, including JS-created
// elements. Do not reference module variables: Playwright serializes this function.
function readTidalDom({ requireArtist = false } = {}) {
  const titleElement = document.querySelector('h1[data-test="content-title"]');
  const normalize = value => value.replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '').replace(/\s+/gu, ' ').trim();
  if (!titleElement || !titleElement.getClientRects().length) return null;
  const title = normalize(titleElement.innerText);
  if (!title) return null;

  // Use the smallest container surrounding the song heading with artist links.
  // Never sweep the entire app, where navigation and recommendations have artists.
  for (let scope = titleElement.parentElement; scope && !['BODY', 'HTML', 'MAIN'].includes(scope.tagName); scope = scope.parentElement) {
    const artists = [];
    for (const anchor of scope.querySelectorAll('a[href]')) {
      if (!anchor.getClientRects().length || anchor.closest('nav, aside, footer, [hidden], [aria-hidden="true"]')) continue;
      let target;
      try { target = new URL(anchor.getAttribute('href'), 'https://tidal.com'); }
      catch { continue; }
      if (!['https:', 'http:'].includes(target.protocol) || target.username || target.password || target.port ||
          !['tidal.com', 'listen.tidal.com'].includes(target.hostname) ||
          !/^\/(?:browse\/)?artist\/[^/]+\/?$/.test(target.pathname)) continue;
      // Exclude links under later section headings (e.g. related artists).
      const laterSection = [...scope.querySelectorAll('h1,h2,h3,h4')].some(heading => heading !== titleElement &&
        (titleElement.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING) &&
        (heading.compareDocumentPosition(anchor) & Node.DOCUMENT_POSITION_FOLLOWING));
      if (laterSection) continue;
      const artist = normalize(anchor.innerText);
      if (artist && !artists.includes(artist)) artists.push(artist);
    }
    if (artists.length) return { title, artist: artists.join(', ') };
  }
  return requireArtist ? null : { title, artist: null };
}

async function renderTidalMetadata(value, browserType = chromium) {
  const url = publicTidalUrl(value);
  let browser;
  try {
    browser = await browserType.launch({ headless: true, chromiumSandbox: true, timeout: 15_000 });
    const context = await browser.newContext({ locale: 'en-US', serviceWorkers: 'block', acceptDownloads: false });
    const page = await context.newPage();
    await context.route('**/*', async route => {
      const request = route.request();
      const target = new URL(request.url());
      if (target.protocol !== 'https:' || target.username || target.password || target.port) return route.abort();
      if (request.isNavigationRequest()) {
        if (request.frame() !== page.mainFrame() || !isTidalUrl(target.toString())) return route.abort();
        let shareUrl;
        try { shareUrl = publicTidalUrl(target.toString()); } catch { return route.abort(); }
        if (shareUrl !== request.url()) return route.fulfill({ status: 302, headers: { location: shareUrl } });
      } else if (!(target.hostname === 'tidal.com' || target.hostname.endsWith('.tidal.com'))) {
        return route.abort();
      }
      if (['image', 'font', 'media'].includes(request.resourceType())) return route.abort();
      return route.continue();
    });
    const deadline = Date.now() + 25_000;
    const remaining = () => Math.max(1, deadline - Date.now());
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: remaining() });
    if (response && !response.ok()) throw new Error(`Tidal returned HTTP ${response.status()}.`);
    try {
      await page.waitForFunction(readTidalDom, { requireArtist: true }, { timeout: remaining() });
    } catch (error) {
      if (error.name !== 'TimeoutError') throw error;
      // Title-only is allowed if the song exists but no artist link rendered.
    }
    const finalUrl = new URL(publicTidalUrl(page.url()));
    if (finalUrl.hostname === 'link.tidal.com') throw new Error('Tidal short link did not resolve to a track.');
    const metadata = await page.evaluate(readTidalDom);
    if (!metadata) throw new Error('Tidal did not render h1[data-test="content-title"]. The track may be unavailable.');
    return { ...metadata, metadataSource: TIDAL_METADATA_SOURCE };
  } finally {
    if (browser) await browser.close();
  }
}

// Bound browser usage to one Tidal lookup at a time; the other providers keep
// their lightweight HTTP lookups. Each lookup uses fresh, non-persistent state.
let queue = Promise.resolve();
function fetchTidalMetadata(value, browserType = chromium) {
  const result = queue.then(() => renderTidalMetadata(value, browserType));
  queue = result.catch(() => {});
  return result;
}

module.exports = { TIDAL_METADATA_SOURCE, isTidalUrl, publicTidalUrl, readTidalDom, fetchTidalMetadata };
