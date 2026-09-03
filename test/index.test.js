const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const discord = require('discord.js');

// Exercise the real interaction handler with fake Discord/config dependencies.
// Never load .env, connect to Discord, start timers, or touch the real run data.
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'sotd-interaction-test-')));
const { getGuild, updateGuild } = require('../src/storage');
const entryPath = path.resolve(__dirname, '../src/index.js');
const entrySource = fs.readFileSync(entryPath, 'utf8');
const entryRequire = createRequire(entryPath);

function loadHandler() {
  const listeners = new Map();
  class FakeClient {
    on(event, handler) { listeners.set(event, handler); return this; }
    once(event, handler) { return this.on(event, handler); }
    login() { return Promise.resolve(); }
  }
  vm.runInNewContext(entrySource, {
    require(name) {
      if (name === 'discord.js') return { ...discord, Client: FakeClient };
      if (name === './config') return { token: 'test-only-placeholder' };
      return entryRequire(name);
    },
    console
  }, { filename: entryPath });
  return listeners.get(discord.Events.InteractionCreate);
}

function interaction(commandName) {
  const replies = [], edits = [], followUps = [];
  const value = {
    guildId: 'guild', commandName, memberPermissions: { has: () => true },
    inGuild: () => true, isModalSubmit: () => false, isChatInputCommand: () => true,
    reply: async payload => { replies.push(payload); },
    deferReply: async () => { value.deferred = true; },
    editReply: async payload => { edits.push(payload); },
    followUp: async payload => { followUps.push(payload); }
  };
  return { value, replies, edits, followUps };
}

function startInteraction(failSecondDm = false) {
  updateGuild('guild', () => ({ roleId: 'role', channelId: 'channel', run: null }));
  const result = interaction();
  const dms = [];
  const members = new discord.Collection(['a', 'b'].map(id => [id, {
    id, user: { bot: false }, send: async payload => {
      if (failSecondDm && id === 'b') throw new Error('DMs disabled');
      dms.push({ id, payload });
    }
  }]));
  result.value.isModalSubmit = () => true;
  result.value.customId = 'sotd-duration';
  result.value.fields = { getTextInputValue: field => ({ hours: '48', 'daily-time': '18:00', timezone: 'America/Chicago' })[field] };
  result.value.guild = {
    roles: { fetch: async () => ({ members }) },
    members: { me: {}, fetch: async () => members },
    channels: { fetch: async () => ({
      isTextBased: () => true, isDMBased: () => false, isThread: () => false,
      permissionsFor: () => ({ has: () => true })
    }) }
  };
  return { ...result, dms };
}

test('starting a run shows its deadline and sends the exact selection prompt', async () => {
  const { value, edits, followUps, dms } = startInteraction();
  await loadHandler()(value);
  const run = getGuild('guild').run;
  assert.equal(run.status, 'collecting');
  const timestamp = Math.floor(Date.parse(run.collectionEndsAt) / 1000);
  assert.deepEqual(edits, [`Starting Song Selection - Song selection ends <t:${timestamp}:F>`]);
  assert.deepEqual(dms.map(dm => dm.id), ['a', 'b']);
  assert.ok(dms.every(dm => dm.payload === 'Song selection please provide just the link to the song link from tidal, spotify, apple music or youtube music'));
  assert.equal(followUps.length, 0);
});

test('failed DMs are reported privately without replacing the start wording', async () => {
  const { value, edits, followUps } = startInteraction(true);
  await loadHandler()(value);
  assert.match(edits[0], /^Starting Song Selection - Song selection ends <t:\d+:F>$/);
  assert.equal(edits.length, 1);
  assert.equal(followUps.length, 1);
  assert.equal(followUps[0].ephemeral, true);
  assert.match(followUps[0].content, /1 member\(s\) could not be DMed/);
  assert.deepEqual(getGuild('guild').run.failedDmIds, ['b']);
});

for (const command of ['end-run', 'skip-person']) {
  test(`${command} ends the run with That's all folks`, async () => {
    updateGuild('guild', () => ({ roleId: 'role', run: {
      id: 'run', status: 'presenting', currentIndex: 0, schedule: [{ userId: 'a' }]
    } }));
    const { value, replies } = interaction(command);
    await loadHandler()(value);
    assert.deepEqual(replies, ["That's all folks"]);
    assert.equal(getGuild('guild').run.status, 'ended');
    assert.ok(getGuild('guild').run.endedAt);
  });
}
