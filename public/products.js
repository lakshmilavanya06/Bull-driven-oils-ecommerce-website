(async () => {
  await initPage();
  const grid = $('#grid');
  try {
    const list = await api('/api/products');
    if (!list.length) { grid.innerHTML = '<p class="center">Products coming soon.</p>'; return; }
    grid.innerHTML = list.map(p => {
      const off = p.mrp && p.mrp > p.price ? Math.round((1 - p.price / p.mrp) * 100) : 0;
      return `<div class="product-card">${off ? `<span class="badge">${off}% OFF</span>` : ''}
        <img src="${esc(p.image)}" alt="${esc(p.name)}" loading="lazy">
        <h3>${esc(p.name)}</h3><div class="size">${esc(p.size)}</div>
        <p class="desc">${esc(p.description)}</p>
        <div class="price">${rupee(p.price)}${off ? `<s>${rupee(p.mrp)}</s>` : ''}</div>
        ${p.stock > 0 && p.stock <= 5 ? `<div class="low">Only ${p.stock} left</div>` : ''}
        <button data-id="${p.id}" ${p.stock < 1 ? 'disabled' : ''}>${p.stock < 1 ? 'Out of stock' : 'Add to Cart'}</button></div>`;
    }).join('');
    const stock = Object.fromEntries(list.map(p => [p.id, p]));
    grid.addEventListener('click', e => {
      const b = e.target.closest('button[data-id]'); if (!b) return;
      const id = +b.dataset.id, cart = getCart(), row = cart.find(i => i.id === id);
      if (row && row.qty >= stock[id].stock) return toast('No more stock available');
      row ? row.qty++ : cart.push({ id, qty: 1 });
      saveCart(cart); toast(stock[id].name + ' added to cart');
    });
  } catch { grid.innerHTML = '<p class="center">Could not load products. Please refresh.</p>'; }
})();
