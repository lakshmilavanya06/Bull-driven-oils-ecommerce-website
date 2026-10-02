const $ = (s, r = document) => r.querySelector(s);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const rupee = n => '₹' + Number(n || 0).toLocaleString('en-IN');
async function api(url, opts = {}) {
  const isForm = opts.body instanceof FormData;
  const r = await fetch('/api/admin' + url, { ...opts, headers: isForm ? {} : { 'Content-Type': 'application/json' }, body: opts.body && !isForm ? JSON.stringify(opts.body) : opts.body });
  const d = await r.json().catch(() => ({}));
  if (r.status === 401 && url !== '/login') { showLogin(); throw new Error('Session expired'); }
  if (!r.ok) throw new Error(d.error || 'Failed'); return d;
}
const showLogin = () => { $('#login').classList.remove('hide'); $('#app').classList.add('hide'); };
const say = m => alert(m);
$('#lg').onclick = async () => { try { await api('/login', { method: 'POST', body: { password: $('#pw').value } }); start(); } catch (e) { $('#lerr').textContent = e.message; } };
$('#pw').onkeydown = e => e.key === 'Enter' && $('#lg').click();
$('#out').onclick = async () => { await api('/logout', { method: 'POST' }); showLogin(); };
$('#tabs').onclick = e => { const b = e.target.closest('button'); if (!b) return; document.querySelectorAll('#tabs button').forEach(x => x.classList.toggle('on', x === b)); views[b.dataset.t](); };
async function start() { try { await api('/summary'); $('#login').classList.add('hide'); $('#app').classList.remove('hide'); views.dash(); } catch { showLogin(); } }

