// JSON API used by the web app.
import { ensureSchema, getMeta, setMeta, parseJson, upsertQuoteStmt, quoteFromRow } from './db.js';
import {
  json,
  HttpError,
  bad,
  randomCode,
  randomHex,
  formatAccountCode,
  normalizeAccountCode,
  sha256Hex,
  isValidSymbol,
  isValidTimeZone,
} from './util.js';
import { marketState, nyParts } from './market.js';
import { fetchQuote, searchSymbols, isDemo, hasBarSource } from './providers.js';
import { sanitizeCondition, describeCondition, MAX_CONDITIONS, FREQUENCIES } from './engine.js';
import {
  availableChannels,
  ensureTelegramWebhook,
  telegramSecret,
  telegramReply,
  sendToUser,
  sendRawEmail,
  deliverToChannels,
  CHANNEL_TYPES,
} from './notify.js';

const MAX_WATCHLIST = 50;
const MAX_ALERTS = 30;
let knownOrigin = null;

export async function handleApi(request, env, ctx) {
  const url = new URL(request.url);
  const db = env.DB;
  await ensureSchema(db);

  // Remember the public URL so the background job can build links (Telegram webhook, notifications).
  if (knownOrigin !== url.origin) {
    knownOrigin = url.origin;
    ctx.waitUntil(
      (async () => {
        if ((await getMeta(db, 'app_url')) !== url.origin) await setMeta(db, 'app_url', url.origin);
      })()
    );
  }

  try {
    const res = await route(request, env, ctx, url);
    return res;
  } catch (err) {
    if (err instanceof HttpError) return json({ error: err.message }, err.status);
    console.error(err);
    return json({ error: '伺服器發生錯誤，請稍後再試' }, 500);
  }
}

async function readBody(request) {
  try {
    return await request.json();
  } catch {
    throw bad('資料格式錯誤');
  }
}

async function requireUser(request, env) {
  const auth = request.headers.get('authorization') || '';
  const code = normalizeAccountCode(auth.replace(/^Bearer\s+/i, ''));
  if (code.length !== 16) throw new HttpError(401, '請先登入');
  const user = await env.DB.prepare('SELECT * FROM users WHERE code_hash = ?').bind(await sha256Hex(code)).first();
  if (!user) throw new HttpError(401, '帳號代碼不存在');
  return user;
}

