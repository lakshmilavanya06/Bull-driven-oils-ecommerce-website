if (process.argv.includes('--dev')) process.env.NODE_ENV = 'development';
try { process.loadEnvFile(); } catch { /* no .env file: rely on real environment variables */ }

const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const multer = require('multer');

const { db, getSettings } = require('./db');
const { priceCart, OrderError } = require('./pricing');
const notify = require('./notify');
const backup = require('./backup');

// Fail-closed: anything except an explicit dev/test run is treated as production.
const DEV = ['development', 'test'].includes(process.env.NODE_ENV);
const PROD = !DEV;
const KEY_ID = process.env.RAZORPAY_KEY_ID || '';
const KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || '';
const ONLINE = !!(KEY_ID && KEY_SECRET);
// Fake payments only if: no real keys AND a dev/test run AND explicitly switched on.
const MOCK = !ONLINE && DEV && (process.env.ENABLE_MOCK_PAYMENTS === '1' || process.argv.includes('--dev'));
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || (DEV ? 'admin123' : '');
const SESSION_SECRET = process.env.SESSION_SECRET || (DEV ? 'dev-secret-change-me' : '');

if (PROD && (!ADMIN_PASSWORD || !SESSION_SECRET || ADMIN_PASSWORD.length < 10)) {
  console.error('Refusing to start: set ADMIN_PASSWORD (10+ chars) and SESSION_SECRET in your environment or .env file (see .env.example).'); process.exit(1);
}
const razorpay = ONLINE ? new (require('razorpay'))({ key_id: KEY_ID, key_secret: KEY_SECRET }) : null;

const app = express();
app.set('trust proxy', 1);
// Razorpay's checkout loads a script, opens iframes, calls its APIs and shows bank/UPI logos.
// If the pop-up ever misbehaves, set CSP_REPORT_ONLY=1: the browser console then lists what WOULD be blocked
// without breaking anything, and you can add the missing domain here.
const RZP = ['https://*.razorpay.com'];
app.use(helmet({
  contentSecurityPolicy: { reportOnly: process.env.CSP_REPORT_ONLY === '1', directives: {
    defaultSrc: ["'self'"],
    scriptSrc: ["'self'", ...RZP],
    frameSrc: [...RZP],
    connectSrc: ["'self'", ...RZP],
    imgSrc: ["'self'", 'data:', ...RZP],
    styleSrc: ["'self'", "'unsafe-inline'", ...RZP],
    fontSrc: ["'self'", 'data:', ...RZP],
    mediaSrc: ["'self'"],
    formAction: ["'self'", ...RZP],
  } },
  crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' }, // UPI / bank pages may open pop-ups
  crossOriginResourcePolicy: { policy: 'same-site' },
}));
app.get('/healthz', (_req, res) => res.json({ ok: true }));

// ---------- Razorpay webhook (needs the RAW body, so it comes before express.json) ----------
app.post('/api/razorpay/webhook', express.raw({ type: '*/*' }), (req, res) => {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret) return res.status(501).end();
  const sig = String(req.headers['x-razorpay-signature'] || '');
  const expected = crypto.createHmac('sha256', secret).update(req.body).digest('hex');
  if (!safeEq(sig, expected)) return res.status(400).end();
  try {
    const ev = JSON.parse(req.body.toString());
    const pay = ev.payload?.payment?.entity;
    if (pay && (ev.event === 'payment.captured' || ev.event === 'order.paid')) markPaid(pay.order_id, pay.id);
    if (pay && ev.event === 'payment.failed') db.prepare("UPDATE orders SET payment_status='failed' WHERE rzp_order_id=? AND payment_status='pending'").run(pay.order_id);
  } catch (e) { console.error('webhook error', e); }
  res.json({ ok: true });
});

app.use(express.json({ limit: '50kb' }));
app.use(cookieParser());

const safeEq = (a, b) => { const A = Buffer.from(a), B = Buffer.from(b); return A.length === B.length && crypto.timingSafeEqual(A, B); };
const clean = (v, max = 200) => String(v ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);

