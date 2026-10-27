// Small shared helpers.

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function bad(message) {
  return new HttpError(400, message);
}

const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32, no I L O U

export function randomCode(len = 16) {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  let out = '';
  for (const b of bytes) out += CODE_ALPHABET[b & 31];
  return out;
}

export function formatAccountCode(code) {
  return code.match(/.{1,4}/g).join('-');
}

// Accept what people actually type: lowercase, spaces, dashes, O for 0, I/L for 1.
export function normalizeAccountCode(input) {
  return String(input || '')
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
}

export function randomHex(bytes = 16) {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function clampNumber(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.min(max, Math.max(min, n));
}

export function isValidSymbol(symbol) {
  return typeof symbol === 'string' && /^[A-Z][A-Z0-9.\-]{0,9}$/.test(symbol);
}

export function fmtPrice(n) {
  if (n == null || !Number.isFinite(n)) return '—';
  return n >= 1000 ? n.toFixed(2) : n >= 1 ? n.toFixed(2) : n.toFixed(4);
}

export function fmtPct(n) {
  if (n == null || !Number.isFinite(n)) return '';
  const sign = n > 0 ? '+' : n < 0 ? '−' : '';
  return `${sign}${Math.abs(n).toFixed(2)}%`;
}

// "10/27 22:14" in the user's time zone.
export function fmtUserTime(ms, timeZone) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timeZone || 'UTC',
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date(ms));
    const get = (t) => parts.find((p) => p.type === t)?.value;
    return `${get('month')}/${get('day')} ${get('hour')}:${get('minute')}`;
  } catch {
    return new Date(ms).toISOString().slice(5, 16).replace('T', ' ');
  }
}

export function minutesInZone(ms, timeZone) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timeZone || 'UTC',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date(ms));
    const h = Number(parts.find((p) => p.type === 'hour').value);
    const m = Number(parts.find((p) => p.type === 'minute').value);
    return h * 60 + m;
  } catch {
    const d = new Date(ms);
    return d.getUTCHours() * 60 + d.getUTCMinutes();
  }
}

export function isValidTimeZone(tz) {
  if (typeof tz !== 'string' || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
