// US stock market (NYSE / Nasdaq) regular session: 9:30–16:00 New York time, Mon–Fri.
// Holidays and early closes below need updating once a year.

const NY = 'America/New_York';

export const HOLIDAYS = new Set([
  // 2026
  '2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25', '2026-06-19',
  '2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25',
  // 2027
  '2027-01-01', '2027-01-18', '2027-02-15', '2027-03-26', '2027-05-31', '2027-06-18',
  '2027-07-05', '2027-09-06', '2027-11-25', '2027-12-24',
]);

// Days the market closes at 13:00 New York time.
export const EARLY_CLOSE = new Set(['2026-11-27', '2026-12-24', '2027-11-26']);

const OPEN_MIN = 9 * 60 + 30;
const CLOSE_MIN = 16 * 60;
const EARLY_CLOSE_MIN = 13 * 60;

// Calendar date, weekday and minutes since midnight in New York for a timestamp.
export function nyParts(ms) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: NY,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(ms));
  const get = (t) => parts.find((p) => p.type === t).value;
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    weekday,
    minutes: Number(get('hour')) * 60 + Number(get('minute')),
  };
}

export function isTradingDay(date, weekday) {
  return weekday >= 1 && weekday <= 5 && !HOLIDAYS.has(date);
}

function closeMinutes(date) {
  return EARLY_CLOSE.has(date) ? EARLY_CLOSE_MIN : CLOSE_MIN;
}

// Current market state plus the next open time, used for the countdown banner.
export function marketState(ms, { forceOpen = false } = {}) {
  const p = nyParts(ms);
  const trading = isTradingDay(p.date, p.weekday);
  const close = closeMinutes(p.date);
  const open = forceOpen || (trading && p.minutes >= OPEN_MIN && p.minutes < close);
  // Minutes since today's close, if today was a trading day and it has closed.
  const sinceClose = trading && p.minutes >= close ? p.minutes - close : null;

  let nextOpenMs = null;
  let closesAtMs = null;
  if (open && !forceOpen) {
    closesAtMs = ms + (close - p.minutes) * 60000;
  } else if (!open) {
    nextOpenMs = findNextOpen(ms);
  }
  return { open, date: p.date, minutes: p.minutes, tradingDay: trading, sinceClose, nextOpenMs, closesAtMs };
}

// Walk forward minute-accurately: step to 9:30 NY on the next trading day.
function findNextOpen(ms) {
  let t = ms;
  for (let i = 0; i < 10; i++) {
    const p = nyParts(t);
    if (isTradingDay(p.date, p.weekday) && p.minutes < OPEN_MIN) {
      return t + (OPEN_MIN - p.minutes) * 60000 - (new Date(t).getUTCSeconds() * 1000 + new Date(t).getUTCMilliseconds());
    }
    // Jump to just after midnight NY of the next day.
    t = t + (24 * 60 - p.minutes) * 60000 + 60000;
  }
  return null;
}
