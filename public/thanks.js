initPage();
const q = new URLSearchParams(location.search);
$('#num').textContent = q.get('n') || '';
$('#msg').textContent = q.get('k') === 'paid' ? 'Your payment was received and your order is confirmed.' : 'Your order is placed. Please keep the amount ready for cash on delivery.';
