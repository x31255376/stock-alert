import { test } from 'node:test';
import assert from 'node:assert/strict';
import { smaSeries, rsiSeries, kdSeries, volumeRatio, mergeLiveBar } from '../src/indicators.js';
import { sanitizeCondition, describeCondition, evaluateAlert, makeContext } from '../src/engine.js';
import { marketState, nyParts } from '../src/market.js';
import { normalizeAccountCode } from '../src/util.js';

const close = (a, b, eps = 0.15) => assert.ok(Math.abs(a - b) <= eps, `${a} vs ${b}`);

test('SMA', () => {
  assert.deepEqual(smaSeries([1, 2, 3, 4, 5], 3), [null, null, 2, 3, 4]);
});

// StockCharts rounds intermediate averages, so allow a small tolerance.
test('RSI matches the StockCharts Wilder example', () => {
  const closes = [44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.1, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61, 46.28, 46.28, 46.0, 46.03, 46.41, 46.22, 45.64];
  const r = rsiSeries(closes, 14);
  close(r[14], 70.53);
  close(r[15], 66.32);
  close(r[16], 66.55);
  close(r[17], 69.41);
  close(r[19], 57.97);
});

test('KD stays within 0..100 and K reacts faster than D', () => {
  const bars = [];
  for (let i = 0; i < 40; i++) {
    const c = 100 + i; // steady uptrend
    bars.push({ t: `d${i}`, o: c, h: c + 1, l: c - 1, c, v: 1000 });
  }
  const { K, D } = kdSeries(bars, 9);
  assert.equal(K[7], null);
  for (let i = 8; i < 40; i++) {
    assert.ok(K[i] >= 0 && K[i] <= 100);
    assert.ok(K[i] >= D[i]);
  }
});

test('volume ratio', () => {
  const bars = Array.from({ length: 21 }, (_, i) => ({ t: `d${i}`, o: 1, h: 1, l: 1, c: 1, v: i === 20 ? 300 : 100 }));
  assert.equal(volumeRatio(bars, 20), 3);
});

test('mergeLiveBar replaces today and appends a new day', () => {
  const bars = [{ t: '2026-10-26', o: 1, h: 2, l: 1, c: 1.5, v: 10 }];
  const q = { price: 3, high: 3, low: 1, open: 1.6 };
  assert.equal(mergeLiveBar(bars, q, '2026-10-26')[0].c, 3);
  const appended = mergeLiveBar(bars, q, '2026-10-27');
  assert.equal(appended.length, 2);
  assert.equal(appended[1].t, '2026-10-27');
});

function trendBars(fn, n = 80) {
  return Array.from({ length: n }, (_, i) => {
    const c = fn(i);
    return { t: `d${String(i).padStart(3, '0')}`, o: c, h: c * 1.01, l: c * 0.99, c, v: 1000 };
  });
}

test('MA golden cross triggers only on the crossing day', () => {
  // Falling for 70 days, then a sharp rally so MA5 crosses above MA20 at some point.
  const bars = trendBars((i) => (i < 70 ? 200 - i : 130 + (i - 69) * 12), 80);
  const cond = sanitizeCondition({ type: 'ma_cross', op: 'golden', fast: 5, slow: 20 });
  let crossings = 0;
  for (let n = 25; n <= bars.length; n++) {
    const ctx = makeContext(bars.slice(0, n), null);
    if (evaluateAlert({ logic: 'all', conditions: [cond] }, ctx).triggered) crossings++;
  }
  assert.equal(crossings, 1);
});

test('AND / ANY logic and near state', () => {
  const bars = trendBars(() => 100, 30);
  const ctx = makeContext(bars, { changePct: 0 });
  const a = sanitizeCondition({ type: 'price', op: 'above', value: 99 }); // met
  const b = sanitizeCondition({ type: 'price', op: 'above', value: 100.5 }); // not met, within 1%
  const c = sanitizeCondition({ type: 'price', op: 'above', value: 150 }); // far
  assert.equal(evaluateAlert({ logic: 'all', conditions: [a, b] }, ctx).triggered, false);
  assert.equal(evaluateAlert({ logic: 'all', conditions: [a, b] }, ctx).near, true);
  assert.equal(evaluateAlert({ logic: 'all', conditions: [a, c] }, ctx).near, false);
  assert.equal(evaluateAlert({ logic: 'any', conditions: [a, c] }, ctx).triggered, true);
});

