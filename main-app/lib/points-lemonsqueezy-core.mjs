// Lemon Squeezy points checkout and webhook delivery. Pure server logic: the
// Supabase service client and fetch are injected. Points, prices and the account
// come from server configuration and the verified session, never from a buyer.
// Reference: https://docs.lemonsqueezy.com/api/checkouts/create-checkout and
// https://docs.lemonsqueezy.com/help/webhooks/signing-requests
import { createHmac, timingSafeEqual } from 'node:crypto';
import { PointsError, pointInteger } from './points-core.mjs';
import { pointsMutationsAllowed } from './points-policy.mjs';
import { configuredPlayLivePacks, PLAYLIVE_POINT_PACKS } from './points-catalog.mjs';
import { economyFlags, settleProviderRefund } from './points-economy-core.mjs';

export const LEMONSQUEEZY_API = 'https://api.lemonsqueezy.com/v1';
export const PAYMENTS_NOT_CONFIGURED_MESSAGE = 'Payments are not configured yet.';
export const CHECKOUT_TTL_SECONDS = 3600;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NUMERIC_ID = /^[1-9]\d{0,19}$/;
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (code, status = 400) => { throw new PointsError(code, status); };
const hmac = (secret, value) => createHmac('sha256', secret).update(value).digest('base64url');

