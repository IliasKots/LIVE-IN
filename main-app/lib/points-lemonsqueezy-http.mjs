import { PointsError } from './points-core.mjs';
import { smallRequestBody } from './points-itch-http.mjs';
import { createCheckoutOrder, getCheckoutOrder, retryQueuedPayments, publicOrder, processLemonSqueezyWebhook, packsResponse,
  mockPaymentsAllowed, mockCheckoutToken, mockOrderPayload, mockWebhookSecret, signWebhookBody,
  orderRpc, PAYMENTS_NOT_CONFIGURED_MESSAGE } from './points-lemonsqueezy-core.mjs';
import { timingSafeEqual } from 'node:crypto';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const privateHeaders = { 'Cache-Control': 'private, no-store, max-age=0', Vary: 'Authorization' };
const json = (body, status = 200, headers = privateHeaders) => Response.json(body, { status, headers });
const errorBody = (code) => ({ error: code, ...(code === 'PAYMENTS_NOT_CONFIGURED' ? { message: PAYMENTS_NOT_CONFIGURED_MESSAGE } : {}) });
const errorResponse = (error) => json(errorBody(error instanceof PointsError ? error.code : 'POINTS_UNAVAILABLE'),
  error instanceof PointsError ? error.status : 503);

export function createLemonSqueezyPacksHandler({ getConfig }) {
  return function GET() {
    try {
      return Response.json(packsResponse(getConfig()), { headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
    } catch {
      return Response.json({ error: 'Points packs are temporarily unavailable' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
    }
  };
}

// Launcher endpoints. The account is ONLY the verified session's user; a body may
// name a pack and nothing else is read (user IDs, amounts and prices are ignored).
export function createPointOrdersHandler({ authenticate, getAdminClient, getConfig, readsEnabled, fetchImpl = fetch,
  providerCheckout = undefined }) {
  return {
    async GET(request) {
      try {
        const auth = await authenticate(request);
        if (!auth) return json({ error: 'UNAUTHORIZED' }, 401);
        if (!readsEnabled()) return json({ error: 'POINTS_DISABLED' }, 503);
        const values = new URL(request.url).searchParams.getAll('order');
        if (values.length > 1 || (values.length === 1 && !UUID.test(values[0]))) return json({ error: 'INVALID_PURCHASE_INTENT' }, 400);
        const client = getAdminClient();
        let order = await getCheckoutOrder(client, auth.userId, values[0] ?? null);
        // A verified payment that could not be credited earlier is credited now.
        if (order?.status === 'pending' && getConfig().walletEnabled
          && (await retryQueuedPayments(client, order.id))?.credited > 0)
          order = await getCheckoutOrder(client, auth.userId, order.id);
        order = publicOrder(order);
        // Another account's order is indistinguishable from an unknown one.
        if (values.length === 1 && !order) return json({ error: 'UNKNOWN_PURCHASE_INTENT' }, 404);
        return json({ order });
      } catch (error) { return errorResponse(error); }
    },
    async POST(request) {
      try {
        const auth = await authenticate(request);
        if (!auth) return json({ error: 'UNAUTHORIZED' }, 401);
        const config = getConfig();
        if (config.state !== 'ready') return json(errorBody('PAYMENTS_NOT_CONFIGURED'), 503);
        let body;
        try { body = JSON.parse(await smallRequestBody(request)); } catch { return json({ error: 'INVALID_REQUEST' }, 400); }
        const result = await createCheckoutOrder(getAdminClient(), config, auth.userId, body?.packId, fetchImpl,
          providerCheckout);
        return json({ order: publicOrder(result.order), checkoutUrl: result.checkoutUrl, reused: result.reused });
      } catch (error) { return errorResponse(error); }
    },
  };
}

async function rawBody(request, limit = 262144) {
  const reader = request.body?.getReader();
  if (!reader) throw new PointsError('INVALID_PAYLOAD', 400);
  const chunks = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > limit) { await reader.cancel(); throw new PointsError('INVALID_PAYLOAD', 413); }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

// Signature is verified over the exact bytes received, before any JSON parsing.
export function createLemonSqueezyWebhookHandler({ getConfig, getAdminClient, provider = 'lemonsqueezy' }) {
  return async function POST(request) {
    const headers = { 'Cache-Control': 'no-store' };
    try {
      const config = getConfig();
      if (!config.selected || config.provider !== provider) return Response.json({ error: 'PAYMENTS_NOT_CONFIGURED' }, { status: 503, headers });
      const body = await rawBody(request);
      const result = await processLemonSqueezyWebhook(getAdminClient(), config, body, {
        signature: request.headers.get('x-signature'), eventName: request.headers.get('x-event-name') }, { provider });
      return Response.json(result.body, { status: result.status, headers });
    } catch (error) {
      const status = error instanceof PointsError ? error.status : 503;
      return Response.json({ error: status === 503 ? 'POINTS_UNAVAILABLE' : 'INVALID_PAYLOAD' }, { status, headers });
    }
  };
}

const sameToken = (a, b) => typeof a === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b)
  && timingSafeEqual(Buffer.from(a), Buffer.from(b));

// DEVELOPMENT ONLY. 404 unless mockPaymentsAllowed(): a local/staging deployment,
// LEMONSQUEEZY_MODE=mock, POINTS_MOCK_PAYMENTS_ENABLED=true and not Vercel production.
// Possession of the checkout link (token) stands in for a hosted checkout page; the
// payment then travels through the real signed-webhook delivery code.
export function createMockCheckoutHandler({ getConfig, getAdminClient, isAllowed = mockPaymentsAllowed }) {
  return async function POST(request) {
    if (!isAllowed()) return new Response(null, { status: 404 });
    try {
      const config = getConfig();
      if (config.provider !== 'mock' || config.state !== 'ready') return json(errorBody('PAYMENTS_NOT_CONFIGURED'), 503, { 'Cache-Control': 'no-store' });
      if (request.headers.get('origin') !== config.origin) return json({ error: 'INVALID_ORIGIN' }, 403);
      let body;
      try { body = JSON.parse(await smallRequestBody(request)); } catch { return json({ error: 'INVALID_REQUEST' }, 400); }
      if (!UUID.test(body?.orderId || '') || !sameToken(body?.token, mockCheckoutToken(config, body.orderId))
        || !['paid', 'failed'].includes(body?.outcome)) return json({ error: 'INVALID_REQUEST' }, 400);
      const client = getAdminClient();
      const order = await orderRpc(client, 'get_point_checkout_order_for_delivery', { p_order_id: body.orderId });
      if (!order || order.provider !== 'mock') return json({ error: 'UNKNOWN_PURCHASE_INTENT' }, 404);
      const raw = Buffer.from(JSON.stringify(mockOrderPayload(config, order, body.outcome)));
      const result = await processLemonSqueezyWebhook(client, config, raw,
        { signature: signWebhookBody(raw, mockWebhookSecret(config)), eventName: 'order_created' }, { provider: 'mock' });
      return json({ mock: true, ...result.body }, result.status);
    } catch (error) { return errorResponse(error); }
  };
}
