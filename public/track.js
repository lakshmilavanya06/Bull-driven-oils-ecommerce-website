initPage();
const q = new URLSearchParams(location.search); if (q.get('n')) $('#num').value = q.get('n');
const steps = ['new', 'confirmed', 'packed', 'shipped', 'delivered'];
$('#go').onclick = async () => {
  $('#err').textContent = ''; $('#result').innerHTML = '';
  try {
    const o = await api(`/api/track?number=${encodeURIComponent($('#num').value.trim())}&phone=${encodeURIComponent($('#ph').value.trim())}`);
    const at = steps.indexOf(o.orderStatus);
    $('#result').innerHTML = `<div class="box"><h2>Order ${esc(o.orderNumber)}</h2>
      ${o.orderStatus === 'cancelled' ? '<p class="err">This order was cancelled.</p>' : `<div class="timeline">${steps.map((s, i) => `<div class="${i <= at ? 'on' : ''}">${s[0].toUpperCase() + s.slice(1)}</div>`).join('')}</div>`}
      <p>Payment: <strong>${esc(o.paymentStatus)}</strong> (${o.method === 'cod' ? 'Cash on delivery' : 'Online'})</p>
      ${o.tracking ? `<p>Courier / tracking: <strong>${esc(o.tracking)}</strong></p>` : ''}
      <hr style="margin:.8rem 0;border:0;border-top:1px solid #eee">
      ${o.items.map(i => `<div class="sum-row"><span>${i.qty} × ${esc(i.name)} ${esc(i.size)}</span><span>${rupee(i.price * i.qty)}</span></div>`).join('')}
      ${o.discount ? `<div class="sum-row green"><span>Discount</span><span>−${rupee(o.discount)}</span></div>` : ''}
      <div class="sum-row"><span>Delivery</span><span>${o.shipping ? rupee(o.shipping) : 'FREE'}</span></div>
      <div class="sum-row total"><span>Total</span><span>${rupee(o.total)}</span></div></div>`;
  } catch (e) { $('#err').textContent = e.message; }
};
