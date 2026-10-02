// All money is calculated HERE, on the server, from database prices.
// The browser only sends product ids + quantities, so prices can't be tampered with.
const { db, getSettings } = require('./db');

class OrderError extends Error {}

function priceCart(rawItems, couponCode) {
  if (!Array.isArray(rawItems) || rawItems.length === 0) throw new OrderError('Your cart is empty.');
  if (rawItems.length > 50) throw new OrderError('Too many items.');
  const s = getSettings();
  if (s.store_open !== '1') throw new OrderError('The store is currently not accepting orders. Please try later.');

  const merged = new Map();
  for (const it of rawItems) {
    const id = Number(it.id), qty = Math.floor(Number(it.qty));
    if (!Number.isInteger(id) || !(qty >= 1)) throw new OrderError('Invalid cart item.');
    merged.set(id, Math.min((merged.get(id) || 0) + qty, 100));
  }

  const items = [];
  let subtotal = 0;
  for (const [id, qty] of merged) {
    const p = db.prepare('SELECT * FROM products WHERE id=? AND active=1').get(id);
    if (!p) throw new OrderError('A product in your cart is no longer available.');
    if (p.stock < qty) throw new OrderError(`Only ${p.stock} left of ${p.name}${p.size ? ' (' + p.size + ')' : ''}.`);
    items.push({ id: p.id, name: p.name, size: p.size, price: p.price, qty });
    subtotal += p.price * qty;
  }

  let discount = 0, coupon = null;
  if (couponCode) {
    const c = db.prepare('SELECT * FROM coupons WHERE code=? COLLATE NOCASE').get(String(couponCode).trim());
    if (!c || !c.active) throw new OrderError('Invalid coupon code.');
    if (c.expires_at && new Date(c.expires_at + 'T23:59:59') < new Date()) throw new OrderError('This coupon has expired.');
    if (c.max_uses && c.uses >= c.max_uses) throw new OrderError('This coupon has been fully used.');
    if (subtotal < c.min_order) throw new OrderError(`Coupon needs a minimum order of ₹${c.min_order}.`);
    discount = c.type === 'percent' ? Math.round(subtotal * c.value / 100) : c.value;
    discount = Math.min(discount, subtotal);
    coupon = c.code;
  }

  const after = subtotal - discount;
  const freeAbove = Number(s.free_shipping_above);
  const shipping = freeAbove > 0 && after >= freeAbove ? 0 : Number(s.shipping_fee) || 0;
  return { items, subtotal, discount, shipping, total: after + shipping, coupon };
}

module.exports = { priceCart, OrderError };