const views = {
  async dash() {
    const s = await api('/summary');
    $('#view').innerHTML = `<div class="grid"><div class="card">Orders today<div class="stat">${s.todayOrders}</div></div><div class="card">Orders to process<div class="stat">${s.newOrders}</div></div><div class="card">Paid revenue (30 days)<div class="stat">${rupee(s.revenue30)}</div></div></div>
      ${s.abandoned ? `<div class="card"><small>${s.abandoned} unpaid online attempt(s) are hidden from Orders (deleted automatically after 7 days).</small></div>` : ''}<div class="card"><h3>Low stock</h3>${s.lowStock.length ? s.lowStock.map(p => `<div>${esc(p.name)} ${esc(p.size)}: <strong>${p.stock}</strong> left</div>`).join('') : 'All products well stocked.'}</div>`;
  },
  async orders(status = '', q = '', unpaid = '') {
    const list = await api(`/orders?status=${status}&q=${encodeURIComponent(q)}&unpaid=${unpaid}`);
    const opt = (arr, cur) => arr.map(x => `<option ${x === cur ? 'selected' : ''}>${x}</option>`).join('');
    $('#view').innerHTML = `<div class="row"><select id="fs"><option value="">All statuses</option>${opt(['new', 'confirmed', 'packed', 'shipped', 'delivered', 'cancelled'], status)}</select>
      <input id="fq" placeholder="Search name / phone / order no." value="${esc(q)}"><label><input type="checkbox" id="fu" ${unpaid ? 'checked' : ''} style="width:auto"> Show unpaid online attempts</label><button class="b" id="fgo">Search</button><a href="/api/admin/orders.csv"><button class="b g">Download CSV</button></a></div>
      <div class="card scroll"><table><tr><th>Order</th><th>Customer</th><th>Items</th><th>Total</th><th>Payment</th><th>Status &amp; tracking</th><th></th></tr>
      ${list.map(o => `<tr data-id="${o.id}"><td><strong>${esc(o.order_number)}</strong><br><small>${esc(o.created_at)} UTC</small></td>
      <td>${esc(o.name)}<br><a href="tel:${esc(o.phone)}">${esc(o.phone)}</a> · <a target="_blank" rel="noopener" href="https://wa.me/91${esc(o.phone.slice(-10))}">WhatsApp</a><br><small>${esc(o.address)}, ${esc(o.city)}, ${esc(o.state)} ${esc(o.pincode)}</small>${o.notes ? `<br><em>${esc(o.notes)}</em>` : ''}</td>
      <td>${o.items.map(i => `${i.qty}× ${esc(i.name)} ${esc(i.size)}`).join('<br>')}${o.coupon ? `<br><small>Coupon ${esc(o.coupon)}</small>` : ''}</td>
      <td>${rupee(o.total)}<br><small>${o.method === 'cod' ? 'COD' : 'Online'}</small></td>
      <td><select class="ps">${opt(['pending', 'paid', 'failed', 'refunded'], o.payment_status)}</select></td>
      <td><select class="os">${opt(['new', 'confirmed', 'packed', 'shipped', 'delivered', 'cancelled'], o.order_status)}</select><br><input class="tr" style="width:160px;margin-top:4px" placeholder="Courier / tracking no." value="${esc(o.tracking)}"></td>
      <td><button class="b sv">Save</button></td></tr>`).join('') || '<tr><td colspan="7">No orders yet.</td></tr>'}</table></div>`;
    $('#fgo').onclick = () => views.orders($('#fs').value, $('#fq').value, $('#fu').checked ? '1' : '');
    $('#view').onclick = async e => { const b = e.target.closest('.sv'); if (!b) return; const tr = b.closest('tr');
      try { await api('/orders/' + tr.dataset.id, { method: 'PUT', body: { payment_status: $('.ps', tr).value, order_status: $('.os', tr).value, tracking: $('.tr', tr).value } }); b.textContent = 'Saved ✓'; setTimeout(() => b.textContent = 'Save', 1200); } catch (e) { say(e.message); } };
  },
  async products() {
    const list = await api('/products');
    $('#view').innerHTML = `<div class="card"><h3>Change prices in bulk</h3><div class="row">
      <input id="bp" type="number" min="1" max="89" placeholder="%" style="width:80px">
      <button class="b" data-b="discount">Run sale: X% off all</button><button class="b" data-b="up">Raise all prices by X%</button><button class="b g" data-b="down">Lower all by X%</button><button class="b r" data-b="end-sale">End sale (restore prices)</button></div>
      <small>Sale shows the old price crossed out with a "% OFF" badge. Bulk changes apply to every product; edit single prices in the table below.</small></div>
      <div class="card scroll"><table><tr><th></th><th>Name</th><th>Size</th><th>Price ₹</th><th>MRP ₹ (optional)</th><th>Stock</th><th>Visible</th><th>Photo</th><th></th></tr>
      ${list.map(p => `<tr data-id="${p.id}"><td><img class="t" src="${esc(p.image)}" alt=""></td><td><input class="n" style="width:150px" value="${esc(p.name)}"></td><td><input class="z" style="width:70px" value="${esc(p.size)}"></td>
      <td><input class="pr" type="number" min="0" value="${p.price}"></td><td><input class="mp" type="number" min="0" value="${p.mrp ?? ''}"></td><td><input class="st" type="number" min="0" value="${p.stock}"></td>
      <td><input class="ac" type="checkbox" ${p.active ? 'checked' : ''} style="width:auto"></td><td><input class="im" type="file" accept="image/*" style="width:110px"></td><td><button class="b sv">Save</button></td></tr>`).join('')}</table></div>
      <div class="card"><h3>Add a new product</h3><div class="row"><input id="an" placeholder="Name (e.g. Neem Oil)"><input id="az" placeholder="Size (1 L)" style="width:90px"><input id="ap" type="number" placeholder="Price ₹" style="width:100px"><input id="as" type="number" placeholder="Stock" style="width:90px" value="50"><input id="ai" type="file" accept="image/*"></div>
      <div class="row"><input id="ad" placeholder="Short description" style="width:100%"></div><button class="b" id="add">Add product</button></div>`;
    $('#view').onclick = async e => {
      const bb = e.target.closest('[data-b]');
      if (bb) { const pct = +$('#bp').value, a = bb.dataset.b; if (a !== 'end-sale' && !(pct > 0)) return say('Enter a percentage first');
        if (!confirm('Apply to ALL products?')) return;
        try { await api('/products/bulk-price', { method: 'POST', body: a === 'up' || a === 'down' ? { action: 'adjust', direction: a, percent: pct } : { action: a, percent: pct } }); views.products(); } catch (er) { say(er.message); } return; }
      const b = e.target.closest('.sv'); if (!b) return; const tr = b.closest('tr'), f = new FormData();
      f.set('name', $('.n', tr).value); f.set('size', $('.z', tr).value); f.set('price', $('.pr', tr).value); f.set('mrp', $('.mp', tr).value); f.set('stock', $('.st', tr).value); f.set('active', $('.ac', tr).checked ? '1' : '0');
      if ($('.im', tr).files[0]) f.set('image', $('.im', tr).files[0]);
      try { await api('/products/' + tr.dataset.id, { method: 'PUT', body: f }); b.textContent = 'Saved ✓'; setTimeout(() => views.products(), 600); } catch (er) { say(er.message); } };
    $('#add').onclick = async () => { const f = new FormData(); f.set('name', $('#an').value); f.set('size', $('#az').value); f.set('price', $('#ap').value); f.set('stock', $('#as').value); f.set('description', $('#ad').value);
      if ($('#ai').files[0]) f.set('image', $('#ai').files[0]); try { await api('/products', { method: 'POST', body: f }); views.products(); } catch (er) { say(er.message); } };
  },
  async coupons() {
    const list = await api('/coupons');
    $('#view').innerHTML = `<div class="card"><h3>Create coupon</h3><div class="row"><input id="cc" placeholder="CODE (e.g. DIWALI10)"><select id="ct"><option value="percent">% off</option><option value="flat">₹ off</option></select><input id="cv" type="number" placeholder="Value" style="width:90px">
      <input id="cm" type="number" placeholder="Min order ₹" style="width:110px"><input id="cu" type="number" placeholder="Max uses (0=∞)" style="width:130px"><input id="ce" type="date" title="Expiry date"><button class="b" id="cadd">Save coupon</button></div></div>
      <div class="card scroll"><table><tr><th>Code</th><th>Discount</th><th>Min order</th><th>Used</th><th>Expires</th><th>Active</th><th></th></tr>
      ${list.map(c => `<tr data-c="${esc(c.code)}"><td><strong>${esc(c.code)}</strong></td><td>${c.type === 'percent' ? c.value + '%' : rupee(c.value)}</td><td>${rupee(c.min_order)}</td><td>${c.uses}${c.max_uses ? '/' + c.max_uses : ''}</td><td>${esc(c.expires_at || '-')}</td>
      <td><input type="checkbox" class="ca" ${c.active ? 'checked' : ''} style="width:auto"></td><td><button class="b r cd">Delete</button></td></tr>`).join('') || '<tr><td colspan="7">No coupons yet.</td></tr>'}</table></div>`;
    $('#cadd').onclick = async () => { try { await api('/coupons', { method: 'POST', body: { code: $('#cc').value, type: $('#ct').value, value: $('#cv').value, min_order: $('#cm').value, max_uses: $('#cu').value, expires_at: $('#ce').value } }); views.coupons(); } catch (e) { say(e.message); } };
    $('#view').onclick = async e => { const tr = e.target.closest('tr[data-c]'); if (!tr) return;
      if (e.target.classList.contains('cd') && confirm('Delete coupon?')) { await api('/coupons/' + tr.dataset.c, { method: 'DELETE' }); views.coupons(); }
      if (e.target.classList.contains('ca')) await api('/coupons/' + tr.dataset.c, { method: 'PUT', body: { active: e.target.checked } }); };
  },
  async settings() {
    const s = await api('/settings');
    $('#view').innerHTML = `<div class="card"><h3>Store settings</h3>
      <p>Order alerts: email <strong>${s.mail ? 'on ✓' : 'OFF (add SMTP_* in .env)'}</strong>, Telegram <strong>${s.telegram ? 'on ✓' : 'off (optional)'}</strong></p>
      <p>Database: <code>${esc(s.dbPath)}</code> · last automatic backup: <strong>${esc(s.lastBackup || 'none yet')}</strong> · <a href="/api/admin/backup"><button class="b g" type="button">Download backup now</button></a></p>
      <p>Online payments: <strong>${s.online ? 'Razorpay connected ✓' : s.mock ? 'TEST MODE (fake payments, add Razorpay keys in .env)' : 'Not configured'}</strong></p>
      <div class="row"><label>Delivery charge ₹ <input id="sf" type="number" value="${esc(s.shipping_fee)}" style="width:90px"></label><label>Free delivery above ₹ (0 = never) <input id="sa" type="number" value="${esc(s.free_shipping_above)}" style="width:110px"></label></div>
      <div class="row"><label><input type="checkbox" id="sc" ${s.cod_enabled === '1' ? 'checked' : ''}> Allow cash on delivery</label><label><input type="checkbox" id="so" ${s.store_open === '1' ? 'checked' : ''}> Store open (untick to pause orders)</label></div>
      <div class="row"><label>Banner message on every page <input id="sn" style="width:420px;max-width:100%" placeholder="e.g. Diwali sale: 10% off on all oils" value="${esc(s.announcement)}"></label></div>
      <button class="b" id="ssv">Save settings</button></div>`;
    $('#ssv').onclick = async () => { await api('/settings', { method: 'PUT', body: { shipping_fee: $('#sf').value, free_shipping_above: $('#sa').value, cod_enabled: $('#sc').checked ? '1' : '0', store_open: $('#so').checked ? '1' : '0', announcement: $('#sn').value } }); say('Saved'); };
  },
};
start();
