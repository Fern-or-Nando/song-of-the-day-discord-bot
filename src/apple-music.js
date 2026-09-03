const APPLE_METADATA_SOURCE = 'apple-document-name-v1';
const { readDocumentTitle } = require('./html-title');

function isAppleMusicUrl(value) {
  try { return new URL(value).hostname.toLowerCase() === 'music.apple.com'; }
  catch { return false; }
}

function parseAppleDocumentName(documentName) {
  // Apple prefixes the document title with an invisible direction mark and
  // commonly uses U+00A0 between Apple and Music. Preserve punctuation in names.
  const normalized = documentName
    .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '')
    .replace(/\s+/gu, ' ').trim();
  const match = normalized.match(/^(.+?)\s+[-\u2013\u2014]\s+Song by\s+(.+?)\s+[-\u2013\u2014]\s+Apple Music$/i);
  if (!match) return null;
  return { title: match[1].trim(), artist: match[2].trim() };
}

function parseAppleHtml(html) {
  // The document accessibility name is sourced from <title>, NOT og:title
  // (the social preview), description, or the artist's heading.
  const title = readDocumentTitle(html);
  return title ? parseAppleDocumentName(title) : null;
}

async function fetchAppleMetadata(value, fetchImpl = fetch) {
  let url = new URL(value);
  if (!isAppleMusicUrl(value) || !['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port) {
    throw new Error('Expected a public Apple Music URL.');
  }
  url.protocol = 'https:';
  // Request English metadata so the document uses the literal "Song by" label.
  // Preserve the storefront, song ID, and album ?i= track selection.
  url.searchParams.set('l', 'en-US');
  const signal = AbortSignal.timeout(10_000);
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const response = await fetchImpl(url.toString(), {
      headers: { 'accept-language': 'en-US,en;q=0.9', 'user-agent': 'Mozilla/5.0 SOTDDiscordBot/1.0' },
      redirect: 'manual', signal
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location) throw new Error('Apple Music redirect has no destination.');
      url = new URL(location, url);
      if (!isAppleMusicUrl(url.toString()) || url.protocol !== 'https:' || url.username || url.password || url.port) {
        throw new Error('Apple Music redirected outside its public music website.');
      }
      continue;
    }
    if (!response.ok) throw new Error(`Apple Music returned HTTP ${response.status}.`);
    const metadata = parseAppleHtml(await response.text());
    if (!metadata) throw new Error('Apple Music document name did not match "Title - Song by Artist - Apple Music".');
    return { ...metadata, metadataSource: APPLE_METADATA_SOURCE };
  }
  throw new Error('Too many Apple Music redirects.');
}

module.exports = { APPLE_METADATA_SOURCE, isAppleMusicUrl, parseAppleDocumentName, parseAppleHtml, fetchAppleMetadata };