async function route(request, env, ctx, url) {
  const db = env.DB;
  const method = request.method;
  const path = url.pathname.replace(/\/+$/, '');
  const now = Date.now();

  // ---------- public ----------
  if (path === '/api/config' && method === 'GET') {
    const channels = availableChannels(env);
    let telegramBot = null;
    if (channels.telegram) {
      try {
        telegramBot = await ensureTelegramWebhook(env, url.origin);
      } catch (err) {
        console.warn('telegram', String(err));
        channels.telegram = false;
      }
    }
    return json({
      demo: isDemo(env),
      indicators: hasBarSource(env),
      channels,
      vapidPublicKey: channels.webpush ? env.VAPID_PUBLIC_KEY : null,
      telegramBot,
      market: marketInfo(env, now),
    });
  }

  if (path === '/api/account' && method === 'POST') {
    const body = await readBody(request);
    const code = randomCode(16);
    const id = randomHex(12);
    const tz = isValidTimeZone(body.tz) ? body.tz : 'UTC';
    await db
      .prepare('INSERT INTO users (id, code_hash, tz, created_at) VALUES (?, ?, ?, ?)')
      .bind(id, await sha256Hex(code), tz, now)
      .run();
    return json({ code: formatAccountCode(code) });
  }

  if (path === '/api/login' && method === 'POST') {
    const body = await readBody(request);
    const code = normalizeAccountCode(body.code);
    if (code.length !== 16) throw bad('帳號代碼是 16 個字元');
    const user = await db.prepare('SELECT id FROM users WHERE code_hash = ?').bind(await sha256Hex(code)).first();
    if (!user) throw new HttpError(404, '找不到這組帳號代碼，請再確認一次');
    return json({ code: formatAccountCode(code) });
  }

  if (path === '/api/telegram/webhook' && method === 'POST') {
    return telegramWebhook(request, env);
  }

  if (path === '/api/email/verify' && method === 'GET') {
    const code = url.searchParams.get('c') || '';
    const link = await db.prepare("SELECT * FROM link_codes WHERE code = ? AND kind = 'email'").bind(code).first();
    if (!link || link.expires_at < now) return Response.redirect(`${url.origin}/#/settings?email=expired`, 302);
    await db.batch([
      db.prepare("DELETE FROM channels WHERE user_id = ? AND type = 'email'").bind(link.user_id),
      db.prepare("INSERT INTO channels (user_id, type, target, created_at) VALUES (?, 'email', ?, ?)").bind(link.user_id, link.payload, now),
      db.prepare('DELETE FROM link_codes WHERE code = ?').bind(code),
    ]);
    return Response.redirect(`${url.origin}/#/settings?email=ok`, 302);
  }

  // ---------- signed in ----------
  const user = await requireUser(request, env);

  if (path === '/api/me') {
    if (method === 'GET') return json(await meResponse(env, user));
    if (method === 'PUT') {
      const body = await readBody(request);
      const tz = body.tz !== undefined ? (isValidTimeZone(body.tz) ? body.tz : user.tz) : user.tz;
      const minutes = (v, d) => (Number.isInteger(v) && v >= 0 && v < 1440 ? v : d);
      const quietOn = body.quietOn !== undefined ? (body.quietOn ? 1 : 0) : user.quiet_on;
      await db
        .prepare('UPDATE users SET tz = ?, quiet_on = ?, quiet_start = ?, quiet_end = ? WHERE id = ?')
        .bind(tz, quietOn, minutes(body.quietStart, user.quiet_start), minutes(body.quietEnd, user.quiet_end), user.id)
        .run();
      const fresh = await db.prepare('SELECT * FROM users WHERE id = ?').bind(user.id).first();
      return json(await meResponse(env, fresh));
    }
    if (method === 'DELETE') {
      await db.batch(
        ['watchlist', 'alerts', 'events', 'channels', 'link_codes'].map((t) => db.prepare(`DELETE FROM ${t} WHERE user_id = ?`).bind(user.id)).concat([
          db.prepare('DELETE FROM users WHERE id = ?').bind(user.id),
        ])
      );
      return json({ ok: true });
    }
  }

  if (path === '/api/search' && method === 'GET') {
    const q = (url.searchParams.get('q') || '').slice(0, 40);
    try {
      return json({ results: await searchSymbols(env, q) });
    } catch (err) {
      console.warn('search', String(err));
      throw new HttpError(502, '搜尋暫時無法使用，請稍後再試');
    }
  }

  if (path === '/api/watchlist') {
    if (method === 'GET') return json(await watchlistResponse(env, user, now));
    if (method === 'POST') {
      const body = await readBody(request);
      const symbol = String(body.symbol || '').toUpperCase().trim();
      if (!isValidSymbol(symbol)) throw bad('股票代號格式不正確');
      const count = await db.prepare('SELECT COUNT(*) AS n FROM watchlist WHERE user_id = ?').bind(user.id).first();
      if (count.n >= MAX_WATCHLIST) throw bad(`自選股最多 ${MAX_WATCHLIST} 支`);
      await ensureQuote(env, symbol, now);
      await db
        .prepare('INSERT OR IGNORE INTO watchlist (user_id, symbol, name, added_at) VALUES (?, ?, ?, ?)')
        .bind(user.id, symbol, String(body.name || symbol).slice(0, 80), now)
        .run();
      return json(await watchlistResponse(env, user, now));
    }
  }

  let m = path.match(/^\/api\/watchlist\/([A-Z0-9.\-]{1,10})$/i);
  if (m && method === 'DELETE') {
    const symbol = m[1].toUpperCase();
    await db.batch([
      db.prepare('DELETE FROM watchlist WHERE user_id = ? AND symbol = ?').bind(user.id, symbol),
      db.prepare('DELETE FROM alerts WHERE user_id = ? AND symbol = ?').bind(user.id, symbol),
    ]);
    return json({ ok: true });
  }

  if (path === '/api/alerts' && method === 'POST') {
    const body = await readBody(request);
    const fields = cleanAlertInput(body, true);
    const count = await db.prepare('SELECT COUNT(*) AS n FROM alerts WHERE user_id = ? AND active = 1').bind(user.id).first();
    if (count.n >= MAX_ALERTS) throw bad(`啟用中的提醒最多 ${MAX_ALERTS} 個`);
    await ensureQuote(env, fields.symbol, now);
    const inserted = await db.batch([
      db
        .prepare('INSERT OR IGNORE INTO watchlist (user_id, symbol, name, added_at) VALUES (?, ?, ?, ?)')
        .bind(user.id, fields.symbol, String(body.name || fields.symbol).slice(0, 80), now),
      db
        .prepare(
          `INSERT INTO alerts (user_id, symbol, logic, conditions, channels, frequency, active, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 1, 'watching', ?) RETURNING *`
        )
        .bind(user.id, fields.symbol, fields.logic, JSON.stringify(fields.conditions), fields.channels, fields.frequency, now),
    ]);
    const row = inserted[1].results[0];
    await db
      .prepare("INSERT INTO events (user_id, alert_id, symbol, kind, title, body, created_at) VALUES (?, ?, ?, 'created', ?, ?, ?)")
      .bind(user.id, row.id, row.symbol, `${row.symbol} 提醒已建立`, fields.conditions.map(describeCondition).join(row.logic === 'any' ? ' 或 ' : ' 且 '), now)
      .run();
    return json({ alert: alertResponse(row) });
  }

  m = path.match(/^\/api\/alerts\/(\d+)$/);
  if (m) {
    const id = Number(m[1]);
    const row = await db.prepare('SELECT * FROM alerts WHERE id = ? AND user_id = ?').bind(id, user.id).first();
    if (!row) throw new HttpError(404, '找不到這個提醒');
    if (method === 'GET') return json({ alert: alertResponse(row) });
    if (method === 'DELETE') {
      await db.prepare('DELETE FROM alerts WHERE id = ?').bind(id).run();
      return json({ ok: true });
    }
    if (method === 'PUT') {
      const body = await readBody(request);
      const fields = cleanAlertInput({ ...body, symbol: row.symbol }, false);
      const active = body.active === undefined ? row.active : body.active ? 1 : 0;
      const changed = JSON.stringify(fields.conditions) !== row.conditions || fields.logic !== row.logic;
      const updated = await db
        .prepare(
          `UPDATE alerts SET logic = ?, conditions = ?, channels = ?, frequency = ?, active = ?,
             status = CASE WHEN ? THEN 'watching' ELSE status END,
             last_trigger_day = CASE WHEN ? THEN NULL ELSE last_trigger_day END,
             last_near_day = CASE WHEN ? THEN NULL ELSE last_near_day END
           WHERE id = ? RETURNING *`
        )
        .bind(fields.logic, JSON.stringify(fields.conditions), fields.channels, fields.frequency, active, changed ? 1 : 0, changed ? 1 : 0, changed ? 1 : 0, id)
        .first();
      return json({ alert: alertResponse(updated) });
    }
  }

  if (path === '/api/events' && method === 'GET') {
    const range = url.searchParams.get('range') || 'today';
    const since = range === 'today' ? now - 86400000 : range === 'week' ? now - 7 * 86400000 : 0;
    const { results } = await db
      .prepare('SELECT * FROM events WHERE user_id = ? AND created_at >= ? ORDER BY created_at DESC LIMIT 200')
      .bind(user.id, since)
      .all();
    return json({
      events: results.map((e) => ({
        id: e.id,
        alertId: e.alert_id,
        symbol: e.symbol,
        kind: e.kind,
        title: e.title,
        body: e.body,
        delivery: e.delivery,
        sentVia: parseJson(e.sent_via, []),
        createdAt: e.created_at,
      })),
    });
  }

  // ---------- notification channels ----------
  if (path === '/api/channels/webpush') {
    const body = await readBody(request);
    const endpoint = String(body.endpoint || body.subscription?.endpoint || '');
    if (!/^https:\/\//.test(endpoint) || endpoint.length > 1000) throw bad('推播訂閱資料不正確');
    if (method === 'POST') {
      if (!availableChannels(env).webpush) throw bad('網頁推播尚未設定');
      const keys = body.subscription?.keys || {};
      if (!keys.p256dh || !keys.auth) throw bad('推播訂閱資料不正確');
      await db
        .prepare(
          `INSERT INTO channels (user_id, type, target, meta, created_at) VALUES (?, 'webpush', ?, ?, ?)
           ON CONFLICT(user_id, type, target) DO UPDATE SET meta = excluded.meta`
        )
        .bind(user.id, endpoint, JSON.stringify({ keys: { p256dh: keys.p256dh, auth: keys.auth }, ua: String(body.device || '').slice(0, 60) }), now)
        .run();
      // Clean up the same endpoint if it was saved under another account on this device.
      await db.prepare("DELETE FROM channels WHERE type = 'webpush' AND target = ? AND user_id != ?").bind(endpoint, user.id).run();
      return json(await meResponse(env, user));
    }
    if (method === 'DELETE') {
      await db.prepare("DELETE FROM channels WHERE user_id = ? AND type = 'webpush' AND target = ?").bind(user.id, endpoint).run();
      return json(await meResponse(env, user));
    }
  }

  if (path === '/api/channels/telegram' && method === 'POST') {
    if (!availableChannels(env).telegram) throw bad('Telegram 尚未設定');
    const username = await ensureTelegramWebhook(env, url.origin);
    const code = randomHex(12);
    await db
      .prepare("INSERT INTO link_codes (code, user_id, kind, expires_at) VALUES (?, ?, 'telegram', ?)")
      .bind(code, user.id, now + 30 * 60000)
      .run();
    return json({ url: `https://t.me/${username}?start=${code}` });
  }

  if (path === '/api/channels/discord' && method === 'POST') {
    const body = await readBody(request);
    const hook = String(body.url || '').trim();
    if (!/^https:\/\/(canary\.|ptb\.)?(discord|discordapp)\.com\/api\/webhooks\/\d+\/[\w-]+$/.test(hook)) {
      throw bad('這不是 Discord Webhook 網址，應該像 https://discord.com/api/webhooks/…');
    }
    const ch = { user_id: user.id, type: 'discord', target: hook };
    const { sentVia } = await deliverToChannels(env, [ch], { title: '股票提醒已連接 ✓', body: '之後觸發的提醒會傳到這個頻道。' });
    if (!sentVia.length) throw bad('傳送測試訊息失敗，請確認 Webhook 網址還有效');
    await db.batch([
      db.prepare("DELETE FROM channels WHERE user_id = ? AND type = 'discord'").bind(user.id),
      db.prepare("INSERT INTO channels (user_id, type, target, created_at) VALUES (?, 'discord', ?, ?)").bind(user.id, hook, now),
    ]);
    return json(await meResponse(env, user));
  }

  if (path === '/api/channels/email' && method === 'POST') {
    if (!availableChannels(env).email) throw bad('Email 通知尚未設定');
    const body = await readBody(request);
    const address = String(body.address || '').trim().toLowerCase();
    if (!/^[^\s@]{1,64}@[^\s@]{1,190}\.[a-z]{2,}$/.test(address)) throw bad('Email 格式不正確');
    const recent = await db
      .prepare("SELECT COUNT(*) AS n FROM link_codes WHERE user_id = ? AND kind = 'email' AND expires_at > ?")
      .bind(user.id, now + 23 * 3600000)
      .first();
    if (recent.n >= 3) throw bad('驗證信寄太多次了，請一小時後再試');
    const code = randomHex(16);
    await db
      .prepare("INSERT INTO link_codes (code, user_id, kind, payload, expires_at) VALUES (?, ?, 'email', ?, ?)")
      .bind(code, user.id, address, now + 24 * 3600000)
      .run();
    const r = await sendRawEmail(
      env,
      address,
      '確認你的股票提醒 Email',
      `點下面的連結，之後的股票提醒就會寄到這個信箱：\n\n${url.origin}/api/email/verify?c=${code}\n\n如果不是你本人操作，忽略這封信即可。`
    );
    if (!r.ok) throw new HttpError(502, '驗證信寄送失敗，請稍後再試');
    return json({ ok: true });
  }

  m = path.match(/^\/api\/channels\/(telegram|discord|email)$/);
  if (m && method === 'DELETE') {
    await db.prepare('DELETE FROM channels WHERE user_id = ? AND type = ?').bind(user.id, m[1]).run();
    return json(await meResponse(env, user));
  }

  if (path === '/api/test' && method === 'POST') {
    const { sentVia, connected } = await sendToUser(env, user.id, {
      title: '測試通知 ✓',
      body: '收到這則訊息，代表股票提醒可以正常通知你。',
      url: '/#/settings',
      tag: 'test',
    });
    if (!connected) throw bad('還沒有連接任何通知方式');
    if (!sentVia.length) throw new HttpError(502, '測試通知送出失敗，請重新連接通知方式');
    return json({ sentVia });
  }

  throw new HttpError(404, '找不到這個功能');
}

// ---------- helpers ----------

function marketInfo(env, now) {
  const s = marketState(now, { forceOpen: env.FORCE_MARKET_OPEN === '1' });
  return { open: s.open, nextOpenMs: s.nextOpenMs, closesAtMs: s.closesAtMs, now };
}

function cleanAlertInput(body, isNew) {
  const symbol = String(body.symbol || '').toUpperCase().trim();
  if (isNew && !isValidSymbol(symbol)) throw bad('請先選擇股票');
  const list = Array.isArray(body.conditions) ? body.conditions : [];
  if (!list.length) throw bad('至少需要一個條件');
  if (list.length > MAX_CONDITIONS) throw bad(`條件最多 ${MAX_CONDITIONS} 個`);
  let conditions;
  try {
    conditions = list.map(sanitizeCondition);
  } catch (err) {
    throw bad(err.message);
  }
  const logic = body.logic === 'any' ? 'any' : 'all';
  const frequency = FREQUENCIES.includes(body.frequency) ? body.frequency : 'daily';
  const channels = Array.isArray(body.channels) ? body.channels.filter((c) => CHANNEL_TYPES.includes(c)) : [];
  return { symbol, logic, conditions, frequency, channels: channels.length ? JSON.stringify([...new Set(channels)]) : null };
}

export function alertResponse(row) {
  const conditions = parseJson(row.conditions, []);
  return {
    id: row.id,
    symbol: row.symbol,
    logic: row.logic,
    conditions,
    labels: conditions.map(describeCondition),
    channels: parseJson(row.channels, []),
    frequency: row.frequency,
    active: Boolean(row.active),
    status: row.active ? row.status : row.last_triggered_at && row.frequency === 'once' ? 'done' : 'paused',
    statusDetail: row.status_detail,
    checked: Boolean(row.checked_at),
    lastTriggeredAt: row.last_triggered_at,
  };
}

async function meResponse(env, user) {
  const { results } = await env.DB.prepare('SELECT type, target, meta, created_at FROM channels WHERE user_id = ?').bind(user.id).all();
  const channels = results.map((c) => ({
    type: c.type,
    // Only Web Push needs the real target (so a device knows whether it is subscribed).
    target: c.type === 'webpush' ? c.target : c.type === 'email' ? c.target : c.type === 'discord' ? 'Discord 頻道' : 'Telegram',
    device: c.type === 'webpush' ? parseJson(c.meta, {}).ua || '' : '',
  }));
  return {
    tz: user.tz,
    quietOn: Boolean(user.quiet_on),
    quietStart: user.quiet_start,
    quietEnd: user.quiet_end,
    channels,
  };
}

// Make sure we have a recent quote for the symbol (also validates that the symbol exists).
async function ensureQuote(env, symbol, now) {
  const row = await env.DB.prepare('SELECT * FROM quotes WHERE symbol = ?').bind(symbol).first();
  if (row && now - row.updated_at < 6 * 3600000) return quoteFromRow(row);
  let q;
  try {
    q = await fetchQuote(env, symbol, now);
  } catch (err) {
    console.warn('quote', symbol, String(err));
    if (row) return quoteFromRow(row);
    throw new HttpError(502, '暫時查不到股價，請稍後再試');
  }
  if (!q) throw bad(`找不到 ${symbol} 這個股票代號`);
  await upsertQuoteStmt(env.DB, symbol, q, now).run();
  return q;
}

async function watchlistResponse(env, user, now) {
  const db = env.DB;
  const [wl, alerts] = await db.batch([
    db.prepare('SELECT * FROM watchlist WHERE user_id = ? ORDER BY added_at').bind(user.id),
    db.prepare('SELECT * FROM alerts WHERE user_id = ? ORDER BY created_at').bind(user.id),
  ]);
  const symbols = wl.results.map((w) => w.symbol);
  const quotes = new Map();
  if (symbols.length) {
    const { results } = await db.prepare(`SELECT * FROM quotes WHERE symbol IN (${symbols.map(() => '?').join(',')})`).bind(...symbols).all();
    for (const r of results) quotes.set(r.symbol, quoteFromRow(r));
  }
  // Refresh stale prices on the spot (a few per request to respect the data provider's limits).
  const market = marketState(now, { forceOpen: env.FORCE_MARKET_OPEN === '1' });
  const maxAge = market.open ? 60000 : 30 * 60000;
  const stale = symbols.filter((s) => !quotes.get(s) || now - quotes.get(s).updatedAt > maxAge).slice(0, 8);
  if (stale.length) {
    const fetched = await Promise.allSettled(stale.map((s) => fetchQuote(env, s, now)));
    const writes = [];
    fetched.forEach((r, i) => {
      if (r.status === 'fulfilled' && r.value) {
        quotes.set(stale[i], { ...r.value, updatedAt: now });
        writes.push(upsertQuoteStmt(db, stale[i], r.value, now));
      }
    });
    if (writes.length) await db.batch(writes);
  }
  return {
    market: marketInfo(env, now),
    today: nyParts(now).date,
    stocks: wl.results.map((w) => ({
      symbol: w.symbol,
      name: w.name,
      quote: quotes.get(w.symbol) || null,
      alerts: alerts.results.filter((a) => a.symbol === w.symbol).map(alertResponse),
    })),
  };
}

// ---------- Telegram bot webhook ----------

async function telegramWebhook(request, env) {
  if (!env.TELEGRAM_BOT_TOKEN) return new Response('not configured', { status: 404 });
  if (request.headers.get('x-telegram-bot-api-secret-token') !== (await telegramSecret(env))) {
    return new Response('forbidden', { status: 403 });
  }
  const update = await request.json().catch(() => ({}));
  const msg = update.message;
  if (!msg || !msg.chat) return json({ ok: true });
  const chatId = String(msg.chat.id);
  const text = String(msg.text || '').trim();
  const db = env.DB;
  const start = text.match(/^\/start\s+([a-f0-9]{24})$/);
  if (start) {
    const link = await db.prepare("SELECT * FROM link_codes WHERE code = ? AND kind = 'telegram'").bind(start[1]).first();
    if (!link || link.expires_at < Date.now()) {
      await telegramReply(env, chatId, '這個連接已過期，請回到網頁重新按「連接 Telegram」。');
      return json({ ok: true });
    }
    await db.batch([
      db.prepare("DELETE FROM channels WHERE user_id = ? AND type = 'telegram'").bind(link.user_id),
      db.prepare("INSERT INTO channels (user_id, type, target, created_at) VALUES (?, 'telegram', ?, ?)").bind(link.user_id, chatId, Date.now()),
      db.prepare('DELETE FROM link_codes WHERE code = ?').bind(start[1]),
    ]);
    await telegramReply(env, chatId, '連接成功 ✓\n之後股票提醒觸發時，會在這裡通知你。');
    return json({ ok: true });
  }
  if (text === '/stop') {
    await db.prepare("DELETE FROM channels WHERE type = 'telegram' AND target = ?").bind(chatId).run();
    await telegramReply(env, chatId, '已停止 Telegram 通知。要重新開啟，請到網頁的「通知設定」。');
    return json({ ok: true });
  }
  await telegramReply(env, chatId, '這是股票提醒的通知機器人。請到網頁的「通知設定」按「連接 Telegram」來開始接收提醒。\n輸入 /stop 可以停止通知。');
  return json({ ok: true });
}
