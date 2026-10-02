// Integration tests: run with `npm test`. Uses a throwaway database.
const fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto'), assert = require('assert');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oil-'));
Object.assign(process.env, { DB_FILE: path.join(tmp, 't.db'), DATA_DIR: tmp, UPLOAD_DIR: tmp, NODE_ENV: 'test', ENABLE_MOCK_PAYMENTS: '1', RAZORPAY_KEY_ID: '', RAZORPAY_KEY_SECRET: '', ADMIN_PASSWORD: 'testpass123', SESSION_SECRET: 's' });
const app = require('./server'); const { db } = require('./db');

const cust = { name: 'Test User', phone: '9876543210', email: '', address: '12 Main Road, Kakinada', city: 'Kakinada', state: 'Andhra Pradesh', pincode: '533001' };
(async () => {
  const srv = app.listen(0); const base = 'http://localhost:' + srv.address().port; let cookie = '';
  const call = async (p, method = 'GET', body, hdr = {}) => { const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', cookie, ...hdr }, body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0]; return { s: r.status, d: await r.json().catch(() => ({})) }; };
  let n = 0; const ok = (name, fn) => fn().then(() => console.log('  ✓', name)).catch(e => { console.error('  ✗', name, '\n   ', e.message); process.exitCode = 1; });

  await ok('lists products', async () => { const r = await call('/api/products'); assert.equal(r.d.length, 6); });
  await ok('quote uses server prices (client price ignored)', async () => {
    const r = await call('/api/quote', 'POST', { items: [{ id: 1, qty: 2, price: 1 }] }); assert.equal(r.d.subtotal, 1180); assert.equal(r.d.shipping, 60); assert.equal(r.d.total, 1240); });
  await ok('free shipping above threshold', async () => { const r = await call('/api/quote', 'POST', { items: [{ id: 1, qty: 3 }] }); assert.equal(r.d.shipping, 0); });
  await ok('rejects negative/invalid qty', async () => { assert.equal((await call('/api/quote', 'POST', { items: [{ id: 1, qty: -5 }] })).s, 400); });
  await ok('admin endpoints need login', async () => { assert.equal((await call('/api/admin/orders')).s, 401); });
  await ok('wrong admin password rejected', async () => { assert.equal((await call('/api/admin/login', 'POST', { password: 'nope' })).s, 401); });
  await ok('admin login', async () => { assert.equal((await call('/api/admin/login', 'POST', { password: 'testpass123' })).s, 200); });
  await ok('admin creates percent coupon', async () => { assert.equal((await call('/api/admin/coupons', 'POST', { code: 'diwali10', type: 'percent', value: 10, min_order: 500 })).s, 200); });
  await ok('coupon applies', async () => { const r = await call('/api/quote', 'POST', { items: [{ id: 1, qty: 3 }], coupon: 'DIWALI10' }); assert.equal(r.d.discount, 177); assert.equal(r.d.total, 1593); });
  await ok('bulk sale 10% off then end sale', async () => {
    await call('/api/admin/products/bulk-price', 'POST', { action: 'discount', percent: 10 });
    let p = (await call('/api/products')).d[0]; assert.equal(p.price, 531); assert.equal(p.mrp, 590);
    await call('/api/admin/products/bulk-price', 'POST', { action: 'end-sale' });
    p = (await call('/api/products')).d[0]; assert.equal(p.price, 590); assert.equal(p.mrp, null); });
  await ok('bulk +10% raises prices', async () => { await call('/api/admin/products/bulk-price', 'POST', { action: 'adjust', direction: 'up', percent: 10 });
    assert.equal((await call('/api/products')).d[0].price, 649); await call('/api/admin/products/bulk-price', 'POST', { action: 'adjust', direction: 'down', percent: 9.0909090909 }); });
  await ok('validation on order form', async () => { const r = await call('/api/orders', 'POST', { items: [{ id: 1, qty: 1 }], method: 'cod', customer: { ...cust, phone: '123' } }); assert.equal(r.s, 400); });
  let cod;
  await ok('COD order reduces stock', async () => {
    const before = db.prepare('SELECT stock FROM products WHERE id=1').get().stock;
    cod = await call('/api/orders', 'POST', { items: [{ id: 1, qty: 2 }], method: 'cod', coupon: 'DIWALI10', customer: cust }); assert.equal(cod.s, 200);
    assert.equal(db.prepare('SELECT stock FROM products WHERE id=1').get().stock, before - 2);
    assert.equal(db.prepare("SELECT uses FROM coupons WHERE code='DIWALI10'").get().uses, 1); });
  await ok('mock online payment marks paid', async () => {
    const r = await call('/api/orders', 'POST', { items: [{ id: 2, qty: 1 }], method: 'razorpay', customer: cust }); assert.equal(r.s, 200);
    const p = await call('/api/orders/mock-pay', 'POST', { razorpay_order_id: r.d.razorpay.orderId }); assert.equal(p.s, 200);
    assert.equal(db.prepare('SELECT payment_status FROM orders WHERE order_number=?').get(r.d.orderNumber).payment_status, 'paid'); });
  await ok('customer tracking needs matching phone', async () => {
    assert.equal((await call(`/api/track?number=${cod.d.orderNumber}&phone=1111111111`)).s, 404);
    assert.equal((await call(`/api/track?number=${cod.d.orderNumber}&phone=9876543210`)).s, 200); });
  await ok('cancelling restores stock', async () => {
    const o = db.prepare('SELECT id FROM orders WHERE order_number=?').get(cod.d.orderNumber); const before = db.prepare('SELECT stock FROM products WHERE id=1').get().stock;
    await call('/api/admin/orders/' + o.id, 'PUT', { order_status: 'cancelled' }); assert.equal(db.prepare('SELECT stock FROM products WHERE id=1').get().stock, before + 2); });
  await ok('out-of-stock is refused', async () => { db.prepare('UPDATE products SET stock=1 WHERE id=3').run(); assert.equal((await call('/api/quote', 'POST', { items: [{ id: 3, qty: 2 }] })).s, 400); });
  await ok('CSV export', async () => { const r = await fetch(base + '/api/admin/orders.csv', { headers: { cookie } }); assert.match(await r.text(), /JSR-/); });
  await ok('unpaid online attempts hidden from orders, counted as abandoned', async () => {
    const r = await call('/api/orders', 'POST', { items: [{ id: 4, qty: 1 }], method: 'razorpay', customer: cust });
    const all = (await call('/api/admin/orders')).d.map(o => o.order_number); assert.ok(!all.includes(r.d.orderNumber));
    const un = (await call('/api/admin/orders?unpaid=1')).d.map(o => o.order_number); assert.ok(un.includes(r.d.orderNumber));
    assert.ok((await call('/api/admin/summary')).d.abandoned >= 1); });
  await ok('old abandoned orders are purged, paid ones kept', async () => {
    db.prepare("INSERT INTO orders(order_number,items,method,payment_status,created_at) VALUES ('OLD1','[]','razorpay','pending',datetime('now','-9 day'))").run();
    db.prepare("INSERT INTO orders(order_number,items,method,payment_status,created_at) VALUES ('OLD2','[]','razorpay','paid',datetime('now','-9 day'))").run();
    delete require.cache[require.resolve('./server')]; /* purge runs on load */ require('./server');
    assert.equal(db.prepare("SELECT COUNT(*) c FROM orders WHERE order_number='OLD1'").get().c, 0);
    assert.equal(db.prepare("SELECT COUNT(*) c FROM orders WHERE order_number='OLD2'").get().c, 1); });
  await ok('owner is alerted exactly once per confirmed order', async () => {
    const notify = require('./notify'); const seen = [];
    db.prepare("INSERT INTO orders(order_number,items,method,name,phone,total) VALUES ('JSR-N1','[]','cod','A','9876543210',100)").run();
    const id = db.prepare("SELECT id FROM orders WHERE order_number='JSR-N1'").get().id;
    notify.orderConfirmed(id); notify.orderConfirmed(id);
    assert.equal(db.prepare('SELECT notified FROM orders WHERE id=?').get(id).notified, 1); });
  await ok('backup endpoint returns a database file', async () => { const r = await fetch(base + '/api/admin/backup', { headers: { cookie } }); assert.equal(r.status, 200); assert.ok((await r.arrayBuffer()).byteLength > 4096); });
  srv.close();

  // Signature verification path (Razorpay keys present) in a second app instance
  await ok('Razorpay signature verified with HMAC', async () => {
    process.env.RAZORPAY_KEY_ID = 'rzp_test_x'; process.env.RAZORPAY_KEY_SECRET = 'secret123'; process.env.RAZORPAY_WEBHOOK_SECRET = 'whsec';
    delete require.cache[require.resolve('./server')]; const app2 = require('./server'); const s2 = app2.listen(0); const b2 = 'http://localhost:' + s2.address().port;
    db.prepare("INSERT INTO orders(order_number,items,method,rzp_order_id,total) VALUES ('JSR-T1','[{\"id\":4,\"qty\":1}]','razorpay','order_abc',650)").run();
    const post = (u, body, h = {}) => fetch(b2 + u, { method: 'POST', headers: { 'Content-Type': 'application/json', ...h }, body: typeof body === 'string' ? body : JSON.stringify(body) });
    assert.equal((await post('/api/orders/verify', { razorpay_order_id: 'order_abc', razorpay_payment_id: 'pay_1', razorpay_signature: 'bad' })).status, 400);
    const sig = crypto.createHmac('sha256', 'secret123').update('order_abc|pay_1').digest('hex');
    assert.equal((await post('/api/orders/verify', { razorpay_order_id: 'order_abc', razorpay_payment_id: 'pay_1', razorpay_signature: sig })).status, 200);
    assert.equal(db.prepare("SELECT payment_status FROM orders WHERE order_number='JSR-T1'").get().payment_status, 'paid');
    // webhook: bad signature rejected, good one accepted
    const body = JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: { id: 'pay_2', order_id: 'order_abc' } } } });
    assert.equal((await post('/api/razorpay/webhook', body, { 'x-razorpay-signature': 'nope' })).status, 400);
    assert.equal((await post('/api/razorpay/webhook', body, { 'x-razorpay-signature': crypto.createHmac('sha256', 'whsec').update(body).digest('hex') })).status, 200);
    assert.equal((await post('/api/orders/mock-pay', { razorpay_order_id: 'order_abc' })).status, 404); // mock disabled when live keys set
    s2.close(); });
  process.exit(process.exitCode || 0);
})();
