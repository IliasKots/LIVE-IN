import { randomUUID } from 'node:crypto';

// POST /api/v1/games/{gameId}/download — contract: PLAYLIVE_WEB_DEVELOPER_R2_HANDOFF.md (launcher repo).
// Standard catalogue games are free: a valid launcher session and a verified email are the only requirements.
// No purchase, ownership, subscription or Points check, and no Points are charged for a download.

export const KNOWN_GAME_IDS = Object.freeze([
  'red-vs-blue', 'disco-tiktok-live', 'squid-game-tiktok-live', 'world-cup-country-battle',
  'driverush-live', 'score-goal', 'spacecrafts-race',
]);
export const PLATFORM = 'windows-x64';
const MAX_PACKAGE_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_BODY_CHARS = 1024;
const RESERVED = new Set(['CON', 'PRN', 'AUX', 'NUL', 'CONIN$', 'CONOUT$']);

const MESSAGES = {
  invalid_request: 'This download request could not be accepted.',
  unauthorized: 'Sign in to download.',
  verification_required: 'Verify your account email before downloading.',
  game_not_found: 'Game not found.',
  package_unavailable: 'Game package is not available yet.',
  rate_limited: 'Too many download requests. Please wait and try again.',
  server_error: 'The download service had a problem. Please try again later.',
  service_unavailable: 'Game downloads are temporarily unavailable.',
};
const STATUS = { invalid_request: 400, unauthorized: 401, verification_required: 403, game_not_found: 404,
  package_unavailable: 409, rate_limited: 429, server_error: 500, service_unavailable: 503 };

export function readDownloadConfig(env = process.env) {
  const accountId = (env.R2_ACCOUNT_ID || '').trim();
  const endpoint = (env.R2_S3_ENDPOINT || (accountId ? `https://${accountId}.r2.cloudflarestorage.com` : '')).trim();
  const ttl = Number.parseInt(env.PLAYLIVE_GAME_DOWNLOAD_URL_TTL_SECONDS || '900', 10);
  const limit = Number.parseInt(env.PLAYLIVE_GAME_DOWNLOAD_RATE_LIMIT || '10', 10);
  const config = {
    enabled: env.R2_DOWNLOADS_ENABLED === 'true',
    accountId,
    endpoint,
    bucket: (env.R2_BUCKET_NAME || '').trim(),
    accessKeyId: (env.R2_ACCESS_KEY_ID || '').trim(),
    secretAccessKey: (env.R2_SECRET_ACCESS_KEY || '').trim(),
    ttlSeconds: Number.isFinite(ttl) ? Math.min(3600, Math.max(60, ttl)) : 900,
    rateLimit: Number.isFinite(limit) ? Math.min(1000, Math.max(1, limit)) : 10,
    rateWindowSeconds: 60,
  };
  let endpointOk = false;
  try {
    const url = new URL(config.endpoint);
    endpointOk = url.protocol === 'https:' && !url.username && !url.password && url.pathname === '/'
      && !url.search && !url.hash && url.hostname.endsWith('.r2.cloudflarestorage.com');
  } catch { endpointOk = false; }
  config.complete = /^[0-9a-f]{32}$/.test(accountId) && endpointOk && /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(config.bucket)
    && config.accessKeyId.length >= 16 && config.secretAccessKey.length >= 32;
  return config;
}

// Mirrors LauncherPackageMetadataV7.NormalizeRelativePath in the Unity launcher.
export function isSafeRelativePath(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 240 || value !== value.trim()
    || value.startsWith('/') || /[\\:%<>"|?*]/.test(value) || /[\u0000-\u001f\u007f]/.test(value)) return false;
  for (const part of value.split('/')) {
    if (!part.trim() || part === '.' || part === '..' || part.endsWith('.') || part.endsWith(' ') || part !== part.trim()) return false;
    const stem = part.split('.')[0].toUpperCase();
    if (RESERVED.has(stem) || (stem.length === 4 && /^(COM|LPT)[0-9]$/.test(stem))) return false;
  }
  return true;
}

export function isSafeGameId(value) {
  return typeof value === 'string' && /^[a-z0-9_-]{1,100}$/.test(value);
}

// Defence in depth: the database constrains these too, but nothing malformed may reach the launcher.
export function validateRelease(release, gameId, config) {
  if (!release || typeof release !== 'object') return null;
  const size = typeof release.sizeBytes === 'string' && /^[0-9]{1,10}$/.test(release.sizeBytes)
    ? Number(release.sizeBytes) : release.sizeBytes;
  const ok = release.gameId === gameId && release.platform === PLATFORM
    && typeof release.version === 'string' && release.version.length >= 1 && release.version.length <= 64
    && release.version === release.version.trim() && !/[\u0000-\u001f\u007f]/.test(release.version)
    && release.bucket === config.bucket
    && typeof release.filename === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}\.zip$/.test(release.filename)
    && release.objectKey === `${gameId}/${release.version}/${release.filename}`
    && Number.isSafeInteger(size) && size >= 1 && size <= MAX_PACKAGE_BYTES
    && typeof release.sha256 === 'string' && /^[0-9a-f]{64}$/.test(release.sha256)
    && isSafeRelativePath(release.executablePath) && release.executablePath.toLowerCase().endsWith('.exe');
  return ok ? { ...release, sizeBytes: size } : null;
}

