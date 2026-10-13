import { PointsError } from './points-core.mjs';
import { startUsageSession, updateUsageSession, getUsageSession, chargeUsage, listProducts, listEntitlements,
  purchaseProduct, listPurchaseLots, requestRefund } from './points-economy-core.mjs';

const headers = { 'Cache-Control': 'private, no-store, max-age=0', Vary: 'Authorization' };
const json = (body, status = 200) => Response.json(body, { status, headers });
const errorResponse = (error) => error instanceof PointsError
  ? json({ error: error.code }, error.status) : json({ error: 'POINTS_UNAVAILABLE' }, 503);

// Bounded JSON body. A gift batch is larger than other launcher requests.
export async function jsonBody(request, limit = 32768) {
  const reader = request.body?.getReader();
  if (!reader) throw new PointsError('INVALID_REQUEST', 400);
  const chunks = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > limit) { await reader.cancel(); throw new PointsError('INVALID_REQUEST', 413); }
    chunks.push(Buffer.from(value));
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new PointsError('INVALID_REQUEST', 400); }
}

// Shared shape: authenticate first (401), then the feature switch (503), then work.
function guarded({ authenticate, isEnabled, disabledCode }, work) {
  return async function handler(request) {
    try {
      const auth = await authenticate(request);
      if (!auth) return json({ error: 'UNAUTHORIZED' }, 401);
      if (!isEnabled()) return json({ error: disabledCode }, 503);
      return json(await work(request, auth));
    } catch (error) { return errorResponse(error); }
  };
}

export function createUsageHandlers({ authenticate, getAdminClient, getFlags }) {
  const options = { authenticate, isEnabled: () => getFlags().usageBilling, disabledCode: 'USAGE_BILLING_DISABLED' };
  return {
    sessions: {
      POST: guarded(options, async (request, auth) => startUsageSession(getAdminClient(), auth.userId, await jsonBody(request, 2048))),
      GET: guarded(options, async (request, auth) => ({ session: await getUsageSession(getAdminClient(), auth.userId,
        new URL(request.url).searchParams.get('session')) })),
    },
    state: { POST: guarded(options, async (request, auth) => updateUsageSession(getAdminClient(), auth.userId, await jsonBody(request, 2048))) },
    charges: { POST: guarded(options, async (request, auth) => chargeUsage(getAdminClient(), auth.userId, await jsonBody(request))) },
  };
}

export function createProductHandlers({ authenticate, getAdminClient, getFlags }) {
  const options = { authenticate, isEnabled: () => getFlags().products, disabledCode: 'PRODUCTS_DISABLED' };
  const gameParam = (request) => {
    const values = new URL(request.url).searchParams.getAll('gameId');
    if (values.length > 1) throw new PointsError('INVALID_PRODUCT_REQUEST', 400);
    return values[0] ?? null;
  };
  return {
    products: { GET: guarded(options, async (request) => ({ products: await listProducts(getAdminClient(), gameParam(request)) })) },
    entitlements: { GET: guarded(options, async (request, auth) => ({
      entitlements: await listEntitlements(getAdminClient(), auth.userId, gameParam(request)) })) },
    purchases: { POST: guarded(options, async (request, auth) => {
      try { return await purchaseProduct(getAdminClient(), auth.userId, await jsonBody(request, 1024)); }
      catch (error) {
        // Insufficient Points: nothing was charged and nothing was granted.
        if (error instanceof PointsError && error.code === 'INSUFFICIENT_POINTS') return { status: 'insufficient_points' };
        throw error;
      }
    }) },
  };
}

export function createRefundHandlers({ authenticate, getAdminClient, getFlags }) {
  return {
    lots: { GET: guarded({ authenticate, isEnabled: () => getFlags().reads, disabledCode: 'POINTS_DISABLED' },
      async (request, auth) => ({ purchases: await listPurchaseLots(getAdminClient(), auth.userId) })) },
    requests: { POST: guarded({ authenticate, isEnabled: () => getFlags().refundRequests, disabledCode: 'REFUND_REQUESTS_DISABLED' },
      async (request, auth) => requestRefund(getAdminClient(), auth.userId, await jsonBody(request, 1024))) },
  };
}
