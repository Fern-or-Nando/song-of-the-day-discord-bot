const test = require('node:test');
const assert = require('node:assert/strict');
const { ModalSubmitFields } = require('discord.js');
const { createRunSetup, SELECTION_MODAL_ID, SETUP_TTL } = require('../src/run-setup');

const NOW = Date.parse('2026-09-03T12:00:00Z');
const dateFields = { 'selection-month': '9', 'selection-day': '5' };
const selectionTime = { 'selection-hour': ['6'], 'selection-period': ['PM'] };

function interaction(type, customId, text = {}, selects = {}, userId = 'owner', guildId = 'guild') {
  const result = {
    customId, user: { id: userId }, guildId, replies: [], updates: [], modal: null,
    isModalSubmit: () => type === 'modal', isButton: () => type === 'button',
    fields: new ModalSubmitFields([
      ...Object.entries(text).map(([customId, value]) => ({ type: 18, component: { type: 4, customId, value } })),
      ...Object.entries(selects).map(([customId, values]) => ({ type: 18, component: { type: 3, customId, values } }))
    ]),
    reply: async payload => { result.replies.push(payload); },
    update: async payload => { result.updates.push(payload); },
    showModal: async builder => { result.modal = builder.toJSON(); }
  };
  return result;
}

async function draft(setup, text = dateFields, selects = selectionTime) {
  const first = interaction('modal', SELECTION_MODAL_ID, text, selects);
  assert.equal(await setup.handle(first), null);
  const buttons = first.replies[0].components[0].toJSON().components;
  return { first, buttonId: buttons[0].custom_id, cancelId: buttons[1].custom_id };
}

async function announcement(setup, buttonId) {
  const button = interaction('button', buttonId);
  assert.equal(await setup.handle(button), null);
  return button;
}

function confirm(modalId, hour = '6', period = 'PM') {
  return interaction('modal', modalId, {}, { 'announcement-hour': [hour], 'announcement-period': [period] });
}

function assertTimeDropdowns(labels, prefix) {
  const hour = labels.find(label => label.component.custom_id === `${prefix}-hour`).component;
  const period = labels.find(label => label.component.custom_id === `${prefix}-period`).component;
  assert.equal(hour.type, 3);
  assert.equal(period.type, 3);
  assert.deepEqual(hour.options.map(option => option.label), Array.from({ length: 12 }, (_, i) => String(i + 1)));
  assert.deepEqual(period.options.map(option => option.label), ['AM', 'PM']);
  for (const select of [hour, period]) {
    assert.equal(select.min_values, 1);
    assert.equal(select.max_values, 1);
    assert.equal(select.required, true);
  }
}

test('both forms serialize valid labeled dropdowns with no year/minute fields', async t => {
  t.mock.method(Date, 'now', () => NOW);
  const setup = createRunSetup();
  const start = interaction('command');
  await setup.open(start);
  assert.equal(start.modal.components.length, 4);
  assertTimeDropdowns(start.modal.components, 'selection');
  const { first, buttonId } = await draft(setup);
  assert.equal(first.replies[0].ephemeral, true);
  assert.match(first.replies[0].content, /No run or invitations/);
  const { modal } = await announcement(setup, buttonId);
  assert.equal(modal.components.length, 2);
  assertTimeDropdowns(modal.components, 'announcement');
  for (const form of [start.modal, modal]) {
    assert.ok(form.custom_id.length <= 100);
    assert.ok(form.title.length <= 45);
    assert.ok(form.components.length <= 5);
    assert.ok(form.components.every(label => label.type === 18));
    assert.doesNotMatch(JSON.stringify(form), /minute|year/);
  }
});

test('confirmed setup returns the saved deadline and a whole-hour announcement exactly once', async t => {
  t.mock.method(Date, 'now', () => NOW);
  const setup = createRunSetup();
  const { buttonId } = await draft(setup);
  const { modal } = await announcement(setup, buttonId);
  const submission = confirm(modal.custom_id, '12', 'AM');
  const result = await setup.handle(submission);
  assert.equal(result.deadline.toISOString(), '2026-09-05T23:00:00.000Z');
  assert.equal(result.dailyTime, '00:00');
  assert.equal(result.timezone, 'America/Chicago');
  assert.equal(await setup.handle(submission), null);
  assert.match(submission.replies[0].content, /already used/);
});

