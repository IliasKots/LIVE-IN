import { PointsError } from './points-core.mjs';
import { createPurchaseIntent, getPurchaseIntent, publicPurchase } from './points-purchases-core.mjs';
import { smallRequestBody } from './points-itch-http.mjs';
const headers = { 'Cache-Control': 'private, no-store, max-age=0', Vary: 'Authorization, Cookie' };
const json = (body, status = 200) => Response.json(body, { status, headers });
export function createPointsPurchasesHandler({ authenticate, getAdminClient, getConfig, readsEnabled,
  createIntent = createPurchaseIntent, getIntent = getPurchaseIntent, browser = false }) {
  const error = (value) => json({ error: value instanceof PointsError ? value.code : 'POINTS_UNAVAILABLE' },
    value instanceof PointsError ? value.status : 503);
  return {
    async GET(request) {
      try {
        const auth = await authenticate(request);
        if (!auth) return json({ error: 'UNAUTHORIZED' }, 401);
        if (!readsEnabled()) return json({ error: 'POINTS_DISABLED' }, 503);
        const values = new URL(request.url).searchParams.getAll('intent');
        if (values.length > 1) return json({ error: 'INVALID_PURCHASE_INTENT' }, 400);
        return json({ purchase: publicPurchase(await getIntent(getAdminClient(), auth.userId, values[0] ?? null)) });
      } catch (value) { return error(value); }
    },
    async POST(request) {
      try {
        const auth = await authenticate(request);
        if (!auth) return json({ error: 'UNAUTHORIZED' }, 401);
        const config = getConfig();
        if (browser && request.headers.get('origin') !== config.origin) return json({ error: 'INVALID_ORIGIN' }, 403);
        const raw = await smallRequestBody(request);
        let body;
        try { body = JSON.parse(raw); } catch { return json({ error: 'INVALID_REQUEST' }, 400); }
        return json({ purchase: publicPurchase(await createIntent(getAdminClient(), config, auth.userId, body?.packId)) });
      } catch (value) { return error(value); }
    },
  };
}
