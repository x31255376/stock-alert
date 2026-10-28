// 股票提醒 / Stock Alerts — mobile web app (no build step, plain JavaScript). Traditional Chinese + English.

const $view = document.getElementById('view');
const $nav = document.getElementById('nav');

function storeGet(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function storeSet(key, value) {
  try {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {}
}

const initialLang = storeGet('sa_lang') || (/^zh/i.test(navigator.language || '') ? 'zh' : 'en');

const state = {
  lang: initialLang === 'en' ? 'en' : 'zh',
  code: storeGet('sa_code') || null,
  config: null,
  me: null,
  watch: null,
  events: null,
  range: 'today',
  upRed: storeGet('sa_upred') != null ? storeGet('sa_upred') !== '0' : initialLang !== 'en', // red = up in Asia, green = up in the US
  clockOffset: 0,
  draft: null,
  telegramPolling: null,
  openForm: null, // which channel form is expanded in settings
  turnstileToken: null,
};

// L('中文', 'English') picks the text for the current language.
function L(zh, en) {
  return state.lang === 'en' ? en : zh;
}
const SEP = () => L('、', ', ');

const CHANNEL_NAMES = () => ({ webpush: L('網頁推播', 'Web push'), telegram: 'Telegram', discord: 'Discord', email: 'Email' });
const FREQ = () => [
  ['once', L('只提醒一次', 'Only once')],
  ['daily', L('每天最多一次', 'At most once a day')],
  ['hourly', L('每小時最多一次', 'At most once an hour')],
];
const MA_PAIRS = [
  [5, 20],
  [10, 20],
  [20, 60],
  [50, 200],
];
const MA_PERIODS = [5, 10, 20, 50, 60, 120, 200];
const KD_PARAMS = () => [
  ['9-3-3', L('9,3,3（台灣常用）', '9,3,3 (common in Asia)')],
  ['14-3-3', L('14,3,3（美股 Stochastic）', '14,3,3 (US slow stochastic)')],
  ['5-3-3', L('5,3,3（較敏感）', '5,3,3 (more sensitive)')],
];

// Condition types shown in the editor (mirrors src/engine.js).
function TYPES() {
  return {
    price: {
      label: L('價格', 'Price'),
      ops: [
        ['above', L('高於或等於', 'At or above')],
        ['below', L('低於或等於', 'At or below')],
        ['cross_above', L('向上突破', 'Crosses above')],
        ['cross_below', L('向下跌破', 'Crosses below')],
      ],
      value: { unit: 'USD', step: '0.01' },
      basic: true,
    },
    change: {
      label: L('漲跌幅', 'Daily change'),
      ops: [
        ['up', L('漲幅達', 'Up by at least')],
        ['down', L('跌幅達', 'Down by at least')],
      ],
      value: { unit: '%', step: '0.1', def: 3 },
      basic: true,
    },
    rsi: {
      label: 'RSI (14)',
      ops: [
        ['below', L('低於', 'Below')],
        ['above', L('高於', 'Above')],
      ],
      value: { unit: '', step: '1', def: 30 },
    },
    ma_cross: {
      label: L('均線交叉', 'Moving average cross'),
      ops: [
        ['golden', L('黃金交叉（向上）', 'Golden cross (up)')],
        ['death', L('死亡交叉（向下）', 'Death cross (down)')],
      ],
      pair: true,
      mode: true,
    },
    price_ma: {
      label: L('價格 vs 均線', 'Price vs moving average'),
      ops: [
        ['cross_above', L('站上', 'Crosses above')],
        ['cross_below', L('跌破', 'Crosses below')],
        ['above', L('在之上', 'Is above')],
        ['below', L('在之下', 'Is below')],
      ],
      period: true,
      mode: true,
    },
    kd: {
      label: L('KD 指標', 'KD / Stochastic'),
      ops: [
        ['golden', L('黃金交叉', 'Golden cross')],
        ['death', L('死亡交叉', 'Death cross')],
        ['k_below', L('K 值低於', 'K below')],
        ['k_above', L('K 值高於', 'K above')],
      ],
      value: { unit: '', step: '1', def: 20, only: ['k_below', 'k_above'] },
      mode: true,
      kdp: true,
    },
    volume: {
      label: L('成交量（前一交易日）', 'Volume (prior session)'),
      ops: [['above', L('大於 20 日均量', 'Above 20-day average')]],
      value: { unit: L('倍', '×'), step: '0.1', def: 1.5 },
      close: true,
    },
  };
}

const TEMPLATES = () => [
  { name: L('超跌反彈', 'Oversold bounce'), logic: 'all', conditions: [{ type: 'rsi', op: 'below', value: 30 }, { type: 'kd', op: 'golden' }] },
  { name: L('均線多頭', 'Uptrend'), logic: 'all', conditions: [{ type: 'ma_cross', op: 'golden', fast: 20, slow: 60 }, { type: 'price_ma', op: 'above', period: 20 }] },
  { name: L('放量突破', 'Volume breakout'), logic: 'all', conditions: [{ type: 'volume', op: 'above', value: 1.5 }, { type: 'change', op: 'up', value: 3 }] },
  { name: L('跌破停損', 'Stop loss'), logic: 'all', conditions: [{ type: 'price', op: 'cross_below', value: null, pct: -5 }] },
];

// ---------- helpers ----------

function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function toast(message, isError = false) {
  document.querySelectorAll('.toast').forEach((t) => t.remove());
  const el = document.createElement('div');
  el.className = `toast${isError ? ' error' : ''}`;
  el.setAttribute('role', 'status');
  el.textContent = message;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3600);
}

async function api(path, { method = 'GET', body } = {}) {
  const headers = { 'content-type': 'application/json', 'x-lang': state.lang };
  if (state.code) headers.authorization = `Bearer ${state.code}`;
  let res;
  try {
    res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  } catch {
    throw new Error(L('網路連線不穩，請再試一次', 'Network problem. Please try again.'));
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && state.code) {
    logout(false);
    throw new Error(data.error || L('請重新登入', 'Please sign in again'));
  }
  if (!res.ok) throw new Error(data.error || L('發生錯誤', 'Something went wrong'));
  return data;
}

function priceClass(chg) {
  if (!chg) return 'flat';
  const up = chg > 0;
  return up === state.upRed ? 'up' : 'down';
}

function fmtPrice(n) {
  if (n == null) return '—';
  return Number(n).toFixed(n < 1 ? 4 : 2);
}

function fmtChange(q) {
  if (!q || q.changePct == null) return '';
  const arrow = q.changePct > 0 ? '▲' : q.changePct < 0 ? '▼' : '';
  const sign = q.changePct > 0 ? '+' : q.changePct < 0 ? '−' : '';
  return `${arrow} ${sign}${Math.abs(q.changePct).toFixed(2)}%`;
}

function fmtDuration(ms) {
  if (ms == null) return '';
  const min = Math.max(0, Math.round(ms / 60000));
  const d = Math.floor(min / 1440);
  const h = Math.floor((min % 1440) / 60);
  const m = min % 60;
  if (d) return L(`${d} 天 ${h} 小時`, `${d}d ${h}h`);
  if (h) return L(`${h} 小時 ${m} 分`, `${h}h ${m}m`);
  return L(`${m} 分鐘`, `${m} min`);
}

function locale() {
  return state.lang === 'en' ? 'en-US' : 'zh-TW';
}

function fmtTime(ms) {
  const d = new Date(ms);
  const now = new Date();
  const hm = d.toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit', hour12: false });
  if (d.toDateString() === now.toDateString()) return hm;
  return `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

// Local clock time of 01:00 New York, when the previous session's complete data is published.
function dailyCheckTime() {
  try {
    const fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    let t = Math.ceil(Date.now() / 900000) * 900000;
    for (let i = 0; i < 200; i++, t += 900000) {
      if (fmt.format(new Date(t)) === '01:00') {
        const hm = new Date(t).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit', hour12: false });
        return L(`${hm} 之後`, `after ${hm}`);
      }
    }
  } catch {}
  return L('美東時間凌晨 1 點後', 'after 1:00 AM New York time');
}

function minutesToTime(m) {
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

function timeToMinutes(t) {
  const [h, m] = String(t).split(':').map(Number);
  return h * 60 + (m || 0);
}

const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const pushSupported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

const ICON = {
  plus: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
  back: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>',
  close: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  search: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>',
  more: '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>',
};

// ---------- language ----------

function applyLangChrome() {
  document.documentElement.lang = state.lang === 'en' ? 'en' : 'zh-Hant';
  document.title = L('股票提醒', 'Stock Alerts');
  $nav.setAttribute('aria-label', L('主選單', 'Main menu'));
  const labels = { home: L('自選股', 'Watchlist'), history: L('提醒紀錄', 'History'), settings: L('通知設定', 'Settings') };
  $nav.querySelectorAll('a').forEach((a) => {
    const span = a.querySelector('span');
    if (span) span.textContent = labels[a.dataset.tab];
  });
}

async function setLang(lang) {
  state.lang = lang === 'en' ? 'en' : 'zh';
  storeSet('sa_lang', state.lang);
  if (storeGet('sa_upred') == null) state.upRed = state.lang !== 'en';
  applyLangChrome();
  state.watch = null;
  if (state.code) await api('/api/me', { method: 'PUT', body: { lang: state.lang } }).catch(() => {});
  render();
}

function langSwitch() {
  return `<div class="seg" role="group" aria-label="Language / 語言">
    <button type="button" data-act="lang" data-value="zh" aria-pressed="${state.lang === 'zh'}">中文</button>
    <button type="button" data-act="lang" data-value="en" aria-pressed="${state.lang === 'en'}">English</button>
  </div>`;
}

// ---------- routing ----------

function parseRoute() {
  const hash = location.hash.replace(/^#/, '') || '/';
  const [path, query = ''] = hash.split('?');
  return { path, params: new URLSearchParams(query) };
}

function setNav(tab) {
  $nav.classList.toggle('hidden', !tab);
  $nav.querySelectorAll('a').forEach((a) => {
    if (a.dataset.tab === tab) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
}

async function render() {
  stopTelegramPolling();
  const { path, params } = parseRoute();
  if (path === '/terms') {
    setNav(null);
    return renderTerms();
  }
  if (path === '/recovered' && params.get('c')) {
    state.code = params.get('c');
    storeSet('sa_code', state.code);
    state.me = null;
    state.watch = null;
    history.replaceState(null, '', '#/');
    setNav(null);
    return renderWelcome(state.code, true);
  }
  if (!state.code) {
    setNav(null);
    if (params.get('recover') === 'expired') toast(L('連結已過期，請重新申請', 'That link has expired. Please request a new one.'), true);
    return renderWelcome();
  }
  try {
    if (path === '/' || path === '') return await renderHome();
    if (path === '/new') return await renderEditor(null, params);
    const m = path.match(/^\/alert\/(\d+)$/);
    if (m) return await renderEditor(Number(m[1]), params);
    if (path === '/history') return await renderHistory();
    if (path === '/settings') return await renderSettings(params);
    location.hash = '#/';
  } catch (err) {
    $view.innerHTML = `<div class="empty"><b>${L('載入失敗', 'Could not load')}</b><span>${esc(err.message)}</span><button class="btn small outline" data-act="reload">${L('重新整理', 'Reload')}</button></div>`;
  }
}

window.addEventListener('hashchange', () => {
  closeSheet();
  render();
  window.scrollTo(0, 0);
});

// ---------- bot check (Cloudflare Turnstile, only when the admin set it up) ----------

let turnstileLoading = null;

function loadTurnstile() {
  if (window.turnstile) return Promise.resolve();
  if (!turnstileLoading) {
    turnstileLoading = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
      s.async = true;
      s.onload = resolve;
      s.onerror = reject;
      document.head.appendChild(s);
    });
  }
  return turnstileLoading;
}

async function mountTurnstile() {
  const key = state.config?.turnstileSiteKey;
  const box = document.getElementById('turnstile');
  if (!key || !box) return;
  state.turnstileToken = null;
  try {
    await loadTurnstile();
    if (!document.getElementById('turnstile')) return;
    window.turnstile.render(box, {
      sitekey: key,
      language: state.lang === 'en' ? 'en' : 'zh-tw',
      callback: (token) => {
        state.turnstileToken = token;
      },
      'expired-callback': () => {
        state.turnstileToken = null;
      },
    });
  } catch {
    box.textContent = L('驗證元件載入失敗，請重新整理', 'Could not load the verification. Please reload.');
  }
}

function resetTurnstile() {
  state.turnstileToken = null;
  try {
    if (window.turnstile) window.turnstile.reset();
  } catch {}
}

function requireTurnstile() {
  if (state.config?.turnstileSiteKey && !state.turnstileToken) throw new Error(L('請先完成機器人驗證', 'Please complete the verification first'));
  return state.turnstileToken;
}

// ---------- welcome / login ----------

function renderWelcome(showCode = null, recovered = false) {
  $view.className = 'view welcome no-nav';
  if (showCode) {
    $view.innerHTML = `
      <img src="/icons/icon-192.png" alt="">
      <h1>${recovered ? L('這是你的新帳號代碼', 'Your new account code') : L('記下你的帳號代碼', 'Save your account code')}</h1>
      <p>${
        recovered
          ? L('舊代碼已失效。其他裝置請用這組新代碼重新登入。', 'The old code no longer works. Use this new code to sign in on your other devices.')
          : L('換手機、換瀏覽器或把網頁加到主畫面時，輸入這組代碼就能找回你的設定。', 'You need this code to sign in on a new phone, another browser, or after adding the app to your home screen.')
      }</p>
      <div class="code-box" id="code-box">${esc(showCode)}</div>
      <div class="stack">
        <button class="btn secondary" data-act="copy-code">${L('複製代碼', 'Copy code')}</button>
        <button class="btn" data-act="start">${L('我已記下，開始使用', "I've saved it — continue")}</button>
      </div>`;
    return;
  }
  const cfg = state.config || {};
  $view.innerHTML = `
    <div style="display:flex;justify-content:flex-end">${langSwitch()}</div>
    <img src="/icons/icon-192.png" alt="">
    <h1>${L('股票提醒', 'Stock Alerts')}</h1>
    <p>${L('設定美股條件，條件達成就通知你，不用整天盯盤。', 'Set conditions on US stocks and get notified when they hit — no need to watch the market all day.')}</p>
    ${
      isIOS && !isStandalone
        ? `<div class="notice" style="text-align:left"><b>${L('iPhone 用戶先做這一步', 'iPhone users: do this first')}</b>${L(
            '想收到推播通知的話，先用 Safari 點下方「分享」→「加入主畫面」，再從主畫面的圖示打開這個網頁開始使用。',
            'To get push notifications, tap Share → "Add to Home Screen" in Safari, then open the app from the new home screen icon.'
          )}</div>`
        : ''
    }
    <div class="stack">
      <div id="turnstile" class="${cfg.turnstileSiteKey ? '' : 'hidden'}" style="min-height:65px;display:flex;justify-content:center"></div>
      <button class="btn" data-act="create-account">${L('開始使用', 'Get started')}</button>
      <button class="btn secondary" data-act="show-login">${L('我已有帳號代碼', 'I have an account code')}</button>
      <form id="login-form" class="stack hidden">
        <label class="label" for="login-code">${L('帳號代碼', 'Account code')}</label>
        <input id="login-code" class="input" autocomplete="off" autocapitalize="characters" placeholder="XXXX-XXXX-XXXX-XXXX" required>
        <button class="btn" type="submit">${L('登入', 'Sign in')}</button>
        ${cfg.recovery ? `<button class="text-btn" type="button" data-act="show-recover">${L('忘記帳號代碼？', 'Forgot your code?')}</button>` : ''}
      </form>
      <form id="recover-form" class="stack hidden">
        <label class="label" for="recover-email">${L('輸入你在通知設定綁定的 Email', 'Enter the email you verified in Settings')}</label>
        <input id="recover-email" class="input" type="email" inputmode="email" placeholder="you@example.com" required>
        <button class="btn" type="submit">${L('寄送找回連結', 'Send recovery link')}</button>
      </form>
    </div>
    <p style="font-size:12px"><a href="#/terms">${L('使用條款、免責聲明與隱私權', 'Terms, disclaimer & privacy')}</a></p>`;
  mountTurnstile();
}

async function createAccount() {
  const turnstile = requireTurnstile();
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  try {
    const { code } = await api('/api/account', { method: 'POST', body: { tz, lang: state.lang, turnstile } });
    state.code = code;
    storeSet('sa_code', code);
    renderWelcome(code);
  } catch (err) {
    resetTurnstile();
    throw err;
  }
}

async function login(code) {
  const res = await api('/api/login', { method: 'POST', body: { code } });
  state.code = res.code;
  storeSet('sa_code', res.code);
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  api('/api/me', { method: 'PUT', body: { tz, lang: state.lang } }).catch(() => {});
  location.hash = '#/';
  render();
}

function logout(confirmFirst = true) {
  if (confirmFirst && !confirm(L('登出這個裝置？之後輸入帳號代碼可以再登入。', 'Sign out on this device? You can sign in again with your account code.'))) return;
  state.code = null;
  state.me = null;
  state.watch = null;
  state.events = null;
  storeSet('sa_code', null);
  location.hash = '#/';
  render();
}

// ---------- terms / disclaimer / privacy ----------

function renderTerms() {
  $view.className = 'view no-nav';
  const zh = `
    <h2>免責聲明</h2>
    <p>股票提醒只會依照你自己設定的條件發送通知，不提供任何投資建議，也不代表買賣推薦。股價與技術指標資料來自第三方資料商，可能有延遲、錯誤或中斷，通知也可能因網路或第三方服務而延遲或沒有送達。請勿只依賴本服務做交易決定，投資風險請自行承擔。</p>
    <h2>使用條款</h2>
    <ul>
      <li>本服務依現況提供，可能隨時調整功能或暫停服務。</li>
      <li>請勿以自動化程式大量建立帳號或送出請求；濫用者帳號可能被停用。</li>
      <li>帳號代碼等同你的密碼，請自行保管，不要分享給他人。</li>
    </ul>
    <h2>隱私權</h2>
    <ul>
      <li><b>我們保存的資料：</b>帳號代碼的雜湊值（不保存原始代碼）、時區與語言、自選股與提醒設定、提醒紀錄（保留 90 天），以及你連接的通知方式（推播訂閱、Telegram 對話 ID、Discord Webhook、Email）。</li>
      <li><b>用途：</b>只用來判斷條件和發送你設定的通知，不會出售或分享給廣告商。</li>
      <li><b>第三方服務：</b>網站與資料庫由 Cloudflare 託管；股價來自 Finnhub 與 Twelve Data（只送出股票代號，不含你的個人資料）；通知經由瀏覽器推播服務、Telegram、Discord 或 Email 服務商傳送。</li>
      <li><b>刪除資料：</b>在「通知設定」按「刪除帳號與所有資料」即可立即刪除。</li>
    </ul>`;
  const en = `
    <h2>Disclaimer</h2>
    <p>Stock Alerts only sends notifications based on the conditions you set. It does not provide investment advice or recommendations to buy or sell. Prices and indicators come from third-party data providers and may be delayed, inaccurate or unavailable, and notifications may be delayed or not delivered. Do not rely on this service alone for trading decisions; you are responsible for your own investment risk.</p>
    <h2>Terms of use</h2>
    <ul>
      <li>The service is provided as is. Features may change and the service may be paused at any time.</li>
      <li>Do not create accounts or send requests in bulk with automated tools; abusive accounts may be disabled.</li>
      <li>Your account code works like a password. Keep it private.</li>
    </ul>
    <h2>Privacy</h2>
    <ul>
      <li><b>What we store:</b> a hash of your account code (never the code itself), your time zone and language, your watchlist and alert settings, alert history (kept for 90 days), and the notification methods you connect (push subscription, Telegram chat ID, Discord webhook, email).</li>
      <li><b>How it is used:</b> only to check your conditions and send the notifications you set up. It is never sold or shared with advertisers.</li>
      <li><b>Third parties:</b> the site and database are hosted by Cloudflare; prices come from Finnhub and Twelve Data (only ticker symbols are sent, no personal data); notifications go through browser push services, Telegram, Discord or an email provider.</li>
      <li><b>Deleting your data:</b> tap "Delete account and all data" in Settings to delete everything immediately.</li>
    </ul>`;
  $view.innerHTML = `
    <div class="top-bar">
      <a class="icon-btn ghost" href="#/${state.code ? 'settings' : ''}" aria-label="${L('返回', 'Back')}">${ICON.back}</a>
      <h1>${L('使用條款與隱私權', 'Terms & privacy')}</h1>
      <span class="spacer"></span>
    </div>
    <article class="card terms">${state.lang === 'en' ? en : zh}</article>`;
}

// ---------- home (watchlist) ----------

let homeTimer = null;

async function loadHome() {
  const [watch, me] = await Promise.all([api('/api/watchlist'), state.me ? Promise.resolve(state.me) : api('/api/me')]);
  state.watch = watch;
  state.me = me;
  state.clockOffset = watch.market.now - Date.now();
}

function statusInfo(a, market) {
  if (a.status === 'paused') return ['st-paused', L('已暫停', 'Paused')];
  if (a.status === 'done') return ['st-done', L('已完成', 'Done')];
  if (a.timing === 'close') {
    if (!a.checked) return ['st-waiting', L('等待收盤資料', 'Waiting for close')];
    if (a.status === 'triggered') return ['st-triggered', L('收盤已觸發', 'Hit at close')];
  }
  if (!a.checked) return ['st-waiting', market.open ? L('準備中', 'Starting') : L('等待開盤', 'Waiting for open')];
  if (a.status === 'triggered') return ['st-triggered', L('今日已觸發', 'Hit today')];
  if (a.status === 'near') return ['st-near', L('接近觸發', 'Getting close')];
  return ['st-watching', L('監控中', 'Watching')];
}

function channelSummary() {
  const names = CHANNEL_NAMES();
  const types = [...new Set((state.me?.channels || []).map((c) => c.type))].filter((t) => state.config.channels[t]);
  return types.map((t) => names[t]);
}

function marketBanner(market) {
  const now = Date.now() + state.clockOffset;
  const names = channelSummary();
  const pill = names.length
    ? `<a class="pill" href="#/settings">${L('通知：', 'Alerts: ')}${esc(names.join(SEP()))}</a>`
    : `<a class="pill warn" href="#/settings">${L('設定通知 ›', 'Set up alerts ›')}</a>`;
  const title = market.open ? L('美股交易中', 'US market open') : L('美股休市中', 'US market closed');
  const sub = market.open
    ? market.closesAtMs
      ? L(`距離收盤 ${fmtDuration(market.closesAtMs - now)}`, `Closes in ${fmtDuration(market.closesAtMs - now)}`)
      : L('每分鐘檢查一次條件', 'Checking every minute')
    : market.nextOpenMs
      ? L(`距離開盤 ${fmtDuration(market.nextOpenMs - now)}`, `Opens in ${fmtDuration(market.nextOpenMs - now)}`)
      : '';
  return `<div class="banner"><div><b>${title}</b><small>${esc(sub)}</small></div>${pill}</div>`;
}

function alertRowHtml(a, market) {
  const [cls, label] = statusInfo(a, market);
  const joiner = a.logic === 'any' ? L('或', 'or') : '';
  const chips = a.labels.map((l, i) => `${i && joiner ? `<span class="chip joiner">${joiner}</span>` : ''}<span class="chip">${esc(l)}</span>`).join('');
  return `<a class="alert-row" href="#/alert/${a.id}" aria-label="${L('編輯提醒：', 'Edit alert: ')}${esc(a.labels.join(SEP()))}">
      <span class="chips">${chips}</span><span class="status ${cls}">${label}</span></a>`;
}

function stockCardHtml(s, market) {
  const q = s.quote;
  const cls = priceClass(q?.changePct);
  const alerts = s.alerts.map((a) => alertRowHtml(a, market)).join('');
  return `<article class="card">
    <div class="stock-top">
      <div><span class="sym">${esc(s.symbol)}</span><span class="name">${esc(s.name || '')}</span></div>
      <div style="display:flex;gap:6px;align-items:flex-start">
        <div class="px num"><b>${fmtPrice(q?.price)}</b><span class="${cls}">${esc(fmtChange(q))}</span></div>
        <button class="more-btn" data-act="stock-menu" data-symbol="${esc(s.symbol)}" aria-label="${esc(s.symbol)} ${L('更多選項', 'more options')}">${ICON.more}</button>
      </div>
    </div>
    ${alerts}
    <a class="add-link" href="#/new?symbol=${encodeURIComponent(s.symbol)}&name=${encodeURIComponent(s.name || '')}">＋ ${
      s.alerts.length ? L('再加一個提醒', 'Add another alert') : L('設定提醒條件', 'Set an alert')
    }</a>
  </article>`;
}

function homeHtml() {
  const w = state.watch;
  const active = w.stocks.reduce((n, s) => n + s.alerts.filter((a) => a.active).length, 0);
  const demo = state.config.demo
    ? `<div class="notice info"><b>${L('示範模式', 'Demo mode')}</b>${L(
        '目前用的是模擬股價，方便你先試用。管理員設定股價 API 後會自動改成真實行情。',
        'Prices are simulated so you can try things out. Real prices start once the admin adds a market data key.'
      )}</div>`
    : '';
  const list = w.stocks.length
    ? `<div class="stack">${w.stocks.map((s) => stockCardHtml(s, w.market)).join('')}</div>`
    : `<div class="empty"><b>${L('還沒有自選股', 'Your watchlist is empty')}</b><span>${L(
        '先加入一支想盯的股票，再設定提醒條件。',
        'Add a stock you want to follow, then set an alert.'
      )}</span><button class="btn small" data-act="open-search">＋ ${L('加入股票', 'Add a stock')}</button></div>`;
  return `
    <header class="page-head">
      <div><h1>${L('自選股', 'Watchlist')}</h1><p>${
        active ? L(`${active} 個提醒監控中`, `${active} alert${active > 1 ? 's' : ''} active`) : L('設定條件，達成就通知你', 'Set conditions, get notified when they hit')
      }</p></div>
      <button class="icon-btn" data-act="open-search" aria-label="${L('加入股票', 'Add a stock')}">${ICON.plus}</button>
    </header>
    ${marketBanner(w.market)}
    ${demo}
    ${list}`;
}

async function renderHome() {
  setNav('home');
  $view.className = 'view';
  if (state.watch) $view.innerHTML = homeHtml();
  else $view.innerHTML = `<div class="empty">${L('載入中…', 'Loading…')}</div>`;
  await loadHome();
  if (parseRoute().path === '/') $view.innerHTML = homeHtml();
  clearInterval(homeTimer);
  homeTimer = setInterval(async () => {
    if (document.hidden || parseRoute().path !== '/' || document.querySelector('.sheet-backdrop')) return;
    try {
      await loadHome();
      if (parseRoute().path === '/' && !document.querySelector('.sheet-backdrop')) $view.innerHTML = homeHtml();
    } catch {}
  }, 30000);
}

// ---------- search sheet ----------

let searchTimer = null;

function openSearch(mode = 'add') {
  closeSheet();
  const el = document.createElement('div');
  el.className = 'sheet-backdrop';
  el.innerHTML = `
    <div class="sheet" role="dialog" aria-modal="true" aria-label="${L('搜尋股票', 'Search stocks')}">
      <div class="sheet-head"><b>${mode === 'add' ? L('加入自選股', 'Add to watchlist') : L('選擇股票', 'Choose a stock')}</b>
        <button class="icon-btn ghost" data-act="close-sheet" aria-label="${L('關閉', 'Close')}">${ICON.close}</button></div>
      <label class="label" for="search-input">${L('輸入代號或公司名稱（美股）', 'Ticker or company name (US listings)')}</label>
      <input id="search-input" class="input" type="search" placeholder="${L('例如 AAPL、Tesla', 'e.g. AAPL, Tesla')}" autocomplete="off" autocapitalize="characters">
      <div class="sheet-results" id="search-results"><div class="empty">${L('輸入後會顯示結果', 'Results appear as you type')}</div></div>
    </div>`;
  el.dataset.mode = mode;
  el.addEventListener('click', (e) => {
    if (e.target === el) closeSheet();
  });
  document.body.appendChild(el);
  const input = el.querySelector('#search-input');
  input.focus();
  input.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => runSearch(input.value), 300);
  });
}

async function runSearch(q) {
  const box = document.getElementById('search-results');
  if (!box) return;
  if (!q.trim()) {
    box.innerHTML = `<div class="empty">${L('輸入後會顯示結果', 'Results appear as you type')}</div>`;
    return;
  }
  box.innerHTML = `<div class="empty">${L('搜尋中…', 'Searching…')}</div>`;
  try {
    let { results } = await api(`/api/search?q=${encodeURIComponent(q)}`);
    if (!document.getElementById('search-results')) return;
    // Search can miss some listings: let a typed ticker be added directly (the server checks it exists).
    const typed = q.trim().toUpperCase();
    if (/^[A-Z][A-Z0-9.\-]{0,9}$/.test(typed) && !results.some((r) => r.symbol === typed)) {
      results = [{ symbol: typed, name: L('直接加入這個代號', 'Add this ticker directly'), type: '', direct: true }, ...results];
    }
    box.innerHTML = results.length
      ? results
          .map(
            (r) =>
              `<button class="result" data-act="pick-symbol" data-symbol="${esc(r.symbol)}" data-name="${esc(r.direct ? r.symbol : r.name)}"><b>${esc(r.symbol)}</b><span>${
                r.type ? `<em class="type">${esc(r.type)}</em>` : ''
              }${esc(r.name)}</span></button>`
          )
          .join('')
      : `<div class="empty">${L('找不到符合的美股', 'No US listings found')}</div>`;
  } catch (err) {
    box.innerHTML = `<div class="empty">${esc(err.message)}</div>`;
  }
}

function closeSheet() {
  document.querySelectorAll('.sheet-backdrop').forEach((s) => s.remove());
}

async function pickSymbol(symbol, name) {
  const sheet = document.querySelector('.sheet-backdrop');
  const mode = sheet?.dataset.mode;
  closeSheet();
  if (mode === 'pick' && state.draft) {
    state.draft.symbol = symbol;
    state.draft.name = name;
    renderEditorView();
    return;
  }
  try {
    state.watch = await api('/api/watchlist', { method: 'POST', body: { symbol, name } });
    toast(L(`已加入 ${symbol}`, `${symbol} added`));
    if (parseRoute().path === '/') $view.innerHTML = homeHtml();
    else location.hash = '#/';
  } catch (err) {
    toast(err.message, true);
  }
}

async function stockMenu(symbol) {
  if (!confirm(L(`從自選股移除 ${symbol}？這支股票的提醒也會一起刪除。`, `Remove ${symbol} from your watchlist? Its alerts will be deleted too.`))) return;
  try {
    await api(`/api/watchlist/${encodeURIComponent(symbol)}`, { method: 'DELETE' });
    state.watch.stocks = state.watch.stocks.filter((s) => s.symbol !== symbol);
    $view.innerHTML = homeHtml();
    toast(L(`已移除 ${symbol}`, `${symbol} removed`));
  } catch (err) {
    toast(err.message, true);
  }
}

// ---------- alert editor ----------

function defaultCondition(type, price) {
  const t = TYPES()[type];
  const c = { type, op: t.ops[0][0] };
  if (t.value) c.value = type === 'price' ? (price ? Number(price.toFixed(2)) : null) : t.value.def;
  if (t.pair) {
    c.fast = 20;
    c.slow = 60;
  }
  if (t.period) c.period = 20;
  if (t.mode) c.mode = 'close';
  if (t.kdp) c.kdp = state.lang === 'en' ? '14-3-3' : '9-3-3';
  return c;
}

function currentPrice(symbol) {
  const s = state.watch?.stocks.find((x) => x.symbol === symbol);
  return s?.quote?.price || null;
}

async function renderEditor(id, params) {
  setNav(null);
  $view.className = 'view no-nav';
  if (!state.watch) await loadHome().catch(() => {});
  if (!state.me) state.me = await api('/api/me');
  if (id) {
    const { alert } = await api(`/api/alerts/${id}`);
    const s = state.watch?.stocks.find((x) => x.symbol === alert.symbol);
    state.draft = { ...alert, name: s?.name || '', conditions: alert.conditions.map((c) => ({ ...c })) };
  } else {
    const symbol = params.get('symbol') || '';
    state.draft = {
      id: null,
      symbol,
      name: params.get('name') || '',
      logic: 'all',
      conditions: [defaultCondition(state.config.indicators ? 'rsi' : 'price', currentPrice(symbol))],
      channels: [],
      frequency: 'daily',
      active: true,
    };
  }
  renderEditorView();
}

function condHtml(c, i) {
  const types = TYPES();
  const t = types[c.type];
  const allowed = Object.entries(types).filter(([, v]) => v.basic || state.config.indicators);
  const typeOpts = allowed.map(([k, v]) => `<option value="${k}" ${k === c.type ? 'selected' : ''}>${v.label}</option>`).join('');
  const opOpts = t.ops.map(([k, l]) => `<option value="${k}" ${k === c.op ? 'selected' : ''}>${l}</option>`).join('');
  let third = '';
  if (t.pair) {
    third = `<select class="input" data-cond="${i}" data-field="pair" aria-label="${L('均線組合', 'Moving averages')}">${MA_PAIRS.map(
      ([f, s]) => `<option value="${f}-${s}" ${c.fast === f && c.slow === s ? 'selected' : ''}>MA${f} / MA${s}</option>`
    ).join('')}</select>`;
  } else if (t.period) {
    third = `<select class="input" data-cond="${i}" data-field="period" aria-label="${L('均線天數', 'Period')}">${MA_PERIODS.map(
      (p) => `<option value="${p}" ${c.period === p ? 'selected' : ''}>MA${p}</option>`
    ).join('')}</select>`;
  } else if (t.value && (!t.value.only || t.value.only.includes(c.op))) {
    third = `<input class="input num" type="number" inputmode="decimal" step="${t.value.step}" data-cond="${i}" data-field="value" value="${c.value ?? ''}" aria-label="${L(
      '數值',
      'Value'
    )}" placeholder="${L('數值', 'Value')}">${t.value.unit ? `<span class="unit">${t.value.unit}</span>` : ''}`;
  }
  const kdpLine = t.kdp
    ? `<div class="cond-line"><select class="input" data-cond="${i}" data-field="kdp" aria-label="${L('KD 參數', 'KD settings')}">${KD_PARAMS()
        .map(([k, l]) => `<option value="${k}" ${(c.kdp || '9-3-3') === k ? 'selected' : ''}>${l}</option>`)
        .join('')}</select></div>`
    : '';
  const modeLine = t.mode
    ? `<div class="cond-line"><select class="input" data-cond="${i}" data-field="mode" aria-label="${L('判斷時機', 'When to check')}">
        <option value="close" ${c.mode !== 'intraday' ? 'selected' : ''}>${L('收盤確認（建議）', 'At the close (recommended)')}</option>
        <option value="intraday" ${c.mode === 'intraday' ? 'selected' : ''}>${L('盤中即時（較快，可能假訊號）', 'Live (faster, may give false signals)')}</option>
      </select></div>`
    : '';
  return `<div class="cond">
    <div class="cond-line">
      <select class="input" data-cond="${i}" data-field="type" aria-label="${L('指標', 'Indicator')}">${typeOpts}</select>
      <button class="x" type="button" data-act="remove-cond" data-index="${i}" aria-label="${L('刪除這個條件', 'Remove this condition')}">${ICON.close}</button>
    </div>
    <div class="cond-line">
      <select class="input grow2" data-cond="${i}" data-field="op" aria-label="${L('比較方式', 'Comparison')}">${opOpts}</select>
      ${third}
    </div>
    ${kdpLine}
    ${modeLine}
  </div>`;
}

