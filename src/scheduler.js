// Runs every minute (Cron Trigger): refresh prices, evaluate alerts, deliver notifications.
// Written to stay inside the Workers Free plan limits per run: 50 outbound requests, 50 D1 queries
// (a db.batch counts as one), 10 ms CPU.
import { ensureSchema, getMeta, parseJson, upsertQuoteStmt, quoteFromRow } from './db.js';
import { marketState, nyParts } from './market.js';
import { fetchQuote, fetchBars, hasBarSource, isDemo, twelveDataCreditsLeft, TD_DAILY_CAP } from './providers.js';
import { mergeLiveBar } from './indicators.js';
import { makeContext, evaluateAlert, alertTiming, needsBars } from './engine.js';
import { availableChannels, ensureTelegramWebhook, deliverToChannels } from './notify.js';
import { fmtPrice, fmtPct, fmtUserTime, minutesInZone } from './util.js';

const QUOTES_PER_TICK = 20; // Finnhub free: 60/min, leave room for the app's own lookups
const BARS_PER_TICK = 5; // Twelve Data free: 8/min
const OUTBOUND_BUDGET = 46; // Workers Free: 50 subrequests per run
const PENDING_PER_TICK = 25;

// Twelve Data publishes the previous session's full volume after midnight New York time.
const DAILY_READY_MIN = 60; // 01:00 New York

// True when the stored bars were refreshed today (New York date) after the daily data was ready.
export function barsReadyToday(updatedAt, market) {
  if (!updatedAt) return false;
  const p = nyParts(updatedAt);
  return p.date === market.date && p.minutes >= DAILY_READY_MIN;
}

function detailLine(r) {
  return r.results.map((x) => x.now).filter((v, i, arr) => arr.indexOf(v) === i).join(' · ');
}

function metLine(r) {
  return r.results.filter((x) => x.met).map((x) => x.label).join('、');
}

function triggerEvent(db, a, title, body, now) {
  return db
    .prepare(
      `INSERT INTO events (user_id, alert_id, symbol, kind, title, body, channels, delivery, created_at)
       VALUES (?, ?, ?, 'triggered', ?, ?, ?, 'pending', ?)`
    )
    .bind(a.user_id, a.id, a.symbol, title, body, a.channels, now);
}

function nearEvent(db, a, title, r, detail, now) {
  const pending = r.results.filter((x) => !x.met).map((x) => x.label);
  return db
    .prepare(
      `INSERT INTO events (user_id, alert_id, symbol, kind, title, body, delivery, created_at)
       VALUES (?, ?, ?, 'near', ?, ?, 'none', ?)`
    )
    .bind(a.user_id, a.id, a.symbol, title, `還差：${pending.join('、')}\n${detail}`, now);
}

export function packBars(bars) {
  return JSON.stringify(bars.map((b) => [b.t, b.o, b.h, b.l, b.c, b.v]));
}

export function unpackBars(text) {
  return parseJson(text, []).map(([t, o, h, l, c, v]) => ({ t, o, h, l, c, v }));
}

