import { createHmac, timingSafeEqual, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { pointInteger, PointsError, awardPoints, getPointAccount } from './points-core.mjs';
import { pointsMutationsAllowed, pointsProductsVerified } from './points-policy.mjs';
import { PURCHASE_UUID, creditPurchaseIntent } from './points-purchases-core.mjs';
import { configuredPlayLivePacks, PLAYLIVE_POINT_PACKS } from './points-catalog.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const object = (value) => value && typeof value === 'object' && !Array.isArray(value);
const fail = (code, status = 400) => { throw new PointsError(code, status); };
const now = () => Math.floor(Date.now() / 1000);

function numericId(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === 'string' && /^[1-9]\d{0,19}$/.test(value)) return value;
  return fail('INVALID_PURCHASE');
}

export function readItchConfig(env = process.env) {
  const config = { checkoutEnabled: env.POINTS_ITCH_CHECKOUT_ENABLED === 'true',
    claimsEnabled: env.POINTS_ITCH_CLAIMS_ENABLED === 'true',
    walletEnabled: pointsMutationsAllowed(env) && pointsProductsVerified(env),
    packs: [], blockedPurchaseIds: [], projectUrl: null, origin: null, secret: env.ITCH_POINTS_REDEEM_SECRET || '' };
  if (!config.checkoutEnabled && !config.claimsEnabled) return config;
  try {
    const project = new URL(env.ITCH_POINTS_PROJECT_URL);
    if (project.protocol !== 'https:' || project.username || project.password || project.port
      || !/^[a-z0-9][a-z0-9-]*\.itch\.io$/.test(project.hostname)
      || !/^\/[a-z0-9][a-z0-9-]*\/?$/.test(project.pathname) || project.search || project.hash) throw new Error();
    const site = new URL(env.POINTS_SITE_ORIGIN);
    if (site.username || site.password || site.pathname !== '/' || site.search || site.hash
      || (site.protocol !== 'https:' && !(env.NODE_ENV !== 'production' && site.protocol === 'http:'
        && ['localhost', '127.0.0.1', '[::1]'].includes(site.hostname)))) throw new Error();
    if (config.secret.length < 16) throw new Error();
    config.projectUrl = project.href.replace(/\/$/, '');
    config.origin = site.origin;
    const blocked = JSON.parse(env.ITCH_POINTS_BLOCKED_PURCHASE_IDS_JSON || '[]');
    if (!Array.isArray(blocked) || blocked.length > 2000) throw new Error();
    config.blockedPurchaseIds = blocked.map(numericId);
    // New installations configure only provider IDs; amounts come from our catalog.
    // Retain the old private catalog for previously issued signed purchases.
    const packs = env.ITCH_POINTS_PRODUCT_IDS_JSON
      ? configuredPlayLivePacks(JSON.parse(env.ITCH_POINTS_PRODUCT_IDS_JSON))
      : JSON.parse(env.ITCH_POINTS_PACKS_JSON || '[]');
    if (env.ITCH_POINTS_PRODUCT_IDS_JSON && JSON.parse(env.ITCH_POINTS_PACKS_JSON || '[]').length)
      throw new Error('AMBIGUOUS_CATALOG');
    if (!Array.isArray(packs) || packs.length > 20) throw new Error();
    const ids = new Set();
    const products = new Set();
    config.packs = packs.map((pack) => {
      if (!object(pack) || !/^[a-z0-9][a-z0-9_-]{0,49}$/.test(pack.id)
        || typeof pack.name !== 'string' || !pack.name.trim() || pack.name.length > 100
        || typeof pack.priceLabel !== 'string' || !pack.priceLabel.trim() || pack.priceLabel.length > 50
        || typeof pack.enabled !== 'boolean' || ids.has(pack.id)) throw new Error();
      const subProductId = numericId(pack.subProductId);
      if (products.has(subProductId)) throw new Error();
      ids.add(pack.id); products.add(subProductId);
      const currency = pack.currency ?? null;
      const priceMinor = pack.priceMinor ?? null;
      if ((currency === null) !== (priceMinor === null)
        || (currency !== null && (!/^[A-Z]{3}$/.test(currency) || typeof currency !== 'string'))) throw new Error();
      if (currency !== null && (!Intl.supportedValuesOf('currency').includes(currency)
        || new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits !== 2)) throw new Error();
      if (priceMinor !== null) pointInteger(priceMinor, { nonzero: true });
      const approved = PLAYLIVE_POINT_PACKS.find((value) => value.id === pack.id);
      // Old server snapshots remain claimable, but a priced commercial pack cannot
      // silently drift from the approved points, currency or minimum price.
      if (approved && currency !== null && (pack.points !== approved.points
        || currency !== approved.currency || priceMinor !== approved.priceMinor)) throw new Error();
      return { id: pack.id, name: pack.name.trim(), points: pointInteger(pack.points, { nonzero: true }),
        subProductId, priceLabel: pack.priceLabel, currency, priceMinor, enabled: pack.enabled };
    });
    return config;
  } catch {
    return fail('PURCHASE_CONFIGURATION_UNAVAILABLE', 503);
  }
}

