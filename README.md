# SMM Panel + Digital Store Mini App

Node.js 20 + Express + SQLite (better-sqlite3), vanilla-JS mobile-first SPA (Ocean Blue, light/dark).

## Run
```
npm install
cp .env.example .env     # fill in secrets
npm start                # http://localhost:3000
```
First start creates the admin from ADMIN_USERNAME / ADMIN_PASSWORD. Log in, open Account → Admin panel.
Schema: `schema.sql` (auto-applied on start).

## First-time setup (Admin panel)
1. **settings**: brand, ABA account name/number, KHQR image URL, minimum deposit.
2. **services → Import from supplier**: set SUPPLIER_API_URL / SUPPLIER_API_KEY in env (standard SMM API v2). Only TikTok/Facebook/Telegram services are imported, *disabled*, with your markup; review and enable them.
3. **products**: add products. `auto` = stock codes (one per line, stored AES-256-GCM encrypted) delivered instantly; `manual` = admin delivers from the **digital** tab.

## Payments (ABA KHQR)
Users create a deposit → get a reference and your KHQR/ABA details. Balance is credited only when:
- your KHQR provider calls `POST /api/payments/webhook` with header `x-webhook-secret: $PAYMENT_WEBHOOK_SECRET` and JSON `{ref, amount, tx_id}` (adapt field names to the provider docs, e.g. khmer-system.com), or
- an admin presses **Confirm** in the payments tab after seeing the money arrive.
Confirmation is idempotent and `tx_id` is unique, so a payment can never be credited twice.

## Telegram Mini App
Set BOT_TOKEN, host over HTTPS, and set the bot's Menu Button / Web App URL to your site. `initData` is verified (HMAC + 24h expiry) at `/api/auth/telegram`.

## Deploy (Render only)
The repo root must contain `package.json`, `server.js` and `render.yaml` directly (do not push the parent folder). This app is a long-running Node server with a SQLite file, so it cannot run on Vercel or Netlify (serverless, read-only/ephemeral disk, no background jobs). Use Render (paid plan + disk), Railway or Fly.io (with a volume), or any VPS.

Push to GitHub → New Blueprint (uses `render.yaml`, persistent disk at /var/data). Set the `sync:false` env vars in the dashboard.

## Security notes
Prices and balance checks are server-side inside DB transactions; supplier/payment secrets live only in env; rate limits on API and auth; refunds are automatic for Failed/Cancelled/Partial orders; admin actions are written to the audit log. Back up the SQLite file regularly.

## Branding and editor
Account → Admin panel → **Site editor**: upload your logo, set shop name, tagline, accent colour, announcement banner, support link and KHQR image, with a live preview. Uploaded images are stored in the database (`images` table), so keep the persistent disk. In **Services**, filter by Disabled, tick services and use Enable / Disable to publish imported services in bulk.

## Log in with Telegram (website button)
Admin panel -> **Login** tab. Uses Telegram's OpenID Connect flow (authorization code + PKCE), verified on the server (RS256 id_token, issuer, audience, nonce).
1. @BotFather -> your bot -> **Login Widget**: add the Website URL and the Redirect URL shown in the Login tab as Allowed URLs.
2. Copy the **Client ID** and **Client Secret** from BotFather into the Login tab, switch it on, press Save.
3. Style the button in **Button editor** (text, colour, style, size, radius, icon, full width) with a live preview.
The secret is stored AES-256-GCM encrypted and is never sent back to the browser. BOT_TOKEN is only used for the Telegram Mini App auto-login; never commit it.

## Bot messages
With `BOT_TOKEN` and `ADMIN_CHAT_ID` set, the bot messages the admin when the site starts (every deploy), and on new users, deposits, orders and tickets. Customers who logged in with Telegram also get their order/deposit notifications in the bot chat (they must have pressed Start on the bot once).
