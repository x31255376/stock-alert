// Market data sources.
//  - Live price: Finnhub /quote (free plan: 60 calls/minute)
//  - Daily bars for indicators: Twelve Data /time_series (free plan: 8 credits/minute, 800/day)
//  - Demo mode (no Finnhub key, or DATA_MODE=mock): simulated prices so the app can be tried right away.
import { getMeta } from './db.js';
import { nyParts, isTradingDay } from './market.js';

export const TD_DAILY_CAP = 760;
export const BAR_COUNT = 260; // enough for MA200 plus smoothing

export function isDemo(env) {
  return env.DATA_MODE === 'mock' || !env.FINNHUB_KEY;
}

export function hasBarSource(env) {
  return isDemo(env) || Boolean(env.TWELVEDATA_KEY);
}

async function getJson(url, init) {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
  return res.json();
}

// ---------- quotes ----------

export async function fetchQuote(env, symbol, now = Date.now()) {
  if (isDemo(env)) return mockQuote(symbol, now);
  const url = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${env.FINNHUB_KEY}`;
  const q = await getJson(url);
  if (!q || !q.c) return null; // unknown symbol
  return {
    price: q.c,
    change: q.d,
    changePct: q.dp,
    prevClose: q.pc,
    open: q.o,
    high: q.h,
    low: q.l,
    ts: q.t ? q.t * 1000 : now,
  };
}

// ---------- daily bars ----------

export async function twelveDataCreditsLeft(env, now = Date.now()) {
  const key = `td_credits:${nyParts(now).date}`;
  const used = Number((await getMeta(env.DB, key)) || 0);
  return { key, used, left: TD_DAILY_CAP - used };
}

// Returns bars oldest first, or null if no source is configured.
export async function fetchBars(env, symbol, now = Date.now()) {
  if (isDemo(env)) return mockBars(symbol, now);
  if (!env.TWELVEDATA_KEY) return null;
  // Credits are counted by the caller (one batch write per run, to save database queries).
  const url =
    `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symbol)}` +
    `&interval=1day&outputsize=${BAR_COUNT}&timezone=America/New_York&apikey=${env.TWELVEDATA_KEY}`;
  const data = await getJson(url);
  if (data.status !== 'ok' || !Array.isArray(data.values)) {
    throw new Error(`Twelve Data: ${data.message || 'no data'}`);
  }
  return data.values
    .map((v) => ({
      t: v.datetime.slice(0, 10),
      o: Number(v.open),
      h: Number(v.high),
      l: Number(v.low),
      c: Number(v.close),
      v: Number(v.volume || 0),
    }))
    .filter((b) => Number.isFinite(b.c) && b.c > 0)
    .reverse();
}

// ---------- symbol search ----------

export async function searchSymbols(env, query) {
  const q = query.trim();
  if (!q) return [];
  if (isDemo(env)) {
    const up = q.toUpperCase();
    return DEMO_SYMBOLS.filter(([s, n]) => s.startsWith(up) || n.toUpperCase().includes(up))
      .slice(0, 12)
      .map(([symbol, name]) => ({ symbol, name }));
  }
  const url = `https://finnhub.io/api/v1/search?q=${encodeURIComponent(q)}&exchange=US&token=${env.FINNHUB_KEY}`;
  const data = await getJson(url);
  const seen = new Set();
  return (data.result || [])
    .filter((r) => r.symbol && !r.symbol.includes('.') && /^[A-Z][A-Z0-9-]{0,9}$/.test(r.symbol))
    .filter((r) => !r.type || ['Common Stock', 'ETP', 'ADR', 'REIT'].includes(r.type))
    .filter((r) => (seen.has(r.symbol) ? false : seen.add(r.symbol)))
    .slice(0, 12)
    .map((r) => ({ symbol: r.symbol, name: titleCase(r.description || r.symbol) }));
}

function titleCase(s) {
  return s.toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase()).replace(/\bInc\b/, 'Inc.');
}

