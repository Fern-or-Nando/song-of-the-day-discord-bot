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
const { SELECTION_MODAL_ID } = require('../src/run-setup');
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
      if (name === './config') return { token: 'test-only-placeholder', timezone: 'America/Chicago' };
      return entryRequire(name);
    },
    console
  }, { filename: entryPath });
  return listeners.get(discord.Events.InteractionCreate);
}

function interaction(commandName) {
  const replies = [], edits = [], followUps = [];
  const value = {
    guildId: 'guild', commandName, user: { id: 'manager' }, memberPermissions: { has: () => true },
    inGuild: () => true, isModalSubmit: () => false, isButton: () => false, isChatInputCommand: () => true,
    reply: async payload => { replies.push(payload); },
    deferReply: async () => { value.deferred = true; },
    editReply: async payload => { edits.push(payload); },
    followUp: async payload => { followUps.push(payload); }
  };
  return { value, replies, edits, followUps };
}

async function startInteraction(failSecondDm = false) {
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
  result.value.customId = SELECTION_MODAL_ID;
  const future = new Date(Date.now() + 2 * 86400000);
  result.value.fields = {
    getTextInputValue: field => field === 'selection-month' ? String(future.getUTCMonth() + 1) : String(future.getUTCDate()),
    getStringSelectValues: field => [field.endsWith('-hour') ? '6' : 'PM']
  };
  result.value.guild = {
    roles: { fetch: async () => ({ members }) },
    members: { me: {}, fetch: async () => members },
    channels: { fetch: async () => ({
      isTextBased: () => true, isDMBased: () => false, isThread: () => false,
      permissionsFor: () => ({ has: () => true })
    }) }
  };
  const handler = loadHandler();
  await handler(result.value);
  assert.equal(getGuild('guild').run, null, 'selection step must not create a run');
  result.value.customId = result.replies[0].components[0].toJSON().components[0].custom_id;
  result.value.isModalSubmit = () => false;
  result.value.isButton = () => true;
  let modal;
  result.value.showModal = async builder => { modal = builder.toJSON(); };
  await handler(result.value);
  result.value.customId = modal.custom_id;
  result.value.isModalSubmit = () => true;
  result.value.isButton = () => false;
  result.replies.length = 0;
  return { ...result, dms, handler };
}

test('starting a run shows its deadline and sends the exact selection prompt', async () => {
  const { value, edits, followUps, dms, handler } = await startInteraction();
  await handler(value);
  const run = getGuild('guild').run;
  assert.equal(run.status, 'collecting');
  assert.equal(run.dailyTime, '18:00');
  assert.equal(run.timezone, 'America/Chicago');
  const timestamp = Math.floor(Date.parse(run.collectionEndsAt) / 1000);
  assert.deepEqual(edits, [`Starting Song Selection - Song selection ends <t:${timestamp}:F>`]);
  assert.deepEqual(dms.map(dm => dm.id), ['a', 'b']);
  assert.ok(dms.every(dm => dm.payload === 'Song selection please provide just the link to the song link from tidal, spotify, apple music or youtube music'));
  assert.equal(followUps.length, 0);
});

test('failed DMs are reported privately without replacing the start wording', async () => {
  const { value, edits, followUps, handler } = await startInteraction(true);
  await handler(value);
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

test('start form has separate month/day inputs and hour/AM-PM dropdowns', async () => {
  const { value } = interaction('start-sotd-run');
  let modal;
  value.showModal = async builder => { modal = builder.toJSON(); };
  await loadHandler()(value);
  assert.equal(modal.custom_id, SELECTION_MODAL_ID);
  assert.equal(modal.components.length, 4);
  const inputs = modal.components.map(label => label.component);
  assert.deepEqual(inputs.map(input => input.custom_id), ['selection-month', 'selection-day', 'selection-hour', 'selection-period']);
  assert.ok(inputs.every(input => input.required));
  assert.deepEqual(inputs.map(input => input.type), [4, 4, 3, 3]);
  assert.doesNotMatch(JSON.stringify(modal), /minute|year|sotd-duration/);
});

test('old duration form asks the user to reopen the new form', async () => {
  const { value, replies, dms } = await startInteraction();
  value.customId = 'sotd-duration';
  await loadHandler()(value);
  assert.match(replies[0].content, /reopen \/start-sotd-run/);
  assert.equal(getGuild('guild').run, null);
  assert.equal(dms.length, 0);
});

test('invalid month/day submissions do not start a run or send invites', async () => {
  const { value, replies, dms } = await startInteraction();
  value.customId = SELECTION_MODAL_ID;
  value.fields.getTextInputValue = field => field === 'selection-month' ? '13' : '1';
  await loadHandler()(value);
  assert.match(replies[0].content, /valid month/);
  assert.equal(getGuild('guild').run, null);
  assert.equal(dms.length, 0);
});

test('replaying the final setup submission cannot send duplicate invitations', async () => {
  const { value, replies, dms, handler } = await startInteraction();
  await handler(value);
  const runId = getGuild('guild').run.id;
  await handler(value);
  assert.equal(getGuild('guild').run.id, runId);
  assert.equal(dms.length, 2);
  assert.match(replies.at(-1).content, /already used/);
});
