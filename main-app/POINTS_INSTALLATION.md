# PlayLive account points — staging installation

The site remains deployed from `staging`. Implementation is on
`feature/points-system`, based on staging commit
`df3dc579afcf0aec7b607f297ed2ccc016e56c1e`. Merge the reviewed implementation into
`staging`; do not change the hosting provider's deployment-branch setting.

## Implemented

- Supabase UUID ownership (`auth.users`), owner-only RLS reads and trusted-server
  mutation functions. No legacy Prisma `User`/itch.io identity dependency.
- Atomic, append-only ledger with a cached balance, monotonic sequence, exact
  signed 64-bit arithmetic, global retry-key and source-event uniqueness.
- Award, spend, operator adjustments and full transaction reversals.
- Existing Unity balance contract plus separate summary/history endpoints.
- Account-page balance, gross credit/debit totals, UTC history, pagination,
  refresh, unavailable and invalid-link states. Add Points stays disabled.
- Independent read/write kill switches and disabled-by-default reward rules.
- Operator CLI and tests that run without staging credentials.

## Before applying the migration

Confirm the deployment's Supabase project is the intended staging project.
A Git staging branch does not itself isolate the database. Do not reuse
production database credentials in a preview environment.

The repository does not contain migrations for existing `profiles`,
`launcher_sessions` or `launcher_authorization_codes`. These are prerequisites,
not created/replaced by this change. The existing launcher authentication code
must already work. In particular `launcher_sessions.access_expires_at` must
exist and be populated by the current token endpoint.

Earlier Unity handoffs mention `grant_points`/`deduct_points` infrastructure that
is not present in this repository. Inspect staging first for an existing wallet
or funded ledger. If one exists, reconcile/import it with its source records
before enabling this implementation; do not silently start funded users at zero
or run two balance authorities. This migration intentionally fails on conflicting
table/function names rather than overwriting them. No live schema was inspected
or migrated during local implementation.

## Deploy sequence

1. Install Node 22+ and run `npm ci`, `npm test`, `npm run lint:points`,
   `npm run build`, and `npm run test:smoke` in `main-app`. The smoke test starts
   a temporary localhost server using fake credentials; it never connects to staging.
2. Back up staging and run the read-only `supabase/points-preflight.sql` to
   inspect the existing schema as above.
3. Apply `supabase/migrations/202609190001_points_ledger.sql` using the staging
   SQL editor or your existing Supabase migration pipeline. It is an atomic,
   additive migration. Do not run Prisma `db push` or `migrate reset`.
4. Configure the existing Supabase URL, publishable key and server secret key.
   The secret key must never have a `NEXT_PUBLIC_` prefix.
5. Deploy the reviewed commit to `staging` with `POINTS_ENABLED=false` and
   `POINTS_MUTATIONS_ENABLED=false` initially. No branch-setting change is needed.
6. Set `POINTS_ENABLED=true` in staging and redeploy. Test a real account:
   anonymous launcher request -> 401; authenticated missing wallet ->
   `{"balance":"0"}`; account page -> zero and empty history.
7. Set `POINTS_MUTATIONS_ENABLED=true` only in the trusted environment used for
   grants. Use the CLI below to grant 10,000, retry the same request, debit 100,
   and verify 9,900 in both website and launcher. Verify a second user cannot
   read the first user's account or history.
8. In Unity, enable the existing **Enable Staging Wallet Api** setting only
   after the staging API is verified. The current Unity workspace has this
   disabled because the old route returned 404. Production stays independent.
9. Verify token refresh once after 401, logout clearing, and a simulated server
   failure retaining a labeled last-known balance in Unity.

No secret values are supplied with this implementation.

## Configuration

```dotenv
POINTS_ENABLED=false
POINTS_MUTATIONS_ENABLED=false
POINTS_REWARD_RULES_JSON={}
# Trusted CLI only; existing auth.users UUID, not customer-controlled metadata:
POINTS_OPERATOR_USER_ID=
```

The JSON rule shape is `{ "rule_id": { "enabled": true, "amount": "100",
"description": "Welcome reward" } }`. Rates and earning events must be decided
before enabling rules. There are no automatically enabled signup, daily-login,
purchase or gameplay rewards. Existing users start at a virtual zero without
bulk inserts; their row is created on the first valid ledger operation.

## API contract

All launcher routes require the existing bearer access token, derive the user ID
from `launcher_sessions`, and return `Cache-Control: private, no-store`.
Client-supplied user IDs and point amounts cannot change the account being read.

| Route | Result |
| --- | --- |
| `GET /api/v1/me/points` | Exactly `{ "balance": "9900" }`, unchanged Unity contract |
| `GET /api/v1/me/points/summary` | String `balance`, `lifetimeEarned`, `lifetimeSpent`, `version`; `updatedAt` UTC or null |
| `GET /api/v1/me/points/transactions?limit=20&cursor=…` | `{ "items": […], "nextCursor": "…" or null }` |

