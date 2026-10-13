# PlayLive points via Lemon Squeezy — setup and acceptance (11 October 2026)

> **13 October 2026 update:** all five packs are sold once their variant IDs are set (find them with
> `node --env-file=.env.local scripts/verify-lemonsqueezy-config.mjs --discover`). Verified payments are stored
> before crediting (migration `202610130007_points_payment_queue.sql`) and retried automatically; see
> `points-admin payments` / `retry-payments`. Staging steps: `E:\PlayLive-Workspace\LEMONSQUEEZY_COMPLETION_HANDOFF_2026-10-13.md`.

PlayLive's side is implemented and tested locally. **No Lemon Squeezy account,
real purchase, deployment, live migration or live sale was made.** Sales stay off
until the settings below are supplied and the test-mode purchase passes.
The itch.io integration is preserved and stays the default when
`POINTS_PAYMENT_PROVIDER` is not `lemonsqueezy`.

## How it works

1. Launcher **+** → pack popup → **Buy**. The launcher sends only `{"packId":"starter"}`
   to `POST /api/v1/me/points/orders` with its existing sign-in token.
2. The server takes the account from the verified launcher session, looks up the
   pack's points/price in `lib/points-catalog.mjs` and its variant ID in settings,
   stores an immutable order, and asks Lemon Squeezy (`POST /v1/checkouts`) for a
   checkout with discount codes off, only that variant enabled, a one-hour expiry and
   signed custom data (`playlive_order`, `playlive_account`, `playlive_env`, `playlive_sig`).
3. The launcher opens the returned Lemon Squeezy URL with its existing browser
   helper and polls `GET /api/v1/me/points/orders?order=…` for up to two minutes,
   and again whenever the launcher regains focus.
4. Lemon Squeezy sends `order_created` to the webhook. The server verifies
   `X-Signature` (HMAC-SHA256 hex) over the **raw body**, then checks: paid status,
   store, variant, one unit, no discount, price (USD), test/live environment, and the
   signed order/account reference. Only then does it credit **through the existing
   ledger** (`apply_point_transaction`). The launcher sees `credited` and refreshes the balance.

The return page (`/launcher/points/complete`), a closed checkout window and the
launcher never credit anything. A later webhook still delivers if the buyer closed
everything. Duplicate or concurrent webhooks credit once: the provider order ID is
a primary key and the ledger's idempotency key/source are unique, both under an
advisory lock. Another account's order returns 404.

## Settings we must supply later (server-only; never in Unity)

| Setting | Where to find it |
|---|---|
| `POINTS_PAYMENT_PROVIDER=lemonsqueezy` | Selects Lemon Squeezy for `/api/points/packs`. |
| `LEMONSQUEEZY_MODE=test` | `live` only on production. |
| `LEMONSQUEEZY_STORE_ID` | Dashboard → Settings → Stores: the numeric ID next to the store. |
| `LEMONSQUEEZY_API_KEY` | Dashboard → Settings → API, created **while Test mode is on**. |
| `LEMONSQUEEZY_WEBHOOK_SECRET` | The signing secret you type when creating the webhook (16–40 random characters). |
| `LEMONSQUEEZY_VARIANT_IDS_JSON` | `{"starter":"<numeric variant ID>"}` — the variant of the Starter product. |
| `POINTS_ORDER_REFERENCE_SECRET` | Generate: `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"` |
| `POINTS_SITE_ORIGIN` | Exact staging origin, e.g. `https://live-in-git-staging-tdevs-projects-3014b9cb.vercel.app` |
| `LEMONSQUEEZY_PRODUCTS_VERIFIED=true` | Only after the verification script below reports `"ok": true`. |
| `POINTS_ENABLED=true`, `POINTS_MUTATIONS_ENABLED=true`, `POINTS_DEPLOYMENT_ENVIRONMENT=staging` | Existing wallet switches. **Crediting is a wallet mutation.** |

Templates with comments: `.env.points.example` (staging) and
`.env.points.production.example` (production, live mode).

**Product to create in Lemon Squeezy (Test mode):** one product “PlayLive Points —
Starter (5,000 points)”, single variant, **one-time payment of $5.00 USD** (the
price already in `lib/points-catalog.mjs`), not pay-what-you-want, not a
subscription, no license keys or files needed. Store currency: **USD**.
Other packs (10,000/$10 … 120,000/$100) are in the catalog but stay unsold until
their variant IDs are added.

## Webhook to configure

- **URL:** `https://<staging origin>/api/points/lemonsqueezy/webhook`
  (staging today: `https://live-in-git-staging-tdevs-projects-3014b9cb.vercel.app/api/points/lemonsqueezy/webhook`)
