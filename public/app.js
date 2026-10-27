// 股票提醒 — mobile web app (no build step, plain JavaScript).

const $view = document.getElementById('view');
const $nav = document.getElementById('nav');

const state = {
  code: localStorage.getItem('sa_code') || null,
  config: null,
  me: null,
  watch: null,
  events: null,
  range: 'today',
  upRed: localStorage.getItem('sa_upred') !== '0',
  clockOffset: 0,
  draft: null,
  telegramPolling: null,
  openForm: null, // which channel form is expanded in settings
};

const CHANNEL_NAMES = { webpush: '網頁推播', telegram: 'Telegram', discord: 'Discord', email: 'Email' };
const FREQ = [
  ['once', '只提醒一次'],
  ['daily', '每天最多一次'],
  ['hourly', '每小時最多一次'],
];
const MA_PAIRS = [
  [5, 20],
  [10, 20],
  [20, 60],
  [50, 200],
];
const MA_PERIODS = [5, 10, 20, 50, 60, 120, 200];

// Condition types shown in the editor (mirrors src/engine.js).
const TYPES = {
  price: {
    label: '價格',
    ops: [['above', '高於或等於'], ['below', '低於或等於'], ['cross_above', '向上突破'], ['cross_below', '向下跌破']],
    value: { unit: '美元', step: '0.01' },
    basic: true,
  },
  change: { label: '今日漲跌幅', ops: [['up', '漲幅達'], ['down', '跌幅達']], value: { unit: '%', step: '0.1', def: 3 }, basic: true },
  rsi: { label: 'RSI (14)', ops: [['below', '低於'], ['above', '高於']], value: { unit: '', step: '1', def: 30 } },
  ma_cross: { label: '均線交叉', ops: [['golden', '黃金交叉（向上）'], ['death', '死亡交叉（向下）']], pair: true },
  price_ma: { label: '價格 vs 均線', ops: [['cross_above', '站上'], ['cross_below', '跌破'], ['above', '在之上'], ['below', '在之下']], period: true },
  kd: {
    label: 'KD (9,3,3)',
    ops: [['golden', '黃金交叉'], ['death', '死亡交叉'], ['k_below', 'K 值低於'], ['k_above', 'K 值高於']],
    value: { unit: '', step: '1', def: 20, only: ['k_below', 'k_above'] },
  },
  volume: { label: '今日成交量', ops: [['above', '大於 20 日均量']], value: { unit: '倍', step: '0.1', def: 1.5 } },
};

const TEMPLATES = [
  { name: '超跌反彈', logic: 'all', conditions: [{ type: 'rsi', op: 'below', value: 30 }, { type: 'kd', op: 'golden' }] },
  { name: '均線多頭', logic: 'all', conditions: [{ type: 'ma_cross', op: 'golden', fast: 20, slow: 60 }, { type: 'price_ma', op: 'above', period: 20 }] },
  { name: '放量突破', logic: 'all', conditions: [{ type: 'volume', op: 'above', value: 1.5 }, { type: 'change', op: 'up', value: 3 }] },
  { name: '跌破停損', logic: 'all', conditions: [{ type: 'price', op: 'cross_below', value: null, pct: -5 }] },
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
  setTimeout(() => el.remove(), 3200);
}

async function api(path, { method = 'GET', body } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (state.code) headers.authorization = `Bearer ${state.code}`;
  let res;
  try {
    res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  } catch {
    throw new Error('網路連線不穩，請再試一次');
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && state.code) {
    logout(false);
    throw new Error(data.error || '請重新登入');
  }
  if (!res.ok) throw new Error(data.error || '發生錯誤');
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
  if (d) return `${d} 天 ${h} 小時`;
  if (h) return `${h} 小時 ${m} 分`;
  return `${m} 分鐘`;
}