function respond(code, requestId, extraHeaders = {}) {
  return Response.json({ code, message: MESSAGES[code], requestId }, { status: STATUS[code], headers: {
    'Cache-Control': 'no-store', 'X-Request-Id': requestId, Vary: 'Authorization',
    ...(code === 'unauthorized' ? { 'WWW-Authenticate': 'Bearer' } : {}), ...extraHeaders } });
}

async function readEmptyBody(request) {
  const text = await request.text();
  if (text.length > MAX_BODY_CHARS) return false;
  if (!text.trim()) return true;
  try {
    const value = JSON.parse(text);
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  } catch { return false; }
}

function isoSeconds(ms) {
  return new Date(Math.floor(ms / 1000) * 1000).toISOString().replace('.000Z', 'Z');
}

/**
 * deps: authenticate(request) -> { userId } | null; getUser(userId) -> { emailConfirmedAt } | null;
 * beginRequest({ requestId, userId, gameId, limit, windowSeconds }) -> { allowed, retryAfter };
 * finishRequest(requestId, outcome, version); findReadyRelease(gameId, platform) -> release | null;
 * sign({ bucket, key, expiresIn, signingDate }) -> url; now() -> ms; log(event).
 */
export async function handleGameDownload(request, rawGameId, deps, config) {
  const requestId = randomUUID();
  const log = deps.log || (() => {});
  const gameId = typeof rawGameId === 'string' ? rawGameId : '';
  try {
    if (!isSafeGameId(gameId) || !(await readEmptyBody(request))) return respond('invalid_request', requestId);
    if (!config.enabled || !config.complete) return respond('service_unavailable', requestId);
    const auth = await deps.authenticate(request);
    if (!auth?.userId) return respond('unauthorized', requestId);
    const user = await deps.getUser(auth.userId);
    if (!user) return respond('unauthorized', requestId);
    if (!user.emailConfirmedAt) return respond('verification_required', requestId);

    const gate = await deps.beginRequest({ requestId, userId: auth.userId, gameId,
      limit: config.rateLimit, windowSeconds: config.rateWindowSeconds });
    if (!gate?.allowed) {
      log({ event: 'game_download', requestId, gameId, outcome: 'rate_limited' });
      return respond('rate_limited', requestId, { 'Retry-After': String(Math.max(1, gate?.retryAfter || 60)) });
    }
    const finish = async (outcome, version = null) => {
      try { await deps.finishRequest(requestId, outcome, version); } catch { log({ event: 'game_download_audit_failed', requestId }); }
    };
    if (!KNOWN_GAME_IDS.includes(gameId)) { await finish('game_not_found'); return respond('game_not_found', requestId); }
    const release = validateRelease(await deps.findReadyRelease(gameId, PLATFORM), gameId, config);
    if (!release) {
      await finish('package_unavailable');
      log({ event: 'game_download', requestId, gameId, outcome: 'package_unavailable' });
      return respond('package_unavailable', requestId);
    }
    const signedAt = deps.now();
    let downloadUrl;
    try {
      downloadUrl = await deps.sign({ bucket: release.bucket, key: release.objectKey,
        expiresIn: config.ttlSeconds, signingDate: new Date(signedAt) });
      const url = new URL(downloadUrl);
      if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error('UNSAFE_URL');
    } catch {
      await finish('signing_failed', release.version);
      log({ event: 'game_download', requestId, gameId, outcome: 'signing_failed' });
      return respond('service_unavailable', requestId);
    }
    await finish('issued', release.version);
    log({ event: 'game_download', requestId, gameId, version: release.version, outcome: 'issued' });
    return Response.json({
      gameId, version: release.version, downloadUrl,
      expiresAt: isoSeconds(signedAt + config.ttlSeconds * 1000),
      sha256: release.sha256, sizeBytes: release.sizeBytes, executablePath: release.executablePath,
    }, { status: 200, headers: { 'Cache-Control': 'no-store', 'X-Request-Id': requestId, Vary: 'Authorization',
      'Referrer-Policy': 'no-referrer' } });
  } catch (error) {
    log({ event: 'game_download', requestId, gameId: isSafeGameId(gameId) ? gameId : null, outcome: 'server_error',
      error: error?.message === 'LAUNCHER_AUTH_UNAVAILABLE' ? 'auth_unavailable' : 'unexpected' });
    return respond('server_error', requestId);
  }
}
