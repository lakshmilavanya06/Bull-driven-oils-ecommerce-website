const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dir = path.resolve(process.env.DATA_DIR || './data');
fs.mkdirSync(dir, { recursive: true });
const db = new Database(process.env.DB_FILE || path.join(dir, 'store.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  size TEXT DEFAULT '',
  price INTEGER NOT NULL CHECK (price >= 0),      -- selling price, rupees
  mrp INTEGER,                                    -- optional original price (shows strike-through)
  stock INTEGER NOT NULL DEFAULT 100,
  image TEXT DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS coupons (
  code TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('percent','flat')),
  value INTEGER NOT NULL,
  min_order INTEGER NOT NULL DEFAULT 0,
  max_uses INTEGER NOT NULL DEFAULT 0,            -- 0 = unlimited
  uses INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_number TEXT UNIQUE NOT NULL,
  name TEXT, phone TEXT, email TEXT,
  address TEXT, city TEXT, state TEXT, pincode TEXT, notes TEXT,
  items TEXT NOT NULL,                            -- JSON snapshot: name, price, qty
  subtotal INTEGER, discount INTEGER, shipping INTEGER, total INTEGER,
  coupon TEXT,
  method TEXT NOT NULL,                           -- razorpay | cod
  payment_status TEXT NOT NULL DEFAULT 'pending', -- pending | paid | failed | refunded
  order_status TEXT NOT NULL DEFAULT 'new',       -- new | confirmed | packed | shipped | delivered | cancelled
  rzp_order_id TEXT, rzp_payment_id TEXT,
  tracking TEXT DEFAULT '',
  stock_taken INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_orders_rzp ON orders(rzp_order_id);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
`);

const defaults = {
  shipping_fee: '60',
  free_shipping_above: '1500',
  cod_enabled: '1',
  store_open: '1',
  announcement: '',
  whatsapp: '917095924929',
};
const ins = db.prepare('INSERT OR IGNORE INTO settings(key,value) VALUES (?,?)');
for (const [k, v] of Object.entries(defaults)) ins.run(k, v);

if (db.prepare('SELECT COUNT(*) c FROM products').get().c === 0) {
  const add = db.prepare('INSERT INTO products(name,size,price,image,sort,description) VALUES (?,?,?,?,?,?)');
  [
    ['Groundnut Oil', '1 L', 590, '/img/groundnut.webp', 1, 'Wood-pressed from premium groundnuts. Great for everyday cooking and frying.'],
    ['White Sesame Oil', '1 L', 620, '/img/whitesesame.webp', 2, 'Traditional gingelly oil, rich aroma. Good for cooking and oil pulling.'],
    ['Coconut Oil', '500 ml', 795, '/img/coconut.webp', 3, 'Pure cold-pressed coconut oil for cooking, hair and skin.'],
    ['Black Sesame Oil', '1 L', 650, '/img/blackses.webp', 4, 'Deep flavour, traditionally used for health and massage.'],
    ['Safflower Oil', '1 L', 620, '/img/safflower.webp', 5, 'Light, neutral, unrefined safflower seed oil.'],
    ['Mustard Oil', '1 L', 610, '/img/mustard.webp', 6, 'Pungent, wood-pressed mustard oil.'],
  ].forEach(r => add.run(...r));
}

try { db.exec('ALTER TABLE orders ADD COLUMN notified INTEGER NOT NULL DEFAULT 0'); } catch { /* already exists */ }

const getSettings = () =>
  Object.fromEntries(db.prepare('SELECT key,value FROM settings').all().map(r => [r.key, r.value]));

module.exports = { db, getSettings, dbPath: db.name };
