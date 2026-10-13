import { PointsError } from './points-core.mjs';
import { createItchCheckout, verifyItchClaim, sealPendingClaim, openPendingClaim, redeemItchClaim } from './points-itch-core.mjs';
import { createPurchaseIntent, getPurchaseIntent } from './points-purchases-core.mjs';
import { rememberVerifiedItchClaim } from './points-delivery-core.mjs';

export const CLAIM_COOKIE = 'playlive_itch_claim';
export const CLAIM_PATH = '/launcher/points/claim';
const headers = { 'Cache-Control': 'private, no-store, max-age=0', 'Referrer-Policy': 'no-referrer', Vary: 'Cookie' };
const json = (body, status = 200) => Response.json(body, { status, headers });
const cookie = (value, config) => `${CLAIM_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800${config.origin?.startsWith('https:') ? '; Secure' : ''}`;
const pending = (request) => request.headers.get('cookie')?.split(';').map((value) => value.trim())
  .find((value) => value.startsWith(`${CLAIM_COOKIE}=`))?.slice(CLAIM_COOKIE.length + 1);
const sameOrigin = (request, config) => request.headers.get('origin') === config.origin;
const errorResponse = (error) => json({ error: error instanceof PointsError ? error.code : 'POINTS_UNAVAILABLE' }, error instanceof PointsError ? error.status : 503);

export async function smallRequestBody(request) {
  const reader = request.body?.getReader();
  if (!reader) throw new PointsError('INVALID_REQUEST', 400);
  const chunks = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > 1024) { await reader.cancel(); throw new PointsError('INVALID_REQUEST', 400); }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function createItchCheckoutHandler({ getConfig, authenticate, getAdminClient,
  createIntent = createPurchaseIntent, getIntent = getPurchaseIntent }) {
  return async function POST(request) {
    try {
      const config = getConfig();
      if (!config.checkoutEnabled || !config.claimsEnabled || !config.walletEnabled) return json({ error: 'CHECKOUT_DISABLED' }, 503);
      if (!sameOrigin(request, config)) return json({ error: 'INVALID_ORIGIN' }, 403);
      const auth = await authenticate();
      if (!auth) return json({ error: 'UNAUTHORIZED' }, 401);
      if (Number(request.headers.get('content-length') || 0) > 1024) return json({ error: 'INVALID_REQUEST' }, 400);
      const raw = await smallRequestBody(request);
      let body;
      try { body = JSON.parse(raw); } catch { return json({ error: 'INVALID_REQUEST' }, 400); }
      const client = getAdminClient();
      const intent = body?.intentId
        ? await getIntent(client, auth.userId, body.intentId)
        : await createIntent(client, config, auth.userId, body?.packId);
      if (!intent) throw new PointsError('UNKNOWN_PURCHASE_INTENT', 404);
      if (intent.packId !== body?.packId) throw new PointsError('PACK_MISMATCH', 409);
      if (intent.status === 'refunded') throw new PointsError('PURCHASE_REFUNDED', 409);
      if (intent.status === 'credited') return json({ intentId: intent.id, alreadyCredited: true });
      return json({ url: createItchCheckout(config, auth.userId, body.packId, intent), intentId: intent.id });
    } catch (error) { return errorResponse(error); }
  };
}

export function createItchRedeemHandler({ getConfig, getAdminClient, rememberClaim = rememberVerifiedItchClaim }) {
  return async function GET(request) {
    let config;
    let status;
    let claimCookie;
    try {
      config = getConfig();
      const tokens = new URL(request.url).searchParams.getAll('jwt');
      if (tokens.length !== 1) throw new PointsError('INVALID_PURCHASE', 400);
      const claim = verifyItchClaim(config, tokens[0]);
      claimCookie = cookie(sealPendingClaim(claim, config.secret), config);
      if (claim.intentId) await rememberClaim(getAdminClient(), config, claim);
    } catch (error) {
      status = error instanceof PointsError ? error.code : 'POINTS_UNAVAILABLE';
    }
    // The raw proof never enters a rendered page, analytics, or a login URL.
    // Keep a valid continuation on a temporary database outage; the authenticated
    // POST retries persistence and delivery. Invalid proofs never get a cookie.
    const location = `${CLAIM_PATH}${status && !(claimCookie && status === 'POINTS_UNAVAILABLE')
      ? `?status=${encodeURIComponent(status)}` : ''}`;
    return new Response(null, { status: 303, headers: { ...headers, Location: location, ...(claimCookie ? { 'Set-Cookie': claimCookie } : {}) } });
  };
}

export function createItchClaimHandler({ getConfig, authenticate, getAdminClient }) {
  return async function POST(request) {
    try {
      const config = getConfig();
      if (!config.claimsEnabled || !config.walletEnabled) return json({ error: 'CLAIMS_DISABLED' }, 503);
      if (!sameOrigin(request, config)) return json({ error: 'INVALID_ORIGIN' }, 403);
      const auth = await authenticate();
      if (!auth) return json({ error: 'UNAUTHORIZED' }, 401);
      const claim = openPendingClaim(pending(request), config.secret);
      if (claim.userId !== auth.userId) throw new PointsError('WRONG_ACCOUNT', 403);
      const client = getAdminClient();
      await rememberVerifiedItchClaim(client, config, claim);
      return json(await redeemItchClaim(client, config, claim, auth.userId));
      // Keep the sealed proof for seven days so retries can show "already credited".
    } catch (error) { return errorResponse(error); }
  };
}
