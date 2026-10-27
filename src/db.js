// Database schema and small helpers (Cloudflare D1 / SQLite).
// The schema is created automatically on first use, so there is no migration step to run.

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    code_hash TEXT NOT NULL UNIQUE,
    tz TEXT NOT NULL DEFAULT 'UTC',
    quiet_on INTEGER NOT NULL DEFAULT 0,
    quiet_start INTEGER NOT NULL DEFAULT 60,
    quiet_end INTEGER NOT NULL DEFAULT 420,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS watchlist (
    user_id TEXT NOT NULL,
    symbol TEXT NOT NULL,
    name TEXT,
    added_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, symbol)
  )`,
  `CREATE INDEX IF NOT EXISTS watchlist_symbol ON watchlist(symbol)`,
  `CREATE TABLE IF NOT EXISTS alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    symbol TEXT NOT NULL,
    logic TEXT NOT NULL DEFAULT 'all',
    conditions TEXT NOT NULL,
    channels TEXT,
    frequency TEXT NOT NULL DEFAULT 'daily',
    active INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'watching',
    status_detail TEXT,
    last_triggered_at INTEGER,
    last_trigger_day TEXT,
    last_near_day TEXT,
    checked_at INTEGER,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS alerts_user ON alerts(user_id)`,
  `CREATE INDEX IF NOT EXISTS alerts_active_symbol ON alerts(active, symbol)`,
  `CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    alert_id INTEGER,
    symbol TEXT,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT,
    channels TEXT,
    delivery TEXT NOT NULL DEFAULT 'none',
    sent_via TEXT,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS events_user_time ON events(user_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS events_delivery ON events(delivery)`,
  `CREATE TABLE IF NOT EXISTS channels (
    user_id TEXT NOT NULL,
    type TEXT NOT NULL,
    target TEXT NOT NULL,
    meta TEXT,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, type, target)
  )`,
  `CREATE TABLE IF NOT EXISTS link_codes (
    code TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    payload TEXT,
    expires_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS quotes (
    symbol TEXT PRIMARY KEY,
    price REAL,
    change REAL,
    change_pct REAL,
    prev_close REAL,
    open REAL,
    high REAL,
    low REAL,
    ts INTEGER,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS bars (
    symbol TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT
  )`,
];

let schemaReady = false;

export async function ensureSchema(db) {
  if (schemaReady) return;
  await db.batch(SCHEMA.map((sql) => db.prepare(sql)));
  schemaReady = true;
}

export async function getMeta(db, key) {
  const row = await db.prepare('SELECT value FROM meta WHERE key = ?').bind(key).first();
  return row ? row.value : null;
}

export async function setMeta(db, key, value) {
  await db
    .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .bind(key, value == null ? null : String(value))
    .run();
}

export function parseJson(text, fallback) {
  if (text == null) return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

export function upsertQuoteStmt(db, symbol, q, now) {
  return db
    .prepare(
      `INSERT INTO quotes (symbol, price, change, change_pct, prev_close, open, high, low, ts, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(symbol) DO UPDATE SET price=excluded.price, change=excluded.change, change_pct=excluded.change_pct,
         prev_close=excluded.prev_close, open=excluded.open, high=excluded.high, low=excluded.low, ts=excluded.ts,
         updated_at=excluded.updated_at`
    )
    .bind(symbol, q.price, q.change, q.changePct, q.prevClose, q.open, q.high, q.low, q.ts, now);
}

export function quoteFromRow(row) {
  if (!row || row.price == null) return null;
  return {
    price: row.price,
    change: row.change,
    changePct: row.change_pct,
    prevClose: row.prev_close,
    open: row.open,
    high: row.high,
    low: row.low,
    ts: row.ts,
    updatedAt: row.updated_at,
  };
}
