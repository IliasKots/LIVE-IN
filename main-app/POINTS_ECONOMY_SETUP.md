# PlayLive Points economy — gift billing, in-game products, refunds (13 October 2026)

Built and tested **locally only**. Nothing was deployed, no remote database was touched,
no real or sandbox payment was made. Every new behaviour is off until switched on.

Related: [POINTS_LEMONSQUEEZY_SETUP.md](POINTS_LEMONSQUEEZY_SETUP.md) (pack purchases),
launcher/game contract `PLAYLIVE_GAME_BILLING_BRIDGE.md` (launcher project root),
draft customer terms [POINTS_TERMS_REFUND_DRAFT.md](POINTS_TERMS_REFUND_DRAFT.md) (legal review; not published).

## 1. What exists

| Part | Server | Launcher (Unity) | Switch (all off) |
|---|---|---|---|
| A. TikTok gift usage billing | Sessions, batched charges, versioned rate, replay-safe dedupe | Mailbox to the game, session lifecycle, Go LIVE readout | `POINTS_USAGE_BILLING_ENABLED` + DB settings + per-game + per-gift verification; Unity **Enable Staging Usage Billing** |
| B. In-game Point products | Server price table, one charge per request ID, entitlements | Game purchase requests via the mailbox | `POINTS_PRODUCTS_ENABLED` (no products seeded) |
| C. Purchase lots | Every credit is a lot; every debit allocated (promotional first, then paid FIFO) | — | Always on once migrated (bookkeeping only) |
| C. Refund requests | Per-purchase evaluation, never moves money | — (API only) | `POINTS_REFUND_REQUESTS_ENABLED` |
| C. Provider refund/dispute settlement | Lemon Squeezy refunds; Stripe refunds and disputes | — | `POINTS_REFUND_AUTOMATION_ENABLED` (off = record + flag only, as before) |
| Stripe adapter | Checkout Session + signed webhook, **sandbox only** | Opens `checkout.stripe.com` | `POINTS_PAYMENT_PROVIDER=stripe` + Stripe settings |

The ledger (`apply_point_transaction`) stays the only way a balance changes.

## 2. TikTok Diamond measurement — unresolved, blocks real billing

Finding from the games' code (Disco, TikTokLiveSharp 1.2.2 `dev.vanhoof.tiktokliveunity`):

- Gift events come from an **unofficial, reverse-engineered** TikTok LIVE client running on the
  **streamer's own PC**. They are not signed by TikTok and the server cannot verify them.
- The only value field is `Gift.DiamondCost` (protobuf `diamond_count`). It is the gift's catalogue
  value. Nothing in the library or in TikTok documentation available to us establishes that it equals
  the **creator Diamonds** a gift yields, so it is **not** used. Disco also replaces unknown values
  with a fallback of 1, which must never reach billing.
- `GiftMessage.Amount` (protobuf `combo_count`) is used as the cumulative streak count, and
  `GroupId` as the streak identity. That is how the library itself tracks streaks
  (`TikTokGift.UpdateGiftAmount`), but it has **not** been checked against a real LIVE.

So the server prices a gift **only** from `point_gift_values`, a table an operator fills with a
per-gift Diamond quantity **and the evidence for it**. It ships empty. Until a reliable source for
creator Diamonds per gift exists and is entered, every gift is answered `gift_value_unverified`:
no charge, and no billable effect in a billing-enabled game.