export function publicItchPacks(config) {
  if (!config.checkoutEnabled || !config.claimsEnabled || !config.walletEnabled) return [];
  return config.packs.filter((pack) => pack.enabled && pack.currency && pack.priceMinor)
    .map(({ id, name, points, priceLabel, currency, priceMinor }) => ({ id, name, points, priceLabel, currency, priceMinor }));
}

function sign(payload, secret) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const message = `${header}.${body}`;
  return `${message}.${createHmac('sha256', secret).update(message).digest('base64url')}`;
}

function verify(token, secret) {
  try {
    if (typeof token !== 'string' || token.length > 4096 || !/^[\w-]+\.[\w-]+\.[\w-]+$/.test(token)) throw new Error();
    const [header, body, signature] = token.split('.');
    const decodedHeader = JSON.parse(Buffer.from(header, 'base64url').toString());
    if (!object(decodedHeader) || decodedHeader.alg !== 'HS256' || decodedHeader.crit) throw new Error();
    const expected = createHmac('sha256', secret).update(`${header}.${body}`).digest();
    const supplied = Buffer.from(signature, 'base64url');
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new Error();
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (!object(payload)) throw new Error();
    return payload;
  } catch { return fail('INVALID_PURCHASE'); }
}

export function createItchCheckout(config, userId, packId, intent = null) {
  if (!config.checkoutEnabled || !config.claimsEnabled || !config.walletEnabled) return fail('CHECKOUT_DISABLED', 503);
  if (!UUID.test(userId)) return fail('UNAUTHORIZED', 401);
  const pack = config.packs.find((value) => value.id === packId && value.enabled);
  if (!pack) return fail('UNKNOWN_PACK');
  if (intent && (!PURCHASE_UUID.test(intent.id) || intent.userId !== userId || intent.packId !== pack.id
    || intent.projectUrl !== config.projectUrl || intent.subProductId !== pack.subProductId
    || intent.points !== pack.points || intent.currency !== pack.currency || intent.priceMinor !== pack.priceMinor))
    return fail('PACK_MISMATCH', 409);
  // A snapshot keeps outstanding purchases valid when names/rates change later.
  // No purchase_id/iat/exp fields: this token cannot masquerade as a redeem proof.
  const metadata = sign({ playlive: 'points-v1', project: config.projectUrl, userId,
    packId: pack.id, subProductId: pack.subProductId, points: pack.points, name: pack.name,
    ...(intent ? { intentId: intent.id, currency: intent.currency, priceMinor: intent.priceMinor } : {}) }, config.secret);
  if (metadata.length >= 1024) return fail('PURCHASE_CONFIGURATION_UNAVAILABLE', 503);
  const url = new URL(`${config.projectUrl}/purchase`);
  url.searchParams.set('sub_product_id', pack.subProductId);
  url.searchParams.set('metadata', metadata);
  url.searchParams.set('popup', '1');
  return url.href;
}

