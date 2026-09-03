const DEFAULT_TIMEZONE = 'America/Chicago';

function localParts(instant, timezone) {
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  });
  return Object.fromEntries(formatter.formatToParts(new Date(instant)).map(part => [part.type, Number(part.value)]));
}

function localDateInstants(year, month, day, hour, minute, second, timezone) {
  const wallClock = Date.UTC(year, month - 1, day, hour, minute, second);
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  });
  const matches = [];
  // Resolve local clock time using real instants, including DST gaps/repeats.
  for (let candidate = wallClock - 26 * 3600000; candidate <= wallClock + 26 * 3600000; candidate += 60000) {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(candidate)).map(part => [part.type, Number(part.value)]));
    if (parts.year === year && parts.month === month && parts.day === day &&
        parts.hour === hour && parts.minute === minute && parts.second === second) matches.push(candidate);
  }
  return matches;
}

function hourlyTime(hour, period) {
  if (!/^(?:[1-9]|1[0-2])$/.test(String(hour)) || !['AM', 'PM'].includes(period)) {
    throw new Error('Choose an hour from 1 to 12 and AM or PM.');
  }
  return `${String(Number(hour) % 12 + (period === 'PM' ? 12 : 0)).padStart(2, '0')}:00`;
}

function nextSelectionDeadline(monthInput, dayInput, hour, period, now = Date.now(), timezone = DEFAULT_TIMEZONE) {
  const monthText = String(monthInput).trim(), dayText = String(dayInput).trim();
  const month = Number(monthText), day = Number(dayText);
  if (!/^\d{1,2}$/.test(monthText) || month < 1 || month > 12 ||
      !/^\d{1,2}$/.test(dayText) || day < 1 || day > new Date(Date.UTC(2000, month, 0)).getUTCDate()) {
    throw new Error('Enter a valid month (1–12) and day for that month.');
  }
  const hour24 = Number(hourlyTime(hour, period).slice(0, 2));
  const current = localParts(now, timezone);
  const currentWallClock = Date.UTC(current.year, current.month - 1, current.day, current.hour, current.minute, current.second);
  // Leap-day selection may need up to eight years across a non-leap century.
  for (let year = current.year; year <= current.year + 8; year += 1) {
    if (day > new Date(Date.UTC(year, month, 0)).getUTCDate()) continue;
    if (Date.UTC(year, month - 1, day) < Date.UTC(current.year, current.month - 1, current.day)) continue;
    const matches = localDateInstants(year, month, day, hour24, 0, 0, timezone);
    if (!matches.length) {
      if (Date.UTC(year, month - 1, day, hour24) < currentWallClock) continue;
      throw new Error(`That hour does not occur on that date in ${timezone} because of a clock change. Choose another hour.`);
    }
    const next = matches.find(instant => instant > now);
    if (next !== undefined) return new Date(next);
  }
  throw new Error('Could not find the next occurrence of that date and hour.');
}

function nextDaily(time, timezone = DEFAULT_TIMEZONE, now = Date.now()) {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error('Daily time must be HH:mm (24-hour clock).');
  const formatter = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  // Search real instants: this handles timezone offsets and daylight-saving transitions.
  for (let instant = Math.floor(now / 60000) * 60000 + 60000; instant <= now + 49 * 3600000; instant += 60000) {
    if (formatter.format(new Date(instant)) === time) return new Date(instant).toISOString();
  }
  throw new Error('Could not find the next daily posting time.');
}

function selectionDeadline(input, now = Date.now(), timezone = DEFAULT_TIMEZONE) {
  const match = input.trim().match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(Z|[+-]\d{2}:\d{2})?$/);
  if (!match) throw new Error(`Enter the selection end date and time as YYYY-MM-DD HH:mm (${timezone}), not a number of hours.`);
  const [, year, month, day, hour, minute, second = '00', offset] = match;
  const wallClock = Date.UTC(+year, +month - 1, +day, +hour, +minute, +second);
  const date = new Date(wallClock);
  if (date.getUTCFullYear() !== +year || date.getUTCMonth() !== +month - 1 || date.getUTCDate() !== +day ||
      +hour > 23 || +minute > 59 || +second > 59) {
    throw new Error('Enter a valid calendar date and time.');
  }
  let instant;
  if (offset) {
    instant = Date.parse(`${year}-${month}-${day}T${hour}:${minute}:${second}${offset}`);
  } else {
    const matches = localDateInstants(+year, +month, +day, +hour, +minute, +second, timezone);
    if (!matches.length) throw new Error(`That local time does not exist in ${timezone} because of a clock change. Choose another time.`);
    if (matches.length > 1) throw new Error('That local time occurs twice. Include a UTC offset, for example YYYY-MM-DDTHH:mm-06:00.');
    [instant] = matches;
  }
  if (!Number.isFinite(instant) || instant <= now || instant > now + 366 * 86400000) throw new Error('Selection must end in the future, within 366 days.');
  return new Date(instant);
}

module.exports = { DEFAULT_TIMEZONE, nextDaily, selectionDeadline, hourlyTime, nextSelectionDeadline };
