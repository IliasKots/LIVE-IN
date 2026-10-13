// Stripe points checkout — SANDBOX (test mode) ONLY. A separate provider on the
// existing order/payment/ledger tables; Lemon Squeezy and itch.io are unchanged.
// Live keys, live events and live credits are refused here AND in the database
// (STRIPE_LIVE_DISABLED). Stripe Managed Payments is not used: its eligibility
// review is pending and none of its parameters are sent.
// References: https://docs.stripe.com/api/checkout/sessions/create
//             https://docs.stripe.com/webhooks#verify-manually
import { createHmac, timingSafeEqual } from 'node:crypto';
import { PointsError } from './points-core.mjs';
import { pointsMutationsAllowed } from './points-policy.mjs';
import { PLAYLIVE_POINT_PACKS } from './points-catalog.mjs';
import { siteOrigin, checkoutCustomData, verifyCustomData, orderRpc, CHECKOUT_TTL_SECONDS,
  PAYMENTS_NOT_CONFIGURED_MESSAGE } from './points-lemonsqueezy-core.mjs';
import { economyFlags, settleProviderRefund } from './points-economy-core.mjs';

export const STRIPE_API = 'https://api.stripe.com/v1';
export const SIGNATURE_TOLERANCE_SECONDS = 300;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SESSION_ID = /^cs_test_[A-Za-z0-9]{1,200}$/;
const PAYMENT_INTENT = /^pi_[A-Za-z0-9]{1,200}$/;
const PRICE_ID = /^price_[A-Za-z0-9]{1,100}$/;
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (code, status = 400) => { throw new PointsError(code, status); };

export function stripeSelected(env = process.env) { return env.POINTS_PAYMENT_PROVIDER === 'stripe'; }

// Same shape as the Lemon Squeezy config so the shared order code can use it.
export function readStripeConfig(env = process.env) {
  const config = { selected: stripeSelected(env), mode: 'test', state: 'not_configured', missing: [], problems: [],
    provider: 'stripe', environment: 'test', storeId: 'stripe', apiKey: null, webhookSecret: null,
    referenceSecret: null, origin: null, packs: [], walletEnabled: pointsMutationsAllowed(env),
    refundAutomation: economyFlags(env).refundAutomation, checkoutTtlSeconds: CHECKOUT_TTL_SECONDS };
  if (!config.selected) return config;
  const required = (name) => { const value = (env[name] || '').trim(); if (!value) config.missing.push(name); return value; };
  try {
    if (!['local', 'staging'].includes(env.POINTS_DEPLOYMENT_ENVIRONMENT) || env.VERCEL_ENV === 'production'
      || env.POINTS_PRODUCTION_ACCEPTED === 'true') config.problems.push('STRIPE_SANDBOX_REQUIRES_LOCAL_OR_STAGING');
    config.apiKey = required('STRIPE_SECRET_KEY');
    if (config.apiKey && !/^(sk|rk)_test_[A-Za-z0-9]{10,}$/.test(config.apiKey)) config.problems.push('STRIPE_TEST_KEY_REQUIRED');
    config.webhookSecret = required('STRIPE_WEBHOOK_SECRET');
    if (config.webhookSecret && !/^whsec_[A-Za-z0-9]{10,}$/.test(config.webhookSecret)) config.problems.push('STRIPE_WEBHOOK_SECRET');
    config.referenceSecret = required('POINTS_ORDER_REFERENCE_SECRET');
    if (config.referenceSecret && config.referenceSecret.length < 32) config.problems.push('POINTS_ORDER_REFERENCE_SECRET');
    if (required('POINTS_SITE_ORIGIN')) {
      try { config.origin = siteOrigin(env); } catch { config.problems.push('POINTS_SITE_ORIGIN'); }
    }
    const raw = (env.STRIPE_PRICE_IDS_JSON || '').trim();
    if (!raw || raw === '{}') config.missing.push('STRIPE_PRICE_IDS_JSON');
    else {
      const prices = JSON.parse(raw);
      const values = object(prices) ? Object.values(prices) : [];
      if (!object(prices) || Object.keys(prices).some((id) => !PLAYLIVE_POINT_PACKS.some((pack) => pack.id === id))
        || values.some((id) => typeof id !== 'string' || !PRICE_ID.test(id)) || new Set(values).size !== values.length)
        config.problems.push('STRIPE_PRICE_IDS_JSON');
      else config.packs = PLAYLIVE_POINT_PACKS.filter((pack) => prices[pack.id])
        .map((pack) => ({ ...pack, variantId: prices[pack.id], enabled: true }));
    }
    if (env.STRIPE_PRODUCTS_VERIFIED !== 'true') config.missing.push('STRIPE_PRODUCTS_VERIFIED');
    if (!config.walletEnabled) config.missing.push('POINTS_MUTATIONS_ENABLED');
  } catch {
    config.problems.push('CONFIGURATION');
  }
  config.state = config.problems.length ? 'invalid' : config.missing.length ? 'not_configured' : 'ready';
  if (config.state === 'invalid') config.packs = [];
  return config;
}

function stripeCheckoutUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && url.hostname === 'checkout.stripe.com'
      ? url.href : null;
  } catch { return null; }
}

// Hosted Checkout Session for exactly one unit of the pack's server-configured
// Price. Promotion codes stay off; the signed PlayLive reference travels in the
// session and PaymentIntent metadata.
export async function createStripeCheckout(fetchImpl, config, order) {
  const custom = checkoutCustomData(config, order);
  const form = new URLSearchParams({ mode: 'payment', 'line_items[0][price]': order.variantId,
    'line_items[0][quantity]': '1', client_reference_id: order.id,
    success_url: `${config.origin}/launcher/points/complete?order=${order.id}`,
    cancel_url: `${config.origin}/launcher/points/complete?order=${order.id}`,
    expires_at: String(Math.floor(Date.parse(order.checkoutExpiresAt) / 1000)) });
  for (const [key, value] of Object.entries(custom)) {
    form.set(`metadata[${key}]`, value);
    form.set(`payment_intent_data[metadata][${key}]`, value);
  }
  let response;
  try {
    response = await fetchImpl(`${STRIPE_API}/checkout/sessions`, { method: 'POST', redirect: 'error',
      signal: AbortSignal.timeout(15000), body: form.toString(),
      headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/x-www-form-urlencoded',
        'Idempotency-Key': `playlive-order-${order.id}` } });
  } catch { return fail('CHECKOUT_UNAVAILABLE', 503); }
  if (!response.ok) return fail('CHECKOUT_UNAVAILABLE', 503); // Provider error bodies are never relayed.
  let session;
  try { session = await response.json(); } catch { return fail('CHECKOUT_UNAVAILABLE', 503); }
  const url = stripeCheckoutUrl(session?.url);
  if (session?.object !== 'checkout.session' || !SESSION_ID.test(session.id || '') || session.livemode !== false || !url)
    return fail('CHECKOUT_UNAVAILABLE', 503);
  return { checkoutId: session.id, url };
}

export function packsResponse(config) {
  const ready = config.state === 'ready';
  return { packs: ready ? config.packs.map(({ id, name, points, priceLabel, currency, priceMinor }) =>
    ({ id, name, points, priceLabel, currency, priceMinor })) : [], checkoutEnabled: ready,
  checkoutProvider: 'stripe', testMode: true,
  ...(ready ? {} : { status: 'PAYMENTS_NOT_CONFIGURED', message: PAYMENTS_NOT_CONFIGURED_MESSAGE }) };
}

// Stripe-Signature: t=<unix>,v1=<hex>[,v1=...]. HMAC-SHA256 over "<t>.<raw body>".
export function verifyStripeSignature(rawBody, header, secret, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (!secret || typeof header !== 'string' || header.length > 2048) return false;
  let timestamp = null; const signatures = [];
  for (const part of header.split(',')) {
    const index = part.indexOf('=');
    const key = part.slice(0, index).trim(), value = part.slice(index + 1).trim();
    if (key === 't' && /^\d{1,12}$/.test(value)) timestamp = Number(value);
    if (key === 'v1' && /^[0-9a-f]{64}$/.test(value)) signatures.push(value);
  }
  if (timestamp === null || !signatures.length || Math.abs(nowSeconds - timestamp) > SIGNATURE_TOLERANCE_SECONDS) return false;
  const expected = Buffer.from(createHmac('sha256', secret).update(`${timestamp}.`).update(rawBody).digest('hex'), 'utf8');
  return signatures.some((value) => { const supplied = Buffer.from(value, 'utf8');
    return supplied.length === expected.length && timingSafeEqual(supplied, expected); });
}
export function signStripeBody(rawBody, secret, timestamp) {
  return `t=${timestamp},v1=${createHmac('sha256', secret).update(`${timestamp}.`).update(rawBody).digest('hex')}`;
}

