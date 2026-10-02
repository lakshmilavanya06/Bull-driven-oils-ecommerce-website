# Jai Shri Ram Bull-Driven Oils: Online Store

A full-stack e-commerce site for a home-based cold-pressed oil business.

**Stack:** Node.js, Express, SQLite (better-sqlite3), vanilla JS front end, Razorpay payments.

## Features
- Product catalogue loaded from the database (no code changes to add products)
- Cart, coupon codes, delivery charge with free-delivery threshold
- **Razorpay** checkout (UPI, cards, netbanking) with server-side signature verification and webhook backup
- Cash on delivery option (can be switched off)
- **Admin panel** (`/admin`): orders, products, prices, stock, coupons, settings
  - Edit any price or upload a new product photo in one click
  - Bulk pricing: run an X% sale (strike-through price and "% OFF" badge), raise or lower all prices, end sale
  - Order workflow (new, confirmed, packed, shipped, delivered), courier tracking note, CSV export
  - Pause orders, banner message ("Diwali sale!"), low-stock alerts
- Policy pages (terms, privacy, refunds, shipping), order alerts by email/Telegram, automatic backups
- Customer order tracking (order number + phone)
- Security: prices calculated only on the server, HMAC payment verification, rate limiting, CSP headers, signed admin session cookie, input validation, XSS escaping
- Integration tests (`npm test`)

## Run locally
```bash
npm install
npm run dev            # http://localhost:3000 (dev mode only)
```
`npm run dev` runs in **dev mode**: fake online payments and admin password `admin123`, so you can try the whole flow.
Any other way of starting the server is treated as **production**: it refuses to start without `ADMIN_PASSWORD` and `SESSION_SECRET`, and online payment stays disabled until Razorpay keys are set. Nothing is faked on a live server.

## Go live checklist
1. **Fill in the policy pages.** Search `public/` for `[ADD` and replace the postal address and FSSAI licence number (food sellers must show it). Read the four policy pages (`terms`, `privacy`, `refund-policy`, `shipping-policy`) and edit anything that doesn't match how the owner really works. Razorpay checks these during account approval.
2. Create a Razorpay account, complete KYC, copy your API keys. Start with `rzp_test_` keys.
3. `cp .env.example .env` and fill it in (long `ADMIN_PASSWORD`, random `SESSION_SECRET`, Razorpay keys).
4. **Order alerts:** add the `SMTP_*` and `OWNER_EMAIL` values (a Gmail app password works) and optionally a Telegram bot. The owner is alerted for every COD order and every paid online order; customers with an email get a confirmation and shipped/delivered/cancelled updates. Admin > Settings shows whether alerts are on.
5. In Razorpay Dashboard > Webhooks add `https://yourdomain.com/api/razorpay/webhook`, events `payment.captured`, `order.paid`, `payment.failed`, with the same secret as `RAZORPAY_WEBHOOK_SECRET`.
6. **Hosting:** the database is a file, so use a host with a **persistent disk** (a small VPS, or Railway/Render with a mounted volume) and point `DATA_DIR` and `UPLOAD_DIR` at it. On free hosts with a temporary disk your orders will disappear on every restart. Serve over HTTPS.
7. **Test with `rzp_test_` keys** using Razorpay's test UPI/card details. Open the browser console (F12). If anything is blocked by the security policy, set `CSP_REPORT_ONLY=1`, retry, and add the domain listed in the console to `server.js` (the `RZP` list). Then remove the flag.
8. Swap to live keys and place one real small order.

## Orders, abandoned payments and backups
- Only real orders (COD, or paid online) appear under Orders. Abandoned online attempts are hidden (tick "Show unpaid online attempts" to see them) and deleted after 7 days.
- The database is backed up automatically on start and every 24 hours to `DATA_DIR/backups` (last 14 kept). That protects against mistakes, not disk loss, so also press **Settings > Download backup now** weekly and keep the file somewhere else (email, Google Drive).

## Structure
```
server.js    routes, payments, admin API      pricing.js  all price/coupon/shipping math
db.js        schema + seed products           test.js     integration tests
public/      storefront pages, admin/ panel
```
