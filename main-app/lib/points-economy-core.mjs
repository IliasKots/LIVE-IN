// Points economy: TikTok gift usage billing, in-game Point products, purchase-lot
// usage and refund settlement. Pure server logic: the Supabase service client is
// injected. Accounts always come from the verified launcher session; clients
// never supply an amount, price, Diamond quantity or account ID.
import { PointsError } from './points-core.mjs';
import { pointsMutationsAllowed } from './points-policy.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GAME_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const LIVE_ID = /^[A-Za-z0-9._-]{1,100}$/;
const PRODUCT_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const EVENT_KEY = /^[A-Za-z0-9:._|-]{1,200}$/;
export const MAX_USAGE_EVENTS = 50;
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (code, status = 400) => { throw new PointsError(code, status); };

// Every feature is off unless its own switch is on AND wallet mutations are allowed.
export function economyFlags(env = process.env) {
  const mutations = pointsMutationsAllowed(env);
  return {
    reads: env.POINTS_ENABLED === 'true',
    usageBilling: mutations && env.POINTS_USAGE_BILLING_ENABLED === 'true',
    products: mutations && env.POINTS_PRODUCTS_ENABLED === 'true',
    refundRequests: mutations && env.POINTS_REFUND_REQUESTS_ENABLED === 'true',
    // Provider refund/dispute notifications change balances only with this on;
    // otherwise they are recorded for operator review exactly as before.
    refundAutomation: mutations && env.POINTS_REFUND_AUTOMATION_ENABLED === 'true',
  };
}

const RPC_ERRORS = new Map([
  ['INSUFFICIENT_POINTS', 409], ['POINT_IDEMPOTENCY_CONFLICT', 409], ['POINT_LIMIT_EXCEEDED', 409],
  ['PRODUCT_UNAVAILABLE', 404], ['UNKNOWN_USAGE_SESSION', 404], ['INVALID_USAGE_REQUEST', 400],
  ['UNKNOWN_PURCHASE', 404], ['ALREADY_REFUNDED', 409], ['INVALID_PURCHASE', 400],
  ['POINT_LOT_CONSUMED', 409],
]);

export async function economyRpc(client, name, args) {
  const { data, error } = await client.rpc(name, args);
  if (error) {
    const code = [...RPC_ERRORS.keys()].find((value) => error.message === value);
    return fail(code || 'POINTS_UNAVAILABLE', code ? RPC_ERRORS.get(code) : 503);
  }
  return data;
}

function requireUser(userId) {
  if (typeof userId !== 'string' || !UUID.test(userId)) fail('UNAUTHORIZED', 401);
}

// ---- TikTok gift usage billing ------------------------------------------

export async function startUsageSession(client, userId, body) {
  requireUser(userId);
  if (!object(body) || !UUID.test(body.requestId || '') || !GAME_ID.test(body.gameId || '')
    || !LIVE_ID.test(body.liveId || '')) fail('INVALID_USAGE_REQUEST');
  return economyRpc(client, 'start_point_usage_session', { p_user_id: userId, p_request_id: body.requestId,
    p_game_id: body.gameId, p_live_id: body.liveId });
}

export async function updateUsageSession(client, userId, body) {
  requireUser(userId);
  if (!object(body) || !UUID.test(body.sessionId || '')
    || !['heartbeat', 'pause', 'resume', 'stop'].includes(body.action)) fail('INVALID_USAGE_REQUEST');
  return economyRpc(client, 'update_point_usage_session', { p_user_id: userId, p_session_id: body.sessionId,
    p_action: body.action });
}

export async function getUsageSession(client, userId, sessionId) {
  requireUser(userId);
  if (!UUID.test(sessionId || '')) fail('INVALID_USAGE_REQUEST');
  const session = await economyRpc(client, 'get_point_usage_session', { p_user_id: userId, p_session_id: sessionId });
  return session ?? fail('UNKNOWN_USAGE_SESSION', 404);
}

