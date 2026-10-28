// Alert conditions: validation, labels (Chinese / English), and evaluation against daily bars + live quote.
import { smaSeries, rsiSeries, kdSeries, volumeRatio } from './indicators.js';
import { HttpError } from './util.js';

export const MA_PERIODS = [5, 10, 20, 50, 60, 120, 200];
export const MA_PAIRS = [
  [5, 20],
  [10, 20],
  [20, 60],
  [50, 200],
];
export const MAX_CONDITIONS = 6;
export const FREQUENCIES = ['once', 'daily', 'hourly'];

// KD parameter sets. 9,3,3 and 5,3,3 use the Taiwan / Asia smoothing; 14,3,3 is the US "slow stochastic".
export const KD_PARAMS = {
  '9-3-3': { n: 9, m1: 3, m2: 3, style: 'tw' },
  '5-3-3': { n: 5, m1: 3, m2: 3, style: 'tw' },
  '14-3-3': { n: 14, m1: 3, m2: 3, style: 'us' },
};
const KD_DEFAULT = '9-3-3';

// Conditions that can be checked on the close only ("收盤確認") instead of live during the session.
export const MODE_TYPES = ['kd', 'ma_cross', 'price_ma'];

const OPS = {
  price: ['above', 'below', 'cross_above', 'cross_below'],
  change: ['up', 'down'],
  rsi: ['below', 'above'],
  ma_cross: ['golden', 'death'],
  price_ma: ['cross_above', 'cross_below', 'above', 'below'],
  kd: ['golden', 'death', 'k_below', 'k_above'],
  volume: ['above'],
};

function invalid(zh, en) {
  return new HttpError(400, zh, en);
}

// Returns a cleaned condition or throws a bilingual error for the user.
export function sanitizeCondition(raw) {
  if (!raw || typeof raw !== 'object') throw invalid('條件格式錯誤', 'Invalid condition');
  const type = raw.type;
  if (!OPS[type]) throw invalid('不支援的條件類型', 'Unsupported condition type');
  const op = raw.op;
  if (!OPS[type].includes(op)) throw invalid('條件的比較方式不正確', 'Invalid comparison for this condition');
  const num = (v, min, max, zh, en) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < min || n > max) throw invalid(`${zh}需介於 ${min} 到 ${max}`, `${en} must be between ${min} and ${max}`);
    return Math.round(n * 10000) / 10000;
  };
  switch (type) {
    case 'price':
      return { type, op, value: num(raw.value, 0.0001, 1e7, '價格', 'Price') };
    case 'change':
      return { type, op, value: num(raw.value, 0.1, 100, '漲跌幅', 'Change') };
    case 'rsi':
      return { type, op, value: num(raw.value, 1, 99, 'RSI 數值', 'RSI value') };
    case 'ma_cross': {
      const pair = MA_PAIRS.find(([f, s]) => f === Number(raw.fast) && s === Number(raw.slow)) || [20, 60];
      return { type, op, fast: pair[0], slow: pair[1], mode: cleanMode(raw.mode) };
    }
    case 'price_ma': {
      const period = MA_PERIODS.includes(Number(raw.period)) ? Number(raw.period) : 20;
      return { type, op, period, mode: cleanMode(raw.mode) };
    }
    case 'kd': {
      const kdp = KD_PARAMS[raw.kdp] ? raw.kdp : KD_DEFAULT;
      if (op === 'k_below' || op === 'k_above') return { type, op, value: num(raw.value, 1, 99, 'K 值', 'K value'), kdp, mode: cleanMode(raw.mode) };
      return { type, op, kdp, mode: cleanMode(raw.mode) };
    }
    case 'volume':
      return { type, op: 'above', value: num(raw.value, 1, 50, '倍數', 'Multiple') };
  }
  throw invalid('條件格式錯誤', 'Invalid condition');
}

function cleanMode(mode) {
  return mode === 'intraday' ? 'intraday' : 'close';
}

// Volume is always checked on the last completed session (live intraday volume from the free
// data plans is partial). KD / MA conditions default to the close unless set to 'intraday'.
export function isCloseCondition(c) {
  return c.type === 'volume' || (MODE_TYPES.includes(c.type) && c.mode !== 'intraday');
}

// An alert with any close-only condition is evaluated once per session, on completed daily bars.
export function alertTiming(conditions) {
  return conditions.some(isCloseCondition) ? 'close' : 'intraday';
}

// Price / change conditions work from the live quote alone; everything else needs daily bars.
export function needsBars(conditions) {
  return conditions.some((c) => c.type !== 'price' && c.type !== 'change');
}

export function describeCondition(c, lang = 'zh') {
  const label = lang === 'en' ? labelEn(c) : labelZh(c);
  if (MODE_TYPES.includes(c.type) && c.mode === 'intraday') return lang === 'en' ? `${label} (live)` : `${label}（盤中）`;
  return label;
}

function kdName(c) {
  const p = c.kdp && c.kdp !== KD_DEFAULT ? `(${c.kdp.replace(/-/g, ',')})` : '';
  return `KD${p}`;
}