function sameText(a, b) {
  const left = Buffer.from(String(a ?? ''), 'utf8');
  const right = Buffer.from(String(b ?? ''), 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

export function siteOrigin(env) {
  const site = new URL(env.POINTS_SITE_ORIGIN);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(site.hostname);
  if (site.username || site.password || site.pathname !== '/' || site.search || site.hash
    || (site.protocol !== 'https:' && !(site.protocol === 'http:' && loopback
      && env.POINTS_DEPLOYMENT_ENVIRONMENT === 'local'))) throw new Error('POINTS_SITE_ORIGIN');
  return site.origin;
}

// The development mock is impossible on a production deployment, even if its
// switch is copied there by mistake. Production databases also refuse test credits.
export function mockPaymentsAllowed(env = process.env) {
  return env.POINTS_PAYMENT_PROVIDER === 'lemonsqueezy' && env.LEMONSQUEEZY_MODE === 'mock'
    && env.POINTS_MOCK_PAYMENTS_ENABLED === 'true'
    && ['local', 'staging'].includes(env.POINTS_DEPLOYMENT_ENVIRONMENT)
    && env.VERCEL_ENV !== 'production' && env.POINTS_PRODUCTION_ACCEPTED !== 'true';
}

export function lemonSqueezySelected(env = process.env) {
  return env.POINTS_PAYMENT_PROVIDER === 'lemonsqueezy';
}

// Never throws for missing values: an unconfigured deployment reports a clear
// "not configured" state. Invalid values fail closed with the same public message.
export function readLemonSqueezyConfig(env = process.env) {
  const mode = env.LEMONSQUEEZY_MODE || 'test';
  const config = { selected: lemonSqueezySelected(env), mode, state: 'not_configured', missing: [], problems: [],
    provider: mode === 'mock' ? 'mock' : 'lemonsqueezy', environment: mode === 'live' ? 'live' : 'test',
    storeId: null, apiKey: null, webhookSecret: null, referenceSecret: null, origin: null, packs: [],
    walletEnabled: pointsMutationsAllowed(env), refundAutomation: economyFlags(env).refundAutomation,
    checkoutTtlSeconds: CHECKOUT_TTL_SECONDS };
  if (!config.selected) return config;
  const required = (name) => { const value = (env[name] || '').trim(); if (!value) config.missing.push(name); return value; };
  try {
    if (!['test', 'live', 'mock'].includes(mode)) config.problems.push('LEMONSQUEEZY_MODE');
    const deployment = env.POINTS_DEPLOYMENT_ENVIRONMENT;
    // Live money only on an explicitly accepted production deployment; test/mock never there.
    if (mode === 'live' && deployment !== 'production') config.problems.push('LIVE_MODE_REQUIRES_PRODUCTION');
    if (mode !== 'live' && !['local', 'staging'].includes(deployment)) config.problems.push('TEST_MODE_REQUIRES_LOCAL_OR_STAGING');
    if (mode === 'mock' && !mockPaymentsAllowed(env)) config.problems.push('MOCK_PAYMENTS_NOT_ALLOWED');
    config.referenceSecret = required('POINTS_ORDER_REFERENCE_SECRET');
    if (config.referenceSecret && config.referenceSecret.length < 32) config.problems.push('POINTS_ORDER_REFERENCE_SECRET');
    if (required('POINTS_SITE_ORIGIN')) {
      try { config.origin = siteOrigin(env); } catch { config.problems.push('POINTS_SITE_ORIGIN'); }
    }
    let variants = {};
    if (mode === 'mock') {
      config.storeId = NUMERIC_ID.test(env.LEMONSQUEEZY_STORE_ID || '') ? env.LEMONSQUEEZY_STORE_ID : '1';
      variants = env.LEMONSQUEEZY_VARIANT_IDS_JSON && env.LEMONSQUEEZY_VARIANT_IDS_JSON.trim() !== '{}'
        ? JSON.parse(env.LEMONSQUEEZY_VARIANT_IDS_JSON) : { starter: '1001' };
    } else {
      config.storeId = required('LEMONSQUEEZY_STORE_ID');
      if (config.storeId && !NUMERIC_ID.test(config.storeId)) config.problems.push('LEMONSQUEEZY_STORE_ID');
      config.apiKey = required('LEMONSQUEEZY_API_KEY');
      if (config.apiKey && (config.apiKey.length < 20 || /\s/.test(config.apiKey))) config.problems.push('LEMONSQUEEZY_API_KEY');
      config.webhookSecret = required('LEMONSQUEEZY_WEBHOOK_SECRET');
      if (config.webhookSecret && config.webhookSecret.length < 16) config.problems.push('LEMONSQUEEZY_WEBHOOK_SECRET');
      const raw = (env.LEMONSQUEEZY_VARIANT_IDS_JSON || '').trim();
      if (!raw || raw === '{}') config.missing.push('LEMONSQUEEZY_VARIANT_IDS_JSON');
      else variants = JSON.parse(raw);
      if (env.LEMONSQUEEZY_PRODUCTS_VERIFIED !== 'true') config.missing.push('LEMONSQUEEZY_PRODUCTS_VERIFIED');
    }
    try {
      config.packs = configuredPlayLivePacks(variants).map(({ subProductId, ...pack }) => ({ ...pack, variantId: subProductId }));
    } catch { config.problems.push('LEMONSQUEEZY_VARIANT_IDS_JSON'); }
    if (!config.walletEnabled) config.missing.push('POINTS_MUTATIONS_ENABLED');
  } catch {
    config.problems.push('CONFIGURATION');
  }
  config.state = config.problems.length ? 'invalid' : config.missing.length ? 'not_configured' : 'ready';
  if (config.state === 'invalid') config.packs = [];
  return config;
}

export function publicLemonSqueezyPacks(config) {
  if (config.state !== 'ready') return [];
  return config.packs.map(({ id, name, points, priceLabel, currency, priceMinor }) => ({ id, name, points, priceLabel, currency, priceMinor }));
}

export function packsResponse(config) {
  const ready = config.state === 'ready';
  return { packs: publicLemonSqueezyPacks(config), checkoutEnabled: ready,
    checkoutProvider: config.provider, testMode: config.environment === 'test',
    ...(ready ? {} : { status: 'PAYMENTS_NOT_CONFIGURED', message: PAYMENTS_NOT_CONFIGURED_MESSAGE }) };
}

// Server-generated references carried through checkout custom data. Anyone can
// add custom data to a public checkout URL, so the reference is HMAC-signed and
// bound to the order's account, provider, environment, store and variant.
export function accountReference(config, userId) {
  return hmac(config.referenceSecret, `playlive-account:v1|${userId}`).slice(0, 32);
}
function orderSignature(config, order) {
  return hmac(config.referenceSecret, ['playlive-order:v1', order.id, order.userId, order.provider,
    order.environment, order.storeId, order.variantId].join('|'));
}
export function checkoutCustomData(config, order) {
  return { playlive_order: order.id, playlive_account: accountReference(config, order.userId),
    playlive_env: order.environment, playlive_sig: orderSignature(config, order) };
}
export function verifyCustomData(config, order, custom) {
  return object(custom) && custom.playlive_order === order.id
    && sameText(custom.playlive_account, accountReference(config, order.userId))
    && sameText(custom.playlive_env, order.environment)
    && sameText(custom.playlive_sig, orderSignature(config, order));
}
export function mockCheckoutToken(config, orderId) { return hmac(config.referenceSecret, `playlive-mock-checkout:v1|${orderId}`); }
export function mockWebhookSecret(config) { return hmac(config.referenceSecret, 'playlive-mock-webhook:v1'); }
export function mockProviderOrderId(config, orderId) {
  // Deterministic per checkout: pressing "Pay" twice is a duplicate delivery.
  const digest = createHmac('sha256', config.referenceSecret).update(`playlive-mock-order:v1|${orderId}`).digest();
  return String((digest.readBigUInt64BE(0) % 900000000000n) + 100000000000n);
}

export function verifyWebhookSignature(rawBody, signature, secret) {
  if (!secret || typeof signature !== 'string' || !/^[0-9a-f]{64}$/i.test(signature.trim())) return false;
  const expected = Buffer.from(createHmac('sha256', secret).update(rawBody).digest('hex'), 'utf8');
  const supplied = Buffer.from(signature.trim().toLowerCase(), 'utf8');
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
export function signWebhookBody(rawBody, secret) { return createHmac('sha256', secret).update(rawBody).digest('hex'); }

const RPC_CODES = ['WRONG_ACCOUNT', 'PACK_MISMATCH', 'UNKNOWN_PURCHASE_INTENT', 'ENVIRONMENT_MISMATCH',
  'PURCHASE_REFUNDED', 'TEST_PAYMENTS_DISABLED', 'CHECKOUT_IN_PROGRESS', 'INVALID_PURCHASE', 'POINT_IDEMPOTENCY_CONFLICT'];
export async function orderRpc(client, name, args) {
  const { data, error } = await client.rpc(name, args);
  if (error) {
    const code = RPC_CODES.find((value) => error.message?.includes(value));
    return fail(code || 'POINTS_UNAVAILABLE', code ? 409 : 503);
  }
  return data;
}

function validOrder(value, userId = null) {
  if (value === null) return null;
  if (!object(value) || !UUID.test(value.id) || (userId !== null && value.userId !== userId)
    || !['lemonsqueezy', 'mock', 'stripe'].includes(value.provider) || !['test', 'live'].includes(value.environment)
    || !['pending', 'credited', 'refunded', 'rejected', 'expired', 'failed'].includes(value.status)) return fail('POINTS_UNAVAILABLE', 503);
  pointInteger(value.points, { nonzero: true });
  if (value.status === 'credited' && !UUID.test(value.transactionId)) return fail('POINTS_UNAVAILABLE', 503);
  return value;
}

export function publicOrder(value) {
  if (!value) return null;
  const { id, provider, environment, packId, name, points, priceLabel, currency, status, paymentsCredited,
    refundReported, transactionId, creditedAt, createdAt, checkoutExpiresAt, checkoutUrl } = value;
  return { id, provider, environment, packId, name, points, priceLabel, currency, status,
    paymentsCredited, refundReported: refundReported === true, transactionId: transactionId ?? null,
    creditedAt: creditedAt ?? null, createdAt, checkoutExpiresAt,
    // Re-open only an unpaid, unexpired checkout; never expose it once settled.
    checkoutUrl: status === 'pending' ? checkoutUrl ?? null : null };
}

// Credits this order's verified-but-uncredited payments (if any). Best effort:
// a failure leaves the payment queued for the next check or the operator.
export async function retryQueuedPayments(client, orderId = null) {
  const { data, error } = await client.rpc('retry_point_provider_payments', { p_order_id: orderId });
  return error ? null : data;
}

export async function getCheckoutOrder(client, userId, orderId = null) {
  if (!UUID.test(userId) || (orderId !== null && !UUID.test(orderId))) return fail('INVALID_PURCHASE_INTENT', 400);
  return validOrder(await orderRpc(client, 'get_point_checkout_order', { p_user_id: userId, p_order_id: orderId }), userId);
}

function lemonCheckoutUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password
      && (url.hostname === 'lemonsqueezy.com' || url.hostname.endsWith('.lemonsqueezy.com')) ? url.href : null;
  } catch { return null; }
}

export async function createLemonSqueezyCheckout(fetchImpl, config, order) {
  const variant = Number(order.variantId);
  const body = { data: { type: 'checkouts', attributes: {
    product_options: { enabled_variants: [variant],
      redirect_url: `${config.origin}/launcher/points/complete?order=${order.id}`,
      receipt_link_url: `${config.origin}/launcher/points/complete?order=${order.id}`,
      receipt_button_text: 'Return to PlayLive' },
    checkout_options: { embed: false, discount: false },
    checkout_data: { custom: checkoutCustomData(config, order) },
    expires_at: order.checkoutExpiresAt, test_mode: order.environment === 'test' },
  relationships: { store: { data: { type: 'stores', id: order.storeId } },
    variant: { data: { type: 'variants', id: order.variantId } } } } };
  let response;
  try {
    response = await fetchImpl(`${LEMONSQUEEZY_API}/checkouts`, { method: 'POST', redirect: 'error',
      signal: AbortSignal.timeout(15000), body: JSON.stringify(body),
      headers: { Accept: 'application/vnd.api+json', 'Content-Type': 'application/vnd.api+json',
        Authorization: `Bearer ${config.apiKey}` } });
  } catch { return fail('CHECKOUT_UNAVAILABLE', 503); }
  if (!response.ok) return fail('CHECKOUT_UNAVAILABLE', 503); // Provider error bodies are never relayed.
  let json;
  try { json = await response.json(); } catch { return fail('CHECKOUT_UNAVAILABLE', 503); }
  const data = json?.data;
  const attributes = data?.attributes;
  const url = lemonCheckoutUrl(attributes?.url);
  if (data?.type !== 'checkouts' || typeof data.id !== 'string' || !data.id || data.id.length > 100 || !url
    || attributes.test_mode !== (order.environment === 'test')
    || String(attributes.store_id) !== order.storeId || String(attributes.variant_id) !== order.variantId)
    return fail('CHECKOUT_UNAVAILABLE', 503);
  return { checkoutId: data.id, url };
}

// providerCheckout creates the hosted checkout for config.provider (Lemon Squeezy
// by default; the Stripe adapter passes its own). The mock never calls a provider.
export async function createCheckoutOrder(client, config, userId, packId, fetchImpl = fetch,
  providerCheckout = createLemonSqueezyCheckout) {
  if (config.state !== 'ready') return fail('PAYMENTS_NOT_CONFIGURED', 503);
  if (!UUID.test(userId)) return fail('UNAUTHORIZED', 401);
  const pack = typeof packId === 'string' ? config.packs.find((value) => value.id === packId) : null;
  if (!pack) return fail('UNKNOWN_PACK', 400);
  const created = validOrder(await orderRpc(client, 'create_point_checkout_order', { p_user_id: userId,
    p_provider: config.provider, p_environment: config.environment, p_store_id: config.storeId,
    p_variant_id: pack.variantId, p_pack_id: pack.id, p_pack_name: pack.name, p_points: pack.points,
    p_price_label: pack.priceLabel, p_currency: pack.currency, p_price_minor: pack.priceMinor,
    p_ttl_seconds: config.checkoutTtlSeconds }), userId);
  if (created.reused === true && created.checkoutUrl) return { order: created, checkoutUrl: created.checkoutUrl, reused: true };
  const order = { ...created, userId, storeId: config.storeId, variantId: pack.variantId };
  const link = config.provider === 'mock'
    ? { checkoutId: `mock-${order.id}`, url: `${config.origin}/launcher/points/mock-checkout?order=${order.id}&token=${mockCheckoutToken(config, order.id)}` }
    : await providerCheckout(fetchImpl, config, order);
  const attached = validOrder(await orderRpc(client, 'attach_point_checkout_link', { p_user_id: userId,
    p_order_id: order.id, p_checkout_id: link.checkoutId, p_url: link.url }), userId);
  return { order: attached, checkoutUrl: link.url, reused: false };
}

const amount = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : null);
const PERMANENT = new Set(['WRONG_ACCOUNT', 'PACK_MISMATCH', 'UNKNOWN_PURCHASE_INTENT', 'ENVIRONMENT_MISMATCH',
  'PURCHASE_REFUNDED', 'TEST_PAYMENTS_DISABLED', 'INVALID_PURCHASE', 'POINT_IDEMPOTENCY_CONFLICT']);