function fmtTime(ms) {
  const d = new Date(ms);
  const now = new Date();
  const hm = d.toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', hour12: false });
  if (d.toDateString() === now.toDateString()) return hm;
  return `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
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
  if (!state.code) {
    setNav(null);
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
    $view.innerHTML = `<div class="empty"><b>載入失敗</b><span>${esc(err.message)}</span><button class="btn small outline" data-act="reload">重新整理</button></div>`;
  }
}

window.addEventListener('hashchange', () => {
  closeSheet();
  render();
  window.scrollTo(0, 0);
});

// ---------- welcome / login ----------

function renderWelcome(showCode = null) {
  $view.className = 'view welcome no-nav';
  if (showCode) {
    $view.innerHTML = `
      <img src="/icons/icon-192.png" alt="">
      <h1>記下你的帳號代碼</h1>
      <p>換手機、換瀏覽器或把網頁加到主畫面時，輸入這組代碼就能找回你的設定。</p>
      <div class="code-box" id="code-box">${esc(showCode)}</div>
      <div class="stack">
        <button class="btn secondary" data-act="copy-code">複製代碼</button>
        <button class="btn" data-act="start">我已記下，開始使用</button>
      </div>`;
    return;
  }
  $view.innerHTML = `
    <img src="/icons/icon-192.png" alt="">
    <h1>股票提醒</h1>
    <p>設定美股條件，條件達成就通知你，不用整天盯盤。</p>
    ${
      isIOS && !isStandalone
        ? `<div class="notice" style="text-align:left"><b>iPhone 用戶先做這一步</b>想收到推播通知的話，先用 Safari 點下方「分享」→「加入主畫面」，再從主畫面的圖示打開這個網頁開始使用。</div>`
        : ''
    }
    <div class="stack">
      <button class="btn" data-act="create-account">開始使用</button>
      <button class="btn secondary" data-act="show-login">我已有帳號代碼</button>
      <form id="login-form" class="stack hidden">
        <label class="label" for="login-code">帳號代碼</label>
        <input id="login-code" class="input" autocomplete="off" autocapitalize="characters" placeholder="XXXX-XXXX-XXXX-XXXX" required>
        <button class="btn" type="submit">登入</button>
      </form>
    </div>`;
}

async function createAccount() {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const { code } = await api('/api/account', { method: 'POST', body: { tz } });
  state.code = code;
  localStorage.setItem('sa_code', code);
  renderWelcome(code);
}

async function login(code) {
  const res = await api('/api/login', { method: 'POST', body: { code } });
  state.code = res.code;
  localStorage.setItem('sa_code', res.code);
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  api('/api/me', { method: 'PUT', body: { tz } }).catch(() => {});
  location.hash = '#/';
  render();
}

function logout(confirmFirst = true) {
  if (confirmFirst && !confirm('登出這個裝置？之後輸入帳號代碼可以再登入。')) return;
  state.code = null;
  state.me = null;
  state.watch = null;
  state.events = null;
  localStorage.removeItem('sa_code');
  location.hash = '#/';
  render();
}

// ---------- home (自選股) ----------

let homeTimer = null;

async function loadHome() {
  const [watch, me] = await Promise.all([api('/api/watchlist'), state.me ? Promise.resolve(state.me) : api('/api/me')]);
  state.watch = watch;
  state.me = me;
  state.clockOffset = watch.market.now - Date.now();
}

function statusInfo(a, market) {
  if (a.status === 'paused') return ['st-paused', '已暫停'];
  if (a.status === 'done') return ['st-done', '已完成'];
  if (!a.checked) return ['st-waiting', market.open ? '準備中' : '等待開盤'];
  if (a.status === 'triggered') return ['st-triggered', '今日已觸發'];
  if (a.status === 'near') return ['st-near', '接近觸發'];
  return ['st-watching', '監控中'];
}

function channelSummary() {
  const types = [...new Set((state.me?.channels || []).map((c) => c.type))].filter((t) => state.config.channels[t]);
  return types.map((t) => CHANNEL_NAMES[t]);
}

function marketBanner(market) {
  const now = Date.now() + state.clockOffset;
  const names = channelSummary();
  const pill = names.length
    ? `<a class="pill" href="#/settings">通知：${esc(names.join('、'))}</a>`
    : `<a class="pill warn" href="#/settings">設定通知 ›</a>`;
  const title = market.open ? '美股交易中' : '美股休市中';
  const sub = market.open
    ? market.closesAtMs
      ? `距離收盤 ${fmtDuration(market.closesAtMs - now)}`
      : '每分鐘檢查一次條件'
    : market.nextOpenMs
      ? `距離開盤 ${fmtDuration(market.nextOpenMs - now)}`
      : '';
  return `<div class="banner"><div><b>${title}</b><small>${esc(sub)}</small></div>${pill}</div>`;
}

function alertRowHtml(a, market) {
  const [cls, label] = statusInfo(a, market);
  const joiner = a.logic === 'any' ? '或' : '';
  const chips = a.labels
    .map((l, i) => `${i && joiner ? `<span class="chip joiner">${joiner}</span>` : ''}<span class="chip">${esc(l)}</span>`)
    .join('');
  return `<a class="alert-row" href="#/alert/${a.id}" aria-label="編輯提醒：${esc(a.labels.join('、'))}">
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
        <button class="more-btn" data-act="stock-menu" data-symbol="${esc(s.symbol)}" aria-label="${esc(s.symbol)} 更多選項">${ICON.more}</button>
      </div>
    </div>
    ${alerts}
    <a class="add-link" href="#/new?symbol=${encodeURIComponent(s.symbol)}&name=${encodeURIComponent(s.name || '')}">＋ ${s.alerts.length ? '再加一個提醒' : '設定提醒條件'}</a>
  </article>`;
}

function homeHtml() {
  const w = state.watch;
  const active = w.stocks.reduce((n, s) => n + s.alerts.filter((a) => a.active).length, 0);
  const demo = state.config.demo
    ? `<div class="notice info"><b>示範模式</b>目前用的是模擬股價，方便你先試用。管理員設定股價 API 後會自動改成真實行情。</div>`
    : '';
  const list = w.stocks.length
    ? `<div class="stack">${w.stocks.map((s) => stockCardHtml(s, w.market)).join('')}</div>`
    : `<div class="empty"><b>還沒有自選股</b><span>先加入一支想盯的股票，再設定提醒條件。</span><button class="btn small" data-act="open-search">＋ 加入股票</button></div>`;
  return `
    <header class="page-head">
      <div><h1>自選股</h1><p>${active ? `${active} 個提醒監控中` : '設定條件，達成就通知你'}</p></div>
      <button class="icon-btn" data-act="open-search" aria-label="加入股票">${ICON.plus}</button>
    </header>
    ${marketBanner(w.market)}
    ${demo}
    ${list}`;
}

async function renderHome() {
  setNav('home');
  $view.className = 'view';
  if (state.watch) $view.innerHTML = homeHtml();
  else $view.innerHTML = '<div class="empty">載入中…</div>';
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
    <div class="sheet" role="dialog" aria-modal="true" aria-label="搜尋股票">
      <div class="sheet-head"><b>${mode === 'add' ? '加入自選股' : '選擇股票'}</b>
        <button class="icon-btn ghost" data-act="close-sheet" aria-label="關閉">${ICON.close}</button></div>
      <label class="label" for="search-input">輸入代號或公司名稱（美股）</label>
      <input id="search-input" class="input" type="search" placeholder="例如 AAPL、Tesla" autocomplete="off" autocapitalize="characters">
      <div class="sheet-results" id="search-results"><div class="empty">輸入後會顯示結果</div></div>
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
    box.innerHTML = '<div class="empty">輸入後會顯示結果</div>';
    return;
  }
  box.innerHTML = '<div class="empty">搜尋中…</div>';
  try {
    const { results } = await api(`/api/search?q=${encodeURIComponent(q)}`);
    if (!document.getElementById('search-results')) return;
    box.innerHTML = results.length
      ? results
          .map(
            (r) =>
              `<button class="result" data-act="pick-symbol" data-symbol="${esc(r.symbol)}" data-name="${esc(r.name)}"><b>${esc(r.symbol)}</b><span>${esc(r.name)}</span></button>`
          )
          .join('')
      : '<div class="empty">找不到符合的美股</div>';
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
    toast(`已加入 ${symbol}`);
    if (parseRoute().path === '/') $view.innerHTML = homeHtml();
    else location.hash = '#/';
  } catch (err) {
    toast(err.message, true);
  }
}

async function stockMenu(symbol) {
  if (!confirm(`從自選股移除 ${symbol}？這支股票的提醒也會一起刪除。`)) return;
  try {
    await api(`/api/watchlist/${encodeURIComponent(symbol)}`, { method: 'DELETE' });
    state.watch.stocks = state.watch.stocks.filter((s) => s.symbol !== symbol);
    $view.innerHTML = homeHtml();
    toast(`已移除 ${symbol}`);
  } catch (err) {
    toast(err.message, true);
  }
}

// ---------- alert editor ----------

function defaultCondition(type, price) {
  const t = TYPES[type];
  const c = { type, op: t.ops[0][0] };
  if (t.value) c.value = type === 'price' ? (price ? Number(price.toFixed(2)) : null) : t.value.def;
  if (t.pair) {
    c.fast = 20;
    c.slow = 60;
  }
  if (t.period) c.period = 20;
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
  const t = TYPES[c.type];
  const allowed = Object.entries(TYPES).filter(([, v]) => v.basic || state.config.indicators);
  const typeOpts = allowed.map(([k, v]) => `<option value="${k}" ${k === c.type ? 'selected' : ''}>${v.label}</option>`).join('');
  const opOpts = t.ops.map(([k, l]) => `<option value="${k}" ${k === c.op ? 'selected' : ''}>${l}</option>`).join('');
  let third = '';
  if (t.pair) {
    third = `<select class="input" data-cond="${i}" data-field="pair" aria-label="均線組合">${MA_PAIRS.map(
      ([f, s]) => `<option value="${f}-${s}" ${c.fast === f && c.slow === s ? 'selected' : ''}>MA${f} / MA${s}</option>`
    ).join('')}</select>`;
  } else if (t.period) {
    third = `<select class="input" data-cond="${i}" data-field="period" aria-label="均線天數">${MA_PERIODS.map(
      (p) => `<option value="${p}" ${c.period === p ? 'selected' : ''}>MA${p}</option>`
    ).join('')}</select>`;
  } else if (t.value && (!t.value.only || t.value.only.includes(c.op))) {
    third = `<input class="input num" type="number" inputmode="decimal" step="${t.value.step}" data-cond="${i}" data-field="value" value="${c.value ?? ''}" aria-label="數值" placeholder="數值">${
      t.value.unit ? `<span class="unit">${t.value.unit}</span>` : ''
    }`;
  }
  return `<div class="cond">
    <div class="cond-line">
      <select class="input" data-cond="${i}" data-field="type" aria-label="指標">${typeOpts}</select>
      <button class="x" type="button" data-act="remove-cond" data-index="${i}" aria-label="刪除這個條件">${ICON.close}</button>
    </div>
    <div class="cond-line">
      <select class="input grow2" data-cond="${i}" data-field="op" aria-label="比較方式">${opOpts}</select>
      ${third}
    </div>
  </div>`;
}

function renderEditorView() {
  const d = state.draft;
  const isNew = !d.id;
  const connected = [...new Set((state.me?.channels || []).map((c) => c.type))].filter((t) => state.config.channels[t]);
  const channelBox = connected.length
    ? `<div class="row-list">${connected
        .map(
          (t) =>
            `<label class="check"><input type="checkbox" data-channel="${t}" ${!d.channels.length || d.channels.includes(t) ? 'checked' : ''}> ${CHANNEL_NAMES[t]}</label>`
        )
        .join('')}</div>`
    : `<div class="notice">還沒有設定通知方式，提醒觸發時只會記錄在「提醒紀錄」。<a href="#/settings">去設定通知 ›</a></div>`;
  const indicatorNote = state.config.indicators
    ? ''
    : `<div class="notice info">技術指標（RSI、KD、均線、成交量）需要管理員設定指標資料來源後才能使用，目前可設定價格與漲跌幅。</div>`;

  $view.innerHTML = `
    <div class="top-bar">
      <a class="icon-btn ghost" href="#/" aria-label="返回">${ICON.back}</a>
      <h1>${isNew ? '新增提醒' : '編輯提醒'}</h1>
      <span class="spacer"></span>
    </div>
    <div class="stack">
      <span class="label">股票</span>
      <button class="field-btn" type="button" data-act="${isNew ? 'pick-stock' : 'noop'}" ${isNew ? '' : 'aria-disabled="true"'}>
        <span class="muted">${ICON.search}</span>
        ${d.symbol ? `<b>${esc(d.symbol)}</b><span class="muted">${esc(d.name || '')}</span>` : '<span class="muted">選擇股票</span>'}
      </button>
    </div>
    <div class="stack">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px">
        <span class="label">觸發條件（組合拳）</span>
        <div class="seg" role="group" aria-label="條件組合方式">
          <button type="button" data-act="logic" data-value="all" aria-pressed="${d.logic === 'all'}">全部符合</button>
          <button type="button" data-act="logic" data-value="any" aria-pressed="${d.logic === 'any'}">任一符合</button>
        </div>
      </div>
      ${indicatorNote}
      ${d.conditions.map(condHtml).join('')}
      ${d.conditions.length < 6 ? '<button class="dashed" type="button" data-act="add-cond">＋ 新增條件</button>' : ''}
      ${
        state.config.indicators
          ? `<div class="tpls"><span class="label">快速範本</span>${TEMPLATES.map(
              (t, i) => `<button class="tpl" type="button" data-act="template" data-index="${i}">${t.name}</button>`
            ).join('')}</div>`
          : ''
      }
    </div>
    <div class="stack">
      <span class="label">傳送到</span>
      ${channelBox}
    </div>
    <div class="stack">
      <label class="label" for="freq">提醒頻率</label>
      <select id="freq" class="input" data-field="frequency">${FREQ.map(
        ([k, l]) => `<option value="${k}" ${d.frequency === k ? 'selected' : ''}>${l}</option>`
      ).join('')}</select>
    </div>
    ${
      isNew
        ? ''
        : `<div class="row-list"><div class="row"><div class="main"><b>啟用這個提醒</b><small>${
            d.statusDetail ? `目前：${esc(d.statusDetail)}` : '暫停後不會再檢查'
          }</small></div><button class="switch" role="switch" type="button" data-act="toggle-active" aria-checked="${d.active}" aria-label="啟用這個提醒"></button></div></div>
          <button class="btn danger" type="button" data-act="delete-alert">刪除提醒</button>`
    }
    <div class="footer-bar"><div class="inner"><button class="btn" type="button" data-act="save-alert">${isNew ? '建立提醒' : '儲存變更'}</button></div></div>`;
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
  if (!d.symbol) return toast('請先選擇股票', true);
  if (d.channels.includes('__none__')) return toast('至少勾選一種通知方式', true);
  for (const c of d.conditions) {
    const t = TYPES[c.type];
    if (t.value && (!t.value.only || t.value.only.includes(c.op)) && (c.value == null || Number.isNaN(c.value))) {
      return toast(`請填寫「${t.label}」的數值`, true);
    }
  }
  const body = {
    symbol: d.symbol,
    name: d.name,
    logic: d.logic,
    conditions: d.conditions.map(({ type, op, value, fast, slow, period }) => ({ type, op, value, fast, slow, period })),
    channels: d.channels,
    frequency: d.frequency,
    active: d.active,
  };
  try {
    if (d.id) await api(`/api/alerts/${d.id}`, { method: 'PUT', body });
    else await api('/api/alerts', { method: 'POST', body });
    toast(d.id ? '已儲存' : '提醒已建立');
    state.watch = null;
    location.hash = '#/';
  } catch (err) {
    toast(err.message, true);
  }
}

// ---------- history ----------

function deliveryText(e) {
  if (e.kind === 'created') return '';
  if (e.kind === 'near') return '預警，不推播';
  if (e.delivery === 'sent') return `已送出：${e.sentVia.map((t) => CHANNEL_NAMES[t]).join('、')}`;
  if (e.delivery === 'pending') return '等待送出（勿擾時段結束後送出）';
  if (e.delivery === 'failed') return '送出失敗，請到通知設定重新連接';
  return '未送出：尚未設定通知方式';
}

async function renderHistory() {
  setNav('history');
  $view.className = 'view';
  const draw = () => {
    const list = state.events;
    const items = !list
      ? '<div class="empty">載入中…</div>'
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
        : `<div class="empty"><b>${state.range === 'today' ? '今天還沒有提醒' : '還沒有提醒紀錄'}</b><span>條件達成或接近達成時，會記錄在這裡。</span></div>`;
    $view.innerHTML = `
      <header class="page-head"><div><h1>提醒紀錄</h1></div></header>
      <div class="seg" role="group" aria-label="時間範圍">
        ${[
          ['today', '今天'],
          ['week', '本週'],
          ['all', '全部'],
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
  if (params?.get('email') === 'ok') toast('Email 已驗證，之後會寄提醒給你');
  if (params?.get('email') === 'expired') toast('驗證連結已過期，請重新寄一次', true);
  drawSettings(endpoint);
}

function drawSettings(endpoint) {
  const me = state.me;
  const cfg = state.config;
  const has = (t) => me.channels.some((c) => c.type === t);
  const pushOnThisDevice = endpoint && me.channels.some((c) => c.type === 'webpush' && c.target === endpoint);
  const otherPush = me.channels.filter((c) => c.type === 'webpush' && c.target !== endpoint).length;

  const rows = [];
  // Web Push
  {
    let action;
    let desc = '免裝 App，直接跳在手機通知列';
    if (!cfg.channels.webpush) action = '<span class="muted" style="font-size:13px">尚未開放</span>';
    else if (pushOnThisDevice) {
      action = '<button class="btn small secondary" data-act="push-off">關閉</button>';
      desc = '這台裝置已開啟';
    } else if (isIOS && !isStandalone) {
      action = '<span class="muted" style="font-size:13px">先加入主畫面</span>';
    } else if (!pushSupported) {
      action = '<span class="muted" style="font-size:13px">此瀏覽器不支援</span>';
    } else action = '<button class="btn small outline" data-act="push-on">開啟</button>';
    if (otherPush) desc += `（另有 ${otherPush} 台裝置已開啟）`;
    rows.push(row('網頁推播', desc, action, '推薦'));
  }
  // Telegram
  {
    let action;
    let desc = '訊息穩定、可保留紀錄';
    if (!cfg.channels.telegram) action = '<span class="muted" style="font-size:13px">尚未開放</span>';
    else if (has('telegram')) action = '<span class="ok">已連接</span><button class="btn small secondary" data-act="channel-off" data-type="telegram">解除</button>';
    else if (state.telegramPolling) {
      action = '<span class="muted" style="font-size:13px">等待連接…</span>';
      desc = '請在 Telegram 按下「開始 / Start」';
    } else action = '<button class="btn small outline" data-act="telegram-on">連接</button>';
    rows.push(row('Telegram', desc, action));
  }
  // Discord
  {
    const open = state.openForm === 'discord';
    const action = has('discord')
      ? '<span class="ok">已連接</span><button class="btn small secondary" data-act="channel-off" data-type="discord">解除</button>'
      : `<button class="btn small outline" data-act="toggle-form" data-form="discord">${open ? '取消' : '連接'}</button>`;
    rows.push(
      row('Discord', '推到你的私人頻道或群組', action) +
        (open && !has('discord')
          ? `<form class="inline-form" data-form="discord">
              <small class="muted">在 Discord 頻道「編輯頻道 → 整合 → Webhook → 新 Webhook」，複製網址貼在這裡。</small>
              <input class="input" name="url" inputmode="url" placeholder="https://discord.com/api/webhooks/..." required aria-label="Discord Webhook 網址">
              <button class="btn small" type="submit">儲存並傳送測試訊息</button></form>`
          : '')
    );
  }
  // Email
  {
    const open = state.openForm === 'email';
    const emailCh = me.channels.find((c) => c.type === 'email');
    let action;
    if (!cfg.channels.email) action = '<span class="muted" style="font-size:13px">尚未開放</span>';
    else if (emailCh) action = '<span class="ok">已連接</span><button class="btn small secondary" data-act="channel-off" data-type="email">解除</button>';
    else action = `<button class="btn small outline" data-act="toggle-form" data-form="email">${open ? '取消' : '設定'}</button>`;
    rows.push(
      row('Email', emailCh ? emailCh.target : '備用管道', action) +
        (open && !emailCh && cfg.channels.email
          ? `<form class="inline-form" data-form="email">
              <input class="input" name="address" type="email" inputmode="email" placeholder="you@example.com" required aria-label="Email">
              <button class="btn small" type="submit">寄驗證信</button></form>`
          : '')
    );
  }

  const iosGuide =
    isIOS && !isStandalone
      ? `<div class="notice"><b>iPhone 要先做這一步才收得到推播</b><ol><li>用 Safari 打開本網頁，點下方「分享」</li><li>選「加入主畫面」</li><li>從主畫面圖示打開，到這頁按「開啟」網頁推播</li></ol><div style="margin-top:6px">從主畫面打開後需要輸入一次帳號代碼。</div></div>`
      : '';

  const code = state.code || '';
  $view.innerHTML = `
    <header class="page-head"><div><h1>通知設定</h1><p>選你收得到的方式，可以多選</p></div></header>
    <div class="row-list">${rows.join('')}</div>
    ${iosGuide}
    <div class="row-list">
      <div class="row"><div class="main"><b>勿擾時段</b><small>這段時間不推播，結束後一次彙整送出</small></div>
        <button class="switch" role="switch" type="button" data-act="quiet" aria-checked="${me.quietOn}" aria-label="勿擾時段"></button></div>
      ${
        me.quietOn
          ? `<div class="times"><input class="input num" type="time" data-quiet="start" value="${minutesToTime(me.quietStart)}" aria-label="開始時間"><span class="muted">到</span><input class="input num" type="time" data-quiet="end" value="${minutesToTime(me.quietEnd)}" aria-label="結束時間"></div>
             <div class="times" style="padding-top:0"><small class="muted">時區：${esc(me.tz)}</small></div>`
          : ''
      }
      <div class="row"><div class="main"><b>漲跌顏色</b></div>
        <div class="seg" role="group" aria-label="漲跌顏色">
          <button type="button" data-act="color" data-value="red" aria-pressed="${state.upRed}">紅漲綠跌</button>
          <button type="button" data-act="color" data-value="green" aria-pressed="${!state.upRed}">綠漲紅跌</button>
        </div></div>
      <div class="row"><button class="text-btn" type="button" data-act="test">發送一則測試通知</button></div>
    </div>
    <div class="row-list">
      <div class="row"><div class="main"><b>帳號代碼</b><small>換裝置或加到主畫面時，用這組代碼登入</small>
        <span class="num" id="code-text" style="font-family:ui-monospace,Menlo,monospace;margin-top:4px">${esc(code.slice(0, 4))}-••••-••••-${esc(code.slice(-4))}</span></div>
        <div style="display:flex;gap:6px"><button class="btn small secondary" data-act="reveal-code">顯示</button><button class="btn small secondary" data-act="copy-code">複製</button></div></div>
      <div class="row"><button class="text-btn" type="button" data-act="logout">登出此裝置</button></div>
      <div class="row"><button class="text-btn" type="button" style="color:var(--up)" data-act="delete-account">刪除帳號與所有資料</button></div>
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
    toast('通知權限被拒絕了，請到手機設定裡允許這個網站的通知', true);
    return;
  }
  const reg = await navigator.serviceWorker.register('/sw.js');
  await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(state.config.vapidPublicKey) });
  }
  const json = sub.toJSON();
  state.me = await api('/api/channels/webpush', {
    method: 'POST',
    body: { subscription: { endpoint: json.endpoint, keys: json.keys }, device: deviceName() },
  });
  toast('網頁推播已開啟');
  drawSettings(json.endpoint);
}

async function disablePush() {
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = reg ? await reg.pushManager.getSubscription() : null;
  if (sub) {
    state.me = await api('/api/channels/webpush', { method: 'DELETE', body: { endpoint: sub.endpoint } });
    await sub.unsubscribe().catch(() => {});
  }
  toast('已關閉這台裝置的推播');
  drawSettings(null);
}

function deviceName() {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return 'Android';
  if (/Mac/.test(ua)) return 'Mac';
  if (/Windows/.test(ua)) return 'Windows';
  return '瀏覽器';
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
        toast('Telegram 已連接');
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
      case 'create-account':
        el.disabled = true;
        return await createAccount();
      case 'show-login':
        document.getElementById('login-form').classList.remove('hidden');
        document.getElementById('login-code').focus();
        return;
      case 'start':
        location.hash = '#/';
        return render();
      case 'copy-code':
        await navigator.clipboard.writeText(state.code);
        return toast('已複製帳號代碼');
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
        if (state.draft.conditions.length === 1) return toast('至少需要一個條件', true);
        state.draft.conditions.splice(Number(el.dataset.index), 1);
        return renderEditorView();
      case 'template': {
        readDraftValues();
        const t = TEMPLATES[Number(el.dataset.index)];
        const price = currentPrice(state.draft.symbol);
        state.draft.logic = t.logic;
        state.draft.conditions = t.conditions.map((c) => {
          const copy = { ...c };
          if (copy.pct != null) {
            copy.value = price ? Number((price * (1 + copy.pct / 100)).toFixed(2)) : null;
            delete copy.pct;
          }
          return copy;
        });
        renderEditorView();
        return toast(`已套用「${t.name}」，可以再調整數值`);
      }
      case 'toggle-active':
        readDraftValues();
        state.draft.active = !state.draft.active;
        return renderEditorView();
      case 'save-alert':
        el.disabled = true;
        await saveAlert();
        el.disabled = false;
        return;
      case 'delete-alert':
        if (!confirm('刪除這個提醒？')) return;
        await api(`/api/alerts/${state.draft.id}`, { method: 'DELETE' });
        state.watch = null;
        toast('已刪除提醒');
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
          el.disabled = false;
        }
      case 'push-off':
        return await disablePush();
      case 'telegram-on':
        return await connectTelegram();
      case 'channel-off':
        if (!confirm(`解除 ${CHANNEL_NAMES[el.dataset.type]} 通知？`)) return;
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
        localStorage.setItem('sa_upred', state.upRed ? '1' : '0');
        return drawSettings(await thisDeviceEndpoint().catch(() => null));
      case 'test': {
        el.disabled = true;
        try {
          const { sentVia } = await api('/api/test', { method: 'POST' });
          toast(`已送出：${sentVia.map((t) => CHANNEL_NAMES[t]).join('、')}`);
        } finally {
          el.disabled = false;
        }
        return;
      }
      case 'logout':
        return logout(true);
      case 'delete-account':
        if (!confirm('確定要刪除帳號嗎？所有自選股、提醒和通知設定都會刪除，無法復原。')) return;
        await api('/api/me', { method: 'DELETE' });
        logout(false);
        return toast('帳號已刪除');
    }
  } catch (err) {
    toast(err.message, true);
    if (el.disabled) el.disabled = false;
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
      const t = TYPES[c.type];
      if (t.value?.only && t.value.only.includes(c.op) && c.value == null) c.value = t.value.def;
    } else if (el.dataset.field === 'pair') {
      const [f, s] = el.value.split('-').map(Number);
      c.fast = f;
      c.slow = s;
    } else if (el.dataset.field === 'period') {
      c.period = Number(el.value);
    } else return;
    return renderEditorView();
  }
  if (state.draft && el.id === 'freq') state.draft.frequency = el.value;
  if (el.dataset.quiet) {
    const patch = el.dataset.quiet === 'start' ? { quietStart: timeToMinutes(el.value) } : { quietEnd: timeToMinutes(el.value) };
    saveQuiet(patch).then(() => toast('已更新勿擾時段')).catch((err) => toast(err.message, true));
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
    } else if (form.dataset.form === 'discord') {
      state.me = await api('/api/channels/discord', { method: 'POST', body: { url: form.url.value } });
      state.openForm = null;
      toast('Discord 已連接，已傳送測試訊息');
      drawSettings(await thisDeviceEndpoint().catch(() => null));
    } else if (form.dataset.form === 'email') {
      await api('/api/channels/email', { method: 'POST', body: { address: form.address.value } });
      state.openForm = null;
      toast('驗證信已寄出，請到信箱點連結完成設定');
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
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  try {
    state.config = await api('/api/config');
  } catch (err) {
    $view.innerHTML = `<div class="empty"><b>連不上伺服器</b><span>${esc(err.message)}</span><button class="btn small outline" data-act="reload">重新整理</button></div>`;
    return;
  }
  render();
})();