const amount = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : null);
const PERMANENT = new Set(['WRONG_ACCOUNT', 'PACK_MISMATCH', 'UNKNOWN_PURCHASE_INTENT', 'ENVIRONMENT_MISMATCH',
  'PURCHASE_REFUNDED', 'TEST_PAYMENTS_DISABLED', 'INVALID_PURCHASE', 'POINT_IDEMPOTENCY_CONFLICT', 'STRIPE_LIVE_DISABLED']);

// Processes one signed Stripe event. Returns { status, body }: 2xx stops Stripe
// retries, so permanent rejections are recorded and acknowledged, while
// database outages return 503 and are retried.
export async function processStripeWebhook(client, config, rawBody, signatureHeader, nowSeconds) {
  const done = (body, status = 200) => ({ status, body });
  if (!config.selected || !config.webhookSecret || config.state === 'invalid') return done({ error: 'PAYMENTS_NOT_CONFIGURED' }, 503);
  if (!verifyStripeSignature(rawBody, signatureHeader, config.webhookSecret, nowSeconds)) return done({ error: 'INVALID_SIGNATURE' }, 401);
  let event;
  try { event = JSON.parse(Buffer.from(rawBody).toString('utf8')); } catch { return done({ error: 'INVALID_PAYLOAD' }, 400); }
  const data = event?.data?.object;
  if (event?.object !== 'event' || typeof event.type !== 'string' || !object(data)) return done({ error: 'INVALID_PAYLOAD' }, 400);
  // Sandbox only: a live event can never credit or change points here.
  if (event.livemode !== false) return done({ ignored: 'LIVE_MODE_DISABLED' });
  try {
    switch (event.type) {
      case 'checkout.session.completed':
      case 'checkout.session.async_payment_succeeded':
      case 'checkout.session.async_payment_failed':
        return await handleSession(client, config, event.type, data, done);
      case 'charge.refunded':
        return await handleRefund(client, config, data, done);
      case 'charge.dispute.created':
      case 'charge.dispute.closed':
        return await handleDispute(client, config, event.type, data, done);
      default:
        return done({ ignored: 'EVENT_NOT_HANDLED' });
    }
  } catch (error) {
    if (error instanceof PointsError && error.status === 400) return done({ error: 'INVALID_PAYLOAD' }, 400);
    return done({ error: 'POINTS_UNAVAILABLE' }, 503);
  }
}

async function handleSession(client, config, type, session, done) {
  const metadata = session.metadata;
  if (session.object !== 'checkout.session' || !object(metadata) || metadata.playlive_order === undefined)
    return done({ ignored: 'NOT_A_POINTS_ORDER' });
  if (!SESSION_ID.test(session.id || '')) return done({ ignored: 'LIVE_MODE_DISABLED' });
  const providerOrderId = session.id;
  const reject = async (reason, orderId = null) => {
    await orderRpc(client, 'record_point_provider_rejection', { p_provider: 'stripe',
      p_provider_order_id: providerOrderId, p_order_id: orderId, p_reason: reason });
    return done({ credited: false, reason });
  };
  if (typeof metadata.playlive_order !== 'string' || !UUID.test(metadata.playlive_order)) return reject('TAMPERED_REFERENCE');
  const stored = await orderRpc(client, 'get_point_checkout_order_for_delivery', { p_order_id: metadata.playlive_order });
  if (!stored) return reject('UNKNOWN_ORDER');
  if (!verifyCustomData(config, stored, metadata)) return reject('TAMPERED_REFERENCE');
  if (stored.provider !== 'stripe' || stored.environment !== 'test') return reject('ENVIRONMENT_MISMATCH', stored.id);
  if (session.client_reference_id !== stored.id) return reject('TAMPERED_REFERENCE', stored.id);
  if (type === 'checkout.session.async_payment_failed') return reject('NOT_PAID', stored.id);
  // A delayed payment method completes the session unpaid; the async_payment_succeeded event follows.
  if (session.payment_status !== 'paid') return done({ credited: false, pending: true });
  if (session.mode !== 'payment' || session.status !== 'complete') return reject('NOT_PAID', stored.id);
  const currency = typeof session.currency === 'string' ? session.currency.toUpperCase() : '';
  const subtotal = amount(session.amount_subtotal), total = amount(session.amount_total);
  const discount = amount(session.total_details?.amount_discount ?? 0);
  if (!/^[A-Z]{3}$/.test(currency) || subtotal === null || total === null || discount === null || total === 0)
    return reject(total === 0 ? 'NOT_PAID' : 'INVALID_PAYMENT_DETAILS', stored.id);
  if (discount !== 0) return reject('DISCOUNT_NOT_ALLOWED', stored.id);
  // Presentment in another currency is not accepted automatically: operator review.
  if (currency !== stored.currency) return reject('CURRENCY_MISMATCH', stored.id);
  // Exactly one unit at the configured price (quantity is fixed to 1 at checkout).
  if (BigInt(subtotal) !== BigInt(stored.priceMinor)) return reject('PRICE_MISMATCH', stored.id);
  if (!PAYMENT_INTENT.test(session.payment_intent || '')) return reject('INVALID_PAYMENT_DETAILS', stored.id);
  const payment = { p_provider: 'stripe', p_environment: 'test', p_provider_order_id: providerOrderId,
    p_order_id: stored.id, p_user_id: stored.userId, p_store_id: stored.storeId, p_variant_id: stored.variantId,
    p_currency: currency, p_subtotal_minor: subtotal, p_total_minor: total };
  let credit;
  try {
    // Stored before crediting so a verified payment can never be forgotten.
    await orderRpc(client, 'queue_point_provider_payment', payment);
    if (!config.walletEnabled) return done({ credited: false, queued: true });
    credit = await orderRpc(client, 'credit_point_checkout_order', payment);
  } catch (error) {
    if (error instanceof PointsError && PERMANENT.has(error.code)) return reject(error.code, stored.id);
    throw error;
  }
  // Refunds and disputes reference the PaymentIntent; link it (idempotently).
  await orderRpc(client, 'link_point_stripe_payment_intent', { p_provider_order_id: providerOrderId,
    p_payment_intent_id: session.payment_intent, p_environment: 'test', p_order_id: stored.id });
  return done({ credited: true, duplicate: credit?.duplicate === true, points: stored.points });
}

