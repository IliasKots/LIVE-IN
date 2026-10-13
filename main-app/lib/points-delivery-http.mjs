import { PointsError } from './points-core.mjs';
import { smallRequestBody } from './points-itch-http.mjs';
import { recoverPointDelivery } from './points-delivery-core.mjs';

export function createPointsDeliveryHandler({ authenticate, getAdminClient, getConfig,
  browser = false, recover = recoverPointDelivery }) {
  return async function POST(request) {
    const headers = { 'Cache-Control': 'private, no-store', Vary: 'Authorization, Cookie' };
    try {
      const config = getConfig();
      if (!config.claimsEnabled || !config.walletEnabled) throw new PointsError('CLAIMS_DISABLED', 503);
      if (browser && request.headers.get('origin') !== config.origin) throw new PointsError('INVALID_ORIGIN', 403);
      const auth = await authenticate(request);
      if (!auth) throw new PointsError('UNAUTHORIZED', 401);
      let body;
      try { body = JSON.parse(await smallRequestBody(request)); }
      catch { throw new PointsError('INVALID_REQUEST', 400); }
      return Response.json(await recover(getAdminClient(), config, auth.userId, body?.intentId), { headers });
    } catch (error) {
      return Response.json({ error: error instanceof PointsError ? error.code : 'POINTS_UNAVAILABLE' },
        { status: error instanceof PointsError ? error.status : 503, headers });
    }
  };
}
