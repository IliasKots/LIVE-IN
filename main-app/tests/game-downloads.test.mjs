import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { handleGameDownload, readDownloadConfig, isSafeRelativePath, validateRelease, KNOWN_GAME_IDS }
  from '../lib/game-downloads-core.mjs';
import { createR2Signer } from '../lib/r2-presign.mjs';

const ACCOUNT = '0123456789abcdef0123456789abcdef';
const ENV = { R2_DOWNLOADS_ENABLED: 'true', R2_ACCOUNT_ID: ACCOUNT, R2_BUCKET_NAME: 'playlivetiktok-games',
  R2_ACCESS_KEY_ID: 'TESTACCESSKEYID000000', R2_SECRET_ACCESS_KEY: 'test-only-secret-access-key-0000000000000000' };
const SQUID = { gameId: 'squid-game-tiktok-live', platform: 'windows-x64', version: '9.5', bucket: 'playlivetiktok-games',
  filename: 'squid-game-tiktok-live-windows-x64-9.5.zip',
  objectKey: 'squid-game-tiktok-live/9.5/squid-game-tiktok-live-windows-x64-9.5.zip', sizeBytes: 102772100,
  sha256: '047f6081fdd1c73837f48ee9b865e2844ec4e9b8cdb4e06eced8ba0d9851d449',
  executablePath: 'Squid Game - Tiktok Live game V9.5.exe' };
const NOW = Date.parse('2026-11-05T20:00:00.500Z');

function request(body = '{}', token = 'valid-token') {
  return new Request('https://staging.example/api/v1/games/x/download', { method: 'POST', body,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) } });
}

function deps(overrides = {}) {
  const calls = { finish: [], begin: [], logs: [], signed: [] };
  const value = {
    authenticate: async (req) => req.headers.get('authorization') === 'Bearer valid-token' ? { userId: 'user-1' } : null,
    getUser: async () => ({ emailConfirmedAt: '2026-10-01T00:00:00Z' }),
    beginRequest: async (args) => { calls.begin.push(args); return { allowed: true, retryAfter: 0 }; },
    finishRequest: async (...args) => { calls.finish.push(args); },
    findReadyRelease: async (id) => (id === SQUID.gameId ? { ...SQUID } : null),
    sign: async (args) => { calls.signed.push(args); return `https://${ACCOUNT}.r2.cloudflarestorage.com/${args.bucket}/${args.key}?X-Amz-Signature=abc`; },
    now: () => NOW,
    log: (event) => calls.logs.push(event),
    ...overrides,
  };
  return { value, calls };
}

async function call(gameId, d, config = readDownloadConfig(ENV), req = request()) {
  const response = await handleGameDownload(req, gameId, d.value, config);
  return { response, body: await response.json() };
}