Amounts, balances, totals and cursor sequence numbers are decimal strings all
the way from PostgreSQL to JSON. Do not cast database BIGINTs to JS `Number`.
History items contain `id`, signed-string `amount`, string `balanceAfter`,
`type`, customer-safe `description`, and `createdAt`. Internal metadata, actor
IDs, source identifiers and retry keys are excluded. Page size is 1–100,
default 20; website pages use 10. Cursors are positive sequence numbers and
are always scoped to the authenticated user. New activity does not shift older
pages. Summary and history are separate reads, not a shared snapshot.

Error statuses: 400 invalid pagination; 401 missing/expired/revoked session;
500 infrastructure/schema failure; 503 feature disabled. Errors never contain
a fabricated balance. A 500 must not trigger logout or reset a known balance.

## Trusted writes and operator commands

`lib/points.js` is server-only and exposes `awardPoints`, `spendPoints`,
`adjustPoints`, `reversePointTransaction` and `rewardTrustedEvent`. Positive
string amounts are passed to award/spend; the spend function derives the
negative delta. Operators use signed string amounts for adjustments.

Only the Supabase service role can execute mutation RPCs. Even that role has no
direct table write permission; it must go through the transaction function.
Browser and Unity clients have no general-purpose grant/debit endpoint.

With a local, ignored `.env.local` configured for staging:

```sh
node --env-file=.env.local scripts/points-admin.mjs balance USER_UUID
node --env-file=.env.local scripts/points-admin.mjs adjust USER_UUID 10000 test-grant-001 "Staging test credit"
node --env-file=.env.local scripts/points-admin.mjs adjust USER_UUID -100 test-debit-001 "Staging test debit"
node --env-file=.env.local scripts/points-admin.mjs history USER_UUID
node --env-file=.env.local scripts/points-admin.mjs reverse TRANSACTION_UUID test-refund-001 "Staging test refund"
```

Replace UUID placeholders with real staging users. Use the same request ID and
payload on a retry. Reusing a key with different data fails. Reusing a source
event with a different key also fails rather than awarding twice. The operator
UUID is audit attribution configured by a trusted operator, not an admin-role
authorization mechanism; possession of the secret key is the trust boundary.

Reversals are full compensating entries, once per original transaction. A
refund cannot itself be reversed. An award already spent cannot be reversed
into a negative balance; it fails with `INSUFFICIENT_POINTS` for manual
resolution. Credit/debit totals are gross movements including adjustments and
refunds, not net purchases or loyalty-earned statistics. Points do not expire,
transfer between users, or represent a cash balance in this release.

Ledger-backed users cannot be deleted through cascading deletes. Account
deletion/anonymization needs an explicit retention workflow that preserves the
ledger and its audit links; this implementation does not define a retention
policy or weaken referential integrity.

## Connecting earning and redemption sources

Call `rewardTrustedEvent` only after the trusted backend has verified the event.
The server rule supplies the amount; a customer/game client's reported amount
is never authoritative. Stable event IDs must include the provider/event scope,
such as a verified purchase ID or server-issued achievement ID. Enabling a JSON
rule does not connect a provider or validate client-reported events by itself.

The current repository has no verified purchase-webhook or authoritative
game-event processor to attach. Those integrations, prices, reward rates and
redeemable items remain product/integration decisions. Do not grant points from
a checkout success redirect, browser callback or unverified Unity event.

Before enabling paid redemption, the entitlement/reward delivery and debit must
be committed together or coordinated with an idempotent outbox. A bare
`spendPoints` call is a ledger operation, not a complete product fulfillment
workflow. No checkout or redemption button is exposed by this change.

## Verification and rollback

`npm test` runs service/auth/API tests and executes the migration against local
PGlite PostgreSQL, including permissions, RLS, reversals, source uniqueness,
immutable history and 64-bit limits. PGlite is a single-backend engine: its
overlapping-request test does not certify multi-connection lock behavior.
Before enabling spending, repeat concurrent duplicate awards and competing
spends on a disposable real PostgreSQL/Supabase staging database.

The existing FAQ CSS module used a global `:root` selector rejected by Next's
production compiler. It is scoped to `.faqPageWrapper` in this change. The
ESLint configuration and `lint` command were also aligned with the repository's
Next 16 version so the added source can be linted with the installed tooling.

Rollback: set `POINTS_MUTATIONS_ENABLED=false`, then `POINTS_ENABLED=false` and
redeploy/revert the application commit. Leave ledger tables and data intact.
Do not drop funded wallets or delete ledger entries. Reconcile balances from
`sum(amount)` and compare with `point_accounts.balance` after any incident.
Take database backups before schema changes. Existing auth/account/library
flows continue independently while the points UI is disabled.
