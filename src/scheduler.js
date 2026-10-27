// Runs every minute (Cron Trigger): refresh prices, evaluate alerts, deliver notifications.
// Written to stay inside the Workers Free plan limits per run: 50 outbound requests, 50 D1 queries
// (a db.batch counts as one), 10 ms CPU.
import { ensureSchema, getMeta, parseJson, upsertQuoteStmt, quoteFromRow } from './db.js';
import { marketState } from './market.js';
import { fetchQuote, fetchBars, hasBarSource, isDemo, twelveDataCreditsLeft, TD_DAILY_CAP } from './providers.js';
import { mergeLiveBar } from './indicators.js';
import { makeContext, evaluateAlert } from './engine.js';
import { availableChannels, ensureTelegramWebhook, deliverToChannels } from './notify.js';
import { fmtPrice, fmtPct, fmtUserTime, minutesInZone } from './util.js';

const QUOTES_PER_TICK = 20; // Finnhub free: 60/min, leave room for the app's own lookups
const BARS_PER_TICK = 5; // Twelve Data free: 8/min
const OUTBOUND_BUDGET = 46; // Workers Free: 50 subrequests per run
const PENDING_PER_TICK = 25;

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

  // ---- 1. which symbols matter right now ----
  const { results: alertRows } = await db.prepare('SELECT * FROM alerts WHERE active = 1').all();
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

    // ---- 2. bars (indicators) ----
    const barsFetched = new Map();
    if (hasBarSource(env)) {
      const refreshMin = Math.max(15, Math.ceil((alertSymbols.length * 390) / (TD_DAILY_CAP - 60)));
      const needsBars = alertSymbols
        .filter((s) => {
          const at = barsUpdated.get(s);
          if (!at) return true; // never fetched
          const ageMin = (now - at) / 60000;
          if (market.open) return ageMin >= refreshMin;
          // After the close, one final refresh to capture the full day's bar.
          if (market.sinceClose != null && market.sinceClose >= 20) return ageMin > market.sinceClose - 20;
          return false;
        })
        .sort((a, b) => (barsUpdated.get(a) || 0) - (barsUpdated.get(b) || 0));
      let credits = null;
      if (needsBars.length && !isDemo(env)) credits = await twelveDataCreditsLeft(env, now);
      const batch = needsBars.slice(0, Math.min(BARS_PER_TICK, credits ? credits.left : Infinity, outbound));
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

    // ---- 3. live quotes, oldest first (only while the market is open) ----
    const freshQuotes = new Map();
    if (market.open) {
      const order = alertSymbols.slice().sort((a, b) => (quoteBySymbol.get(a)?.updated_at || 0) - (quoteBySymbol.get(b)?.updated_at || 0));
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

    // ---- 4. evaluate alerts for symbols with a fresh quote ----
    if (freshQuotes.size) {
      const symbols = [...freshQuotes.keys()];
      const needStored = symbols.filter((s) => !barsFetched.has(s));
      const stored = new Map();
      if (needStored.length) {
        const { results } = await db
          .prepare(`SELECT symbol, data FROM bars WHERE symbol IN (${needStored.map(() => '?').join(',')})`)
          .bind(...needStored)
          .all();
        for (const r of results) stored.set(r.symbol, unpackBars(r.data));
      }
      const userIds = [...new Set(alertRows.filter((a) => freshQuotes.has(a.symbol)).map((a) => a.user_id))];
      const users = new Map();
      if (userIds.length) {
        const { results } = await db
          .prepare(`SELECT id, tz FROM users WHERE id IN (${userIds.map(() => '?').join(',')})`)
          .bind(...userIds)
          .all();
        for (const u of results) users.set(u.id, u);
      }

      const contexts = new Map();
      for (const s of symbols) {
        const quote = freshQuotes.get(s);
        const bars = barsFetched.get(s) || stored.get(s) || [];
        contexts.set(s, makeContext(mergeLiveBar(bars, quote, market.date), quote));
      }

      for (const row of alertRows) {
        const ctx = contexts.get(row.symbol);
        if (!ctx) continue;
        summary.evaluated++;
        const alert = { ...row, conditions: parseJson(row.conditions, []) };
        const r = evaluateAlert(alert, ctx);
        const quote = freshQuotes.get(row.symbol);
        const detail = r.results.map((x) => x.now).filter((v, i, arr) => arr.indexOf(v) === i).join(' · ');
        let status = r.triggered ? 'triggered' : r.near ? 'near' : 'watching';
        if (!r.triggered && row.last_trigger_day === market.date) status = 'triggered'; // keep "今日已觸發" for the day

        let fire = false;
        if (r.triggered) {
          if (row.frequency === 'once') fire = true;
          else if (row.frequency === 'hourly') fire = !row.last_triggered_at || now - row.last_triggered_at >= 3600000;
          else fire = row.last_trigger_day !== market.date;
        }

        const tz = users.get(row.user_id)?.tz || 'UTC';
        const priceLine = `${fmtPrice(quote.price)}（${fmtPct(quote.changePct)}）`;
        if (fire) {
          summary.triggered++;
          const metLabels = r.results.filter((x) => x.met).map((x) => x.label);
          writes.push(
            db
              .prepare(
                `INSERT INTO events (user_id, alert_id, symbol, kind, title, body, channels, delivery, created_at)
                 VALUES (?, ?, ?, 'triggered', ?, ?, ?, 'pending', ?)`
              )
              .bind(
                row.user_id,
                row.id,
                row.symbol,
                `【已觸發】${row.symbol} ${priceLine}`,
                `${metLabels.join('、')}\n${detail}\n${fmtUserTime(now, tz)}`,
                row.channels,
                now
              )
          );
          writes.push(
            db
              .prepare('UPDATE alerts SET last_triggered_at = ?, last_trigger_day = ?, active = ? WHERE id = ?')
              .bind(now, market.date, row.frequency === 'once' ? 0 : 1, row.id)
          );
        } else if (r.near && row.last_near_day !== market.date && row.last_trigger_day !== market.date) {
          const pending = r.results.filter((x) => !x.met).map((x) => x.label);
          writes.push(
            db
              .prepare(
                `INSERT INTO events (user_id, alert_id, symbol, kind, title, body, delivery, created_at)
                 VALUES (?, ?, ?, 'near', ?, ?, 'none', ?)`
              )
              .bind(row.user_id, row.id, row.symbol, `${row.symbol} 接近觸發`, `還差：${pending.join('、')}\n${detail}`, now)
          );
          writes.push(db.prepare('UPDATE alerts SET last_near_day = ? WHERE id = ?').bind(market.date, row.id));
        }
        writes.push(
          db.prepare('UPDATE alerts SET status = ?, status_detail = ?, checked_at = ? WHERE id = ?').bind(status, detail, now, row.id)
        );
      }
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
            body: events.map((e) => e.title.replace('【已觸發】', '')).join('\n'),
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
