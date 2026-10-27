// Technical indicators on daily bars. Bars are oldest first: { t, o, h, l, c, v }.
// Each function returns a full series (same length as input; null where not enough data).

export function smaSeries(values, n) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= n) sum -= values[i - n];
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}

// Wilder's RSI.
export function rsiSeries(closes, n = 14) {
  const out = new Array(closes.length).fill(null);
  if (closes.length <= n) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= n; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d;
    else loss -= d;
  }
  let avgGain = gain / n;
  let avgLoss = loss / n;
  out[n] = rsiValue(avgGain, avgLoss);
  for (let i = n + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (n - 1) + Math.max(d, 0)) / n;
    avgLoss = (avgLoss * (n - 1) + Math.max(-d, 0)) / n;
    out[i] = rsiValue(avgGain, avgLoss);
  }
  return out;
}

function rsiValue(avgGain, avgLoss) {
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

// Stochastic KD (9,3,3), the version common in Taiwan / Asia:
// RSV = (C - lowest low of n) / (highest high of n - lowest low of n) * 100
// K = K_prev * 2/3 + RSV / 3,  D = D_prev * 2/3 + K / 3, starting from 50.
export function kdSeries(bars, n = 9) {
  const K = new Array(bars.length).fill(null);
  const D = new Array(bars.length).fill(null);
  let k = 50;
  let d = 50;
  for (let i = 0; i < bars.length; i++) {
    if (i < n - 1) continue;
    let hi = -Infinity;
    let lo = Infinity;
    for (let j = i - n + 1; j <= i; j++) {
      hi = Math.max(hi, bars[j].h);
      lo = Math.min(lo, bars[j].l);
    }
    const rsv = hi === lo ? 50 : ((bars[i].c - lo) / (hi - lo)) * 100;
    k = (k * 2) / 3 + rsv / 3;
    d = (d * 2) / 3 + k / 3;
    K[i] = k;
    D[i] = d;
  }
  return { K, D };
}

// Today's volume divided by the average of the previous n days.
export function volumeRatio(bars, n = 20) {
  const last = bars.length - 1;
  if (last < n || !bars[last].v) return null;
  let sum = 0;
  for (let i = last - n; i < last; i++) sum += bars[i].v;
  const avg = sum / n;
  return avg > 0 ? bars[last].v / avg : null;
}

// Replace (or append) today's bar with the live quote so indicators reflect the current price.
export function mergeLiveBar(bars, quote, today) {
  if (!quote || !Number.isFinite(quote.price) || quote.price <= 0) return bars;
  const out = bars.slice();
  const last = out[out.length - 1];
  if (last && last.t === today) {
    out[out.length - 1] = {
      ...last,
      c: quote.price,
      h: Math.max(last.h, quote.high || quote.price, quote.price),
      l: Math.min(last.l, quote.low || quote.price, quote.price),
    };
  } else if (!last || last.t < today) {
    out.push({
      t: today,
      o: quote.open || quote.price,
      h: Math.max(quote.high || quote.price, quote.price),
      l: Math.min(quote.low || quote.price, quote.price),
      c: quote.price,
      v: 0,
    });
  }
  return out;
}