test('verified account receives exact package metadata with a short-lived URL; nothing is charged', async () => {
  const d = deps();
  const { response, body } = await call(SQUID.gameId, d);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(Object.keys(body).sort(), ['downloadUrl', 'executablePath', 'expiresAt', 'gameId', 'sha256', 'sizeBytes', 'version']);
  assert.equal(body.gameId, SQUID.gameId);
  assert.equal(body.version, '9.5');
  assert.equal(body.sizeBytes, 102772100);
  assert.equal(body.sha256, SQUID.sha256);
  assert.equal(body.executablePath, 'Squid Game - Tiktok Live game V9.5.exe');
  assert.equal(body.expiresAt, '2026-11-05T20:15:00Z');
  assert.match(body.downloadUrl, /^https:\/\//);
  assert.equal(d.calls.signed[0].key, SQUID.objectKey);
  assert.equal(d.calls.signed[0].expiresIn, 900);
  assert.deepEqual(d.calls.finish[0].slice(1), ['issued', '9.5']);
  // The signed URL never reaches the logs.
  assert.ok(!JSON.stringify(d.calls.logs).includes('X-Amz'));
});

test('missing, invalid or expired sessions get 401 with no package information', async () => {
  for (const token of [null, 'expired-token']) {
    const d = deps();
    const { response, body } = await call(SQUID.gameId, d, undefined, request('{}', token));
    assert.equal(response.status, 401);
    assert.equal(body.code, 'unauthorized');
    assert.equal(response.headers.get('www-authenticate'), 'Bearer');
    assert.equal(d.calls.begin.length, 0);
    assert.equal(d.calls.signed.length, 0);
  }
  const gone = deps({ getUser: async () => null });
  assert.equal((await call(SQUID.gameId, gone)).response.status, 401);
});

test('a valid account with an unverified email gets 403 and no URL', async () => {
  const d = deps({ getUser: async () => ({ emailConfirmedAt: null }) });
  const { response, body } = await call(SQUID.gameId, d);
  assert.equal(response.status, 403);
  assert.equal(body.code, 'verification_required');
  assert.equal(d.calls.signed.length, 0);
});

test('malformed ids and bodies are rejected before authentication', async () => {
  for (const [id, body] of [['../etc', '{}'], ['Disco', '{}'], ['', '{}'], [SQUID.gameId, '[]'], [SQUID.gameId, 'nope'],
    [SQUID.gameId, 'x'.repeat(2000)]]) {
    const d = deps();
    const { response, body: json } = await call(id, d, undefined, request(body));
    assert.equal(response.status, 400, `${id} ${body.slice(0, 10)}`);
    assert.equal(json.code, 'invalid_request');
  }
  assert.equal((await call(SQUID.gameId, deps(), undefined, request(''))).response.status, 200);
});

test('unknown games are 404; known games without a ready, valid release are 409', async () => {
  assert.equal((await call('not-a-catalogue-game', deps())).response.status, 404);
  assert.equal((await call('red-vs-blue', deps())).response.status, 409);
  const tampered = [{ bucket: 'other-bucket' }, { sha256: 'A'.repeat(64) }, { sizeBytes: 0 }, { executablePath: '..\\evil.exe' },
    { executablePath: 'game.bat' }, { objectKey: 'squid-game-tiktok-live/9.0/x.zip' }, { platform: 'mac' }, { gameId: 'disco-tiktok-live' }];
  for (const change of tampered) {
    const d = deps({ findReadyRelease: async () => ({ ...SQUID, ...change }) });
    const { response } = await call(SQUID.gameId, d);
    assert.equal(response.status, 409, JSON.stringify(change));
    assert.equal(d.calls.signed.length, 0);
  }
});

test('rate limiting answers 429 with Retry-After and does not sign', async () => {
  const d = deps({ beginRequest: async () => ({ allowed: false, retryAfter: 42 }) });
  const { response, body } = await call(SQUID.gameId, d);
  assert.equal(response.status, 429);
  assert.equal(body.code, 'rate_limited');
  assert.equal(response.headers.get('retry-after'), '42');
  assert.equal(d.calls.signed.length, 0);
});

test('disabled or incomplete configuration fails closed with 503; signing and auth outages are not 200', async () => {
  assert.equal((await call(SQUID.gameId, deps(), readDownloadConfig({ ...ENV, R2_DOWNLOADS_ENABLED: 'false' }))).response.status, 503);
  assert.equal((await call(SQUID.gameId, deps(), readDownloadConfig({ ...ENV, R2_SECRET_ACCESS_KEY: '' }))).response.status, 503);
  assert.equal((await call(SQUID.gameId, deps(), readDownloadConfig({ ...ENV, R2_S3_ENDPOINT: 'https://example.com' }))).response.status, 503);
  const signing = deps({ sign: async () => { throw new Error('boom'); } });
  assert.equal((await call(SQUID.gameId, signing)).response.status, 503);
  assert.deepEqual(signing.calls.finish[0].slice(1), ['signing_failed', '9.5']);
  const auth = deps({ authenticate: async () => { throw new Error('LAUNCHER_AUTH_UNAVAILABLE'); } });
  const failed = await call(SQUID.gameId, auth);
  assert.equal(failed.response.status, 500);
  assert.equal(failed.body.code, 'server_error');
});

test('configuration clamps the URL lifetime and uses the account S3 endpoint', () => {
  assert.equal(readDownloadConfig({ ...ENV, PLAYLIVE_GAME_DOWNLOAD_URL_TTL_SECONDS: '99999' }).ttlSeconds, 3600);
  assert.equal(readDownloadConfig({ ...ENV, PLAYLIVE_GAME_DOWNLOAD_URL_TTL_SECONDS: '5' }).ttlSeconds, 60);
  const config = readDownloadConfig(ENV);
  assert.equal(config.endpoint, `https://${ACCOUNT}.r2.cloudflarestorage.com`);
  assert.equal(config.complete, true);
  assert.equal(readDownloadConfig({}).complete, false);
});

test('executable paths follow the launcher rules exactly', () => {
  for (const ok of ['Disco Tiktok Live Game.exe', 'Squid Game - Tiktok Live game V9.5.exe', 'bin/Game.exe']) assert.ok(isSafeRelativePath(ok), ok);
  for (const bad of ['/Game.exe', 'a\\b.exe', 'C:Game.exe', '../Game.exe', 'a/./b.exe', 'CON.exe', 'LPT1.exe', 'Game.exe ',
    ' Game.exe', 'Ga%20me.exe', 'Game?.exe', 'dir./Game.exe']) assert.ok(!isSafeRelativePath(bad), bad);
  assert.equal(validateRelease({ ...SQUID, sizeBytes: '102772100' }, SQUID.gameId, readDownloadConfig(ENV)).sizeBytes, 102772100);
  assert.equal(KNOWN_GAME_IDS.length, 7);
});

test('the official AWS SDK presigns a plain, host-only GET for the exact private object (offline)', async () => {
  const sign = createR2Signer(readDownloadConfig(ENV));
  const url = new URL(await sign({ bucket: SQUID.bucket, key: SQUID.objectKey, expiresIn: 900, signingDate: new Date(NOW) }));
  assert.equal(url.protocol, 'https:');
  assert.equal(url.host, `${ACCOUNT}.r2.cloudflarestorage.com`);
  assert.equal(url.pathname, `/playlivetiktok-games/${SQUID.objectKey}`);
  assert.equal(url.searchParams.get('X-Amz-Algorithm'), 'AWS4-HMAC-SHA256');
  assert.equal(url.searchParams.get('X-Amz-Expires'), '900');
  assert.equal(url.searchParams.get('X-Amz-SignedHeaders'), 'host');
  assert.equal(url.searchParams.get('X-Amz-Date'), '20261105T200000Z');
  assert.match(url.searchParams.get('X-Amz-Credential'), /^TESTACCESSKEYID000000\/20261105\/auto\/s3\/aws4_request$/);
  assert.match(url.searchParams.get('X-Amz-Signature'), /^[0-9a-f]{64}$/);
  assert.equal(url.searchParams.get('x-amz-checksum-mode'), null);
  assert.ok(!url.href.includes(ENV.R2_SECRET_ACCESS_KEY));
});

// Real migration on an isolated in-memory PostgreSQL engine; no staging or production connection.
let db;
before(async () => {
  db = new PGlite();
  await db.exec(`
    create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
    create schema auth; create table auth.users (id uuid primary key);
    grant usage on schema auth, public to anon, authenticated, service_role;
  `);
  await db.exec(await readFile(new URL('../supabase/migrations/202611050008_game_releases.sql', import.meta.url), 'utf8'));
});
after(async () => { await db?.close(); });

async function asRole(role, sql, params = []) {
  await db.exec(`set role ${role}`);
  try { return await db.query(sql, params); } finally { await db.exec('reset role'); }
}
const ready = (id) => asRole('service_role', 'select public.get_ready_game_release($1, $2) as r', [id, 'windows-x64'])
  .then((result) => result.rows[0].r);

test('migration: only verified, published releases are served; package identity is immutable', async () => {
  const base = [SQUID.gameId, 'windows-x64', '9.4', 'playlivetiktok-games', 'old.zip', `${SQUID.gameId}/9.4/old.zip`,
    100, 'a'.repeat(64), 'Old.exe'];
  await db.query(`insert into public.game_releases (game_id, platform, version, bucket, filename, object_key, size_bytes,
    sha256, executable_path) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, base);
  assert.equal(await ready(SQUID.gameId), null, 'pending rows are never served');
  await assert.rejects(db.query(`update public.game_releases set status = 'ready' where version = '9.4'`), /game_releases_ready_verified/);
  await db.query(`update public.game_releases set status = 'ready', verified_at = now(), published_at = now() where version = '9.4'`);
  assert.equal((await ready(SQUID.gameId)).version, '9.4');
  await assert.rejects(db.query(`update public.game_releases set sha256 = $1 where version = '9.4'`, ['b'.repeat(64)]), /GAME_RELEASE_IMMUTABLE/);
  await assert.rejects(db.query(`update public.game_releases set executable_path = 'Other.exe' where version = '9.4'`), /GAME_RELEASE_IMMUTABLE/);
  await db.query(`update public.game_releases set status = 'disabled' where version = '9.4'`);
  assert.equal(await ready(SQUID.gameId), null, 'disabled rows are never served');
  for (const [column, value, pattern] of [['object_key', `${SQUID.gameId}/9.9/other.zip`, /game_releases_key_layout/],
    ['executable_path', 'bin\\Game.exe', /executable_path/], ['sha256', 'A'.repeat(64), /sha256/]]) {
    const row = { game_id: SQUID.gameId, platform: 'windows-x64', version: '9.9', bucket: 'playlivetiktok-games',
      filename: 'x.zip', object_key: `${SQUID.gameId}/9.9/x.zip`, size_bytes: 1, sha256: 'c'.repeat(64), executable_path: 'Game.exe' };
    row[column] = value;
    await assert.rejects(db.query(`insert into public.game_releases (${Object.keys(row).join(',')}) values (${Object.keys(row).map((_, i) => `$${i + 1}`).join(',')})`,
      Object.values(row)), pattern);
  }
});

test('migration: client roles cannot read releases or the request log; only service_role runs the functions', async () => {
  for (const role of ['anon', 'authenticated']) {
    await assert.rejects(asRole(role, 'select * from public.game_releases'), /permission denied/);
    await assert.rejects(asRole(role, 'select * from public.game_download_requests'), /permission denied/);
    await assert.rejects(asRole(role, `select public.get_ready_game_release('x', 'windows-x64')`), /permission denied/);
  }
  await assert.rejects(asRole('service_role', 'select * from public.game_releases'), /permission denied/);
});

test('migration: per-account rate limit is atomic and records outcomes without URLs', async () => {
  const user = randomUUID();
  await db.query('insert into auth.users (id) values ($1)', [user]);
  const begin = (id) => asRole('service_role', 'select public.begin_game_download($1, $2, $3, $4, $5) as r',
    [id, user, SQUID.gameId, 3, 60]).then((result) => result.rows[0].r);
  const ids = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  for (const id of ids.slice(0, 3)) assert.equal((await begin(id)).allowed, true);
  const limited = await begin(ids[3]);
  assert.equal(limited.allowed, false);
  assert.ok(limited.retryAfter >= 1 && limited.retryAfter <= 60);
  await asRole('service_role', 'select public.finish_game_download($1, $2, $3)', [ids[0], 'issued', '9.5']);
  const rows = (await db.query('select outcome, version from public.game_download_requests where user_id = $1 order by created_at', [user])).rows;
  assert.deepEqual(rows.map((row) => row.outcome).sort(), ['issued', 'rate_limited', 'requested', 'requested']);
  assert.deepEqual(Object.keys(rows[0]).sort(), ['outcome', 'version']);
});

test('staging seed publishes exactly the two verified packages from the release manifest', async () => {
  await db.exec(`delete from public.game_releases`);
  const seed = await readFile(new URL('../supabase/staging/202611050008_game_releases_staging_seed.sql', import.meta.url), 'utf8');
  await db.exec(seed);
  await db.exec(seed); // idempotent
  const manifest = JSON.parse(await readFile('E:/PlayLive-Workspace/Releases/R2-2026-11-05/release-manifest.json', 'utf8').catch(() => 'null'));
  for (const id of ['disco-tiktok-live', SQUID.gameId]) {
    const release = await ready(id);
    const config = readDownloadConfig(ENV);
    assert.ok(validateRelease(release, id, config), id);
    if (manifest) {
      const expected = manifest.packages.find((p) => p.gameId === id);
      assert.equal(release.sha256, expected.sha256);
      assert.equal(Number(release.sizeBytes), expected.sizeBytes);
      assert.equal(release.executablePath, expected.executablePath);
      assert.equal(release.objectKey, expected.objectKey);
      assert.equal(release.version, expected.version);
    }
  }
  assert.equal((await ready(SQUID.gameId)).executablePath, 'Squid Game - Tiktok Live game V9.5.exe');
  assert.equal((await ready('disco-tiktok-live')).version, '2.1.0');
});
