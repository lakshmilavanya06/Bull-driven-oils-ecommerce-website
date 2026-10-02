// Order alerts: email (owner + customer) and optional Telegram message to the owner.
// Every send is fire-and-forget: a mail failure must never break an order.
const nodemailer = require('nodemailer');
const { db } = require('./db');

const e = k => process.env[k] || '';
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const inr = n => '₹' + Number(n).toLocaleString('en-IN');
const mailReady = () => !!(e('SMTP_HOST') && e('SMTP_USER') && e('SMTP_PASS'));
let transport;
const getTransport = () => transport ||= nodemailer.createTransport({
  host: e('SMTP_HOST'), port: Number(e('SMTP_PORT')) || 587, secure: Number(e('SMTP_PORT')) === 465,
  auth: { user: e('SMTP_USER'), pass: e('SMTP_PASS') },
});
const from = () => e('MAIL_FROM') || `Jai Shri Ram Bull-Driven Oils <${e('SMTP_USER')}>`;

async function sendMail(to, subject, html) {
  if (!mailReady() || !to) return;
  try { await getTransport().sendMail({ from: from(), to, subject, html }); }
  catch (err) { console.error('[mail] failed:', err.message); }
}
async function telegram(text) {
  if (!e('TELEGRAM_BOT_TOKEN') || !e('TELEGRAM_CHAT_ID')) return;
  try {
    const r = await fetch(`https://api.telegram.org/bot${e('TELEGRAM_BOT_TOKEN')}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: e('TELEGRAM_CHAT_ID'), text }) });
    if (!r.ok) console.error('[telegram] failed:', r.status);
  } catch (err) { console.error('[telegram] failed:', err.message); }
}

const itemsHtml = o => JSON.parse(o.items).map(i => `<tr><td>${i.qty} × ${esc(i.name)} ${esc(i.size)}</td><td align="right">${inr(i.price * i.qty)}</td></tr>`).join('');
const table = o => `<table cellpadding="6" style="border-collapse:collapse;width:100%;max-width:480px">${itemsHtml(o)}
  ${o.discount ? `<tr><td>Discount</td><td align="right">−${inr(o.discount)}</td></tr>` : ''}<tr><td>Delivery</td><td align="right">${o.shipping ? inr(o.shipping) : 'FREE'}</td></tr>
  <tr><td><strong>Total</strong></td><td align="right"><strong>${inr(o.total)}</strong></td></tr></table>`;

// Called once when an order becomes real (COD placed, or online payment confirmed)
function orderConfirmed(orderId) {
  const o = db.prepare('SELECT * FROM orders WHERE id=? AND notified=0').get(orderId);
  if (!o) return;
  db.prepare('UPDATE orders SET notified=1 WHERE id=?').run(o.id);
  const how = o.method === 'cod' ? 'CASH ON DELIVERY (collect ' + inr(o.total) + ')' : 'PAID online';
  const list = JSON.parse(o.items).map(i => `${i.qty}x ${i.name} ${i.size}`).join(', ');
  telegram(`🛢 New order ${o.order_number}\n${how}\n${list}\nTotal ${inr(o.total)}\n${o.name}, ${o.phone}\n${o.address}, ${o.city}, ${o.state} ${o.pincode}${o.notes ? '\nNote: ' + o.notes : ''}`);
  sendMail(e('OWNER_EMAIL') || e('SMTP_USER'), `New order ${o.order_number}: ${inr(o.total)} (${o.method === 'cod' ? 'COD' : 'paid'})`,
    `<h3>New order ${esc(o.order_number)}</h3><p><strong>${esc(how)}</strong></p>${table(o)}
     <p><strong>${esc(o.name)}</strong><br>Phone: ${esc(o.phone)}<br>${esc(o.address)}, ${esc(o.city)}, ${esc(o.state)} ${esc(o.pincode)}</p>${o.notes ? `<p>Note: ${esc(o.notes)}</p>` : ''}`);
  if (o.email) sendMail(o.email, `Order confirmed: ${o.order_number}`,
    `<h3>Thank you, ${esc(o.name)}!</h3><p>Your order <strong>${esc(o.order_number)}</strong> is confirmed${o.method === 'cod' ? '. Please keep ' + inr(o.total) + ' ready for cash on delivery' : ' and payment received'}.</p>${table(o)}
     <p>Delivering to: ${esc(o.address)}, ${esc(o.city)}, ${esc(o.state)} ${esc(o.pincode)}</p>
     ${e('SITE_URL') ? `<p>Track your order: <a href="${esc(e('SITE_URL'))}/track.html?n=${esc(o.order_number)}">${esc(e('SITE_URL'))}/track.html</a></p>` : ''}
     <p>Jai Shri Ram Bull-Driven Oils · +91 70959 24929</p>`);
}

// Called when the owner moves an order to shipped / delivered / cancelled
function statusChanged(orderId, status) {
  if (!['shipped', 'delivered', 'cancelled'].includes(status)) return;
  const o = db.prepare('SELECT * FROM orders WHERE id=?').get(orderId);
  if (!o || !o.email) return;
  const msg = { shipped: `has been shipped${o.tracking ? '. Courier / tracking: <strong>' + esc(o.tracking) + '</strong>' : ''}.`,
    delivered: 'has been delivered. Thank you for choosing us!', cancelled: 'has been cancelled. If you paid online, contact us about your refund.' }[status];
  sendMail(o.email, `Order ${o.order_number} ${status}`, `<p>Hi ${esc(o.name)}, your order <strong>${esc(o.order_number)}</strong> ${msg}</p><p>Jai Shri Ram Bull-Driven Oils · +91 70959 24929</p>`);
}

module.exports = { orderConfirmed, statusChanged, mailReady, telegramReady: () => !!(e('TELEGRAM_BOT_TOKEN') && e('TELEGRAM_CHAT_ID')) };