// Only the gift identity and its cumulative count are forwarded. Anything else a
// client sends (diamonds, coins, points, price, account) is dropped here and
// could not be used by the database function either.
export function sanitizeUsageEvent(event) {
  if (!object(event)) return { eventKey: '' };
  const clean = {};
  if (typeof event.eventKey === 'string' && EVENT_KEY.test(event.eventKey)) clean.eventKey = event.eventKey;
  else clean.eventKey = '';
  if (typeof event.giftId === 'string') clean.giftId = event.giftId;
  if (typeof event.cumulativeCount === 'string') clean.cumulativeCount = event.cumulativeCount;
  if (typeof event.occurredAt === 'string' && event.occurredAt.length <= 40
    && Number.isFinite(Date.parse(event.occurredAt))) clean.occurredAt = event.occurredAt;
  return clean;
}

export async function chargeUsage(client, userId, body) {
  requireUser(userId);
  if (!object(body) || !UUID.test(body.sessionId || '') || !Array.isArray(body.events)
    || body.events.length < 1 || body.events.length > MAX_USAGE_EVENTS) fail('INVALID_USAGE_REQUEST');
  return economyRpc(client, 'charge_point_usage', { p_user_id: userId, p_session_id: body.sessionId,
    p_events: body.events.map(sanitizeUsageEvent) });
}

// ---- In-game Point products ---------------------------------------------

export async function listProducts(client, gameId) {
  if (gameId !== null && !GAME_ID.test(gameId)) fail('INVALID_PRODUCT_REQUEST');
  return economyRpc(client, 'list_point_products', { p_game_id: gameId });
}

export async function listEntitlements(client, userId, gameId) {
  requireUser(userId);
  if (gameId !== null && !GAME_ID.test(gameId)) fail('INVALID_PRODUCT_REQUEST');
  return economyRpc(client, 'list_point_entitlements', { p_user_id: userId, p_game_id: gameId });
}

// The client names the product and a request ID it reuses for every retry of
// the same click. The server reads the price and grants the item exactly once.
export async function purchaseProduct(client, userId, body) {
  requireUser(userId);
  if (!object(body) || !PRODUCT_ID.test(body.productId || '') || !UUID.test(body.requestId || ''))
    fail('INVALID_PRODUCT_REQUEST');
  return economyRpc(client, 'purchase_point_product', { p_user_id: userId, p_request_id: body.requestId,
    p_product_id: body.productId });
}

// ---- Purchase lots, refund requests and provider settlement -------------

export async function listPurchaseLots(client, userId) {
  requireUser(userId);
  return economyRpc(client, 'list_point_purchase_lots', { p_user_id: userId });
}

export async function requestRefund(client, userId, body) {
  requireUser(userId);
  if (!object(body) || !UUID.test(body.transactionId || '')) fail('INVALID_REFUND_REQUEST');
  return economyRpc(client, 'request_point_refund', { p_user_id: userId, p_transaction_id: body.transactionId });
}

// Call ONLY with a provider notification whose signature and payload were
// verified by the provider adapter. Repeated notifications return the first outcome.
export async function settleProviderRefund(client, { provider, environment, providerOrderId, eventKind,
  refundStatus = null, amountMinor, currency, applyPoints }) {
  if (!['lemonsqueezy', 'mock', 'stripe'].includes(provider) || !['test', 'live'].includes(environment)
    || typeof providerOrderId !== 'string' || !providerOrderId
    || !['refund', 'dispute_opened', 'dispute_won', 'dispute_lost'].includes(eventKind)
    || (eventKind === 'refund') !== ['refunded', 'partial_refund'].includes(refundStatus)
    || !Number.isSafeInteger(amountMinor) || amountMinor < 0 || !/^[A-Z]{3}$/.test(currency || '')
    || typeof applyPoints !== 'boolean')
    fail('INVALID_PURCHASE');
  return economyRpc(client, 'settle_point_provider_refund', { p_provider: provider, p_environment: environment,
    p_provider_order_id: providerOrderId, p_event_kind: eventKind,
    p_refund_status: eventKind === 'refund' ? refundStatus : null, p_amount_minor: amountMinor, p_currency: currency,
    p_apply_points: applyPoints });
}
