function nextDaily(time, timezone, now = Date.now()) {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error('Daily time must be HH:mm (24-hour clock).');
  const formatter = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  // Search real instants: this handles timezone offsets and daylight-saving transitions.
  for (let instant = Math.floor(now / 60000) * 60000 + 60000; instant <= now + 49 * 3600000; instant += 60000) {
    if (formatter.format(new Date(instant)) === time) return new Date(instant).toISOString();
  }
  throw new Error('Could not find the next daily posting time.');
}

function selectionDeadline(input, now = Date.now()) {
  let instant;
  if (/^\d+(\.\d+)?$/.test(input.trim())) instant = now + Number(input) * 3600000;
  else {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:\d{2})$/.test(input.trim())) {
      throw new Error('Enter hours (e.g. 48) or a date with UTC offset (e.g. 2026-09-05T18:00-05:00).');
    }
    instant = Date.parse(input);
  }
  if (!Number.isFinite(instant) || instant <= now || instant > now + 366 * 86400000) throw new Error('Selection must end in the future, within 366 days.');
  return new Date(instant);
}

module.exports = { nextDaily, selectionDeadline };