// ---------- Orders ----------
function takeStock(order) {
  // Atomically reduce stock once per order (idempotent through stock_taken flag)
  db.transaction(() => {
    const o = db.prepare('SELECT * FROM orders WHERE id=?').get(order.id);
    if (o.stock_taken) return;
    for (const it of JSON.parse(o.items))
      db.prepare('UPDATE products SET stock=MAX(stock-?,0) WHERE id=?').run(it.qty, it.id);
    if (o.coupon) db.prepare('UPDATE coupons SET uses=uses+1 WHERE code=?').run(o.coupon);
    db.prepare('UPDATE orders SET stock_taken=1 WHERE id=?').run(o.id);
  })();
  notify.orderConfirmed(order.id); // no-op if already sent
}
function markPaid(rzpOrderId, rzpPaymentId) {
  const o = db.prepare('SELECT * FROM orders WHERE rzp_order_id=?').get(rzpOrderId);
  if (!o) return null;
  if (o.payment_status !== 'paid') {
    db.prepare("UPDATE orders SET payment_status='paid', rzp_payment_id=?, order_status=CASE WHEN order_status='new' THEN 'confirmed' ELSE order_status END, updated_at=datetime('now') WHERE id=?").run(rzpPaymentId, o.id);
    takeStock(o);
  }
  return o;
}
const newOrderNumber = () => 'JSR-' + Date.now().toString(36).toUpperCase() + crypto.randomBytes(2).toString('hex').toUpperCase();

const publicLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 200, standardHeaders: true, legacyHeaders: false });
const orderLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false });
app.use('/api', publicLimiter);

app.get('/api/config', (_req, res) => {
  const s = getSettings();
  res.json({
    online: ONLINE, mock: MOCK, keyId: KEY_ID,
    codEnabled: s.cod_enabled === '1', storeOpen: s.store_open === '1',
    shippingFee: Number(s.shipping_fee), freeShippingAbove: Number(s.free_shipping_above),
    announcement: s.announcement, whatsapp: s.whatsapp,
  });
});

app.get('/api/products', (_req, res) => {
  res.json(db.prepare('SELECT id,name,description,size,price,mrp,stock,image FROM products WHERE active=1 ORDER BY sort,id').all());
});

app.post('/api/quote', (req, res) => {
  try { res.json(priceCart(req.body.items, req.body.coupon)); }
  catch (e) { fail(res, e); }
});