// ---------- demo data ----------

export const DEMO_SYMBOLS = [
  ['AAPL', 'Apple Inc.', 265],
  ['MSFT', 'Microsoft Corp.', 520],
  ['NVDA', 'NVIDIA Corp.', 185],
  ['TSLA', 'Tesla Inc.', 450],
  ['AMZN', 'Amazon.com Inc.', 225],
  ['GOOGL', 'Alphabet Inc. Class A', 255],
  ['META', 'Meta Platforms Inc.', 740],
  ['AMD', 'Advanced Micro Devices', 250],
  ['AVGO', 'Broadcom Inc.', 350],
  ['TSM', 'Taiwan Semiconductor (ADR)', 300],
  ['NFLX', 'Netflix Inc.', 1100],
  ['PLTR', 'Palantir Technologies', 180],
  ['COIN', 'Coinbase Global', 330],
  ['INTC', 'Intel Corp.', 38],
  ['SPY', 'SPDR S&P 500 ETF', 680],
  ['QQQ', 'Invesco QQQ Trust', 620],
];

function hashString(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function demoBase(symbol) {
  const known = DEMO_SYMBOLS.find(([s]) => s === symbol);
  return known ? known[2] : 20 + (hashString(symbol) % 300);
}

// Trading dates going back from today (New York), oldest first.
function recentTradingDates(now, count) {
  const dates = [];
  let t = now;
  while (dates.length < count) {
    const p = nyParts(t);
    if (isTradingDay(p.date, p.weekday)) dates.push(p.date);
    t -= 86400000;
  }
  return dates.reverse();
}

export function mockBars(symbol, now = Date.now()) {
  const rand = prng(hashString(symbol));
  const dates = recentTradingDates(now, BAR_COUNT);
  let c = demoBase(symbol) * 0.8;
  const bars = [];
  for (const t of dates) {
    const drift = (rand() - 0.48) * 0.035;
    const o = c;
    c = Math.max(1, c * (1 + drift));
    const h = Math.max(o, c) * (1 + rand() * 0.012);
    const l = Math.min(o, c) * (1 - rand() * 0.012);
    const v = Math.round(2e6 + rand() * 6e6);
    bars.push({ t, o: r2(o), h: r2(h), l: r2(l), c: r2(c), v });
  }
  // Today's bar (if a trading day) stays partial; the live quote fills in the price.
  const today = nyParts(now);
  const last = bars[bars.length - 1];
  if (last.t === today.date) {
    const progress = Math.min(1, Math.max(0.05, (today.minutes - 570) / 390));
    last.v = Math.round(last.v * progress * (1 + (hashString(symbol + today.date) % 100) / 100));
  }
  return bars;
}

export function mockQuote(symbol, now = Date.now()) {
  const bars = mockBars(symbol, now);
  const today = nyParts(now).date;
  const lastIsToday = bars[bars.length - 1].t === today;
  const prev = lastIsToday ? bars[bars.length - 2] : bars[bars.length - 1];
  const day = lastIsToday ? bars[bars.length - 1] : null;
  // Smooth wobble that changes every minute so alerts can actually fire in a demo.
  const minute = Math.floor(now / 60000);
  const seed = hashString(symbol);
  const wobble = Math.sin(minute / 17 + (seed % 100)) * 0.025 + Math.sin(minute / 3.7 + (seed % 7)) * 0.006;
  const base = day ? day.c : prev.c;
  const price = r2(base * (1 + wobble));
  const change = r2(price - prev.c);
  return {
    price,
    change,
    changePct: r2((change / prev.c) * 100),
    prevClose: prev.c,
    open: day ? day.o : prev.c,
    high: r2(Math.max(day ? day.h : price, price)),
    low: r2(Math.min(day ? day.l : price, price)),
    ts: now,
  };
}

function r2(n) {
  return Math.round(n * 100) / 100;
}
