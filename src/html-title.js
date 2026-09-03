function decodeTitleEntities(value) {
  const named = {
    amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ',
    lrm: '\u200e', rlm: '\u200f', ndash: '\u2013', mdash: '\u2014',
    lsquo: '\u2018', rsquo: '\u2019', ldquo: '\u201c', rdquo: '\u201d',
    hellip: '\u2026'
  };
  // Decode once: &amp;quot; is literal &quot;, not a quotation mark.
  return value.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (entity, key) => {
    if (!key.startsWith('#')) return named[key] ?? entity;
    const point = /^#x/i.test(key) ? parseInt(key.slice(2), 16) : Number(key.slice(1));
    return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff)
      ? String.fromCodePoint(point) : '\ufffd';
  });
}

function readDocumentTitle(html) {
  const title = html.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i)?.[1];
  return title ? decodeTitleEntities(title) : null;
}

module.exports = { readDocumentTitle, decodeTitleEntities };
