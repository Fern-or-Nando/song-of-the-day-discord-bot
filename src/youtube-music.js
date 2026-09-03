const { decodeTitleEntities } = require('./html-title');
const YOUTUBE_MUSIC_METADATA_SOURCE = 'youtube-music-og-v1';

function isYouTubeMusicUrl(value) {
  try { return new URL(value).hostname.toLowerCase() === 'music.youtube.com'; }
  catch { return false; }
}

function parseYouTubeMusicHtml(html) {
  const fields = new Map();
  // Ignore examples/strings inside comments and raw-text elements. Match full
  // tags so a quoted attribute containing "<meta ...>" is not treated as a tag.
  const markup = html.replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|title|textarea)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
  const tags = markup.matchAll(/<[a-z][\w:-]*\b(?:[^"'<>]|"[^"]*"|'[^']*')*>/gi);
  for (const [tag] of tags) {
    if (!/^<meta\b/i.test(tag)) continue;
    const attributes = new Map();
    const tokens = tag.slice(5, -1).matchAll(/([^\s=/'"<>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g);
    for (const [, name, doubleQuoted, singleQuoted, unquoted] of tokens) {
      const key = name.toLowerCase();
      if (!attributes.has(key)) attributes.set(key, doubleQuoted ?? singleQuoted ?? unquoted ?? '');
    }
    const property = attributes.get('property')?.trim().toLowerCase();
    if (!['og:title', 'og:description'].includes(property) || fields.has(property)) continue;
    const raw = attributes.get('content');
    if (raw === undefined) continue;
    const content = decodeTitleEntities(raw)
      .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '')
      .replace(/\s+/gu, ' ').trim();
    if (content) fields.set(property, content);
  }
  const title = fields.get('og:title');
  // A generic landing/consent page is not a song. Never fall back to <title>,
  // oEmbed, or uploader names when the requested Open Graph title is absent.
  if (!title || /^(YouTube Music|YouTube)$/i.test(title)) return null;
  return { title, artist: fields.get('og:description') || null };
}

function isSongPage(url) {
  return url.pathname === '/watch' && /^[a-z\d_-]+$/i.test(url.searchParams.get('v') || '');
}

async function fetchYouTubeMusicMetadata(value, fetchImpl = fetch) {
  let url = new URL(value);
  if (!isYouTubeMusicUrl(value) || !['http:', 'https:'].includes(url.protocol) ||
      url.username || url.password || url.port || !isSongPage(url)) {
    throw new Error('Expected a public YouTube Music song URL.');
  }
  url.protocol = 'https:';
  const signal = AbortSignal.timeout(10_000);
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const response = await fetchImpl(url.toString(), {
      headers: { 'accept-language': 'en-US,en;q=0.9', 'user-agent': 'Mozilla/5.0 SOTDDiscordBot/1.0' },
      redirect: 'manual', signal
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location) throw new Error('YouTube Music redirect has no destination.');
      url = new URL(location, url);
      if (!isYouTubeMusicUrl(url.toString()) || url.protocol !== 'https:' || url.username || url.password || url.port) {
        throw new Error('YouTube Music redirected outside its public music website.');
      }
      if (!isSongPage(url)) throw new Error('YouTube Music did not redirect to a song page.');
      continue;
    }
    if (!response.ok) throw new Error(`YouTube Music returned HTTP ${response.status}.`);
    const metadata = parseYouTubeMusicHtml(await response.text());
    if (!metadata) throw new Error('YouTube Music page has no usable og:title.');
    return { ...metadata, metadataSource: YOUTUBE_MUSIC_METADATA_SOURCE };
  }
  throw new Error('Too many YouTube Music redirects.');
}

module.exports = { YOUTUBE_MUSIC_METADATA_SOURCE, isYouTubeMusicUrl, parseYouTubeMusicHtml, fetchYouTubeMusicMetadata };