function labelZh(c) {
  switch (c.type) {
    case 'price':
      return { above: `價格 ≥ ${c.value}`, below: `價格 ≤ ${c.value}`, cross_above: `價格向上突破 ${c.value}`, cross_below: `價格跌破 ${c.value}` }[c.op];
    case 'change':
      return c.op === 'up' ? `漲幅 ≥ ${c.value}%` : `跌幅 ≥ ${c.value}%`;
    case 'rsi':
      return c.op === 'below' ? `RSI(14) < ${c.value}` : `RSI(14) > ${c.value}`;
    case 'ma_cross':
      return c.op === 'golden' ? `MA${c.fast} 上穿 MA${c.slow}` : `MA${c.fast} 下穿 MA${c.slow}`;
    case 'price_ma':
      return { cross_above: `價格站上 MA${c.period}`, cross_below: `價格跌破 MA${c.period}`, above: `價格在 MA${c.period} 之上`, below: `價格在 MA${c.period} 之下` }[c.op];
    case 'kd': {
      const k = kdName(c);
      const kv = k === 'KD' ? 'K 值' : `${k} K 值`;
      return { golden: `${k} 黃金交叉`, death: `${k} 死亡交叉`, k_below: `${kv} < ${c.value}`, k_above: `${kv} > ${c.value}` }[c.op];
    }
    case 'volume':
      return `前一交易日成交量 > 均量 ${c.value} 倍`;
  }
  return '條件';
}

function labelEn(c) {
  switch (c.type) {
    case 'price':
      return { above: `Price ≥ ${c.value}`, below: `Price ≤ ${c.value}`, cross_above: `Price crosses above ${c.value}`, cross_below: `Price crosses below ${c.value}` }[c.op];
    case 'change':
      return c.op === 'up' ? `Up ≥ ${c.value}%` : `Down ≥ ${c.value}%`;
    case 'rsi':
      return c.op === 'below' ? `RSI(14) < ${c.value}` : `RSI(14) > ${c.value}`;
    case 'ma_cross':
      return c.op === 'golden' ? `MA${c.fast} crosses above MA${c.slow}` : `MA${c.fast} crosses below MA${c.slow}`;
    case 'price_ma':
      return { cross_above: `Price crosses above MA${c.period}`, cross_below: `Price crosses below MA${c.period}`, above: `Price above MA${c.period}`, below: `Price below MA${c.period}` }[c.op];
    case 'kd': {
      const k = kdName(c);
      return { golden: `${k} golden cross`, death: `${k} death cross`, k_below: `${k} K < ${c.value}`, k_above: `${k} K > ${c.value}` }[c.op];
    }
    case 'volume':
      return `Prior-session volume > ${c.value}× avg`;
  }
  return 'Condition';
}

// Number of daily bars an alert needs (longest lookback + a margin for smoothing).
export function barsNeeded(conditions) {
  let need = 30;
  for (const c of conditions) {
    if (c.type === 'ma_cross') need = Math.max(need, c.slow + 2);
    if (c.type === 'price_ma') need = Math.max(need, c.period + 2);
    if (c.type === 'rsi') need = Math.max(need, 60);
    if (c.type === 'volume') need = Math.max(need, 22);
  }
  return need;
}

// Per-symbol cache of indicator series so many alerts on one stock compute once.
export function makeContext(bars, quote) {
  const closes = bars.map((b) => b.c);
  const cache = new Map();
  const memo = (key, fn) => {
    if (!cache.has(key)) cache.set(key, fn());
    return cache.get(key);
  };
  const n = bars.length;
  return {
    bars,
    quote,
    n,
    price: n ? bars[n - 1].c : quote?.price ?? null,
    prevClose: n >= 2 ? bars[n - 2].c : quote?.prevClose ?? null,
    changePct: quote?.changePct ?? (n >= 2 ? ((bars[n - 1].c - bars[n - 2].c) / bars[n - 2].c) * 100 : null),
    sma: (p) => memo(`sma${p}`, () => smaSeries(closes, p)),
    rsi: () => memo('rsi', () => rsiSeries(closes, 14)),
    kd: (kdp = KD_DEFAULT) =>
      memo(`kd${kdp}`, () => {
        const p = KD_PARAMS[kdp] || KD_PARAMS[KD_DEFAULT];
        return kdSeries(bars, p.n, p.m1, p.m2, p.style);
      }),
    volRatio: () => memo('vol', () => volumeRatio(bars, 20)),
  };
}

const NEAR_PCT = 1; // within 1% counts as "接近 / close to triggering"

function pctGap(a, b) {
  return (Math.abs(a - b) / Math.abs(b)) * 100;
}