// Processes one signed webhook body. Returns { status, body }. Only HTTP 200 stops
// Lemon Squeezy retries, so permanent rejections are recorded and acknowledged,
// while database outages return 5xx and are retried by the provider.
export async function processLemonSqueezyWebhook(client, config, rawBody, headers, { provider = 'lemonsqueezy' } = {}) {
  const done = (body, status = 200) => ({ status, body });
  const secret = provider === 'mock' ? (config.provider === 'mock' && config.referenceSecret ? mockWebhookSecret(config) : null)
    : config.webhookSecret;
  // Paid orders still deliver when new sales are paused (not_configured), never under invalid settings.
  if (!config.selected || !secret || config.provider !== provider || config.state === 'invalid')
    return done({ error: 'PAYMENTS_NOT_CONFIGURED' }, 503);
  if (!verifyWebhookSignature(rawBody, headers.signature, secret)) return done({ error: 'INVALID_SIGNATURE' }, 401);
  let payload;
  try { payload = JSON.parse(Buffer.from(rawBody).toString('utf8')); } catch { return done({ error: 'INVALID_PAYLOAD' }, 400); }
  const event = payload?.meta?.event_name;
  if (typeof event !== 'string' || (headers.eventName && headers.eventName !== event)) return done({ error: 'INVALID_PAYLOAD' }, 400);
  if (!['order_created', 'order_refunded'].includes(event)) return done({ ignored: 'EVENT_NOT_HANDLED' });
  const data = payload.data;
  const attributes = data?.attributes;
  if (data?.type !== 'orders' || !NUMERIC_ID.test(String(data?.id ?? '')) || !object(attributes)) return done({ error: 'INVALID_PAYLOAD' }, 400);
  const providerOrderId = String(data.id);
  const custom = payload.meta.custom_data;
  // Other store products (e.g. game licences) have no PlayLive order reference.
  if (!object(custom) || custom.playlive_order === undefined) return done({ ignored: 'NOT_A_POINTS_ORDER' });

  const reject = async (reason, orderId = null) => {
    await orderRpc(client, 'record_point_provider_rejection', { p_provider: provider,
      p_provider_order_id: providerOrderId, p_order_id: orderId, p_reason: reason });
    return done({ credited: false, reason });
  };
  try {
    if (typeof custom.playlive_order !== 'string' || !UUID.test(custom.playlive_order)) return await reject('TAMPERED_REFERENCE');
    const stored = await orderRpc(client, 'get_point_checkout_order_for_delivery', { p_order_id: custom.playlive_order });
    if (!stored) return await reject('UNKNOWN_ORDER');
    const order = validOrder(stored);
    // An unverifiable reference never marks someone else's order as rejected.
    if (!verifyCustomData(config, order, custom)) return await reject('TAMPERED_REFERENCE');
    if (order.provider !== provider || order.environment !== config.environment) return await reject('ENVIRONMENT_MISMATCH', order.id);
    if (attributes.test_mode !== (order.environment === 'test')) return await reject('ENVIRONMENT_MISMATCH', order.id);
    if (String(attributes.store_id) !== order.storeId || order.storeId !== config.storeId) return await reject('STORE_MISMATCH', order.id);
    const item = attributes.first_order_item;
    if (!object(item) || String(item.variant_id) !== order.variantId) return await reject('VARIANT_MISMATCH', order.id);
    if (item.test_mode !== undefined && item.test_mode !== attributes.test_mode) return await reject('ENVIRONMENT_MISMATCH', order.id);
    const currency = attributes.currency;
    if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) return await reject('INVALID_PAYMENT_DETAILS', order.id);

    if (event === 'order_refunded') {
      const refunded = amount(attributes.refunded_amount);
      const status = attributes.refunded === true || attributes.status === 'refunded' ? 'refunded'
        : attributes.status === 'partial_refund' ? 'partial_refund' : null;
      if (!status || refunded === null) return await reject('INVALID_PAYMENT_DETAILS', order.id);
      const result = await orderRpc(client, 'record_point_provider_refund', { p_provider: provider,
        p_environment: order.environment, p_provider_order_id: providerOrderId, p_order_id: order.id,
        p_refund_status: status, p_refunded_minor: refunded, p_currency: currency });
      // Default: operator verifies and reverses (scripts/points-admin.mjs reverse). With
      // POINTS_REFUND_AUTOMATION_ENABLED the purchase lot is settled automatically:
      // unused points are removed from THIS purchase only; used points go to review.
      const settlement = config.refundAutomation ? await settleProviderRefund(client, { provider,
        environment: order.environment, providerOrderId, eventKind: 'refund', refundStatus: status,
        amountMinor: refunded, currency, applyPoints: true }) : null;
      return done({ refundRecorded: true, duplicate: result?.duplicate === true,
        ...(settlement ? { settlement: settlement.outcome } : {}) });
    }

    if (attributes.status !== 'paid' || attributes.refunded === true) return await reject('NOT_PAID', order.id);
    const subtotal = amount(attributes.subtotal), total = amount(attributes.total), discount = amount(attributes.discount_total ?? 0);
    const setupFee = amount(attributes.setup_fee ?? 0), price = amount(item.price);
    if (subtotal === null || total === null || discount === null || setupFee === null || price === null || total === 0)
      return await reject(total === 0 ? 'NOT_PAID' : 'INVALID_PAYMENT_DETAILS', order.id);
    // Checkout disables discount codes; a discounted order needs operator review.
    if (discount !== 0) return await reject('DISCOUNT_NOT_ALLOWED', order.id);
    // Exactly one unit of the pack. No quantity in first_order_item: subtotal must equal one unit.
    if ((item.quantity !== undefined && item.quantity !== 1) || subtotal !== price || setupFee !== 0)
      return await reject('QUANTITY_MISMATCH', order.id);
    if (currency === order.currency && BigInt(price) < BigInt(order.priceMinor)) return await reject('PRICE_MISMATCH', order.id);

    const payment = { p_provider: provider, p_environment: order.environment, p_provider_order_id: providerOrderId,
      p_order_id: order.id, p_user_id: order.userId, p_store_id: order.storeId, p_variant_id: order.variantId,
      p_currency: currency, p_subtotal_minor: subtotal, p_total_minor: total };
    let credit;
    try {
      // The verified payment is stored before crediting, so it can never be forgotten:
      // if crediting fails it is retried (launcher status check, next delivery, operator).
      await orderRpc(client, 'queue_point_provider_payment', payment);
      if (!config.walletEnabled) return done({ credited: false, queued: true });
      try {
        credit = await orderRpc(client, 'credit_point_checkout_order', payment);
      } catch (error) {
        if (error instanceof PointsError && PERMANENT.has(error.code)) throw error;
        return done({ error: 'POINTS_UNAVAILABLE', queued: true }, 503);
      }
    } catch (error) {
      if (error instanceof PointsError && PERMANENT.has(error.code)) return await reject(error.code, order.id);
      throw error;
    }
    return done({ credited: true, duplicate: credit?.duplicate === true, points: order.points });
  } catch (error) {
    if (error instanceof PointsError && error.status === 400) return done({ error: 'INVALID_PAYLOAD' }, 400);
    return done({ error: 'POINTS_UNAVAILABLE' }, 503);
  }
}

