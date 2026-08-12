const fs = require('fs');
const path = require('path');

const storagePath = path.resolve(process.cwd(), 'data', 'storage.json');
const emptyStore = { guilds: {} };

function readStore() {
  fs.mkdirSync(path.dirname(storagePath), { recursive: true });
  if (!fs.existsSync(storagePath)) fs.writeFileSync(storagePath, JSON.stringify(emptyStore, null, 2));
  try {
    const data = JSON.parse(fs.readFileSync(storagePath, 'utf8'));
    return { guilds: data.guilds || {} };
  } catch (error) {
    console.error('Storage was invalid; starting with an empty store:', error);
    return structuredClone(emptyStore);
  }
}

function writeStore(store) {
  fs.mkdirSync(path.dirname(storagePath), { recursive: true });
  fs.writeFileSync(storagePath, JSON.stringify(store, null, 2));
}

function getGuild(guildId) {
  return readStore().guilds[guildId] || { roleId: null, channelId: null, run: null };
}

function updateGuild(guildId, updater) {
  const store = readStore();
  const current = store.guilds[guildId] || { roleId: null, channelId: null, run: null };
  store.guilds[guildId] = updater(current) || current;
  writeStore(store);
  return store.guilds[guildId];
}

function findCollectingRunForUser(userId) {
  const store = readStore();
  return Object.entries(store.guilds).find(([, guild]) =>
    guild.run?.status === 'collecting' && guild.run.participantIds.includes(userId)
  ) || null;
}

module.exports = { findCollectingRunForUser, getGuild, updateGuild };