// Evaluate one condition. Returns { met, near, now } where `now` is a short current-value string.
export function evaluateCondition(c, ctx, lang = 'zh') {
  const en = lang === 'en';
  const last = ctx.n - 1;
  const insufficient = { met: false, near: false, now: en ? 'Not enough data' : '資料不足' };
  const price = ctx.price;
  if (price == null) return insufficient;

  switch (c.type) {
    case 'price': {
      const prev = ctx.prevClose;
      let met;
      if (c.op === 'above') met = price >= c.value;
      else if (c.op === 'below') met = price <= c.value;
      else if (c.op === 'cross_above') met = prev != null && prev < c.value && price >= c.value;
      else met = prev != null && prev > c.value && price <= c.value;
      const near = !met && pctGap(price, c.value) <= NEAR_PCT;
      return { met, near, now: `${en ? 'Price' : '價格'} ${round(price)}` };
    }
    case 'change': {
      const ch = ctx.changePct;
      if (ch == null) return insufficient;
      const met = c.op === 'up' ? ch >= c.value : ch <= -c.value;
      const dist = c.op === 'up' ? c.value - ch : ch + c.value;
      return { met, near: !met && dist <= 0.5, now: `${en ? 'Change' : '漲跌'} ${ch >= 0 ? '+' : ''}${ch.toFixed(2)}%` };
    }
    case 'rsi': {
      const r = ctx.rsi()[last];
      if (r == null) return insufficient;
      const met = c.op === 'below' ? r < c.value : r > c.value;
      return { met, near: !met && Math.abs(r - c.value) <= 3, now: `RSI ${r.toFixed(1)}` };
    }
    case 'ma_cross': {
      const f = ctx.sma(c.fast);
      const s = ctx.sma(c.slow);
      if (last < 1 || f[last] == null || s[last] == null || f[last - 1] == null || s[last - 1] == null) return insufficient;
      const met = c.op === 'golden' ? f[last - 1] <= s[last - 1] && f[last] > s[last] : f[last - 1] >= s[last - 1] && f[last] < s[last];
      const approaching = c.op === 'golden' ? f[last] < s[last] : f[last] > s[last];
      const gap = pctGap(f[last], s[last]);
      return {
        met,
        near: !met && approaching && gap <= NEAR_PCT,
        now: en ? `MA${c.fast} vs MA${c.slow} gap ${gap.toFixed(1)}%` : `MA${c.fast} 與 MA${c.slow} 相差 ${gap.toFixed(1)}%`,
      };
    }
    case 'price_ma': {
      const m = ctx.sma(c.period);
      if (m[last] == null) return insufficient;
      const prevMa = last >= 1 ? m[last - 1] : null;
      const prev = ctx.prevClose;
      let met;
      if (c.op === 'above') met = price > m[last];
      else if (c.op === 'below') met = price < m[last];
      else if (c.op === 'cross_above') met = prev != null && prevMa != null && prev <= prevMa && price > m[last];
      else met = prev != null && prevMa != null && prev >= prevMa && price < m[last];
      const gap = pctGap(price, m[last]);
      return { met, near: !met && gap <= NEAR_PCT, now: `MA${c.period} ${round(m[last])}` };
    }
    case 'kd': {
      const { K, D } = ctx.kd(c.kdp);
      if (last < 1 || K[last] == null || K[last - 1] == null || D[last] == null || D[last - 1] == null) return insufficient;
      let met;
      let near;
      if (c.op === 'golden') {
        met = K[last - 1] <= D[last - 1] && K[last] > D[last];
        near = !met && K[last] < D[last] && D[last] - K[last] <= 3;
      } else if (c.op === 'death') {
        met = K[last - 1] >= D[last - 1] && K[last] < D[last];
        near = !met && K[last] > D[last] && K[last] - D[last] <= 3;
      } else if (c.op === 'k_below') {
        met = K[last] < c.value;
        near = !met && K[last] - c.value <= 5;
      } else {
        met = K[last] > c.value;
        near = !met && c.value - K[last] <= 5;
      }
      return { met, near, now: `K ${K[last].toFixed(1)} / D ${D[last].toFixed(1)}` };
    }
    case 'volume': {
      const r = ctx.volRatio();
      if (r == null) return { met: false, near: false, now: en ? 'Volume data pending' : '成交量資料更新中' };
      const met = r > c.value;
      return { met, near: !met && r >= c.value * 0.8, now: en ? `Volume ${r.toFixed(2)}× avg` : `成交量 ${r.toFixed(2)} 倍均量` };
    }
  }
  return insufficient;
}

export function evaluateAlert(alert, ctx, lang = 'zh') {
  const results = alert.conditions.map((c) => ({ ...evaluateCondition(c, ctx, lang), label: describeCondition(c, lang) }));
  let triggered;
  let near;
  if (alert.logic === 'any') {
    triggered = results.some((r) => r.met);
    near = !triggered && results.some((r) => r.near);
  } else {
    triggered = results.length > 0 && results.every((r) => r.met);
    // "near" = everything is met or close, and at least one is only close.
    near = !triggered && results.length > 0 && results.every((r) => r.met || r.near);
  }
  return { triggered, near, results };
}

function round(n) {
  return n >= 1 ? n.toFixed(2) : n.toFixed(4);
}
