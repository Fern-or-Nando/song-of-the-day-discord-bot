const { readDocumentTitle } = require('./html-title');
const SPOTIFY_METADATA_SOURCE = 'spotify-document-name-v1';

function isSpotifyUrl(value) {
  try { return ['open.spotify.com', 'spotify.link'].includes(new URL(value).hostname.toLowerCase()); }
  catch { return false; }
}

function parseSpotifyDocumentName(documentName) {
  const normalized = documentName
    .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '')
    .replace(/\s+/gu, ' ').trim();
  // Split at Spotify's descriptive label, not at hyphens within real names.
  const match = normalized.match(/^(.+?)\s+[-\u2013\u2014]\s+song(?: and lyrics)? by\s+(.+?)\s*\|\s*Spotify$/i);
  if (!match) return null;
  return { title: match[1].trim(), artist: match[2].trim() };
}

function parseSpotifyHtml(html) {
  // This is the title that supplies the browser accessibility document name.
  // Do not guess from og:title, descriptions, or Spotify's oEmbed response.
  const title = readDocumentTitle(html);
  return title ? parseSpotifyDocumentName(title) : null;
}

function englishPageUrl(url) {
  if (url.hostname === 'open.spotify.com') {
    url.pathname = url.pathname.replace(/^\/intl-[a-z-]+\//i, '/intl-en/');
  }
  return url;
}

async function fetchSpotifyMetadata(value, fetchImpl = fetch) {
  let url = new URL(value);
  if (!isSpotifyUrl(value) || !['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port) {
    throw new Error('Expected a public Spotify URL.');
  }
  url.protocol = 'https:';
  url = englishPageUrl(url);
  const signal = AbortSignal.timeout(10_000);
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const response = await fetchImpl(url.toString(), {
      headers: { 'accept-language': 'en-US,en;q=0.9', 'user-agent': 'Mozilla/5.0 SOTDDiscordBot/1.0' },
      redirect: 'manual', signal
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location) throw new Error('Spotify redirect has no destination.');
      url = new URL(location, url);
      if (!isSpotifyUrl(url.toString()) || url.protocol !== 'https:' || url.username || url.password || url.port) {
        throw new Error('Spotify redirected outside its public music websites.');
      }
      url = englishPageUrl(url);
      continue;
    }
    if (!response.ok) throw new Error(`Spotify returned HTTP ${response.status}.`);
    if (url.hostname !== 'open.spotify.com' || !/^\/(?:intl-[a-z-]+\/)?track\/[a-z\d]+\/?$/i.test(url.pathname)) {
      throw new Error('Spotify link did not resolve to a song page.');
    }
    const metadata = parseSpotifyHtml(await response.text());
    if (!metadata) throw new Error('Spotify document name did not match "Title - song by Artist | Spotify".');
    return { ...metadata, metadataSource: SPOTIFY_METADATA_SOURCE };
  }
  throw new Error('Too many Spotify redirects.');
}

module.exports = { SPOTIFY_METADATA_SOURCE, isSpotifyUrl, parseSpotifyDocumentName, parseSpotifyHtml, fetchSpotifyMetadata };
