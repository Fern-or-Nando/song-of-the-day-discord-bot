const test = require('node:test');
const assert = require('node:assert/strict');
const { SONG_SELECTION_PROMPT, RUN_ENDED, selectionStarted, songChosen, songAnnouncement } = require('../src/messages');

test('selection and completion messages use the requested wording', () => {
  const deadline = new Date('2026-09-05T18:00:00-05:00');
  assert.equal(selectionStarted(deadline), `Starting Song Selection - Song selection ends <t:${deadline.getTime() / 1000}:F>`);
  assert.equal(selectionStarted(deadline.toISOString()), selectionStarted(deadline));
  assert.equal(SONG_SELECTION_PROMPT, 'Song selection please provide just the link to the song link from tidal, spotify, apple music or youtube music');
  assert.equal(RUN_ENDED, "That's all folks");
});

test('song messages keep names intact and omit an unavailable artist', () => {
  const song = { title: 'Stand by Me - Live', artist: 'Band - One' };
  assert.equal(songChosen(song), 'Song choosen Stand by Me - Live - Band - One');
  assert.equal(songChosen({ title: 'Song', artist: null }), 'Song choosen Song');
  assert.equal(songAnnouncement('role', 'user', song, 'https://example.com/song'),
    '<@&role> song of the day is Stand by Me - Live - Band - One choosen by <@user>\nhttps://example.com/song');
});
