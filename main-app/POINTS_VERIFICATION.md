# Points implementation verification

Date: 2026-09-19. Base: staging `df3dc579afcf0aec7b607f297ed2ccc016e56c1e`.
Implementation branch: `feature/points-system` (local).

## Passed locally

| Check | Result |
| --- | --- |
| Service/auth/API and rendered UI tests | 14 passed |
| Actual SQL migration and database behavior in PGlite PostgreSQL | 12 passed |
| Total automated tests | 26 passed, 0 failed, 0 skipped |
| Targeted ESLint on points/auth changes, account page, tests and operator/smoke scripts | Passed |
| Next.js production build, webpack | Passed; all 28 static pages generated |
| Next.js production build, default Turbopack | Passed; all 28 static pages generated |
| Compiled HTTP routes | All three points routes: anonymous 401, no-store cache policy, POST 405 |
| Signed-out account | Sign-in redirect verified in production response |
| Existing FAQ | HTTP 200 after CSS-module scope fix |
| Git whitespace check | Passed |

Runtime: portable Node v22.23.2; resolved Next version 16.2.12 from the existing
lockfile. Dependencies were installed with lifecycle scripts disabled for local
verification. The existing Prisma postinstall generator and sitemap postbuild
script were not part of these direct Next build checks. No framework upgrade
was performed.

## Coverage

The database tests execute the delivered SQL, including role grants, RLS,
append-only trigger, exact BIGINT arithmetic, virtual zero wallets, atomic
ledger/balance changes, duplicate retries, conflicting retry data, duplicate
provider sources, account isolation, overdraw rejection, overflow rollback,
audited adjustments, full reversals and stable pagination while new events arrive.

The service/API tests verify the exact Unity string-balance contract, bounded
pagination, safe error bodies, no rounded numeric values, server-defined reward
amounts, access-token hashing and expiry, revoked/missing sessions, private
responses, and no zero balance on infrastructure failure. Render tests verify
zero/unavailable/invalid-cursor states, maximum balances, escaped descriptions,
disabled purchase controls and history links.

## Not verified or deployed

- No live Supabase credentials were present, and no live schema/data was read
  or changed. Earlier handoffs mention a previous points backend; run the
  supplied read-only preflight and reconcile any existing funded wallet before
  applying this migration.
- PGlite has a single PostgreSQL backend. Its overlapping-request test checks
  invariants but is not proof of simultaneous independent-connection row-lock
  behavior. Verify concurrent duplicate awards and competing debits against a
  disposable PostgreSQL/Supabase staging database before enabling spending.
- No browser connection was available. Rendered output was tested, but visual
  desktop/mobile layout and browser interaction remain unverified.
- Real staging login, token-refresh/retry and Unity Play Mode checks remain.
  The Unity sources and current disabled wallet switches were not changed.
- No remote push, merge, hosting change or deployment occurred. `staging`
  remains the deployment target. The source is ready for review and migration.
- Earning rates, purchase-provider verification, game-event verification,
  entitlement fulfillment and redemption products are not configured. The
  trusted server service and configurable rules are implemented, but there is
  no customer-facing grant/debit or checkout endpoint.

See `POINTS_INSTALLATION.md` for deployment order, API contracts, operator
commands, feature flags and non-destructive rollback. Both feature flags
default to disabled until configured explicitly in staging.

The handoff ZIP contains only added/changed tracked source files, preserving
the `main-app/` repository paths. Apply it to a reviewed checkout based on the
stated staging commit, not blindly over newer changes. It contains no secrets,
node_modules, local runtime, Unity assets or generated build files.