function renderEditorView() {
  const d = state.draft;
  const isNew = !d.id;
  const types = TYPES();
  const names = CHANNEL_NAMES();
  const connected = [...new Set((state.me?.channels || []).map((c) => c.type))].filter((t) => state.config.channels[t]);
  const channelBox = connected.length
    ? `<div class="row-list">${connected
        .map((t) => `<label class="check"><input type="checkbox" data-channel="${t}" ${!d.channels.length || d.channels.includes(t) ? 'checked' : ''}> ${names[t]}</label>`)
        .join('')}</div>`
    : `<div class="notice">${L(
        '還沒有設定通知方式，提醒觸發時只會記錄在「提醒紀錄」。',
        'No notification method yet — triggered alerts will only show up in History.'
      )}<a href="#/settings">${L('去設定通知 ›', 'Set up notifications ›')}</a></div>`;
  const isClose = d.conditions.some((c) => types[c.type].close || (types[c.type].mode && c.mode !== 'intraday'));
  const timingNote = isClose
    ? `<div class="notice info"><b>${L('這個提醒用收盤資料判斷', 'This alert uses closing data')}</b>${L(
        `每個交易日收盤、完整資料出來後檢查一次（約你當地時間 ${esc(dailyCheckTime())}），所有條件都以那天的收盤價和成交量計算。`,
        `It is checked once per trading day when complete data is available (${esc(dailyCheckTime())} your time). All conditions use that day's closing price and volume.`
      )}</div>`
    : '';
  const indicatorNote = state.config.indicators
    ? ''
    : `<div class="notice info">${L(
        '技術指標（RSI、KD、均線、成交量）需要管理員設定指標資料來源後才能使用，目前可設定價格與漲跌幅。',
        'Indicators (RSI, KD, moving averages, volume) need an indicator data key from the admin. Price and daily change are available now.'
      )}</div>`;

  $view.innerHTML = `
    <div class="top-bar">
      <a class="icon-btn ghost" href="#/" aria-label="${L('返回', 'Back')}">${ICON.back}</a>
      <h1>${isNew ? L('新增提醒', 'New alert') : L('編輯提醒', 'Edit alert')}</h1>
      <span class="spacer"></span>
    </div>
    <div class="stack">
      <span class="label">${L('股票', 'Stock')}</span>
      <button class="field-btn" type="button" data-act="${isNew ? 'pick-stock' : 'noop'}" ${isNew ? '' : 'aria-disabled="true"'}>
        <span class="muted">${ICON.search}</span>
        ${d.symbol ? `<b>${esc(d.symbol)}</b><span class="muted">${esc(d.name || '')}</span>` : `<span class="muted">${L('選擇股票', 'Choose a stock')}</span>`}
      </button>
    </div>
    <div class="stack">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap">
        <span class="label">${L('觸發條件（組合拳）', 'Conditions')}</span>
        <div class="seg" role="group" aria-label="${L('條件組合方式', 'How conditions combine')}">
          <button type="button" data-act="logic" data-value="all" aria-pressed="${d.logic === 'all'}">${L('全部符合', 'All match')}</button>
          <button type="button" data-act="logic" data-value="any" aria-pressed="${d.logic === 'any'}">${L('任一符合', 'Any matches')}</button>
        </div>
      </div>
      ${indicatorNote}
      ${d.conditions.map(condHtml).join('')}
      ${timingNote}
      ${d.conditions.length < 6 ? `<button class="dashed" type="button" data-act="add-cond">＋ ${L('新增條件', 'Add condition')}</button>` : ''}
      ${
        state.config.indicators
          ? `<div class="tpls"><span class="label">${L('快速範本', 'Templates')}</span>${TEMPLATES()
              .map((t, i) => `<button class="tpl" type="button" data-act="template" data-index="${i}">${t.name}</button>`)
              .join('')}</div>`
          : ''
      }
    </div>
    <div class="stack">
      <span class="label">${L('傳送到', 'Send to')}</span>
      ${channelBox}
    </div>
    <div class="stack">
      <label class="label" for="freq">${L('提醒頻率', 'How often')}</label>
      <select id="freq" class="input" data-field="frequency">${FREQ()
        .map(([k, l]) => `<option value="${k}" ${d.frequency === k ? 'selected' : ''}>${l}</option>`)
        .join('')}</select>
    </div>
    ${
      isNew
        ? ''
        : `<div class="row-list"><div class="row"><div class="main"><b>${L('啟用這個提醒', 'Alert on')}</b><small>${
            d.statusDetail ? `${L('目前：', 'Now: ')}${esc(d.statusDetail)}` : L('暫停後不會再檢查', 'Paused alerts are not checked')
          }</small></div><button class="switch" role="switch" type="button" data-act="toggle-active" aria-checked="${d.active}" aria-label="${L(
            '啟用這個提醒',
            'Alert on'
          )}"></button></div></div>
          <button class="btn danger" type="button" data-act="delete-alert">${L('刪除提醒', 'Delete alert')}</button>`
    }
    <div class="footer-bar"><div class="inner"><button class="btn" type="button" data-act="save-alert">${isNew ? L('建立提醒', 'Create alert') : L('儲存變更', 'Save changes')}</button></div></div>`;
}

function readDraftValues() {
  // Pull number inputs into the draft (they update on input, but be safe before saving).
  $view.querySelectorAll('input[data-field="value"]').forEach((el) => {
    const i = Number(el.dataset.cond);
    state.draft.conditions[i].value = el.value === '' ? null : Number(el.value);
  });
  const checks = [...$view.querySelectorAll('input[data-channel]')];
  if (checks.length) {
    const on = checks.filter((c) => c.checked).map((c) => c.dataset.channel);
    state.draft.channels = on.length === checks.length ? [] : on;
    if (!on.length) state.draft.channels = ['__none__'];
  }
}

async function saveAlert() {
  readDraftValues();
  const d = state.draft;
  const types = TYPES();
  if (!d.symbol) return toast(L('請先選擇股票', 'Please choose a stock first'), true);
  if (d.channels.includes('__none__')) return toast(L('至少勾選一種通知方式', 'Choose at least one notification method'), true);
  for (const c of d.conditions) {
    const t = types[c.type];
    if (t.value && (!t.value.only || t.value.only.includes(c.op)) && (c.value == null || Number.isNaN(c.value))) {
      return toast(L(`請填寫「${t.label}」的數值`, `Enter a value for "${t.label}"`), true);
    }
  }
  const body = {
    symbol: d.symbol,
    name: d.name,
    logic: d.logic,
    conditions: d.conditions.map(({ type, op, value, fast, slow, period, mode, kdp }) => ({ type, op, value, fast, slow, period, mode, kdp })),
    channels: d.channels,
    frequency: d.frequency,
    active: d.active,
  };
  try {
    if (d.id) await api(`/api/alerts/${d.id}`, { method: 'PUT', body });
    else await api('/api/alerts', { method: 'POST', body });
    toast(d.id ? L('已儲存', 'Saved') : L('提醒已建立', 'Alert created'));
    state.watch = null;
    location.hash = '#/';
  } catch (err) {
    toast(err.message, true);
  }
}

// ---------- history ----------

function deliveryText(e) {
  const names = CHANNEL_NAMES();
  if (e.kind === 'created') return '';
  if (e.kind === 'near') return L('預警，不推播', 'Heads-up only, not pushed');
  if (e.delivery === 'sent') return `${L('已送出：', 'Sent via ')}${e.sentVia.map((t) => names[t]).join(SEP())}`;
  if (e.delivery === 'pending') return L('等待送出（勿擾時段結束後送出）', 'Waiting (will be sent after quiet hours)');
  if (e.delivery === 'failed') return L('送出失敗，請到通知設定重新連接', 'Delivery failed — reconnect in Settings');
  return L('未送出：尚未設定通知方式', 'Not sent: no notification method set up');
}

async function renderHistory() {
  setNav('history');
  $view.className = 'view';
  const draw = () => {
    const list = state.events;
    const items = !list
      ? `<div class="empty">${L('載入中…', 'Loading…')}</div>`
      : list.length
        ? `<div class="row-list">${list
            .map(
              (e) => `<div class="event">
              <span class="dot ${e.kind}"></span>
              <div class="body">
                <div class="head"><b>${esc(e.title)}</b><span class="num">${fmtTime(e.createdAt)}</span></div>
                ${e.body ? `<p>${esc(e.body)}</p>` : ''}
                ${deliveryText(e) ? `<small>${esc(deliveryText(e))}</small>` : ''}
              </div></div>`
            )
            .join('')}</div>`
        : `<div class="empty"><b>${state.range === 'today' ? L('今天還沒有提醒', 'No alerts today') : L('還沒有提醒紀錄', 'No alert history yet')}</b><span>${L(
            '條件達成或接近達成時，會記錄在這裡。',
            'Alerts that hit or get close show up here.'
          )}</span></div>`;
    $view.innerHTML = `
      <header class="page-head"><div><h1>${L('提醒紀錄', 'History')}</h1></div></header>
      <div class="seg" role="group" aria-label="${L('時間範圍', 'Time range')}">
        ${[
          ['today', L('今天', 'Today')],
          ['week', L('本週', 'This week')],
          ['all', L('全部', 'All')],
        ]
          .map(([k, l]) => `<button type="button" data-act="range" data-value="${k}" aria-pressed="${state.range === k}">${l}</button>`)
          .join('')}
      </div>
      ${items}`;
  };
  state.events = null;
  draw();
  const { events } = await api(`/api/events?range=${state.range}`);
  state.events = events;
  if (parseRoute().path === '/history') draw();
}

// ---------- settings ----------

async function thisDeviceEndpoint() {
  if (!pushSupported) return null;
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = reg ? await reg.pushManager.getSubscription() : null;
  return sub ? sub.endpoint : null;
}

async function renderSettings(params) {
  setNav('settings');
  $view.className = 'view';
  state.me = await api('/api/me');
  const endpoint = await thisDeviceEndpoint().catch(() => null);
  if (params?.get('email') === 'ok') toast(L('Email 已驗證，之後會寄提醒給你', 'Email verified — alerts will be sent there'));
  if (params?.get('email') === 'expired') toast(L('驗證連結已過期，請重新寄一次', 'That link expired. Please send a new one.'), true);
  drawSettings(endpoint);
}

function drawSettings(endpoint) {
  const me = state.me;
  const cfg = state.config;
  const has = (t) => me.channels.some((c) => c.type === t);
  const pushOnThisDevice = endpoint && me.channels.some((c) => c.type === 'webpush' && c.target === endpoint);
  const otherPush = me.channels.filter((c) => c.type === 'webpush' && c.target !== endpoint).length;
  const muted = (text) => `<span class="muted" style="font-size:13px">${text}</span>`;
  const connectedOff = (type) =>
    `<span class="ok">${L('已連接', 'Connected')}</span><button class="btn small secondary" data-act="channel-off" data-type="${type}">${L('解除', 'Remove')}</button>`;
  const notAvailable = muted(L('尚未開放', 'Not available'));

  const rows = [];
  // Web Push
  {
    let action;
    let desc = L('免裝 App，直接跳在手機通知列', 'No app needed — shows in your notifications');
    if (!cfg.channels.webpush) action = notAvailable;
    else if (pushOnThisDevice) {
      action = `<button class="btn small secondary" data-act="push-off">${L('關閉', 'Turn off')}</button>`;
      desc = L('這台裝置已開啟', 'On for this device');
    } else if (isIOS && !isStandalone) action = muted(L('先加入主畫面', 'Add to Home Screen first'));
    else if (!pushSupported) action = muted(L('此瀏覽器不支援', 'Not supported in this browser'));
    else action = `<button class="btn small outline" data-act="push-on">${L('開啟', 'Turn on')}</button>`;
    if (otherPush) desc += L(`（另有 ${otherPush} 台裝置已開啟）`, ` (also on ${otherPush} other device${otherPush > 1 ? 's' : ''})`);
    rows.push(row(L('網頁推播', 'Web push'), desc, action, L('推薦', 'Recommended')));
  }
  // Telegram
  {
    let action;
    let desc = L('訊息穩定、可保留紀錄', 'Reliable, keeps a message history');
    if (!cfg.channels.telegram) action = notAvailable;
    else if (has('telegram')) action = connectedOff('telegram');
    else if (state.telegramPolling) {
      action = muted(L('等待連接…', 'Waiting…'));
      desc = L('請在 Telegram 按下「開始 / Start」', 'Tap "Start" in Telegram');
    } else action = `<button class="btn small outline" data-act="telegram-on">${L('連接', 'Connect')}</button>`;
    rows.push(row('Telegram', desc, action));
  }
  // Discord
  {
    const open = state.openForm === 'discord';
    const action = has('discord')
      ? connectedOff('discord')
      : `<button class="btn small outline" data-act="toggle-form" data-form="discord">${open ? L('取消', 'Cancel') : L('連接', 'Connect')}</button>`;
    rows.push(
      row('Discord', L('推到你的私人頻道或群組', 'Post to your own server or channel'), action) +
        (open && !has('discord')
          ? `<form class="inline-form" data-form="discord">
              <small class="muted">${L(
                '在 Discord 頻道「編輯頻道 → 整合 → Webhook → 新 Webhook」，複製網址貼在這裡。',
                'In Discord: Edit Channel → Integrations → Webhooks → New Webhook, then copy the URL here.'
              )}</small>
              <input class="input" name="url" inputmode="url" placeholder="https://discord.com/api/webhooks/..." required aria-label="${L('Discord Webhook 網址', 'Discord webhook URL')}">
              <button class="btn small" type="submit">${L('儲存並傳送測試訊息', 'Save and send a test message')}</button></form>`
          : '')
    );
  }
  // Email
  {
    const open = state.openForm === 'email';
    const emailCh = me.channels.find((c) => c.type === 'email');
    let action;
    if (!cfg.channels.email) action = notAvailable;
    else if (emailCh) action = connectedOff('email');
    else action = `<button class="btn small outline" data-act="toggle-form" data-form="email">${open ? L('取消', 'Cancel') : L('設定', 'Set up')}</button>`;
    rows.push(
      row('Email', emailCh ? emailCh.target : L('備用管道，也能用來找回帳號', 'Backup channel, also used to recover your account'), action) +
        (open && !emailCh && cfg.channels.email
          ? `<form class="inline-form" data-form="email">
              <input class="input" name="address" type="email" inputmode="email" placeholder="you@example.com" required aria-label="Email">
              <button class="btn small" type="submit">${L('寄驗證信', 'Send verification email')}</button></form>`
          : '')
    );
  }

  const iosGuide =
    isIOS && !isStandalone
      ? `<div class="notice"><b>${L('iPhone 要先做這一步才收得到推播', 'iPhone: do this to get push notifications')}</b><ol>
          <li>${L('用 Safari 打開本網頁，點下方「分享」', 'Open this site in Safari and tap Share')}</li>
          <li>${L('選「加入主畫面」', 'Choose "Add to Home Screen"')}</li>
          <li>${L('從主畫面圖示打開，到這頁按「開啟」網頁推播', 'Open it from the home screen icon and turn on Web push here')}</li>
        </ol><div style="margin-top:6px">${L('從主畫面打開後需要輸入一次帳號代碼。', "You'll need to enter your account code once in the home screen app.")}</div></div>`
      : '';

  const code = state.code || '';
  $view.innerHTML = `
    <header class="page-head"><div><h1>${L('通知設定', 'Settings')}</h1><p>${L('選你收得到的方式，可以多選', 'Choose how you want to be notified — pick any')}</p></div></header>
    <div class="row-list">${rows.join('')}</div>
    ${iosGuide}
    <div class="row-list">
      <div class="row"><div class="main"><b>${L('勿擾時段', 'Quiet hours')}</b><small>${L(
        '這段時間不推播，結束後一次彙整送出',
        'No notifications during these hours; you get a summary afterwards'
      )}</small></div>
        <button class="switch" role="switch" type="button" data-act="quiet" aria-checked="${me.quietOn}" aria-label="${L('勿擾時段', 'Quiet hours')}"></button></div>
      ${
        me.quietOn
          ? `<div class="times"><input class="input num" type="time" data-quiet="start" value="${minutesToTime(me.quietStart)}" aria-label="${L(
              '開始時間',
              'Start'
            )}"><span class="muted">${L('到', 'to')}</span><input class="input num" type="time" data-quiet="end" value="${minutesToTime(me.quietEnd)}" aria-label="${L(
              '結束時間',
              'End'
            )}"></div>
             <div class="times" style="padding-top:0"><small class="muted">${L('時區：', 'Time zone: ')}${esc(me.tz)}</small></div>`
          : ''
      }
      <div class="row"><div class="main"><b>${L('語言', 'Language')}</b><small>${L('介面與通知內容', 'App and notification language')}</small></div>${langSwitch()}</div>
      <div class="row"><div class="main"><b>${L('漲跌顏色', 'Price colors')}</b></div>
        <div class="seg" role="group" aria-label="${L('漲跌顏色', 'Price colors')}">
          <button type="button" data-act="color" data-value="red" aria-pressed="${state.upRed}">${L('紅漲綠跌', 'Red = up')}</button>
          <button type="button" data-act="color" data-value="green" aria-pressed="${!state.upRed}">${L('綠漲紅跌', 'Green = up')}</button>
        </div></div>
      <div class="row"><button class="text-btn" type="button" data-act="test">${L('發送一則測試通知', 'Send a test notification')}</button></div>
    </div>
    <div class="row-list">
      <div class="row"><div class="main"><b>${L('帳號代碼', 'Account code')}</b><small>${L('換裝置或加到主畫面時，用這組代碼登入', 'Use this code to sign in on other devices')}</small>
        <span class="num" id="code-text" style="font-family:ui-monospace,Menlo,monospace;margin-top:4px">${esc(code.slice(0, 4))}-••••-••••-${esc(code.slice(-4))}</span></div>
        <div style="display:flex;gap:6px"><button class="btn small secondary" data-act="reveal-code">${L('顯示', 'Show')}</button><button class="btn small secondary" data-act="copy-code">${L(
          '複製',
          'Copy'
        )}</button></div></div>
      <div class="row"><a href="#/terms" class="text-btn" style="text-decoration:none">${L('使用條款、免責聲明與隱私權', 'Terms, disclaimer & privacy')}</a></div>
      <div class="row"><button class="text-btn" type="button" data-act="logout">${L('登出此裝置', 'Sign out on this device')}</button></div>
      <div class="row"><button class="text-btn" type="button" style="color:var(--up)" data-act="delete-account">${L('刪除帳號與所有資料', 'Delete account and all data')}</button></div>
    </div>`;

  function row(name, desc, action, tag) {
    return `<div class="row"><div class="main"><b>${name}${tag ? `<span class="tag">${tag}</span>` : ''}</b><small>${esc(desc)}</small></div><div style="display:flex;gap:6px;align-items:center">${action}</div></div>`;
  }
}

function urlBase64ToUint8Array(base64) {
  const pad = '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

async function enablePush() {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    toast(L('通知權限被拒絕了，請到手機設定裡允許這個網站的通知', 'Notifications are blocked. Allow them for this site in your phone settings.'), true);
    return;
  }
  const reg = await navigator.serviceWorker.register('/sw.js');
  await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  // A subscription made with an older server key can no longer receive pushes: replace it.
  if (sub && sub.options && sub.options.applicationServerKey) {
    const current = urlBase64ToUint8Array(state.config.vapidPublicKey);
    const existing = new Uint8Array(sub.options.applicationServerKey);
    if (existing.length !== current.length || existing.some((b, i) => b !== current[i])) {
      await sub.unsubscribe().catch(() => {});
      sub = null;
    }
  }
  if (!sub) {
    sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(state.config.vapidPublicKey) });
  }
  const json = sub.toJSON();
  state.me = await api('/api/channels/webpush', {
    method: 'POST',
    body: { subscription: { endpoint: json.endpoint, keys: json.keys }, device: deviceName() },
  });
  toast(L('網頁推播已開啟', 'Web push is on'));
  drawSettings(json.endpoint);
}

async function disablePush() {
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = reg ? await reg.pushManager.getSubscription() : null;
  if (sub) {
    state.me = await api('/api/channels/webpush', { method: 'DELETE', body: { endpoint: sub.endpoint } });
    await sub.unsubscribe().catch(() => {});
  }
  toast(L('已關閉這台裝置的推播', 'Web push turned off for this device'));
  drawSettings(null);
}

function deviceName() {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return 'Android';
  if (/Mac/.test(ua)) return 'Mac';
  if (/Windows/.test(ua)) return 'Windows';
  return 'Browser';
}

async function connectTelegram() {
  const { url } = await api('/api/channels/telegram', { method: 'POST' });
  window.open(url, '_blank');
  const started = Date.now();
  state.telegramPolling = setInterval(async () => {
    if (Date.now() - started > 5 * 60000 || parseRoute().path !== '/settings') return stopTelegramPolling(true);
    try {
      const me = await api('/api/me');
      if (me.channels.some((c) => c.type === 'telegram')) {
        state.me = me;
        stopTelegramPolling(false);
        toast(L('Telegram 已連接', 'Telegram connected'));
        drawSettings(await thisDeviceEndpoint().catch(() => null));
      }
    } catch {}
  }, 3000);
  drawSettings(await thisDeviceEndpoint().catch(() => null));
}

function stopTelegramPolling(redraw) {
  if (!state.telegramPolling) return;
  clearInterval(state.telegramPolling);
  state.telegramPolling = null;
  if (redraw && parseRoute().path === '/settings') thisDeviceEndpoint().catch(() => null).then(drawSettings);
}

async function saveQuiet(patch) {
  state.me = await api('/api/me', { method: 'PUT', body: patch });
  drawSettings(await thisDeviceEndpoint().catch(() => null));
}

// ---------- event handling ----------

document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const act = el.dataset.act;
  try {
    switch (act) {
      case 'reload':
        return location.reload();
      case 'lang':
        return await setLang(el.dataset.value);
      case 'create-account':
        el.disabled = true;
        try {
          return await createAccount();
        } finally {
          if (el.isConnected) el.disabled = false;
        }
      case 'show-login':
        document.getElementById('recover-form').classList.add('hidden');
        document.getElementById('login-form').classList.remove('hidden');
        document.getElementById('login-code').focus();
        return;
      case 'show-recover':
        document.getElementById('recover-form').classList.remove('hidden');
        document.getElementById('recover-email').focus();
        return;
      case 'start':
        location.hash = '#/';
        return render();
      case 'copy-code':
        await navigator.clipboard.writeText(state.code);
        return toast(L('已複製帳號代碼', 'Account code copied'));
      case 'reveal-code':
        document.getElementById('code-text').textContent = state.code;
        return;
      case 'open-search':
        return openSearch('add');
      case 'pick-stock':
        return openSearch('pick');
      case 'close-sheet':
        return closeSheet();
      case 'pick-symbol':
        return await pickSymbol(el.dataset.symbol, el.dataset.name);
      case 'stock-menu':
        return await stockMenu(el.dataset.symbol);
      case 'logic':
        readDraftValues();
        state.draft.logic = el.dataset.value;
        return renderEditorView();
      case 'add-cond':
        readDraftValues();
        state.draft.conditions.push(defaultCondition('price', currentPrice(state.draft.symbol)));
        return renderEditorView();
      case 'remove-cond':
        readDraftValues();
        if (state.draft.conditions.length === 1) return toast(L('至少需要一個條件', 'Keep at least one condition'), true);
        state.draft.conditions.splice(Number(el.dataset.index), 1);
        return renderEditorView();
      case 'template': {
        readDraftValues();
        const t = TEMPLATES()[Number(el.dataset.index)];
        const price = currentPrice(state.draft.symbol);
        state.draft.logic = t.logic;
        state.draft.conditions = t.conditions.map((c) => {
          const copy = { ...defaultCondition(c.type, price), ...c };
          if (copy.pct != null) {
            copy.value = price ? Number((price * (1 + copy.pct / 100)).toFixed(2)) : null;
            delete copy.pct;
          }
          return copy;
        });
        renderEditorView();
        return toast(L(`已套用「${t.name}」，可以再調整數值`, `"${t.name}" applied — adjust the values as you like`));
      }
      case 'toggle-active':
        readDraftValues();
        state.draft.active = !state.draft.active;
        return renderEditorView();
      case 'save-alert':
        el.disabled = true;
        await saveAlert();
        if (el.isConnected) el.disabled = false;
        return;
      case 'delete-alert':
        if (!confirm(L('刪除這個提醒？', 'Delete this alert?'))) return;
        await api(`/api/alerts/${state.draft.id}`, { method: 'DELETE' });
        state.watch = null;
        toast(L('已刪除提醒', 'Alert deleted'));
        location.hash = '#/';
        return;
      case 'range':
        state.range = el.dataset.value;
        return await renderHistory();
      case 'push-on':
        el.disabled = true;
        try {
          return await enablePush();
        } finally {
          if (el.isConnected) el.disabled = false;
        }
      case 'push-off':
        return await disablePush();
      case 'telegram-on':
        return await connectTelegram();
      case 'channel-off':
        if (!confirm(L(`解除 ${CHANNEL_NAMES()[el.dataset.type]} 通知？`, `Remove ${CHANNEL_NAMES()[el.dataset.type]} notifications?`))) return;
        state.me = await api(`/api/channels/${el.dataset.type}`, { method: 'DELETE' });
        return drawSettings(await thisDeviceEndpoint().catch(() => null));
      case 'toggle-form':
        state.openForm = state.openForm === el.dataset.form ? null : el.dataset.form;
        drawSettings(await thisDeviceEndpoint().catch(() => null));
        document.querySelector(`form[data-form="${state.openForm}"] input`)?.focus();
        return;
      case 'quiet':
        return await saveQuiet({ quietOn: !state.me.quietOn, tz: Intl.DateTimeFormat().resolvedOptions().timeZone });
      case 'color':
        state.upRed = el.dataset.value === 'red';
        storeSet('sa_upred', state.upRed ? '1' : '0');
        return drawSettings(await thisDeviceEndpoint().catch(() => null));
      case 'test': {
        el.disabled = true;
        try {
          const { sentVia } = await api('/api/test', { method: 'POST' });
          toast(`${L('已送出：', 'Sent via ')}${sentVia.map((t) => CHANNEL_NAMES()[t]).join(SEP())}`);
        } finally {
          if (el.isConnected) el.disabled = false;
        }
        return;
      }
      case 'logout':
        return logout(true);
      case 'delete-account':
        if (!confirm(L('確定要刪除帳號嗎？所有自選股、提醒和通知設定都會刪除，無法復原。', 'Delete your account? Your watchlist, alerts and notification settings will be permanently deleted.'))) return;
        await api('/api/me', { method: 'DELETE' });
        logout(false);
        return toast(L('帳號已刪除', 'Account deleted'));
    }
  } catch (err) {
    toast(err.message, true);
    if (el.disabled && el.isConnected) el.disabled = false;
  }
});

document.addEventListener('change', (e) => {
  const el = e.target;
  if (state.draft && el.dataset.cond !== undefined) {
    const i = Number(el.dataset.cond);
    readDraftValues();
    const c = state.draft.conditions[i];
    if (el.dataset.field === 'type') {
      state.draft.conditions[i] = defaultCondition(el.value, currentPrice(state.draft.symbol));
    } else if (el.dataset.field === 'op') {
      c.op = el.value;
      const t = TYPES()[c.type];
      if (t.value?.only && t.value.only.includes(c.op) && c.value == null) c.value = t.value.def;
    } else if (el.dataset.field === 'pair') {
      const [f, s] = el.value.split('-').map(Number);
      c.fast = f;
      c.slow = s;
    } else if (el.dataset.field === 'mode') {
      c.mode = el.value;
    } else if (el.dataset.field === 'kdp') {
      c.kdp = el.value;
    } else if (el.dataset.field === 'period') {
      c.period = Number(el.value);
    } else return;
    return renderEditorView();
  }
  if (state.draft && el.id === 'freq') state.draft.frequency = el.value;
  if (el.dataset.quiet) {
    const patch = el.dataset.quiet === 'start' ? { quietStart: timeToMinutes(el.value) } : { quietEnd: timeToMinutes(el.value) };
    saveQuiet(patch)
      .then(() => toast(L('已更新勿擾時段', 'Quiet hours updated')))
      .catch((err) => toast(err.message, true));
  }
});

document.addEventListener('input', (e) => {
  const el = e.target;
  if (state.draft && el.dataset.field === 'value') {
    const i = Number(el.dataset.cond);
    state.draft.conditions[i].value = el.value === '' ? null : Number(el.value);
  }
});

document.addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const btn = form.querySelector('button[type="submit"]');
  if (btn) btn.disabled = true;
  try {
    if (form.id === 'login-form') {
      await login(form.querySelector('#login-code').value);
    } else if (form.id === 'recover-form') {
      const turnstile = requireTurnstile();
      try {
        await api('/api/recover', { method: 'POST', body: { address: form.querySelector('#recover-email').value, turnstile } });
      } finally {
        resetTurnstile();
      }
      form.classList.add('hidden');
      toast(L('如果這個 Email 有綁定帳號，你會收到一封找回信', 'If that email is linked to an account, a recovery link is on its way'));
    } else if (form.dataset.form === 'discord') {
      state.me = await api('/api/channels/discord', { method: 'POST', body: { url: form.url.value } });
      state.openForm = null;
      toast(L('Discord 已連接，已傳送測試訊息', 'Discord connected — test message sent'));
      drawSettings(await thisDeviceEndpoint().catch(() => null));
    } else if (form.dataset.form === 'email') {
      await api('/api/channels/email', { method: 'POST', body: { address: form.address.value } });
      state.openForm = null;
      toast(L('驗證信已寄出，請到信箱點連結完成設定', 'Verification email sent — open the link in it to finish'));
      drawSettings(await thisDeviceEndpoint().catch(() => null));
    }
  } catch (err) {
    toast(err.message, true);
  } finally {
    if (btn && btn.isConnected) btn.disabled = false;
  }
});

// ---------- boot ----------

(async function boot() {
  applyLangChrome();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  try {
    state.config = await api('/api/config');
  } catch (err) {
    $view.innerHTML = `<div class="empty"><b>${L('連不上伺服器', 'Cannot reach the server')}</b><span>${esc(err.message)}</span><button class="btn small outline" data-act="reload">${L(
      '重新整理',
      'Reload'
    )}</button></div>`;
    return;
  }
  // Keep the server's copy of the language in sync with this device.
  if (state.code) {
    api('/api/me')
      .then((me) => {
        state.me = me;
        if (me.lang !== state.lang) api('/api/me', { method: 'PUT', body: { lang: state.lang } }).catch(() => {});
      })
      .catch(() => {});
  }
  render();
})();