app.post('/api/orders', orderLimiter, async (req, res) => {
  try {
    const b = req.body, c = b.customer || {};
    const cust = { name: clean(c.name, 80), phone: clean(c.phone, 15).replace(/[^\d+]/g, ''), email: clean(c.email, 120),
      address: clean(c.address, 300), city: clean(c.city, 60), state: clean(c.state, 60), pincode: clean(c.pincode, 6), notes: clean(c.notes, 300) };
    if (cust.name.length < 2) throw new OrderError('Please enter your name.');
    if (!/^(\+91)?[6-9]\d{9}$/.test(cust.phone)) throw new OrderError('Enter a valid 10-digit Indian mobile number.');
    if (cust.email && !/^\S+@\S+\.\S+$/.test(cust.email)) throw new OrderError('Enter a valid email or leave it blank.');
    if (cust.address.length < 10) throw new OrderError('Please enter your full address.');
    if (!cust.city || !cust.state) throw new OrderError('Please enter city and state.');
    if (!/^\d{6}$/.test(cust.pincode)) throw new OrderError('Enter a valid 6-digit pincode.');

    const method = b.method === 'cod' ? 'cod' : 'razorpay';
    const s = getSettings();
    if (method === 'cod' && s.cod_enabled !== '1') throw new OrderError('Cash on delivery is not available right now.');
    if (method === 'razorpay' && !ONLINE && !MOCK) throw new OrderError('Online payment is not set up yet.');

    const p = priceCart(b.items, b.coupon);
    const number = newOrderNumber();
    let rzpOrderId = null;
    if (method === 'razorpay' && ONLINE) {
      const ro = await razorpay.orders.create({ amount: p.total * 100, currency: 'INR', receipt: number, notes: { phone: cust.phone } });
      rzpOrderId = ro.id;
    } else if (method === 'razorpay') rzpOrderId = 'mock_' + crypto.randomBytes(6).toString('hex');

    const info = db.prepare(`INSERT INTO orders(order_number,name,phone,email,address,city,state,pincode,notes,items,subtotal,discount,shipping,total,coupon,method,rzp_order_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(number, cust.name, cust.phone, cust.email, cust.address, cust.city, cust.state, cust.pincode, cust.notes,
      JSON.stringify(p.items), p.subtotal, p.discount, p.shipping, p.total, p.coupon, method, rzpOrderId);
    if (method === 'cod') takeStock({ id: info.lastInsertRowid });

    res.json({ orderNumber: number, total: p.total, method,
      razorpay: method === 'razorpay' ? { orderId: rzpOrderId, amount: p.total * 100, keyId: KEY_ID, mock: MOCK } : undefined,
      prefill: { name: cust.name, email: cust.email, contact: cust.phone } });
  } catch (e) { fail(res, e); }
});

// Browser calls this after Razorpay checkout succeeds; we verify the signature with our secret.
app.post('/api/orders/verify', orderLimiter, (req, res) => {
  const { razorpay_order_id: oid, razorpay_payment_id: pid, razorpay_signature: sig } = req.body || {};
  if (!oid || !pid || !sig) return res.status(400).json({ error: 'Missing payment details.' });
  const expected = crypto.createHmac('sha256', KEY_SECRET).update(oid + '|' + pid).digest('hex');
  if (!ONLINE || !safeEq(String(sig), expected)) return res.status(400).json({ error: 'Payment could not be verified.' });
  const o = markPaid(oid, pid);
  if (!o) return res.status(404).json({ error: 'Order not found.' });
  res.json({ ok: true, orderNumber: o.order_number });
});

// Dev-only: simulate a successful payment when no Razorpay keys are configured.
app.post('/api/orders/mock-pay', (req, res) => {
  if (!MOCK) return res.status(404).end();
  const o = markPaid(String(req.body.razorpay_order_id), 'mock_pay_' + Date.now());
  o ? res.json({ ok: true, orderNumber: o.order_number }) : res.status(404).json({ error: 'Order not found.' });
});

// Customers look up an order with order number + phone
app.get('/api/track', orderLimiter, (req, res) => {
  const o = db.prepare('SELECT * FROM orders WHERE order_number=? COLLATE NOCASE').get(clean(req.query.number, 30));
  const phone = clean(req.query.phone, 15).replace(/\D/g, '').slice(-10);
  if (!o || !phone || o.phone.replace(/\D/g, '').slice(-10) !== phone) return res.status(404).json({ error: 'No order found. Check the order number and phone.' });
  res.json({ orderNumber: o.order_number, createdAt: o.created_at, items: JSON.parse(o.items), subtotal: o.subtotal, discount: o.discount,
    shipping: o.shipping, total: o.total, method: o.method, paymentStatus: o.payment_status, orderStatus: o.order_status, tracking: o.tracking });
});

function fail(res, e) {
  if (e instanceof OrderError) return res.status(400).json({ error: e.message });
  console.error(e); res.status(500).json({ error: 'Something went wrong. Please try again.' });
}

// ---------- Admin ----------
const sign = v => crypto.createHmac('sha256', SESSION_SECRET).update(v).digest('hex');
function issueSession(res) {
  const exp = String(Date.now() + 12 * 3600 * 1000);
  res.cookie('adm', exp + '.' + sign(exp), { httpOnly: true, sameSite: 'strict', secure: PROD, maxAge: 12 * 3600 * 1000 });
}
function requireAdmin(req, res, next) {
  const [exp, sig] = String(req.cookies.adm || '').split('.');
  if (exp && sig && Number(exp) > Date.now() && safeEq(sig, sign(exp))) return next();
  res.status(401).json({ error: 'Not logged in' });
}
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false });
app.post('/api/admin/login', loginLimiter, (req, res) => {
  if (!safeEq(sign(String(req.body.password || '')), sign(ADMIN_PASSWORD))) return res.status(401).json({ error: 'Wrong password' });
  issueSession(res); res.json({ ok: true });
});
app.post('/api/admin/logout', (_req, res) => { res.clearCookie('adm'); res.json({ ok: true }); });

const admin = express.Router();
admin.use(requireAdmin);
app.use('/api/admin', admin);

const uploadDir = path.resolve(process.env.UPLOAD_DIR || './uploads');
fs.mkdirSync(uploadDir, { recursive: true });
const upload = multer({
  storage: multer.diskStorage({ destination: uploadDir, filename: (_r, f, cb) => cb(null, Date.now() + '-' + crypto.randomBytes(3).toString('hex') + ({ 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' })[f.mimetype]) }),
  limits: { fileSize: 4 * 1024 * 1024 },
  fileFilter: (_r, f, cb) => cb(null, ['image/jpeg', 'image/png', 'image/webp'].includes(f.mimetype)),
});
app.use('/uploads', express.static(uploadDir, { maxAge: '7d' }));

const int = (v, d = 0) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? n : d; };

admin.get('/summary', (_req, res) => {
  const q = sql => db.prepare(sql).get();
  res.json({
    todayOrders: q(`SELECT COUNT(*) c FROM orders WHERE date(created_at)=date('now') AND ${REAL}`).c,
    newOrders: q(`SELECT COUNT(*) c FROM orders WHERE order_status IN ('new','confirmed') AND ${REAL}`).c,
    abandoned: q(`SELECT COUNT(*) c FROM orders WHERE NOT (${REAL})`).c,
    revenue30: q("SELECT COALESCE(SUM(total),0) s FROM orders WHERE payment_status='paid' AND created_at>=datetime('now','-30 day')").s,
    lowStock: db.prepare('SELECT name,size,stock FROM products WHERE active=1 AND stock<=10 ORDER BY stock').all(),
  });
});

// A "real" order is COD, or an online order that has actually been paid. Everything else is an abandoned attempt.
const REAL = "(method='cod' OR payment_status IN ('paid','refunded'))";
// Abandoned online attempts are deleted after 7 days (webhooks for genuinely paid orders arrive within minutes).
const purgeAbandoned = () => db.prepare(`DELETE FROM orders WHERE NOT (${REAL}) AND created_at < datetime('now','-7 day')`).run();
purgeAbandoned(); setInterval(purgeAbandoned, 6 * 3600 * 1000).unref();

// Products
admin.get('/products', (_req, res) => res.json(db.prepare('SELECT * FROM products ORDER BY sort,id').all()));
admin.post('/products', upload.single('image'), (req, res) => {
  const b = req.body; if (!clean(b.name)) return res.status(400).json({ error: 'Name is required' });
  const price = int(b.price, -1); if (price < 0) return res.status(400).json({ error: 'Enter a valid price' });
  const image = req.file ? '/uploads/' + req.file.filename : '';
  const r = db.prepare('INSERT INTO products(name,description,size,price,mrp,stock,image,active,sort) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(clean(b.name, 100), clean(b.description, 500), clean(b.size, 30), price, b.mrp ? int(b.mrp) : null, int(b.stock, 100), image, b.active === '0' ? 0 : 1, int(b.sort, 99));
  res.json({ id: r.lastInsertRowid });
});
admin.put('/products/:id', upload.single('image'), (req, res) => {
  const p = db.prepare('SELECT * FROM products WHERE id=?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Not found' });
  const b = req.body; const price = b.price !== undefined ? int(b.price, -1) : p.price;
  if (price < 0) return res.status(400).json({ error: 'Enter a valid price' });
  db.prepare('UPDATE products SET name=?,description=?,size=?,price=?,mrp=?,stock=?,image=?,active=?,sort=? WHERE id=?').run(
    clean(b.name ?? p.name, 100), clean(b.description ?? p.description, 500), clean(b.size ?? p.size, 30), price,
    b.mrp === undefined ? p.mrp : (b.mrp === '' ? null : int(b.mrp)), b.stock !== undefined ? int(b.stock) : p.stock,
    req.file ? '/uploads/' + req.file.filename : p.image, b.active !== undefined ? (b.active === '0' ? 0 : 1) : p.active, b.sort !== undefined ? int(b.sort) : p.sort, p.id);
  res.json({ ok: true });
});
admin.delete('/products/:id', (req, res) => {
  // Hide instead of hard delete: old orders keep their snapshot either way, and it's reversible.
  db.prepare('UPDATE products SET active=0 WHERE id=?').run(req.params.id); res.json({ ok: true });
});
// Bulk pricing: raise/lower all prices, or run a store-wide sale, or end it.
admin.post('/products/bulk-price', (req, res) => {
  const { action, percent, ids } = req.body; const pct = Number(percent);
  const rows = db.prepare('SELECT * FROM products').all().filter(p => !Array.isArray(ids) || !ids.length || ids.includes(p.id));
  if (['adjust', 'discount'].includes(action) && !(pct > 0 && pct < 90)) return res.status(400).json({ error: 'Enter a percentage between 1 and 89' });
  const up = db.prepare('UPDATE products SET price=?, mrp=? WHERE id=?');
  db.transaction(() => rows.forEach(p => {
    if (action === 'adjust') { // raise (+) or lower (-) both price and MRP
      const f = 1 + (req.body.direction === 'down' ? -pct : pct) / 100;
      up.run(Math.round(p.price * f), p.mrp ? Math.round(p.mrp * f) : null, p.id);
    } else if (action === 'discount') { // X% off the original price
      const base = p.mrp || p.price; up.run(Math.round(base * (1 - pct / 100)), base, p.id);
    } else if (action === 'end-sale') up.run(p.mrp || p.price, null, p.id);
  }))();
  res.json({ updated: rows.length });
});

// Orders
admin.get('/orders', (req, res) => {
  const { status, q, unpaid } = req.query; const where = [unpaid === '1' ? `NOT (${REAL})` : REAL], args = [];
  if (status) { where.push('order_status=?'); args.push(status); }
  if (q) { where.push('(order_number LIKE ? OR name LIKE ? OR phone LIKE ?)'); args.push(...Array(3).fill('%' + q + '%')); }
  const rows = db.prepare(`SELECT * FROM orders ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT 300`).all(...args);
  res.json(rows.map(o => ({ ...o, items: JSON.parse(o.items) })));
});
admin.put('/orders/:id', (req, res) => {
  const o = db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id); if (!o) return res.status(404).json({ error: 'Not found' });
  const OS = ['new', 'confirmed', 'packed', 'shipped', 'delivered', 'cancelled'], PS = ['pending', 'paid', 'failed', 'refunded'];
  const os = OS.includes(req.body.order_status) ? req.body.order_status : o.order_status;
  const ps = PS.includes(req.body.payment_status) ? req.body.payment_status : o.payment_status;
  db.prepare("UPDATE orders SET order_status=?, payment_status=?, tracking=?, updated_at=datetime('now') WHERE id=?").run(os, ps, clean(req.body.tracking ?? o.tracking, 200), o.id);
  // Cancelling an order that had taken stock puts it back on the shelf
  if (os === 'cancelled' && o.order_status !== 'cancelled' && o.stock_taken) {
    db.transaction(() => { JSON.parse(o.items).forEach(it => db.prepare('UPDATE products SET stock=stock+? WHERE id=?').run(it.qty, it.id)); db.prepare('UPDATE orders SET stock_taken=0 WHERE id=?').run(o.id); })();
  }
  if (o.method === 'cod' && ps === 'paid' && o.order_status === 'new') db.prepare("UPDATE orders SET order_status='confirmed' WHERE id=?").run(o.id);
  if (os !== o.order_status) notify.statusChanged(o.id, os);
  res.json({ ok: true });
});
admin.get('/orders.csv', (_req, res) => {
  const esc = v => '"' + String(v ?? '').replace(/"/g, '""') + '"';
  const head = ['Order', 'Date', 'Name', 'Phone', 'Address', 'City', 'State', 'Pincode', 'Items', 'Total', 'Method', 'Payment', 'Status'];
  const lines = db.prepare(`SELECT * FROM orders WHERE ${REAL} ORDER BY id DESC`).all().map(o => [o.order_number, o.created_at, o.name, o.phone, o.address, o.city, o.state, o.pincode,
    JSON.parse(o.items).map(i => `${i.qty}x ${i.name} ${i.size}`).join('; '), o.total, o.method, o.payment_status, o.order_status].map(esc).join(','));
  res.type('text/csv').attachment('orders.csv').send([head.join(','), ...lines].join('\n'));
});

// Coupons
admin.get('/coupons', (_req, res) => res.json(db.prepare('SELECT * FROM coupons ORDER BY code').all()));
admin.post('/coupons', (req, res) => {
  const b = req.body, code = clean(b.code, 30).toUpperCase().replace(/[^A-Z0-9_-]/g, '');
  if (!code || !(int(b.value) > 0)) return res.status(400).json({ error: 'Code and value are required' });
  if (b.type === 'percent' && int(b.value) > 90) return res.status(400).json({ error: 'Percent must be 90 or less' });
  db.prepare('INSERT OR REPLACE INTO coupons(code,type,value,min_order,max_uses,expires_at,active,uses) VALUES (?,?,?,?,?,?,1,COALESCE((SELECT uses FROM coupons WHERE code=?),0))')
    .run(code, b.type === 'flat' ? 'flat' : 'percent', int(b.value), int(b.min_order), int(b.max_uses), b.expires_at || null, code);
  res.json({ ok: true });
});
admin.put('/coupons/:code', (req, res) => { db.prepare('UPDATE coupons SET active=? WHERE code=?').run(req.body.active ? 1 : 0, req.params.code); res.json({ ok: true }); });
admin.delete('/coupons/:code', (req, res) => { db.prepare('DELETE FROM coupons WHERE code=?').run(req.params.code); res.json({ ok: true }); });

// Settings
admin.get('/settings', (_req, res) => res.json({ ...getSettings(), online: ONLINE, mock: MOCK, mail: notify.mailReady(), telegram: notify.telegramReady(),
  dbPath: backup.dbPath, lastBackup: backup.lastBackup() }));
admin.get('/backup', async (_req, res) => {
  try { const f = await backup.runBackup(); res.download(f, 'store-backup.db'); } catch (e) { console.error(e); res.status(500).json({ error: 'Backup failed' }); }
});
admin.put('/settings', (req, res) => {
  const allowed = ['shipping_fee', 'free_shipping_above', 'cod_enabled', 'store_open', 'announcement', 'whatsapp'];
  const up = db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES (?,?)');
  for (const k of allowed) if (req.body[k] !== undefined) up.run(k, clean(req.body[k], 200));
  res.json({ ok: true });
});

// ---------- Static site ----------
app.use('/admin', (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'], maxAge: '1h' }));
app.use((_req, res) => res.status(404).sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3000;
if (require.main === module) app.listen(PORT, () => {
  console.log(`Store running on http://localhost:${PORT}  (payments: ${ONLINE ? 'Razorpay' : MOCK ? 'MOCK (dev only)' : 'DISABLED: add Razorpay keys'})`);
  console.log(`Database: ${backup.dbPath}  (must be on a persistent disk)`);
  console.log(`Alerts: email ${notify.mailReady() ? 'on' : 'off'}, telegram ${notify.telegramReady() ? 'on' : 'off'}`);
  backup.schedule();
});
module.exports = app;
