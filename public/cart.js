(async () => {
  const cfg = await initPage();
  const S = { products: {}, coupon: '', quote: null };
  const showErr = m => $('#err').textContent = m || '';

  const list = await api('/api/products').catch(() => []);
  list.forEach(p => S.products[p.id] = p);
  // drop items that no longer exist
  saveCart(getCart().filter(i => S.products[i.id]));

  // payment options
  const opts = [];
  if (cfg.online || cfg.mock) opts.push(['razorpay', 'Pay online', 'UPI, cards, net banking, wallets' + (cfg.mock && !cfg.online ? ' (TEST MODE: no real payment)' : '')]);
  if (cfg.codEnabled) opts.push(['cod', 'Cash on delivery', 'Pay when the order arrives']);
  $('#payopts').innerHTML = opts.length ? opts.map((o, i) => `<label class="pay-opt"><input type="radio" name="pm" value="${o[0]}" ${i ? '' : 'checked'}><span><strong>${o[1]}</strong><br><small>${o[2]}</small></span></label>`).join('')
    : '<p>Payments are not available right now. Please contact us on WhatsApp.</p>';

  async function render() {
    const cart = getCart(), box = $('#lines');
    $('#empty').style.display = cart.length ? 'none' : 'block';
    $('#place').disabled = !cart.length || !opts.length || cfg.storeOpen === false;
    box.innerHTML = cart.map(i => { const p = S.products[i.id]; return `<div class="line"><div class="grow"><strong>${esc(p.name)}</strong> <small>${esc(p.size)}</small><br>${rupee(p.price)}</div>
      <div class="qty"><button data-a="dec" data-id="${i.id}">−</button><span>${i.qty}</span><button data-a="inc" data-id="${i.id}">+</button></div>
      <strong>${rupee(p.price * i.qty)}</strong><button class="rm" data-a="rm" data-id="${i.id}" aria-label="Remove">×</button></div>`; }).join('');
    if (!cart.length) { $('#summary').innerHTML = ''; return; }
    try {
      S.quote = await api('/api/quote', { method: 'POST', body: { items: cart, coupon: S.coupon } });
      const q = S.quote;
      $('#summary').innerHTML = `<div class="sum-row"><span>Subtotal</span><span>${rupee(q.subtotal)}</span></div>
        ${q.discount ? `<div class="sum-row green"><span>Coupon (${esc(q.coupon)})</span><span>−${rupee(q.discount)}</span></div>` : ''}
        <div class="sum-row"><span>Delivery</span><span>${q.shipping ? rupee(q.shipping) : 'FREE'}</span></div>
        <div class="sum-row total"><span>Total</span><span>${rupee(q.total)}</span></div>
        ${q.shipping && cfg.freeShippingAbove ? `<small>Free delivery above ${rupee(cfg.freeShippingAbove)}</small>` : ''}`;
      showErr('');
    } catch (e) { showErr(e.message); $('#summary').innerHTML = ''; $('#place').disabled = true; }
  }

  $('#lines').addEventListener('click', e => {
    const b = e.target.closest('button[data-a]'); if (!b) return;
    const id = +b.dataset.id; let cart = getCart(); const row = cart.find(i => i.id === id);
    if (b.dataset.a === 'inc') row.qty = Math.min(row.qty + 1, 100);
    if (b.dataset.a === 'dec') row.qty--;
    if (b.dataset.a === 'rm' || row.qty < 1) cart = cart.filter(i => i.id !== id);
    saveCart(cart); render();
  });
  $('#apply').onclick = async () => {
    S.coupon = $('#coupon').value.trim(); const m = $('#cmsg');
    await render();
    m.textContent = S.coupon ? (S.quote && S.quote.coupon ? 'Coupon applied ✓' : '') : ''; m.className = 'green';
    if (S.coupon && !(S.quote && S.quote.coupon)) { m.textContent = ''; S.coupon = ''; }
  };

  $('#place').onclick = async () => {
    showErr(''); const btn = $('#place'); btn.disabled = true; btn.textContent = 'Please wait…';
    const v = id => $('#' + id).value.trim();
    const method = (document.querySelector('input[name=pm]:checked') || {}).value;
    try {
      const res = await api('/api/orders', { method: 'POST', body: { items: getCart(), coupon: S.coupon, method,
        customer: { name: v('name'), phone: v('phone'), email: v('email'), address: v('address'), city: v('city'), state: v('state'), pincode: v('pincode'), notes: v('notes') } } });
      if (res.method === 'cod') return done(res.orderNumber, 'cod');
      const r = res.razorpay;
      if (r.mock) { await api('/api/orders/mock-pay', { method: 'POST', body: { razorpay_order_id: r.orderId } }); return done(res.orderNumber, 'paid'); }
      const rz = new Razorpay({
        key: r.keyId, amount: r.amount, currency: 'INR', order_id: r.orderId, name: 'Jai Shri Ram Bull-Driven Oils', description: 'Order ' + res.orderNumber,
        prefill: res.prefill, theme: { color: '#8B0000' },
        handler: async resp => { try { await api('/api/orders/verify', { method: 'POST', body: resp }); done(res.orderNumber, 'paid'); } catch (e) { showErr(e.message + ' If money was deducted, contact us with order ' + res.orderNumber); reset(); } },
        modal: { ondismiss: () => { showErr('Payment not completed. Your order ' + res.orderNumber + ' is saved. You can try placing the order again.'); reset(); } },
      });
      rz.on('payment.failed', () => showErr('Payment failed. Please try again.'));
      rz.open();
    } catch (e) { showErr(e.message); reset(); }
  };
  const reset = () => { const b = $('#place'); b.disabled = false; b.textContent = 'Place order'; };
  function done(n, kind) { saveCart([]); location.href = `thanks.html?n=${encodeURIComponent(n)}&k=${kind}`; }
  render();
})();
