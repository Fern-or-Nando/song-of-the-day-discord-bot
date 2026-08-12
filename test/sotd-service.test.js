const test = require('node:test');
const assert = require('node:assert/strict');
const { validateSongUrl } = require('../src/sotd-service');

test('accepts supported music services', () => {
  for (const url of [
    'https://open.spotify.com/track/abc',
    'https://spotify.link/abc',
    'https://music.apple.com/us/album/example/123?i=456',
    'https://music.youtube.com/watch?v=abc',
    'https://youtu.be/abc',
    'https://tidal.com/browse/track/123',
    'https://link.tidal.com/abc'
  ]) assert.ok(validateSongUrl(url), url);
});

test('rejects text, unsupported hosts, and deceptive subdomains', () => {
  for (const value of ['hello', 'https://example.com/song', 'https://open.spotify.com.evil.test/track/abc']) {
    assert.equal(validateSongUrl(value), null, value);
  }
});
