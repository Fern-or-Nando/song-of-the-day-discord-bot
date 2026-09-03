const test = require('node:test');
const assert = require('node:assert/strict');
const { selectionDeadline, nextDaily, hourlyTime, nextSelectionDeadline } = require('../src/schedule');

test('local deadlines follow the configured timezone and seasonal offset', () => {
  const now = Date.parse('2026-09-01T00:00:00Z');
  assert.equal(selectionDeadline('2026-09-05 18:00', now).toISOString(), '2026-09-05T23:00:00.000Z');
  assert.equal(selectionDeadline('2026-12-05 18:00', now).toISOString(), '2026-12-06T00:00:00.000Z');
  assert.equal(selectionDeadline('2026-09-05 18:00', now, 'Asia/Kolkata').toISOString(), '2026-09-05T12:30:00.000Z');
});

test('rejects impossible dates, invalid times, missing dates, and hours-only input', () => {
  const now = Date.parse('2026-01-01T00:00:00Z');
  for (const input of ['48', '1.5', '18:00', '2026-02-29 12:00', '2026-04-31T12:00Z',
    '2026-13-01 12:00', '2026-09-05 24:00', '2026-09-05 18:60', '2026-09-05T18:00:60Z']) {
    assert.throws(() => selectionDeadline(input, now), input);
  }
  assert.equal(selectionDeadline('2028-02-29 12:00', Date.parse('2028-01-01T00:00Z')).toISOString(), '2028-02-29T18:00:00.000Z');
});

test('rejects skipped DST times and requires an offset to disambiguate repeated times', () => {
  const now = Date.parse('2026-01-01T00:00:00Z');
  assert.throws(() => selectionDeadline('2026-03-08 02:30', now), /does not exist/);
  assert.throws(() => selectionDeadline('2026-11-01 01:30', now), /occurs twice/);
  assert.equal(selectionDeadline('2026-11-01T01:30-05:00', now).toISOString(), '2026-11-01T06:30:00.000Z');
  assert.equal(selectionDeadline('2026-11-01T01:30-06:00', now).toISOString(), '2026-11-01T07:30:00.000Z');
});

test('end date must be in the future and within 366 days', () => {
  const now = Date.parse('2026-09-05T23:00:00Z');
  assert.throws(() => selectionDeadline('2026-09-05 18:00', now), /future/);
  assert.throws(() => selectionDeadline('2026-09-04 18:00', now), /future/);
  assert.throws(() => selectionDeadline('2030-09-05 18:00', now), /366 days/);
});

test('first announcement uses the next chosen clock time, today or tomorrow', () => {
  assert.equal(nextDaily('18:00', 'America/Chicago', Date.parse('2026-09-05T22:59:00Z')), '2026-09-05T23:00:00.000Z');
  assert.equal(nextDaily('18:00', 'America/Chicago', Date.parse('2026-09-05T23:01:00Z')), '2026-09-06T23:00:00.000Z');
});

test('hour dropdowns convert noon, midnight, AM and PM into whole-hour times', () => {
  assert.equal(hourlyTime('12', 'AM'), '00:00');
  assert.equal(hourlyTime('12', 'PM'), '12:00');
  assert.equal(hourlyTime('1', 'AM'), '01:00');
  assert.equal(hourlyTime('6', 'PM'), '18:00');
  for (const hour of ['0', '13', '6:30', '1.5', '']) assert.throws(() => hourlyTime(hour, 'AM'));
  assert.throws(() => hourlyTime('1', 'morning'));
});

test('month/day without a year selects the next future date/hour in the local timezone', () => {
  const now = Date.parse('2026-09-03T12:00:00Z');
  assert.equal(nextSelectionDeadline('9', '5', '6', 'PM', now).toISOString(), '2026-09-05T23:00:00.000Z');
  assert.equal(nextSelectionDeadline('9', '1', '6', 'PM', now).toISOString(), '2027-09-01T23:00:00.000Z');
  assert.equal(nextSelectionDeadline('9', '3', '8', 'AM', now).toISOString(), '2026-09-03T13:00:00.000Z');
  assert.equal(nextSelectionDeadline('9', '3', '6', 'AM', now).toISOString(), '2027-09-03T11:00:00.000Z');
  assert.equal(nextSelectionDeadline('1', '1', '12', 'AM', Date.parse('2026-12-31T23:00Z')).toISOString(), '2027-01-01T06:00:00.000Z');
  assert.equal(nextSelectionDeadline('9', '5', '12', 'PM', now, 'Asia/Kolkata').toISOString(), '2026-09-05T06:30:00.000Z');
});

test('yearless date input rejects impossible dates and waits for the next leap day', () => {
  const now = Date.parse('2026-09-03T12:00:00Z');
  for (const [month, day] of [['0','1'], ['13','1'], ['4','31'], ['2','30'], ['1','0'], ['1','32'], ['9.5','1'], ['9','5th'], ['','1']]) {
    assert.throws(() => nextSelectionDeadline(month, day, '6', 'PM', now), /valid month/);
  }
  assert.equal(nextSelectionDeadline('02', '29', '12', 'PM', now).toISOString(), '2028-02-29T18:00:00.000Z');
  assert.equal(nextSelectionDeadline('2', '29', '12', 'PM', Date.parse('2096-03-01T00:00:00Z')).toISOString(), '2104-02-29T18:00:00.000Z');
});

test('yearless hours handle clock-change gaps and choose the next real repeated hour', () => {
  assert.throws(() => nextSelectionDeadline('3', '8', '2', 'AM', Date.parse('2026-03-01T00:00Z')), /Choose another hour/);
  assert.equal(nextSelectionDeadline('11', '1', '1', 'AM', Date.parse('2026-10-31T00:00Z')).toISOString(), '2026-11-01T06:00:00.000Z');
  assert.equal(nextSelectionDeadline('11', '1', '1', 'AM', Date.parse('2026-11-01T06:30Z')).toISOString(), '2026-11-01T07:00:00.000Z');
});
