import { PointsError } from './points-core.mjs';
import { processStripeWebhook, packsResponse } from './points-stripe-core.mjs';

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
export function createStripeWebhookHandler({ getConfig, getAdminClient, now = () => Math.floor(Date.now() / 1000) }) {
  return async function POST(request) {
    const headers = { 'Cache-Control': 'no-store' };
    try {
      const config = getConfig();
      if (!config.selected) return Response.json({ error: 'PAYMENTS_NOT_CONFIGURED' }, { status: 503, headers });
      const body = await rawBody(request);
      const result = await processStripeWebhook(getAdminClient(), config, body,
        request.headers.get('stripe-signature'), now());
      return Response.json(result.body, { status: result.status, headers });
    } catch (error) {
      const status = error instanceof PointsError ? error.status : 503;
      return Response.json({ error: status === 503 ? 'POINTS_UNAVAILABLE' : 'INVALID_PAYLOAD' }, { status, headers });
    }
  };
}

export function createStripePacksHandler({ getConfig }) {
  return function GET() {
    try {
      return Response.json(packsResponse(getConfig()), { headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
    } catch {
      return Response.json({ error: 'Points packs are temporarily unavailable' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
    }
  };
}
