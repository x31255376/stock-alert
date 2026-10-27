// Sending notifications: Web Push, Telegram, Discord, Email (Resend).
import { buildPushPayload } from '@block65/webcrypto-web-push';
import { getMeta, setMeta, parseJson } from './db.js';
import { sha256Hex } from './util.js';

export const CHANNEL_TYPES = ['webpush', 'telegram', 'discord', 'email'];

export function availableChannels(env) {
  return {
    webpush: Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY),
    telegram: Boolean(env.TELEGRAM_BOT_TOKEN),
    discord: true,
    email: Boolean(env.RESEND_API_KEY && env.EMAIL_FROM),
  };
}

// ---------- per-channel senders: each returns { ok, gone } ----------

async function sendWebPush(env, appUrl, channel, msg) {
  const meta = parseJson(channel.meta, {});
  const subscription = { endpoint: channel.target, expirationTime: null, keys: meta.keys || {} };
  const vapid = {
    subject: env.VAPID_SUBJECT || appUrl || 'mailto:admin@example.com',
    publicKey: env.VAPID_PUBLIC_KEY,
    privateKey: env.VAPID_PRIVATE_KEY,
  };
  const data = JSON.stringify({ title: msg.title, body: msg.body, url: msg.url || '/', tag: msg.tag });
  const payload = await buildPushPayload({ data, options: { ttl: 3600, urgency: 'high' } }, subscription, vapid);
  const res = await fetch(subscription.endpoint, payload);
  return { ok: res.status >= 200 && res.status < 300, gone: res.status === 404 || res.status === 410, status: res.status };
}

async function sendTelegram(env, appUrl, channel, msg) {
  const text = `${msg.title}\n${msg.body || ''}`.trim();
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: channel.target,
      text,
      disable_web_page_preview: true,
      reply_markup: msg.url && appUrl ? { inline_keyboard: [[{ text: '打開股票提醒', url: absolute(appUrl, msg.url) }]] } : undefined,
    }),
  });
  // 403 = the user blocked the bot
  return { ok: res.ok, gone: res.status === 403, status: res.status };
}

async function sendDiscord(env, appUrl, channel, msg) {
  const res = await fetch(channel.target, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username: '股票提醒',
      content: `**${msg.title}**\n${msg.body || ''}${msg.url && appUrl ? `\n${absolute(appUrl, msg.url)}` : ''}`.slice(0, 1900),
      allowed_mentions: { parse: [] },
    }),
  });
  return { ok: res.ok, gone: res.status === 404 || res.status === 401, status: res.status };
}

async function sendEmail(env, appUrl, channel, msg) {
  return sendRawEmail(env, channel.target, msg.title, `${msg.body || ''}${msg.url && appUrl ? `\n\n${absolute(appUrl, msg.url)}` : ''}`);
}

export async function sendRawEmail(env, to, subject, text) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${env.RESEND_API_KEY}` },
    body: JSON.stringify({ from: env.EMAIL_FROM, to: [to], subject, text }),
  });
  return { ok: res.ok, gone: false, status: res.status };
}

const SENDERS = { webpush: sendWebPush, telegram: sendTelegram, discord: sendDiscord, email: sendEmail };

function absolute(appUrl, path) {
  try {
    return new URL(path, appUrl).toString();
  } catch {
    return appUrl;
  }
}

// Send one message to a list of channel rows. Returns delivered types and rows that are gone
// (unsubscribed / blocked) so the caller can delete them.
export async function deliverToChannels(env, channels, msg, appUrl) {
  if (appUrl === undefined) appUrl = await getMeta(env.DB, 'app_url');
  const available = availableChannels(env);
  const sentVia = new Set();
  const gone = [];
  await Promise.all(
    channels
      .filter((ch) => available[ch.type])
      .map(async (ch) => {
        try {
          const r = await SENDERS[ch.type](env, appUrl, ch, msg);
          if (r.ok) sentVia.add(ch.type);
          else if (r.gone) gone.push(ch);
          else console.warn('notify failed', ch.type, r.status);
        } catch (err) {
          console.warn('notify error', ch.type, String(err));
        }
      })
  );
  return { sentVia: [...sentVia], gone };
}

// Used by the "send a test notification" button.
export async function sendToUser(env, userId, msg) {
  const db = env.DB;
  const { results } = await db.prepare('SELECT * FROM channels WHERE user_id = ?').bind(userId).all();
  const { sentVia, gone } = await deliverToChannels(env, results, msg);
  if (gone.length) {
    await db.batch(gone.map((c) => db.prepare('DELETE FROM channels WHERE user_id = ? AND type = ? AND target = ?').bind(c.user_id, c.type, c.target)));
  }
  return { sentVia, connected: results.length };
}

// ---------- Telegram bot setup ----------

export async function telegramSecret(env) {
  return (await sha256Hex(`tg-webhook:${env.TELEGRAM_BOT_TOKEN}`)).slice(0, 48);
}

// Registers the webhook and remembers the bot's @username. Runs once per app URL / token.
export async function ensureTelegramWebhook(env, appUrl) {
  if (!env.TELEGRAM_BOT_TOKEN || !appUrl) return null;
  const db = env.DB;
  const tokenTag = (await sha256Hex(env.TELEGRAM_BOT_TOKEN)).slice(0, 12);
  const wanted = `${appUrl}/api/telegram/webhook|${tokenTag}`;
  if ((await getMeta(db, 'tg_webhook')) === wanted) return getMeta(db, 'tg_username');
  const api = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}`;
  const me = await (await fetch(`${api}/getMe`)).json();
  if (!me.ok) throw new Error('Telegram bot token 無效');
  const set = await (
    await fetch(`${api}/setWebhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        url: `${appUrl}/api/telegram/webhook`,
        secret_token: await telegramSecret(env),
        allowed_updates: ['message'],
      }),
    })
  ).json();
  if (!set.ok) throw new Error(`Telegram setWebhook 失敗：${set.description || ''}`);
  await setMeta(db, 'tg_username', me.result.username);
  await setMeta(db, 'tg_webhook', wanted);
  return me.result.username;
}

export async function telegramReply(env, chatId, text) {
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
}