export async function runTick(env, now = Date.now()) {
  const db = env.DB;
  await ensureSchema(db);
  const market = marketState(now, { forceOpen: env.FORCE_MARKET_OPEN === '1' });
  let outbound = OUTBOUND_BUDGET;

  // Telegram webhook registration (one-time per token / URL).
  if (env.TELEGRAM_BOT_TOKEN) {
    try {
      const appUrl = await getMeta(db, 'app_url');
      if (appUrl) await ensureTelegramWebhook(env, appUrl);
    } catch (err) {
      console.warn('telegram setup', String(err));
    }
    outbound -= 2;
  }

  const summary = { market: market.open ? 'open' : 'closed', quotes: 0, bars: 0, evaluated: 0, triggered: 0, delivered: 0 };

  // ---- 1. which alerts / symbols matter right now ----
  const { results: rawAlerts } = await db
    .prepare('SELECT a.*, u.tz AS user_tz FROM alerts a JOIN users u ON u.id = a.user_id WHERE a.active = 1')
    .all();
  const alertRows = rawAlerts.map((row) => {
    const conditions = parseJson(row.conditions, []);
    return { ...row, conditions, timing: alertTiming(conditions), bars: needsBars(conditions) };
  });
  const alertSymbols = [...new Set(alertRows.map((a) => a.symbol))];

  if (alertSymbols.length) {
    const marks = alertSymbols.map(() => '?').join(',');
    const [quoteRes, barMetaRes] = await db.batch([
      db.prepare(`SELECT * FROM quotes WHERE symbol IN (${marks})`).bind(...alertSymbols),
      db.prepare(`SELECT symbol, updated_at FROM bars WHERE symbol IN (${marks})`).bind(...alertSymbols),
    ]);
    const quoteBySymbol = new Map(quoteRes.results.map((r) => [r.symbol, r]));
    const barsUpdated = new Map(barMetaRes.results.map((r) => [r.symbol, r.updated_at]));
    const writes = [];

    // ---- 2. daily bars ----
    // Every symbol with indicator alerts is refreshed once a day after 01:00 New York time, when the
    // previous session's full (consolidated) volume is available. Symbols with live-indicator alerts
    // are also refreshed during the session.
    const barSymbols = new Set(alertRows.filter((a) => a.bars).map((a) => a.symbol));
    const liveIndicatorSymbols = new Set(alertRows.filter((a) => a.bars && a.timing === 'intraday').map((a) => a.symbol));
    const barsFetched = new Map();
    if (hasBarSource(env) && barSymbols.size) {
      const refreshMin = Math.max(15, Math.ceil((liveIndicatorSymbols.size * 390) / (TD_DAILY_CAP - 60 - barSymbols.size)));
      const needs = [...barSymbols]
        .filter((s) => {
          const at = barsUpdated.get(s);
          if (!at) return true; // never fetched
          if (!barsReadyToday(at, market) && market.minutes >= DAILY_READY_MIN) return true;
          return market.open && liveIndicatorSymbols.has(s) && (now - at) / 60000 >= refreshMin;
        })
        .sort((a, b) => (barsUpdated.get(a) || 0) - (barsUpdated.get(b) || 0));
      let credits = null;
      if (needs.length && !isDemo(env)) credits = await twelveDataCreditsLeft(env, now);
      const batch = needs.slice(0, Math.min(BARS_PER_TICK, credits ? credits.left : Infinity, outbound));
      outbound -= batch.length;
      if (credits && batch.length) {
        writes.push(
          db
            .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
            .bind(credits.key, String(credits.used + batch.length))
        );
      }
      const fetched = await Promise.allSettled(batch.map((s) => fetchBars(env, s, now)));
      fetched.forEach((r, i) => {
        if (r.status === 'fulfilled' && r.value && r.value.length) {
          barsFetched.set(batch[i], r.value);
          barsUpdated.set(batch[i], now);
          writes.push(
            db
              .prepare('INSERT INTO bars (symbol, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(symbol) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at')
              .bind(batch[i], packBars(r.value), now)
          );
        } else if (r.status === 'rejected') {
          console.warn('bars', batch[i], String(r.reason));
        }
      });
      summary.bars = barsFetched.size;
    }

    // ---- 3. live quotes, oldest first (only while the market is open, only for live alerts) ----
    const freshQuotes = new Map();
    const liveSymbols = [...new Set(alertRows.filter((a) => a.timing === 'intraday').map((a) => a.symbol))];
    if (market.open && liveSymbols.length) {
      const order = liveSymbols.sort((a, b) => (quoteBySymbol.get(a)?.updated_at || 0) - (quoteBySymbol.get(b)?.updated_at || 0));
      const batch = order.slice(0, Math.min(QUOTES_PER_TICK, Math.max(0, outbound - 10)));
      outbound -= batch.length;
      const fetched = await Promise.allSettled(batch.map((s) => fetchQuote(env, s, now)));
      fetched.forEach((r, i) => {
        if (r.status === 'fulfilled' && r.value) {
          freshQuotes.set(batch[i], r.value);
          writes.push(upsertQuoteStmt(db, batch[i], r.value, now));
        } else if (r.status === 'rejected') {
          console.warn('quote', batch[i], String(r.reason));
        }
      });
      summary.quotes = freshQuotes.size;
    }

    // Which alerts get evaluated this run.
    const liveDue = alertRows.filter((a) => a.timing === 'intraday' && freshQuotes.has(a.symbol));
    const closeReady = new Set([...barSymbols].filter((s) => barsReadyToday(barsUpdated.get(s), market)));
    const closeCandidates = alertRows.filter((a) => a.timing === 'close' && closeReady.has(a.symbol));

    // Load stored bars for the symbols we evaluate but did not just fetch.
    const wantBars = new Set([...liveDue.filter((a) => a.bars), ...closeCandidates].map((a) => a.symbol));
    const needStored = [...wantBars].filter((s) => !barsFetched.has(s));
    const allBars = new Map(barsFetched);
    if (needStored.length) {
      const { results } = await db
        .prepare(`SELECT symbol, data FROM bars WHERE symbol IN (${needStored.map(() => '?').join(',')})`)
        .bind(...needStored)
        .all();
      for (const r of results) allBars.set(r.symbol, unpackBars(r.data));
    }

    // ---- 4a. live alerts: daily bars + the current price ----
    const liveCtx = new Map();
    for (const a of liveDue) {
      if (!liveCtx.has(a.symbol)) {
        const quote = freshQuotes.get(a.symbol);
        liveCtx.set(a.symbol, makeContext(mergeLiveBar(allBars.get(a.symbol) || [], quote, market.date), quote));
      }
      const ctx = liveCtx.get(a.symbol);
      const quote = freshQuotes.get(a.symbol);
      summary.evaluated++;
      const r = evaluateAlert(a, ctx);
      const detail = detailLine(r);
      let fire = false;
      if (r.triggered) {
        if (a.frequency === 'once') fire = true;
        else if (a.frequency === 'hourly') fire = !a.last_triggered_at || now - a.last_triggered_at >= 3600000;
        else fire = a.last_trigger_day !== market.date;
      }
      let status = r.triggered ? 'triggered' : r.near ? 'near' : 'watching';
      if (!r.triggered && a.last_trigger_day === market.date) status = 'triggered'; // keep "今日已觸發" for the day
      if (fire) {
        summary.triggered++;
        writes.push(
          triggerEvent(db, a, `【已觸發】${a.symbol} ${fmtPrice(quote.price)}（${fmtPct(quote.changePct)}）`, `${metLine(r)}\n${detail}\n${fmtUserTime(now, a.user_tz)}`, now),
          db.prepare('UPDATE alerts SET last_triggered_at = ?, last_trigger_day = ?, active = ? WHERE id = ?').bind(now, market.date, a.frequency === 'once' ? 0 : 1, a.id)
        );
      } else if (r.near && a.last_near_day !== market.date && a.last_trigger_day !== market.date) {
        writes.push(nearEvent(db, a, `${a.symbol} 接近觸發`, r, detail, now), db.prepare('UPDATE alerts SET last_near_day = ? WHERE id = ?').bind(market.date, a.id));
      }
      writes.push(db.prepare('UPDATE alerts SET status = ?, status_detail = ?, checked_at = ? WHERE id = ?').bind(status, detail, now, a.id));
    }

    // ---- 4b. close-confirmed alerts: once per completed session, on full daily data ----
    const closeCtx = new Map();
    for (const a of closeCandidates) {
      if (!closeCtx.has(a.symbol)) {
        const completed = (allBars.get(a.symbol) || []).filter((b) => b.t < market.date);
        closeCtx.set(a.symbol, completed.length ? makeContext(completed, null) : null);
      }
      const ctx = closeCtx.get(a.symbol);
      if (!ctx) continue;
      const session = ctx.bars[ctx.n - 1].t;
      if (a.last_session === session) continue;
      summary.evaluated++;
      const r = evaluateAlert(a, ctx);
      const day = session.slice(5).replace('-', '/');
      const detail = `${day} 收盤：${detailLine(r)}`;
      const status = r.triggered ? 'triggered' : r.near ? 'near' : 'watching';
      if (r.triggered) {
        summary.triggered++;
        const priceLine = `${fmtPrice(ctx.price)}（${fmtPct(ctx.changePct)}）`;
        writes.push(
          triggerEvent(db, a, `【收盤確認】${a.symbol} ${day} 收 ${priceLine}`, `${metLine(r)}\n${detailLine(r)}`, now),
          db.prepare('UPDATE alerts SET last_triggered_at = ?, last_trigger_day = ?, active = ? WHERE id = ?').bind(now, market.date, a.frequency === 'once' ? 0 : 1, a.id)
        );
      } else if (r.near) {
        writes.push(nearEvent(db, a, `${a.symbol} 接近觸發（${day} 收盤）`, r, detailLine(r), now));
      }
      writes.push(
        db
          .prepare('UPDATE alerts SET status = ?, status_detail = ?, checked_at = ?, last_session = ? WHERE id = ?')
          .bind(status, detail, now, session, a.id)
      );
    }

    if (writes.length) await db.batch(writes);
  }

  // ---- 5. deliver pending notifications (respecting each user's quiet hours) ----
  if (outbound > 0) {
    summary.delivered = await deliverPending(env, now, outbound);
  }

  // ---- 6. daily housekeeping ----
  const day = new Date(now).toISOString().slice(0, 10);
  if ((await getMeta(db, 'cleanup_day')) !== day) {
    await db.batch([
      db.prepare('DELETE FROM events WHERE created_at < ?').bind(now - 90 * 86400000),
      db.prepare('DELETE FROM link_codes WHERE expires_at < ?').bind(now),
      db.prepare("DELETE FROM meta WHERE key LIKE 'td_credits:%' AND key < ?").bind(`td_credits:${new Date(now - 3 * 86400000).toISOString().slice(0, 10)}`),
      db.prepare('DELETE FROM bars WHERE symbol NOT IN (SELECT symbol FROM alerts WHERE active = 1) AND updated_at < ?').bind(now - 7 * 86400000),
      db
        .prepare("INSERT INTO meta (key, value) VALUES ('cleanup_day', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .bind(day),
    ]);
  }
  return summary;
}

export function inQuietHours(user, now) {
  if (!user.quiet_on) return false;
  const m = minutesInZone(now, user.tz);
  const { quiet_start: s, quiet_end: e } = user;
  if (s === e) return false;
  return s < e ? m >= s && m < e : m >= s || m < e;
}

async function deliverPending(env, now, outbound) {
  const db = env.DB;
  const { results: pending } = await db
    .prepare("SELECT * FROM events WHERE delivery = 'pending' ORDER BY created_at LIMIT ?")
    .bind(PENDING_PER_TICK)
    .all();
  if (!pending.length) return 0;
  const userIds = [...new Set(pending.map((e) => e.user_id))];
  const marks = userIds.map(() => '?').join(',');
  const [usersRes, chRes, urlRes] = await db.batch([
    db.prepare(`SELECT * FROM users WHERE id IN (${marks})`).bind(...userIds),
    db.prepare(`SELECT * FROM channels WHERE user_id IN (${marks})`).bind(...userIds),
    db.prepare("SELECT value FROM meta WHERE key = 'app_url'"),
  ]);
  const appUrl = urlRes.results[0]?.value || null;
  const users = new Map(usersRes.results.map((u) => [u.id, u]));
  const available = availableChannels(env);
  const updates = [];
  const toDelete = [];
  let delivered = 0;

  for (const userId of userIds) {
    const user = users.get(userId);
    const events = pending.filter((e) => e.user_id === userId);
    const channels = chRes.results.filter((c) => c.user_id === userId && available[c.type]);
    if (!user || !channels.length) {
      for (const e of events) updates.push(db.prepare("UPDATE events SET delivery = 'none' WHERE id = ?").bind(e.id));
      continue;
    }
    if (inQuietHours(user, now)) continue; // stays pending; sent as a summary once quiet hours end

    // Limit to the channels the alerts asked for (none listed = all connected channels).
    const wanted = new Set();
    let all = false;
    for (const e of events) {
      const list = parseJson(e.channels, null);
      if (!list || !list.length) all = true;
      else list.forEach((t) => wanted.add(t));
    }
    const targets = all ? channels : channels.filter((c) => wanted.has(c.type));
    if (!targets.length) {
      for (const e of events) updates.push(db.prepare("UPDATE events SET delivery = 'none' WHERE id = ?").bind(e.id));
      continue;
    }
    if (targets.length > outbound) break;

    const msg =
      events.length === 1
        ? { title: events[0].title, body: events[0].body, url: '/#/history', tag: `alert-${events[0].alert_id}` }
        : {
            title: `【${events.length} 則提醒】${[...new Set(events.map((e) => e.symbol))].join('、')}`,
            body: events.map((e) => e.title.replace(/^【[^】]+】/, '')).join('\n'),
            url: '/#/history',
            tag: 'digest',
          };
    outbound -= targets.length;
    const { sentVia, gone } = await deliverToChannels(env, targets, msg, appUrl);
    toDelete.push(...gone);
    const status = sentVia.length ? 'sent' : 'failed';
    for (const e of events) {
      updates.push(db.prepare('UPDATE events SET delivery = ?, sent_via = ? WHERE id = ?').bind(status, JSON.stringify(sentVia), e.id));
    }
    if (sentVia.length) delivered += events.length;
  }

  for (const c of toDelete) {
    updates.push(db.prepare('DELETE FROM channels WHERE user_id = ? AND type = ? AND target = ?').bind(c.user_id, c.type, c.target));
  }
  if (updates.length) await db.batch(updates);
  return delivered;
}

export { quoteFromRow };
