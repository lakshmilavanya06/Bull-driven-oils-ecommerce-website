// Shared helpers for all shop pages
const CART_KEY = 'jsrCart';
const $ = (s, r = document) => r.querySelector(s);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const rupee = n => '₹' + Number(n).toLocaleString('en-IN');
const getCart = () => { try { return JSON.parse(localStorage.getItem(CART_KEY)) || []; } catch { return []; } };
const saveCart = c => { localStorage.setItem(CART_KEY, JSON.stringify(c)); updateCartCount(); };
function updateCartCount() { const el = $('#cart-count'); if (el) el.textContent = getCart().reduce((s, i) => s + i.qty, 0); }
function toast(msg) {
  let t = $('.toast'); if (!t) { t = document.createElement('div'); t.className = 'toast'; document.body.append(t); }
  t.textContent = msg; t.classList.add('show'); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), 2200);
}
async function api(url, opts = {}) {
  const r = await fetch(url, { ...opts, headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) }, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || 'Request failed');
  return data;
}
async function initPage() {
  updateCartCount();
  try {
    const cfg = await api('/api/config');
    if (cfg.announcement || !cfg.storeOpen) {
      const d = document.createElement('div'); d.className = 'announce';
      d.textContent = !cfg.storeOpen ? 'We are not taking orders right now. Please check back soon.' : cfg.announcement;
      document.body.prepend(d);
    }
    return cfg;
  } catch { return {}; }
}
