# Launcher game downloads (private Cloudflare R2)

`POST /api/v1/games/{gameId}/download` returns short-lived download metadata for the PlayLive launcher. The ZIP goes straight from R2 to the launcher; this server never proxies package bytes.

## Who can download

- Requires a valid launcher bearer session: `launcher_sessions`, not revoked and not expired.
- Requires a confirmed email (`auth.users.email_confirmed_at`).
- Standard catalogue games are free. There is no purchase, ownership, subscription or Points check, and nothing is charged.
- Per-account limit: 10 requests per 60 s by default (`PLAYLIVE_GAME_DOWNLOAD_RATE_LIMIT`). Every authenticated request is logged in `game_download_requests` (outcome only, never URLs).

## Response

**200** `{ gameId, version, downloadUrl, expiresAt, sha256, sizeBytes, executablePath }`, `Cache-Control: no-store`.

`downloadUrl` is an S3 SigV4 presigned GET for exactly one object. It is made by the AWS SDK v3 (`@aws-sdk/s3-request-presigner`), is valid for `PLAYLIVE_GAME_DOWNLOAD_URL_TTL_SECONDS` (default 900, clamped to 60–3600), and is never stored.

Errors are `{ code, message, requestId }` with these status codes:

| Status | Code |
|---|---|
| 400 | `invalid_request` |
| 401 | `unauthorized` |
| 403 | `verification_required` |
| 404 | `game_not_found` (not one of the 7 catalogue IDs) |
| 409 | `package_unavailable` (no verified, ready release) |
| 429 | `rate_limited` (+ `Retry-After`) |
| 500 | `server_error` |
| 503 | `service_unavailable` (feature off, configuration incomplete, signing failed) |

## Release records (`public.game_releases`, migration `202611050008_game_releases.sql`)

- Each row describes one immutable ZIP: game, platform `windows-x64`, version, bucket, `object_key = gameId/version/filename`, size, SHA-256 and executable path. The package fields cannot be updated; publish a new version instead.
- Only `status = 'ready'` rows with `verified_at` and `published_at` are served, and there is at most one ready row per game/platform. `pending` and `disabled` rows are never served.
- Rollback: set the bad row to `disabled` and the previous version to `ready` (in one transaction).
- All access goes through the service-role-only functions `get_ready_game_release`, `begin_game_download` and `finish_game_download`.
- The staging seed for Disco 2.1.0 and Squid 9.5 is `supabase/staging/202611050008_game_releases_staging_seed.sql`. `supabase/staging/APPLY_IN_STAGING_SQL_EDITOR_2026-11-05.sql` combines the migration and the seed, with a staging guard.

## Server configuration (Vercel; server-only, never `NEXT_PUBLIC_`)

| Name | Value |
|---|---|
| `R2_DOWNLOADS_ENABLED` | `true` to turn on (anything else → 503) |
| `R2_ACCOUNT_ID` | Cloudflare account ID (32 hex) |
| `R2_BUCKET_NAME` | must equal the release rows' bucket |
| `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | R2 API token with **Object Read only**, scoped to the package bucket |
| `R2_S3_ENDPOINT` | optional, default `https://<account>.r2.cloudflarestorage.com` |
| `PLAYLIVE_GAME_DOWNLOAD_URL_TTL_SECONDS`, `PLAYLIVE_GAME_DOWNLOAD_RATE_LIMIT` | optional |

Keep the bucket private: r2.dev off and no public custom domain. Uploading packages uses a separate credential (for example a temporary `wrangler login`), never the download token.

## Tests

`node --test tests/game-downloads.test.mjs` runs:
- the handler for every status;
- the real AWS SDK presigner offline;
- the real migration and the staging seed on PGlite.