test('insufficient data never triggers', () => {
  const bars = trendBars((i) => 100 + i, 10);
  const cond = sanitizeCondition({ type: 'ma_cross', op: 'golden', fast: 20, slow: 60 });
  const r = evaluateAlert({ logic: 'all', conditions: [cond] }, makeContext(bars, null));
  assert.equal(r.triggered, false);
  assert.equal(r.results[0].now, '資料不足');
});

test('sanitize rejects bad input and labels are Chinese', () => {
  assert.throws(() => sanitizeCondition({ type: 'rsi', op: 'below', value: 150 }));
  assert.throws(() => sanitizeCondition({ type: 'nope', op: 'x' }));
  assert.equal(describeCondition(sanitizeCondition({ type: 'kd', op: 'golden' })), 'KD 黃金交叉');
  assert.equal(describeCondition(sanitizeCondition({ type: 'volume', op: 'above', value: 1.5 })), '前一交易日成交量 > 均量 1.5 倍');
});

test('market hours in New York', () => {
  // Tue 2026-10-27 14:00 UTC = 10:00 New York (EDT) → open
  assert.equal(marketState(Date.UTC(2026, 9, 27, 14, 0)).open, true);
  // 21:00 UTC = 17:00 NY → closed, next open tomorrow 13:30 UTC
  const s = marketState(Date.UTC(2026, 9, 27, 21, 0));
  assert.equal(s.open, false);
  assert.equal(new Date(s.nextOpenMs).toISOString(), '2026-10-28T13:30:00.000Z');
  // Thanksgiving closed
  assert.equal(marketState(Date.UTC(2026, 10, 26, 16, 0)).open, false);
  // Saturday → next open Monday (after DST ends: 14:30 UTC)
  const sat = marketState(Date.UTC(2026, 9, 31, 16, 0));
  assert.equal(new Date(sat.nextOpenMs).toISOString(), '2026-11-02T14:30:00.000Z');
  assert.equal(nyParts(Date.UTC(2026, 9, 27, 14, 0)).date, '2026-10-27');
});

test('account code normalization', () => {
  assert.equal(normalizeAccountCode('k7q2-m9xd oiL1'), 'K7Q2M9XD0111');
});

import { alertTiming, isCloseCondition, needsBars } from '../src/engine.js';
import { barsReadyToday } from '../src/scheduler.js';
import { marketState as ms } from '../src/market.js';

test('timing: volume and KD/MA default to close, intraday opt-in', () => {
  const kd = sanitizeCondition({ type: 'kd', op: 'golden' });
  const kdLive = sanitizeCondition({ type: 'kd', op: 'golden', mode: 'intraday' });
  const vol = sanitizeCondition({ type: 'volume', op: 'above', value: 1.5 });
  const price = sanitizeCondition({ type: 'price', op: 'above', value: 10 });
  assert.equal(kd.mode, 'close');
  assert.equal(isCloseCondition(kd), true);
  assert.equal(isCloseCondition(kdLive), false);
  assert.equal(alertTiming([price]), 'intraday');
  assert.equal(alertTiming([price, kdLive]), 'intraday');
  assert.equal(alertTiming([price, vol]), 'close');
  assert.equal(needsBars([price]), false);
  assert.equal(needsBars([kdLive]), true);
  assert.equal(describeCondition(kdLive), 'KD 黃金交叉（盤中）');
  assert.equal(describeCondition(vol), '前一交易日成交量 > 均量 1.5 倍');
});

test('volume uses the last completed session', () => {
  const bars = Array.from({ length: 22 }, (_, i) => ({ t: `2026-10-${String(i + 1).padStart(2, '0')}`, o: 1, h: 1, l: 1, c: 1, v: i === 20 ? 250 : i === 21 ? 5 : 100 }));
  const today = '2026-10-22';
  const completed = bars.filter((b) => b.t < today); // drops the partial "today" bar (v=5)
  const r = evaluateAlert({ logic: 'all', conditions: [sanitizeCondition({ type: 'volume', op: 'above', value: 2 })] }, makeContext(completed, null));
  assert.equal(r.triggered, true);
  assert.equal(r.results[0].now, '成交量 2.50 倍均量');
});

test('daily bars count as ready only after 01:00 New York on the same date', () => {
  const now = Date.UTC(2026, 9, 28, 14, 0); // 10:00 NY
  const market = ms(now);
  assert.equal(barsReadyToday(Date.UTC(2026, 9, 28, 5, 30), market), true); // 01:30 NY
  assert.equal(barsReadyToday(Date.UTC(2026, 9, 28, 4, 30), market), false); // 00:30 NY
  assert.equal(barsReadyToday(Date.UTC(2026, 9, 27, 20, 0), market), false); // yesterday
});
