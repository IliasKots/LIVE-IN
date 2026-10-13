# PlayLive points delivery — 11 October 2026

Local implementation is ready for provider acceptance. **Sales remain disabled.**
No deployment, remote migration, dashboard edit, real payment or live balance
change was made. These instructions replace the earlier example pack amounts.

## What a customer buys

One points **sub-product** under a genuine PlayLive launcher/tool project.
The buyer pays, clicks itch.io's claim action, and PlayLive automatically
delivers the selected fixed credit to the account that started checkout.
Downloading the launcher or buying its ordinary parent product does not prove
a points purchase. No shared redemption-code download is involved.

| Pack / external ID | USD minimum | Delivered total | Included bonus |
|---|---:|---:|---:|
| starter | $5 | 5,000 | — |
| regular | $10 | 10,000 | — |
| pro | $25 | 27,500 | 10% |
| max | $50 | 57,500 | 15% |
| ultimate | $100 | 120,000 | 20% |

`lib/points-catalog.mjs` owns these definitions. Extra payment gives the selected
pack once; it does not multiply points or apply the bonus again.

## Verified capabilities and limits

The [sub-product documentation](https://itch.io/docs/api/sub-products) supports
service digital goods, including coin products, using signed purchase/product
identifiers and account metadata. Our adapter implements that receipt flow.
The buyer's claim button is required; no payment webhook or automatic return is
assumed. HS256 is allowlisted locally; an actual issued proof must establish
algorithm compatibility. This account's feature access remains unverified.

The [official changelog](https://itch.io/blog/105823/return-of-the-itchio-changelog-markdown-sub-prducts-jam-updates-more)
describes admin activation and controls for parent ownership, gifting and extra
payment. If the dashboard is absent, request activation and acceptance of
PlayLive service credits from itch.io support. No current promise of general
availability was found.

The [server purchase API](https://itch.io/docs/api/serverside) returns completed
payment IDs, currency, price and purchase type for a verified itch.io buyer.
PlayLive identity does not supply that buyer identity. Ownership/download-key
results also include free/generated claims; neither they nor email alone prove
payment. Our adapter uses the signed receipt, not a guessed buyer lookup.
The minimum receipt payload does not promise payment amount/currency; verify
dashboard SKU prices before enabling checkout. Optional paid fields are checked.

[itch.io staff](https://itch.io/t/574278/pay-several-times) confirm repeated account
purchases and one external key per purchase. That is not a test of this account's
sub-product checkout or proof reissue. Locally, distinct signed purchase IDs
produce distinct credits; repeat real checkout remains an acceptance test.

[External keys](https://itch.io/docs/creators/download-keys) require eligible
download keys, adequate stock and normally genuine downloadable content. Free
or generated keys can be eligible too. Sub-product payments do not grant them;
key-only exceptions need support. We selected signed sub-product delivery and
have not generated keys, uploaded codes or added a misleading Redeem code UI.

## Why the Starter page has no Buy button

[itch.io's setup guide](https://itch.io/docs/creators/getting-started) requires an
available upload for ordinary project purchases. Your described page has none.
Draft/restricted access and seller payment settings can also prevent purchasing.
The authenticated edit form was unavailable here; anonymous page checks cannot
confirm its actual settings. Setting a $5 parent price alone does not deliver
5,000 points. Do not upload a dummy file to conceal that distinction.

## Exact setup steps

1. Keep the existing page **Draft**, with all PlayLive checkout switches off.
   Record the numeric parent **project/game ID** from its dashboard edit URL.
   This is for dashboard/support inspection, not the Starter sub-product ID.
2. Inspect **Sub-products & DLC**. If missing, contact
   [itch.io support](https://itch.io/support) yourself with the project URL/ID.
   Ask for repeatable service-credit products, signed account metadata, redeem
   claims and support for a restricted controlled-purchase test. No message was sent.
3. Reuse the URL as a genuine PlayLive launcher/tool parent if desired. Our
   recommendation: classification **Other**, custom noun **tool**, kind
   **Downloadable**. Do not misclassify credits as artwork or a Unity browser embed.
4. Upload a real tested launcher ZIP with the executable and required runtime/data
   files, tagging only its tested platform. No release ZIP was created here.
   The Unity source project is not a distributable launcher release. Use a
   service-only exception instead only if itch.io explicitly approves it.
   In **Account settings → Seller settings**, complete the existing itch.io payment
   mode and required seller details; verify that checkout currency is USD. This
   task does not select a new processor or change payment accounts.
5. With support confirmation, make the parent launcher free / $0 minimum; disable
   parent donations if available. The parent is not the $5 points SKU. Keep Draft
   during preparation. Ordinary parent purchases without PlayLive binding will
   not be credited automatically.
6. Add **Starter** as a sub-product: external ID `starter`, **$5 USD** minimum,
   **5,000 total points**, existing Starter artwork, no required parent purchase,
   no gifting. Add the other four from the table when ready, under this same
   parent. Disable discounts during acceptance. Optional overpayment never adds
   extra credits. Record each actual numeric sub-product ID.
7. Set the project's Redeem URL to
   `https://YOUR_STAGING_ORIGIN/api/points/itch/redeem`. Store its generated secret
   solely in server setting `ITCH_POINTS_REDEEM_SECRET`. Never upload/publish it,
   paste it into chat, or put it in Unity or a `NEXT_PUBLIC_*` variable.
8. Supply these private staging settings:

   - `POINTS_DEPLOYMENT_ENVIRONMENT=staging`.
   - `POINTS_SITE_ORIGIN`: exact staging HTTPS origin, without a path.
   - `ITCH_POINTS_PROJECT_URL`: the parent URL. If reused, this is
     `https://tiktok-live-games.itch.io/playlive-5000-points-pack`.
   - `ITCH_POINTS_REDEEM_SECRET`: actual dashboard secret, server only.
   - `ITCH_POINTS_PRODUCT_IDS_JSON={"starter":"ACTUAL_NUMERIC_SUB_PRODUCT_ID"}`
     initially; add the other real IDs afterward. Do not deploy example IDs.
   - `ITCH_POINTS_PACKS_JSON=[]`: the ID mapping and legacy catalog cannot both
     be populated. `node scripts/prepare-itch-packs.mjs starter=REAL_ID` prints
     safe configuration and the fixed credit/price table without enabling sales.
   - Existing **staging** Supabase URL/publishable key and server secret key.
   - `ITCH_POINTS_BLOCKED_PURCHASE_IDS_JSON=[]`, maintained for refunds/disputes.

   No itch.io developer API key or OAuth client is required by this adapter.
9. Run the three read-only Supabase preflights: `points-preflight.sql`,
   `points-purchases-preflight.sql`, `points-delivery-preflight.sql`. Reconcile
   existing wallets. Apply only missing migrations, in order:
   `202609190001_points_ledger.sql`, `202610100002_points_purchase_intents.sql`,
   `202610110003_points_verified_delivery.sql`. Never reset the ledger or reapply
   installed create-table migrations. No remote migration was applied here.
10. In a separate authorized task, deploy the prepared website to **staging only**.
    Editing local files does not publish them. Verify routes, login, wallet
    authority and simulated fulfillment before opening real checkout.
11. Keep `POINTS_ENABLED`, `POINTS_MUTATIONS_ENABLED`,
    `POINTS_ITCH_CHECKOUT_ENABLED`, `POINTS_ITCH_CLAIMS_ENABLED`, and
    `ITCH_POINTS_PRODUCTS_VERIFIED` off until staging readiness is established.
    A separately authorized restricted payment pilot can subsequently enable
    those staging gates and Unity's **Enable Staging Points Checkout**.
    Production checkout/acceptance stays off.

## Purchase instructions and uploads

`public/points-pack-purchase-instructions.txt` is a supplemental buyer guide.
It can accompany a genuine launcher ZIP after checkout is available. It contains
no code/secret and does not fulfill points. Uploading it alone merely to force
a Buy button is not this delivery setup. No download is required to claim a
signed points receipt once the provider page is properly configured.

Buyers start from the launcher + or PlayLive shop, using a verified PlayLive
account. Checkout saves its account-bound intent. They must click itch.io's
claim action after payment. The clean PlayLive claim page credits the original
account; the launcher refreshes balance/history. Direct itch.io purchases without
PlayLive metadata need support verification, not arbitrary account assignment.

## Recovery and refunds

Verified ingress saves normalized evidence in an immutable, service-only inbox
before redirect. Saving it changes no balance. Authenticated native/browser
recovery accepts only an intent reference and loads that evidence. An unpaid
intent stays pending. Atomic wallet credit and receipt creation retain the
existing global purchase ID lock and append-only BIGINT ledger. No raw JWT,
email or secret is stored in the inbox. The original ledger migration is unchanged.

The encrypted HttpOnly cookie survives seven days for database/login retries.
After verified ingress, native Check again can deliver without that cookie after
restart. Before ingress, an intent cannot recover a payment: use the provider's
claim action. If proof reissue is unavailable, support must verify the purchase.

Redact `jwt` from hosting/request logs. Application responses never expose it.
The private-server diagnostic `scripts/verify-itch-receipt.mjs` takes a provider
JWT through stdin with private env loaded; it checks the allowlisted signature,
prints only references and never connects to a database or credits points.

Refunds remain operator-managed: block the purchase ID, check any in-flight
credit, then reverse an existing award through `scripts/points-admin.mjs` using
a stable retry key. Never delete ledger history. Spent credits cannot be reversed
into a negative wallet; resolve that case through support/account policy.
No automatic refund webhook was added.

## Later controlled purchase and repeat test

First obtain feature access, IDs/secret, a genuine tested upload and staging
deployment/migrations. Inspect signed metadata in the owner checkout view
without paying. Keep Draft throughout this task. [Visibility documentation](https://itch.io/docs/creators/access-control)
says Draft does not allow other customers to purchase. After staging fulfillment
is verified, a later authorized pilot can use **Restricted → Also allow a
password to view page** for the test buyer. Do not enable **Public → Disable
new downloads & purchases**, or a future release date, for that purchasing test.
Restricted access is not payment evidence and grants no PlayLive credit.

Only in a later explicitly authorized payment task, buy Starter for $5 through
the staging launcher, click claim, and verify the actual signature format, bound
intent and product/payment IDs privately. Require exactly **+5,000**, one award
and one receipt. Retry/reload/restart must add zero extra points. Test cancelled
checkout, delayed claim, expired login and account switching.

Buy the same Starter again with the same customer account. Require a different
actual payment ID, another **+5,000**, and a second ledger entry. Stop sales if
the provider/account prevents fresh top-ups or metadata is missing. Test parallel
claims using independent staging PostgreSQL connections: local PGlite tests use
a single backend and do not establish real multi-connection lock behavior.

If itch.io denies this capability, leave the adapter disabled. The catalog,
account-bound intents, delivery boundary, receipt polling and ledger remain
reusable. Another provider requires its own verified-evidence adapter and
provider-specific receipt migration; none was switched in this task.