- **Events:** `order_created` and `order_refunded` (nothing else is needed).
- **Signing secret:** the same value as `LEMONSQUEEZY_WEBHOOK_SECRET`.
- Create it with the dashboard in **Test mode**. Test-mode API keys only see test data, so going live needs a
  live API key, live variant IDs (Lemon Squeezy's “Copy to Live Mode”) and a confirmed live webhook.
- The deployment must accept unauthenticated POSTs on that path (no Vercel
  deployment protection on it). `proxy.js` already skips session handling there.

Responses: `200` = processed (credited, duplicate, ignored or recorded as not
creditable); `401` = bad signature; `503` = temporarily unavailable, so Lemon
Squeezy retries (it retries 3 times: about 5 s, 25 s, 125 s). After that, use the
dashboard's webhook log to resend.

## Staging installation (in order)

1. Run `supabase/points-lemonsqueezy-preflight.sql` (read-only) on **staging**.
2. Apply `supabase/migrations/202610110004_points_lemonsqueezy_orders.sql`. It is
   additive; it changes no existing wallet, ledger or itch.io row.
3. On the **staging** database only:
   `update public.point_payment_settings set accept_test_payments = true where id = 1;`
   Leave it `false` on any production database: the database itself then refuses
   every test-mode and mock credit, even if the app is misconfigured.
4. Set the settings above, deploy staging, then on a private machine with the same
   settings run `node --env-file=.env.local scripts/verify-lemonsqueezy-config.mjs`.
   It makes GET requests only and checks store, currency, variant, test mode and the $5.00 price.
5. Set `LEMONSQUEEZY_PRODUCTS_VERIFIED=true` and redeploy. `GET /api/points/packs`
   should list Starter with `"checkoutProvider":"lemonsqueezy"`.
6. Unity: in `SampleScene`, enable **Enable Staging Points Checkout** on the
   `PlayLiveLauncherManagerV7` component. It is still `false`, so the popup shows
   “Purchases will be available soon.” until this is switched on.

Until all of this is done the API answers `503 {"error":"PAYMENTS_NOT_CONFIGURED",
"message":"Payments are not configured yet."}`, and the launcher popup shows that message.

## Shortest real test-mode purchase (after account setup)

1. Complete the staging installation above (test mode, Starter variant only).
2. In the launcher (Unity Play Mode on staging), sign in with a real staging account and note the balance.
3. Click **+** → Starter → **Buy $5.00**. The Lemon Squeezy test checkout opens.
4. Pay with Lemon Squeezy's test card `4242 4242 4242 4242`, any future expiry, any CVC.
   (Optional unpaid check: card `4000 0000 0000 0069` is declined and must add nothing.)
5. Within about a minute the launcher shows “Points added: 5,000” and the balance is +5,000.
6. Check: in the Lemon Squeezy dashboard webhook log the `order_created` delivery returned 200;
   pressing **Resend** returns `"duplicate":true` and the balance does not change.
7. Buy Starter once more: a new order ID gives exactly one more +5,000.
8. Refund one order in the dashboard: `order_refunded` is recorded (see Refunds); the balance does not change by itself.

## Development mock (no account) — not a Lemon Squeezy test

`LEMONSQUEEZY_MODE=mock` and `POINTS_MOCK_PAYMENTS_ENABLED=true` on a **local or
staging** deployment (plus `POINTS_ORDER_REFERENCE_SECRET`, `POINTS_SITE_ORIGIN`
and the wallet switches). The launcher then opens the website's
`/launcher/points/mock-checkout` page (clearly labelled MOCK) with **Pay (mock)**,
**Simulate failed payment** and **Cancel**. “Pay” builds a Lemon Squeezy-shaped
paid order, signs it with a mock-only key and sends it through the same webhook
code and the same ledger function. Credits are labelled “Mock points purchase (test only)”.

The mock is refused (404) when `POINTS_DEPLOYMENT_ENVIRONMENT` is not
`local`/`staging`, when `VERCEL_ENV=production`, when `POINTS_PRODUCTION_ACCEPTED=true`,
or when the switch is off; a real-mode webhook rejects mock signatures; and a
database without `accept_test_payments` refuses the credit. A mock pass proves
our code path only. It does not prove Lemon Squeezy's checkout, payload or delivery.

Local proof without any database or account: `npm run test:lemonsqueezy-smoke`.

## Refunds — decision needed

Existing wallet policy (unchanged): refunds are **operator-managed** with a ledger
reversal; there is no automatic reversal and a reversal that would make a balance
negative is refused. Accordingly, a verified `order_refunded` is recorded against
the credited order (`point_provider_refunds`) and the launcher status gains
`refundReported`, but points are not removed automatically. A refund that arrives
before the paid notification blocks that order from ever being credited.

Operator procedure: `node --env-file=.env.local scripts/points-admin.mjs refunds`
lists refunded orders whose credit is not reversed; then
`scripts/points-admin.mjs reverse <transactionId> <requestId> "Refunded purchase"`.

**Unresolved (owner decision):** automatic vs manual reversal; partial refunds;
what to do when the buyer already spent the points (negative balance is impossible
today); chargebacks/`fraudulent` orders.

## Not verified yet

- Any real Lemon Squeezy behaviour: checkout creation, payload shape, test-mode
  flags, delivery timing, retries. Our parser follows the official docs; the
  payloads in tests are synthetic.
- Whether `order_created` can arrive with status `pending` for some payment
  methods. Such an order is recorded as not paid and **not** credited; Lemon
  Squeezy has no later “order paid” event, so it would need operator review.
- Non-USD buyers: Lemon Squeezy may charge in another currency. Those orders are
  credited by variant (fixed $5 price, quantity 1, no discount); the exact USD price
  check applies only to USD orders.
- Concurrency on real PostgreSQL connections (local tests use one PGlite backend).
- The deployed staging site: these routes and the migration are not deployed there.
- A Unity Windows player build and an interactive Play Mode run.
- The website's own `/launcher/points` shop page still uses the itch.io flow; the
  Lemon Squeezy flow is launcher-first. Wiring the web shop to `/api/v1/me/points/orders`
  needs a browser-session variant of that route (not built).