// Development mock: builds an order_created payload shaped like Lemon Squeezy's,
// signs it with the mock-only secret and sends it through the SAME webhook path.
export function mockOrderPayload(config, order, outcome) {
  const price = Number(order.priceMinor);
  const providerOrderId = mockProviderOrderId(config, order.id);
  return { meta: { event_name: 'order_created', custom_data: checkoutCustomData(config, order) },
    data: { type: 'orders', id: providerOrderId, attributes: { store_id: Number(order.storeId),
      identifier: order.id, order_number: 1, currency: order.currency, currency_rate: '1.0000',
      subtotal: price, setup_fee: 0, discount_total: 0, tax: 0, total: price,
      status: outcome === 'paid' ? 'paid' : 'failed', refunded: false, test_mode: true,
      first_order_item: { variant_id: Number(order.variantId), price, test_mode: true,
        product_name: 'PlayLive Points (mock)', variant_name: order.name } } } };
}

// Operator discovery helper (scripts/verify-lemonsqueezy-config.mjs --discover).
// Proposes one variant per catalog pack only when exactly one non-draft, one-time
// variant of a product named after the pack has the pack's exact price. Never
// guesses: anything ambiguous is reported as a problem for a person to resolve.
export function proposeVariantIds(products) {
  const proposal = {}; const problems = [];
  for (const pack of PLAYLIVE_POINT_PACKS) {
    const word = new RegExp(`\\b${pack.name}\\b`, 'i');
    const matches = (products || []).filter((product) => word.test(product.name || '')).flatMap((product) =>
      (product.variants || []).filter((variant) => String(variant.price) === pack.priceMinor && !variant.subscription
        && !variant.payWhatYouWant && variant.status !== 'draft' && NUMERIC_ID.test(String(variant.variantId))));
    if (matches.length === 1) proposal[pack.id] = String(matches[0].variantId);
    else problems.push(`${pack.id} (${pack.points} points, ${pack.priceLabel}): ${matches.length} matching variants`);
  }
  return { proposal, problems };
}
