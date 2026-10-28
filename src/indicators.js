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

// Stochastic KD. RSV = (C - lowest low of n) / (highest high of n - lowest low of n) * 100
//  style 'tw' (Taiwan / Asia brokers, e.g. 9,3,3): K = K_prev*(m1-1)/m1 + RSV/m1, D likewise from K, seeded at 50.
//  style 'us' (US "slow stochastic", e.g. 14,3,3): K = SMA(RSV, m1), D = SMA(K, m2).
export function kdSeries(bars, n = 9, m1 = 3, m2 = 3, style = 'tw') {
  const len = bars.length;
  const K = new Array(len).fill(null);
  const D = new Array(len).fill(null);
  const rsv = new Array(len).fill(null);
  for (let i = n - 1; i < len; i++) {
    let hi = -Infinity;
    let lo = Infinity;
    for (let j = i - n + 1; j <= i; j++) {
      hi = Math.max(hi, bars[j].h);
      lo = Math.min(lo, bars[j].l);
    }
    rsv[i] = hi === lo ? 50 : ((bars[i].c - lo) / (hi - lo)) * 100;
  }
  if (style === 'us') {
    for (let i = n - 1 + m1 - 1; i < len; i++) {
      let sum = 0;
      for (let j = i - m1 + 1; j <= i; j++) sum += rsv[j];
      K[i] = sum / m1;
    }
    for (let i = n - 1 + m1 - 1 + m2 - 1; i < len; i++) {
      let sum = 0;
      for (let j = i - m2 + 1; j <= i; j++) sum += K[j];
      D[i] = sum / m2;
    }
    return { K, D };
  }
  let k = 50;
  let d = 50;
  for (let i = n - 1; i < len; i++) {
    k = (k * (m1 - 1)) / m1 + rsv[i] / m1;
    d = (d * (m2 - 1)) / m2 + k / m2;
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