export function verifyItchClaim(config, token, time = now()) {
  if (!config.claimsEnabled || !config.walletEnabled) return fail('CLAIMS_DISABLED', 503);
  const payload = verify(token, config.secret);
  if (!Number.isSafeInteger(payload.iat) || !Number.isSafeInteger(payload.exp)
    || payload.iat > time + 60 || payload.iat < 0 || payload.exp <= payload.iat) return fail('INVALID_PURCHASE');
  if (payload.nbf !== undefined && (!Number.isSafeInteger(payload.nbf) || payload.nbf > time)) return fail('INVALID_PURCHASE');
  if (payload.exp <= time) return fail('CLAIM_EXPIRED', 410);
  // A redeem JWT is the documented purchase evidence. If an extended proof
  // exposes a payment status, never accept pending/failed/cancelled/refunded.
  if (payload.status !== undefined && payload.status !== 'complete') return fail('PAYMENT_NOT_COMPLETE', 409);
  const metadata = payload.metadata;
  if (!object(metadata) || metadata.playlive !== 'points-v1' || metadata.project !== config.projectUrl
    || !UUID.test(metadata.userId) || !/^[a-z0-9][a-z0-9_-]{0,49}$/.test(metadata.packId)
    || typeof metadata.name !== 'string' || !metadata.name.trim() || metadata.name.length > 100) return fail('UNLINKED_PURCHASE');
  const subProductId = numericId(payload.sub_product_id);
  if (subProductId !== metadata.subProductId) return fail('PACK_MISMATCH');
  if (payload.external_id !== undefined && payload.external_id !== metadata.packId) return fail('PACK_MISMATCH');
  const purchaseId = numericId(payload.purchase_id);
  if (config.blockedPurchaseIds.includes(purchaseId)) return fail('PURCHASE_REFUNDED', 409);
  if (metadata.intentId !== undefined && !PURCHASE_UUID.test(metadata.intentId)) return fail('INVALID_PURCHASE');
  // The documented redeem JWT does not promise price/currency. If present in a
  // provider-issued proof, validate these fields instead of trusting intent prices.
  let paidCurrency = null, paidMinor = null;
  if (payload.currency !== undefined || payload.price !== undefined) {
    if (typeof payload.currency !== 'string' || !/^[A-Z]{3}$/.test(payload.currency)) return fail('INVALID_PAYMENT_DETAILS');
    paidCurrency = payload.currency;
    if (payload.price !== undefined) {
      // Current priced packs support currencies with two decimal minor units.
      // Unknown/numeric/locale price representations fail closed; no float coercion.
      if (typeof payload.price !== 'string') return fail('INVALID_PAYMENT_DETAILS');
      const match = /^(?:[A-Z]{3} |[^0-9\s.]{1,3})?([0-9]+)(?:\.([0-9]{2}))?$/.exec(payload.price);
      if (!match) return fail('INVALID_PAYMENT_DETAILS');
      paidMinor = pointInteger(String(BigInt(match[1]) * 100n + BigInt(match[2] || '0')));
    }
  }
  return { purchaseId, userId: metadata.userId,
    packId: metadata.packId, subProductId, points: pointInteger(metadata.points, { nonzero: true }), name: metadata.name,
    ...(metadata.intentId ? { intentId: metadata.intentId, currency: metadata.currency,
      priceMinor: metadata.priceMinor, paidCurrency, paidMinor } : {}) };
}

const continuationKey = (secret) => createHmac('sha256', secret).update('PlayLive:verified-itch-claim:v1').digest();
export function sealPendingClaim(claim, secret, time = now()) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', continuationKey(secret), nonce);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify({ claim, expires: time + 7 * 86400 })), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString('base64url');
}

export function openPendingClaim(value, secret, time = now()) {
  try {
    if (typeof value !== 'string' || value.length > 3500 || !/^[\w-]+$/.test(value)) throw new Error();
    const bytes = Buffer.from(value, 'base64url');
    const cipher = createDecipheriv('aes-256-gcm', continuationKey(secret), bytes.subarray(0, 12));
    cipher.setAuthTag(bytes.subarray(12, 28));
    const data = JSON.parse(Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString());
    if (!Number.isSafeInteger(data.expires) || data.expires <= time || !object(data.claim)) throw new Error();
    return data.claim;
  } catch { return fail('NO_PENDING_CLAIM', 410); }
}

export async function redeemItchClaim(client, config, claim, signedInUserId) {
  if (!config.claimsEnabled || !config.walletEnabled) return fail('CLAIMS_DISABLED', 503);
  if (!signedInUserId) return fail('UNAUTHORIZED', 401);
  if (signedInUserId !== claim.userId) return fail('WRONG_ACCOUNT', 403);
  if (config.blockedPurchaseIds.includes(claim.purchaseId)) return fail('PURCHASE_REFUNDED', 409);
  const result = claim.intentId ? await creditPurchaseIntent(client, config, claim, signedInUserId)
    : await awardPoints(client, { userId: claim.userId, amount: claim.points,
    reason: 'itch.io points purchase', sourceType: 'itch.io', sourceId: claim.purchaseId,
    idempotencyKey: `itch.io:purchase:${claim.purchaseId}`,
    metadata: { packId: claim.packId, subProductId: claim.subProductId, points: claim.points, name: claim.name } });
  const account = await getPointAccount(client, claim.userId);
  return { duplicate: result.duplicate === true, points: claim.points, balance: account.balance, transactionId: result.id,
    ...(claim.intentId ? { intentId: claim.intentId } : {}) };
}
