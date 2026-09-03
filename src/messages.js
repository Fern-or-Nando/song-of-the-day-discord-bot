const SONG_SELECTION_PROMPT = 'Song selection please provide just the link to the song link from tidal, spotify, apple music or youtube music';
const RUN_ENDED = "That's all folks";

function selectionStarted(deadline) {
  return `Starting Song Selection - Song selection ends <t:${Math.floor(new Date(deadline).getTime() / 1000)}:F>`;
}

function songLabel({ title, artist }) {
  return artist ? `${title} - ${artist}` : title;
}

function songChosen(song) {
  return `Song choosen ${songLabel(song)}`;
}

function songAnnouncement(roleId, userId, song, url) {
  return `<@&${roleId}> song of the day is ${songLabel(song)} choosen by <@${userId}>\n${url}`;
}

function runStarted(roleId, firstPostAt, everyoneSubmitted) {
  const reason = everyoneSubmitted ? 'Everyone has submitted a song. ' : '';
  return `<@&${roleId}> ${reason}Song selection has ended. The Song of the Day run has started! ` +
    `The first song will be announced <t:${Math.floor(Date.parse(firstPostAt) / 1000)}:F>.`;
}

module.exports = { SONG_SELECTION_PROMPT, RUN_ENDED, selectionStarted, songLabel, songChosen, songAnnouncement, runStarted };