test('only the initiating member in the same server may continue or confirm setup', async t => {
  t.mock.method(Date, 'now', () => NOW);
  const setup = createRunSetup();
  const { buttonId } = await draft(setup);
  for (const [user, guild] of [['intruder','guild'], ['owner','other-guild']]) {
    const button = interaction('button', buttonId, {}, {}, user, guild);
    assert.equal(await setup.handle(button), null);
    assert.equal(button.modal, null);
    assert.match(button.replies[0].content, /Only the member/);
  }
  const { modal } = await announcement(setup, buttonId);
  const foreign = confirm(modal.custom_id);
  foreign.user.id = 'intruder';
  assert.equal(await setup.handle(foreign), null);
  assert.match(foreign.replies[0].content, /Only the member/);
  assert.equal((await setup.handle(confirm(modal.custom_id))).dailyTime, '18:00');
});

test('cancel consumes the draft without creating a schedule', async t => {
  t.mock.method(Date, 'now', () => NOW);
  const setup = createRunSetup();
  const { buttonId, cancelId } = await draft(setup);
  const cancel = interaction('button', cancelId);
  assert.equal(await setup.handle(cancel), null);
  assert.deepEqual(cancel.updates, [{ content: 'Song of the Day setup cancelled.', components: [] }]);
  const button = await announcement(setup, buttonId);
  assert.equal(button.modal, null);
  assert.match(button.replies[0].content, /already used/);
});

test('expired and restarted drafts ask the user to reopen setup', async t => {
  let now = NOW;
  t.mock.method(Date, 'now', () => now);
  const setup = createRunSetup();
  const { buttonId } = await draft(setup);
  const restarted = await announcement(createRunSetup(), buttonId);
  assert.match(restarted.replies[0].content, /expired/);
  now += SETUP_TTL;
  const expired = await announcement(setup, buttonId);
  assert.equal(expired.modal, null);
  assert.match(expired.replies[0].content, /expired/);
});

test('a deadline that passes between steps never silently rolls into next year', async t => {
  let now = Date.parse('2026-09-03T22:55:00Z');
  t.mock.method(Date, 'now', () => now);
  const setup = createRunSetup();
  const { buttonId } = await draft(setup, { 'selection-month': '9', 'selection-day': '3' });
  const { modal } = await announcement(setup, buttonId);
  now += 6 * 60000;
  const submission = confirm(modal.custom_id);
  assert.equal(await setup.handle(submission), null);
  assert.match(submission.replies[0].content, /end time has passed/);
});

test('invalid dates and missing selection values produce errors instead of drafts', async t => {
  t.mock.method(Date, 'now', () => NOW);
  const setup = createRunSetup();
  const invalid = interaction('modal', SELECTION_MODAL_ID, { 'selection-month': '4', 'selection-day': '31' }, selectionTime);
  assert.equal(await setup.handle(invalid), null);
  assert.match(invalid.replies[0].content, /valid month/);
  assert.equal(invalid.replies[0].components, undefined);
  const missing = interaction('modal', SELECTION_MODAL_ID, dateFields, { ...selectionTime, 'selection-hour': [] });
  assert.equal(await setup.handle(missing), null);
  assert.match(missing.replies[0].content, /Choose one value/);
});

test('minute-based announcement input is rejected, and the draft remains available for a valid retry', async t => {
  t.mock.method(Date, 'now', () => NOW);
  const setup = createRunSetup();
  const { buttonId } = await draft(setup);
  const { modal } = await announcement(setup, buttonId);
  const invalid = confirm(modal.custom_id, '6:30');
  assert.equal(await setup.handle(invalid), null);
  assert.match(invalid.replies[0].content, /hour from 1 to 12/);
  assert.equal((await setup.handle(confirm(modal.custom_id, '12', 'PM'))).dailyTime, '12:00');
});

test('a newer deadline setup invalidates the same member’s previous draft', async t => {
  t.mock.method(Date, 'now', () => NOW);
  const setup = createRunSetup();
  const previous = await draft(setup);
  const current = await draft(setup);
  const oldButton = await announcement(setup, previous.buttonId);
  assert.equal(oldButton.modal, null);
  assert.ok((await announcement(setup, current.buttonId)).modal);
});