async function orderForPaymentIntent(client, paymentIntent) {
  if (!PAYMENT_INTENT.test(paymentIntent || '')) return null;
  return orderRpc(client, 'get_point_stripe_payment_intent', { p_payment_intent_id: paymentIntent });
}

async function handleRefund(client, config, charge, done) {
  if (charge.object !== 'charge') return done({ error: 'INVALID_PAYLOAD' }, 400);
  const link = await orderForPaymentIntent(client, charge.payment_intent);
  if (!link) return done({ ignored: 'NOT_A_POINTS_ORDER' });
  const refunded = amount(charge.amount_refunded), currency = String(charge.currency || '').toUpperCase();
  if (refunded === null || !/^[A-Z]{3}$/.test(currency)) return done({ error: 'INVALID_PAYLOAD' }, 400);
  // amount_refunded is cumulative; refunded=true only once the whole charge is refunded.
  const status = charge.refunded === true ? 'refunded' : 'partial_refund';
  const recorded = await orderRpc(client, 'record_point_provider_refund', { p_provider: 'stripe', p_environment: 'test',
    p_provider_order_id: link.providerOrderId, p_order_id: link.orderId, p_refund_status: status,
    p_refunded_minor: refunded, p_currency: currency });
  const settlement = await settleProviderRefund(client, { provider: 'stripe', environment: 'test',
    providerOrderId: link.providerOrderId, eventKind: 'refund', refundStatus: status, amountMinor: refunded, currency,
    applyPoints: config.refundAutomation });
  return done({ refundRecorded: true, duplicate: recorded?.duplicate === true, settlement: settlement.outcome });
}

async function handleDispute(client, config, type, dispute, done) {
  if (dispute.object !== 'dispute') return done({ error: 'INVALID_PAYLOAD' }, 400);
  const link = await orderForPaymentIntent(client, dispute.payment_intent);
  if (!link) return done({ ignored: 'NOT_A_POINTS_ORDER' });
  const disputed = amount(dispute.amount), currency = String(dispute.currency || '').toUpperCase();
  if (disputed === null || !/^[A-Z]{3}$/.test(currency)) return done({ error: 'INVALID_PAYLOAD' }, 400);
  const eventKind = type === 'charge.dispute.created' ? 'dispute_opened'
    : dispute.status === 'lost' ? 'dispute_lost' : dispute.status === 'won' ? 'dispute_won' : null;
  if (!eventKind) return done({ ignored: 'DISPUTE_STATUS_NOT_HANDLED' });
  const settlement = await settleProviderRefund(client, { provider: 'stripe', environment: 'test',
    providerOrderId: link.providerOrderId, eventKind, amountMinor: disputed, currency,
    applyPoints: config.refundAutomation });
  return done({ disputeRecorded: true, settlement: settlement.outcome, duplicate: settlement.duplicate === true });
}