**Trust model.** The charged party (the streamer) controls the event source. A third party cannot
create charges (charges need the streamer's launcher session). The streamer could under-report by
modifying the client; the mitigation is that billable effects run only after a successful charge.
This is a software usage fee measured from client-observed TikTok activity, not a verified TikTok
transaction. Do not describe it to customers as "verified by TikTok".

## 3. Database changes

Apply **in order**, to staging only, after running the read-only
`supabase/points-economy-preflight.sql` and saving its output:

1. `supabase/migrations/202610130005_points_lots_refunds.sql`
   - Ledger type `revocation` (removes the unused rest of ONE purchase). `apply_point_transaction`
     is re-created with that type added; its rules are otherwise identical.
   - `point_lots`, `point_lot_allocations` + trigger on every ledger insert; existing history is
     backfilled. **The migration aborts if any balance ≠ the sum of its lots.**
   - Behaviour change: a reversal of a purchase whose Points were partly used is now refused with
     `POINT_LOT_CONSUMED` instead of silently taking Points from other purchases.
   - Stripe: widened provider/ID constraints on the existing order tables,
     `point_stripe_payment_intents`, and a database guard `STRIPE_LIVE_DISABLED`.
   - `point_review_flags`, `point_refund_settlements`, `point_refund_requests` and their functions.
2. `supabase/migrations/202610130006_points_usage_products.sql`
   - `point_billing_settings` (off), `point_billing_rates` (v1: 1 Diamond = 1 Point, immutable),
     `point_billable_games`, `point_gift_values` (empty), `point_usage_sessions`,
     `point_usage_events` (immutable), `point_products` (empty), `point_product_purchases`
     (immutable), `point_entitlements`.

All tables have RLS on with no customer grants; all functions are service-role only.
Never run Prisma for these. Do not apply to production.

### Operator configuration (SQL, staging only, after review)

```sql
-- A game becomes billable (rate version 1). Billing still needs the next two steps.
insert into public.point_billable_games(game_id, rate_version, billing_enabled) values ('disco-tiktok-live', 1, true);
-- Only once the Diamond quantity source is verified and documented:
update public.point_billing_settings set usage_billing_enabled = true,
  verified_quantity_sources = '{tiktok_creator_diamonds}' where id = 1;
-- One row per gift, with the evidence. No row = the gift is never charged.
insert into public.point_gift_values(quantity_source, gift_id, units_per_gift, evidence, verified_by)
values ('tiktok_creator_diamonds', <gift id>, <verified Diamonds per gift>, '<where this number comes from>', '<operator uuid>');
-- A new price is a new rate version; old charges keep theirs.
-- Products (no prices are seeded; the owner decides them):
insert into public.point_products(product_id, game_id, product_type, name, price_points, purchase_mode,
  duration_seconds, units_per_purchase, fulfillment, active)
values ('disco.neon-overlay', 'disco-tiktok-live', 'overlay', 'Neon overlay', <price>, 'one_time', null, 1, 'overlay:neon', true);
```

## 4. Endpoints (launcher bearer token; account from the session only)

| Method | Path | Body / query | Notes |
|---|---|---|---|
| POST | `/api/v1/me/points/usage/sessions` | `{requestId, gameId, liveId}` | Idempotent start; `{billingEnabled:false, reason}` when not billable |
| GET | `/api/v1/me/points/usage/sessions?session=` | | Session summary |
| POST | `/api/v1/me/points/usage/sessions/state` | `{sessionId, action: heartbeat\|pause\|resume\|stop}` | Silent sessions expire after 90 s |
| POST | `/api/v1/me/points/usage/charges` | `{sessionId, events:[{eventKey, giftId, cumulativeCount, occurredAt?}]}` (1–50) | Per-event outcome; no client amount accepted |
| GET | `/api/v1/me/points/products?gameId=` | | Active products and server prices |
| POST | `/api/v1/me/points/products/purchases` | `{productId, requestId}` | Reuse `requestId` for retries |
| GET | `/api/v1/me/points/entitlements?gameId=` | | |
| GET | `/api/v1/me/points/lots` | | Purchased packages with used/remaining Points |
| POST | `/api/v1/me/points/refund-requests` | `{transactionId}` | Evaluation only |
| POST | `/api/points/stripe/webhook` | Stripe event | Sandbox only; signature over raw body |

Charge outcomes: `charged`, `duplicate`, `superseded`, `insufficient_points`, `session_not_active`,
`session_expired`, `billing_disabled`, `gift_value_unverified`, `before_session`, `invalid`.
Usage debits are ledger `spend` rows with `source_type = tiktok_diamond_usage` and
`metadata.reasonCode = TIKTOK_DIAMOND_USAGE`, plus game, session, LIVE, event key, gift ID,
quantity source, units, rate version.

Operator CLI: `scripts/points-admin.mjs review` (open flags and refund requests) and
`resolve flag|refund-request ID "note"`.

## 5. Refund rules as implemented

- Discretionary request: `eligible_unused` (no Points of that purchase used),
  `manual_review_partially_consumed`, `manual_review_fully_consumed`. A request never refunds money;
  an operator refunds in the provider dashboard, and the verified webhook then settles Points.
- Verified full refund / lost dispute, with `POINTS_REFUND_AUTOMATION_ENABLED=true`:
  unused purchase → full reversal; partly used → only that purchase's unused rest is revoked + review
  flag; fully used → no ledger change + review flag. Never negative, never another purchase.
- Partial refunds never change Points automatically (review flag). Dispute opened → review flag.
- Automation off → recorded and flagged; an operator decides (the previous policy).
- Lemon Squeezy has no dispute webhook event; chargebacks there need the dashboard.

## 6. Stripe (sandbox only)

Settings: `POINTS_PAYMENT_PROVIDER=stripe`, `STRIPE_SECRET_KEY` (`sk_test_…`/`rk_test_…`; live keys
are refused), `STRIPE_WEBHOOK_SECRET` (`whsec_…`), `STRIPE_PRICE_IDS_JSON={"starter":"price_…"}` (a
one-time **USD $5.00** price), `STRIPE_PRODUCTS_VERIFIED=true` after checking it in the dashboard, plus
the existing `POINTS_ORDER_REFERENCE_SECRET`, `POINTS_SITE_ORIGIN` and wallet switches. Webhook
endpoint (test mode) events: `checkout.session.completed`, `checkout.session.async_payment_succeeded`,
`checkout.session.async_payment_failed`, `charge.refunded`, `charge.dispute.created`,
`charge.dispute.closed`. Credits only for `payment_status = paid`, USD, the exact price, no discount and
a valid signed PlayLive reference. **Stripe Managed Payments is not implemented** (eligibility pending);
add its parameters from Stripe's current documentation only once approved. Selecting Stripe replaces
Lemon Squeezy for new checkouts on that deployment; existing orders keep their provider.

## 7. Staging deployment (owner approval first; no new branches)

1. Hand the web developer the changed/new files as a patch for `staging` (list in the handoff).
2. Run the preflight on staging; keep the output. Apply 202610130005, then 202610130006.
   If 202610110004 is not yet on staging, apply the Lemon Squeezy steps first.
3. Run the preflight's "after" checks (lot invariant, billing off, empty tables).
4. Deploy with all new switches **false**. Confirm the new routes answer 401 anonymously.
5. Turn on one feature at a time on staging only, with the owner's approval.

## 8. First manual end-to-end tests (staging, test data only)

**Gift billing (needs a game implementing PLAYLIVE_GAME_BILLING_BRIDGE.md):**
1. Operator: add the game to `point_billable_games`, enable billing settings, and add ONE gift
   (the cheapest, for example a Rose) to `point_gift_values` with the evidence used for its Diamond value.
2. Give a test account e.g. 1,000 test Points (mock purchase or `points-admin adjust`).
3. Set `POINTS_USAGE_BILLING_ENABLED=true` on staging; in Unity enable **Enable Staging Usage Billing**.
4. Go LIVE with the test account; start the game; check Go LIVE shows "Points … This LIVE: 0 used".
5. From a second TikTok account send that gift once: balance drops by exactly the configured value;
   history shows "TikTok gift usage"; the effect runs once.
6. Send a short streak: only the increments are charged. Disconnect the network for 20 s and reconnect:
   no duplicate charge. Close and reopen the launcher: history unchanged.
7. Send a gift with no `point_gift_values` row: no charge, no billable effect.
8. Spend down below 1,000: "Low balance"; to 0: "Insufficient Points", no effect, no negative balance.
9. Stop the game: the session is `stopped`; further gifts are not charged.

**Refund:**
1. With `POINTS_REFUND_AUTOMATION_ENABLED=true`, buy Starter in test mode; refund it fully in the
   provider dashboard: the balance drops by 5,000 once (resend the webhook: no change).
2. Buy Starter twice, use 6,000 Points, refund the second purchase: only its unused 4,000 are removed
   and `review` shows `REFUND_AFTER_CONSUMPTION`.
3. Partial refund: no Point change, `PARTIAL_REFUND_REVIEW` flagged.

## 9. Known risks and limits

- Gift events are unverifiable client reports (section 2). Usage billing must stay off until the
  owner accepts that model and the Diamond values are sourced.
- Real PostgreSQL concurrency with independent connections was not tested (PGlite runs one backend).
  The design serializes each streamer's charges on their wallet row and each gift on an advisory lock.
- A game that does not wait for `execute: true` would show effects without a charge. Billing is only as
  strict as each game's implementation of the addendum.
- Mailbox files live under the user's `%LOCALAPPDATA%`; another local program could write fake gift
  reports. That can only spend the signed-in streamer's own Points on their own LIVE.
- Lot accounting assumes `apply_point_transaction` is the only writer of `point_transactions`.
