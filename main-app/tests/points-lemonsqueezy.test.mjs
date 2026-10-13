import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { readLemonSqueezyConfig, mockPaymentsAllowed, packsResponse, signWebhookBody, mockWebhookSecret,
  checkoutCustomData, PAYMENTS_NOT_CONFIGURED_MESSAGE } from '../lib/points-lemonsqueezy-core.mjs';
import { createPointOrdersHandler, createLemonSqueezyWebhookHandler, createMockCheckoutHandler,
  createLemonSqueezyPacksHandler } from '../lib/points-lemonsqueezy-http.mjs';

// Executes the actual migrations (existing ledger + the new orders migration) in
// an isolated in-memory PostgreSQL engine. Lemon Squeezy is a local fake: no
// network request, account, credential or real payment is involved.
const ORIGIN = 'http://localhost:3000';
const WEBHOOK_SECRET = 'local-test-webhook-secret-0123456789';
const BASE = { NODE_ENV: 'test', POINTS_PAYMENT_PROVIDER: 'lemonsqueezy', POINTS_DEPLOYMENT_ENVIRONMENT: 'local',
  POINTS_ENABLED: 'true', POINTS_MUTATIONS_ENABLED: 'true', POINTS_SITE_ORIGIN: ORIGIN,
  POINTS_ORDER_REFERENCE_SECRET: 'local-test-order-reference-secret-0123456789abcdef' };
const TEST_ENV = { ...BASE, LEMONSQUEEZY_MODE: 'test', LEMONSQUEEZY_STORE_ID: '4242',
  LEMONSQUEEZY_API_KEY: 'local-fake-api-key-not-a-real-credential', LEMONSQUEEZY_WEBHOOK_SECRET: WEBHOOK_SECRET,
  LEMONSQUEEZY_VARIANT_IDS_JSON: '{"starter":"777001"}', LEMONSQUEEZY_PRODUCTS_VERIFIED: 'true' };
const MOCK_ENV = { ...BASE, LEMONSQUEEZY_MODE: 'mock', POINTS_MOCK_PAYMENTS_ENABLED: 'true' };

let db;
before(async () => {
  db = new PGlite();
  await db.exec(`
    create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
    create schema auth; create table auth.users (id uuid primary key);
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    create function auth.role() returns text language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.role', true), '') $$;
    grant usage on schema auth, public to anon, authenticated, service_role;
    grant execute on function auth.uid(), auth.role() to anon, authenticated, service_role;`);
  for (const name of ['202609190001_points_ledger.sql', '202610100002_points_purchase_intents.sql',
    '202610110003_points_verified_delivery.sql', '202610110004_points_lemonsqueezy_orders.sql',
    '202610130007_points_payment_queue.sql'])
    await db.exec(await readFile(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8'));
  await acceptTestPayments(true); // Local/staging test database opt-in.
});
after(async () => { await db?.close(); });

async function asRole(role, sql, args = []) {
  return db.transaction(async (tx) => {
    await tx.exec(`set local role ${role}`);
    await tx.query("select set_config('request.jwt.claim.sub', '', true), set_config('request.jwt.claim.role', $1, true)", [role]);
    return tx.query(sql, args);
  });
}
// Supabase-shaped service client over the real SQL functions.
const client = { async rpc(name, args) {
  const keys = Object.keys(args);
  try {
    const result = await asRole('service_role', `select public.${name}(${keys.map((key, index) => `${key} => $${index + 1}`).join(', ')}) as result`,
      keys.map((key) => args[key]));
    return { data: result.rows[0].result, error: null };
  } catch (error) { return { data: null, error: { message: error.message, code: error.code } }; }
} };
async function newUser() { const id = randomUUID(); await db.query('insert into auth.users(id) values ($1)', [id]); return id; }
async function balance(id) { return (await asRole('service_role', 'select public.get_point_account($1::uuid) as r', [id])).rows[0].r.balance; }
async function ledgerCount(id) { return (await db.query('select count(*)::int as n from public.point_transactions where user_id = $1', [id])).rows[0].n; }
async function rejections(orderId) { return (await db.query('select reason from public.point_provider_rejections where order_id = $1 order by reason', [orderId])).rows.map((row) => row.reason); }
async function acceptTestPayments(value) { await db.query('update public.point_payment_settings set accept_test_payments = $1 where id = 1', [value]); }

// Fake Lemon Squeezy checkout API. Records requests for assertions.
function fakeLemonSqueezy() {
  const requests = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    requests.push({ url, init, body });
    const id = randomUUID();
    return Response.json({ data: { type: 'checkouts', id, attributes: { store_id: Number(body.data.relationships.store.data.id),
      variant_id: Number(body.data.relationships.variant.data.id), test_mode: body.data.attributes.test_mode,
      url: `https://playlive-test.lemonsqueezy.com/checkout/custom/${id}?signature=fake` } } }, { status: 201 });
  };
  return { requests, fetchImpl };
}

function handlers(env, fetchImpl, userOf = () => null) {
  const getConfig = () => readLemonSqueezyConfig(env);
  const deps = { getConfig, getAdminClient: () => client };
  return { orders: createPointOrdersHandler({ ...deps, fetchImpl, readsEnabled: () => true,
      authenticate: async (request) => { const id = userOf(request); return id ? { userId: id } : null; } }),
    webhook: createLemonSqueezyWebhookHandler(deps),
    mockWebhook: createLemonSqueezyWebhookHandler({ ...deps, provider: 'mock' }),
    mock: createMockCheckoutHandler({ ...deps, isAllowed: () => mockPaymentsAllowed(env) }),
    packs: createLemonSqueezyPacksHandler(deps) };
}
const bearer = (request) => request.headers.get('authorization')?.slice(7) || null;
const post = (path, body, headers = {}) => new Request(`${ORIGIN}${path}`, { method: 'POST',
  headers: { 'Content-Type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
const get = (path, headers = {}) => new Request(`${ORIGIN}${path}`, { headers });

async function startCheckout(h, userId, packId = 'starter', extra = {}) {
  const response = await h.orders.POST(post('/api/v1/me/points/orders', { packId, ...extra }, { Authorization: `Bearer ${userId}` }));
  return { status: response.status, body: await response.json() };
}
async function storedOrder(orderId) {
  return (await client.rpc('get_point_checkout_order_for_delivery', { p_order_id: orderId })).data;
}
// A Lemon Squeezy-shaped order payload (fields per the documented order object).
function orderPayload(config, order, overrides = {}, event = 'order_created') {
  const { attributes = {}, item = {}, custom = checkoutCustomData(config, order), id = String(Math.floor(Math.random() * 1e9) + 1) } = overrides;
  return { meta: { event_name: event, custom_data: custom }, data: { type: 'orders', id, attributes: {
    store_id: Number(order.storeId), currency: 'USD', currency_rate: '1.0', subtotal: 500, setup_fee: 0, discount_total: 0,
    tax: 0, total: 500, status: 'paid', refunded: false, test_mode: order.environment === 'test',
    first_order_item: { variant_id: Number(order.variantId), price: 500, test_mode: order.environment === 'test', ...item },
    ...attributes } } };
}
async function deliver(h, payload, secret = WEBHOOK_SECRET, { signature, eventName } = {}) {
  const raw = JSON.stringify(payload);
  const response = await h.webhook(new Request(`${ORIGIN}/api/points/lemonsqueezy/webhook`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Signature': signature ?? signWebhookBody(raw, secret),
      'X-Event-Name': eventName ?? payload.meta.event_name }, body: raw }));
  return { status: response.status, body: await response.json() };
}

test('missing configuration reports "Payments are not configured yet" and cannot start checkout', async () => {
  for (const env of [{ ...BASE, LEMONSQUEEZY_MODE: 'test' }, { ...TEST_ENV, LEMONSQUEEZY_PRODUCTS_VERIFIED: 'false' },
    { ...TEST_ENV, LEMONSQUEEZY_VARIANT_IDS_JSON: '{}' }, { ...TEST_ENV, POINTS_MUTATIONS_ENABLED: 'false' }]) {
    const config = readLemonSqueezyConfig(env);
    assert.equal(config.state, 'not_configured');
    assert.deepEqual(packsResponse(config).packs, []);
    assert.equal(packsResponse(config).message, PAYMENTS_NOT_CONFIGURED_MESSAGE);
    const user = await newUser();
    const h = handlers(env, async () => assert.fail('No provider call when unconfigured'), bearer);
    const result = await startCheckout(h, user);
    assert.equal(result.status, 503);
    assert.deepEqual(result.body, { error: 'PAYMENTS_NOT_CONFIGURED', message: PAYMENTS_NOT_CONFIGURED_MESSAGE });
  }
  const packs = await (await handlers({ ...BASE, LEMONSQUEEZY_MODE: 'test' }).packs()).json();
  assert.equal(packs.checkoutEnabled, false);
  assert.equal(packs.message, 'Payments are not configured yet.');
  // Unselected provider leaves the itch.io configuration path untouched.
  assert.equal(readLemonSqueezyConfig({ ...TEST_ENV, POINTS_PAYMENT_PROVIDER: '' }).selected, false);
});

test('environment rules: live only on production, test/mock never on production', () => {
  assert.equal(readLemonSqueezyConfig({ ...TEST_ENV, LEMONSQUEEZY_MODE: 'live' }).state, 'invalid');
  assert.equal(readLemonSqueezyConfig({ ...TEST_ENV, POINTS_DEPLOYMENT_ENVIRONMENT: 'production', POINTS_PRODUCTION_ACCEPTED: 'true' }).state, 'invalid');
  const production = { ...TEST_ENV, LEMONSQUEEZY_MODE: 'live', POINTS_DEPLOYMENT_ENVIRONMENT: 'production', POINTS_PRODUCTION_ACCEPTED: 'true' };
  assert.equal(readLemonSqueezyConfig(production).state, 'invalid'); // Plain-HTTP site origin is local-only.
  assert.equal(readLemonSqueezyConfig({ ...production, POINTS_SITE_ORIGIN: 'https://playlive.example' }).state, 'ready');
  assert.equal(readLemonSqueezyConfig({ ...TEST_ENV, LEMONSQUEEZY_STORE_ID: 'abc' }).state, 'invalid');
  assert.equal(readLemonSqueezyConfig({ ...TEST_ENV, LEMONSQUEEZY_VARIANT_IDS_JSON: '{"unknown":"1"}' }).state, 'invalid');
  assert.equal(readLemonSqueezyConfig({ ...TEST_ENV, POINTS_ORDER_REFERENCE_SECRET: 'short' }).state, 'invalid');
  const ready = readLemonSqueezyConfig(TEST_ENV);
  assert.equal(ready.state, 'ready');
  // The 5,000-point pack price comes from the existing catalog ($5.00 USD); nothing invented.
  assert.deepEqual(packsResponse(ready).packs, [{ id: 'starter', name: 'Starter', points: '5000', priceLabel: '$5.00', currency: 'USD', priceMinor: '500' }]);
});

test('mock payments cannot be enabled on production deployments', async () => {
  assert.equal(mockPaymentsAllowed(MOCK_ENV), true);
  for (const env of [{ ...MOCK_ENV, POINTS_DEPLOYMENT_ENVIRONMENT: 'production' }, { ...MOCK_ENV, VERCEL_ENV: 'production' },
    { ...MOCK_ENV, POINTS_PRODUCTION_ACCEPTED: 'true' }, { ...MOCK_ENV, POINTS_MOCK_PAYMENTS_ENABLED: 'false' },
    { ...MOCK_ENV, POINTS_DEPLOYMENT_ENVIRONMENT: undefined }]) {
    assert.equal(mockPaymentsAllowed(env), false);
    assert.notEqual(readLemonSqueezyConfig(env).state, 'ready');
    const response = await handlers(env).mock(post('/api/dev/points/mock-checkout', { orderId: randomUUID(), token: 'x', outcome: 'paid' }, { Origin: ORIGIN }));
    assert.equal(response.status, 404);
  }
});

test('complete mock flow credits exactly 5,000 through the shared webhook delivery path; repeats credit once', async () => {
  const user = await newUser();
  const h = handlers(MOCK_ENV, async () => assert.fail('Mock never calls Lemon Squeezy'), bearer);
  const created = await startCheckout(h, user);
  assert.equal(created.status, 200);
  assert.equal(created.body.order.status, 'pending');
  assert.equal(created.body.order.provider, 'mock');
  const url = new URL(created.body.checkoutUrl);
  assert.equal(url.pathname, '/launcher/points/mock-checkout');
  const pay = (outcome, token = url.searchParams.get('token')) => h.mock(post('/api/dev/points/mock-checkout',
    { orderId: created.body.order.id, token, outcome }, { Origin: ORIGIN }));
  assert.equal((await pay('paid', 'A'.repeat(43))).status, 400); // Link possession required.
  const failed = await (await pay('failed')).json();
  assert.equal(failed.credited, false);
  assert.equal(await balance(user), '0');
  const results = await Promise.all(Array.from({ length: 5 }, async () => (await pay('paid')).json()));
  assert.equal(results.filter((value) => value.credited && !value.duplicate).length, 1);
  assert.equal(await balance(user), '5000');
  assert.equal(await ledgerCount(user), 1);
  const status = await (await h.orders.GET(get(`/api/v1/me/points/orders?order=${created.body.order.id}`, { Authorization: `Bearer ${user}` }))).json();
  assert.equal(status.order.status, 'credited');
  assert.equal(status.order.points, '5000');
  assert.equal(status.order.checkoutUrl, null);
  // A real Lemon Squeezy webhook endpoint never accepts a mock-signed event.
  const lsHandlers = handlers(TEST_ENV);
  const mockConfig = readLemonSqueezyConfig(MOCK_ENV);
  const raw = JSON.stringify(orderPayload(mockConfig, await storedOrder(created.body.order.id)));
  const response = await lsHandlers.webhook(new Request(`${ORIGIN}/x`, { method: 'POST', body: raw,
    headers: { 'X-Signature': signWebhookBody(raw, mockWebhookSecret(mockConfig)) } }));
  assert.equal(response.status, 401);
});

test('Lemon Squeezy checkout uses only server data; verified paid webhook credits 5,000 once under duplicate and concurrent delivery', async () => {
  const user = await newUser();
  const attacker = await newUser();
  const provider = fakeLemonSqueezy();
  const h = handlers(TEST_ENV, provider.fetchImpl, bearer);
  // Client-supplied account and amount fields are ignored.
  const created = await startCheckout(h, user, 'starter', { userId: attacker, points: '999999', price: '1' });
  assert.equal(created.status, 200);
  assert.match(created.body.checkoutUrl, /^https:\/\/playlive-test\.lemonsqueezy\.com\//);
  assert.equal(provider.requests.length, 1);
  const sent = provider.requests[0];
  assert.equal(sent.url, 'https://api.lemonsqueezy.com/v1/checkouts');
  assert.equal(sent.init.headers.Authorization, `Bearer ${TEST_ENV.LEMONSQUEEZY_API_KEY}`);
  assert.equal(sent.body.data.attributes.test_mode, true);
  assert.equal(sent.body.data.attributes.checkout_options.discount, false);
  assert.deepEqual(sent.body.data.attributes.product_options.enabled_variants, [777001]);
  assert.equal(sent.body.data.relationships.store.data.id, '4242');
  assert.equal(sent.body.data.relationships.variant.data.id, '777001');
  const custom = sent.body.data.attributes.checkout_data.custom;
  assert.equal(custom.playlive_order, created.body.order.id);
  assert.ok(!JSON.stringify(sent.body).includes(user), 'raw account ID is not sent to the provider');
  assert.ok(!JSON.stringify(sent.body).includes('999999'));

  // Repeated click while the checkout is open reuses it; no second provider call.
  const again = await startCheckout(h, user);
  assert.equal(again.body.order.id, created.body.order.id);
  assert.equal(again.body.reused, true);
  assert.equal(provider.requests.length, 1);

  const config = readLemonSqueezyConfig(TEST_ENV);
  const order = await storedOrder(created.body.order.id);
  assert.equal(order.userId, user);
  const payload = orderPayload(config, order, { id: '9100001' });
  const first = await deliver(h, payload);
  assert.deepEqual([first.status, first.body.credited, first.body.duplicate], [200, true, false]);
  const retries = await Promise.all(Array.from({ length: 8 }, () => deliver(h, payload)));
  assert.ok(retries.every((value) => value.status === 200 && value.body.duplicate === true));
  assert.equal(await balance(user), '5000');
  assert.equal(await balance(attacker), '0');
  assert.equal(await ledgerCount(user), 1);
  // A second, separately paid order on the same checkout is a new payment.
  await deliver(h, orderPayload(config, order, { id: '9100002' }));
  assert.equal(await balance(user), '10000');
  // A new checkout and purchase also credits independently.
  const second = await startCheckout(h, user);
  assert.notEqual(second.body.order.id, created.body.order.id);
});

test('invalid signatures, unpaid orders, wrong variants/stores, environment mismatch and tampered references credit nothing', async () => {
  const user = await newUser();
  const other = await newUser();
  const h = handlers(TEST_ENV, fakeLemonSqueezy().fetchImpl, bearer);
  const config = readLemonSqueezyConfig(TEST_ENV);
  const created = await startCheckout(h, user);
  const order = await storedOrder(created.body.order.id);
  const otherOrder = await storedOrder((await startCheckout(h, other)).body.order.id);
  const valid = orderPayload(config, order);

  assert.equal((await deliver(h, valid, 'wrong-secret-wrong-secret')).status, 401);
  assert.equal((await deliver(h, valid, WEBHOOK_SECRET, { signature: 'not-hex' })).status, 401);
  // Body altered after signing (e.g. variant swapped): signature over raw body fails.
  const raw = JSON.stringify(valid);
  const tampered = raw.replace('"variant_id":777001', '"variant_id":777002');
  const response = await h.webhook(new Request(`${ORIGIN}/x`, { method: 'POST', body: tampered,
    headers: { 'X-Signature': signWebhookBody(raw, WEBHOOK_SECRET) } }));
  assert.equal(response.status, 401);
  assert.equal((await deliver(h, valid, WEBHOOK_SECRET, { eventName: 'order_refunded' })).status, 400);

  const cases = [
    ['NOT_PAID', { attributes: { status: 'pending' } }],
    ['NOT_PAID', { attributes: { status: 'failed' } }],
    ['NOT_PAID', { attributes: { status: 'fraudulent' } }],
    ['VARIANT_MISMATCH', { item: { variant_id: 123456 } }],
    ['STORE_MISMATCH', { attributes: { store_id: 9999 } }],
    ['ENVIRONMENT_MISMATCH', { attributes: { test_mode: false }, item: { test_mode: false } }],
    ['NOT_PAID', { attributes: { discount_total: 500, total: 0 } }],
    ['DISCOUNT_NOT_ALLOWED', { attributes: { discount_total: 100, total: 400 } }],
    ['QUANTITY_MISMATCH', { attributes: { subtotal: 1000, total: 1000 } }],
    ['QUANTITY_MISMATCH', { item: { quantity: 2 } }],
    ['PRICE_MISMATCH', { attributes: { subtotal: 1, total: 1 }, item: { price: 1 } }],
  ];
  for (const [reason, overrides] of cases) {
    const result = await deliver(h, orderPayload(config, order, overrides));
    assert.equal(result.status, 200, reason);
    assert.deepEqual(result.body, { credited: false, reason }, reason);
  }
  // Tampered account/order references: copy another account's order ID, or forge the signature.
  const forged = [
    { ...checkoutCustomData(config, order), playlive_order: otherOrder.id },
    { ...checkoutCustomData(config, order), playlive_account: checkoutCustomData(config, otherOrder).playlive_account },
    { ...checkoutCustomData(config, order), playlive_sig: 'A'.repeat(43) },
    { ...checkoutCustomData(config, order), playlive_env: 'live' },
    { playlive_order: 'not-a-uuid' },
  ];
  for (const custom of forged) {
    const result = await deliver(h, orderPayload(config, order, { custom }));
    assert.deepEqual(result.body, { credited: false, reason: 'TAMPERED_REFERENCE' });
  }
  const unknown = await deliver(h, orderPayload(config, { ...order, id: randomUUID() }));
  assert.deepEqual(unknown.body, { credited: false, reason: 'UNKNOWN_ORDER' });
  // Orders from other products (no PlayLive reference) are acknowledged and ignored.
  assert.deepEqual((await deliver(h, orderPayload(config, order, { custom: { user_id: '1' } }))).body, { ignored: 'NOT_A_POINTS_ORDER' });
  assert.deepEqual((await deliver(h, { ...valid, meta: { ...valid.meta, event_name: 'subscription_created' } })).body, { ignored: 'EVENT_NOT_HANDLED' });

  assert.equal(await balance(user), '0');
  assert.equal(await balance(other), '0');
  assert.equal(await ledgerCount(user), 0);
  // Forged references never mark the victim's order as rejected.
  assert.deepEqual(await rejections(otherOrder.id), []);
  const status = await (await h.orders.GET(get(`/api/v1/me/points/orders?order=${order.id}`, { Authorization: `Bearer ${user}` }))).json();
  assert.equal(status.order.status, 'rejected');
});

test('a live-mode deployment rejects test orders, and a database without the test opt-in refuses test credits', async () => {
  const user = await newUser();
  const h = handlers(TEST_ENV, fakeLemonSqueezy().fetchImpl, bearer);
  const config = readLemonSqueezyConfig(TEST_ENV);
  const order = await storedOrder((await startCheckout(h, user)).body.order.id);
  // Same secrets, but the deployment is live: a test-environment order must not credit.
  const liveEnv = { ...TEST_ENV, LEMONSQUEEZY_MODE: 'live', POINTS_DEPLOYMENT_ENVIRONMENT: 'production',
    POINTS_PRODUCTION_ACCEPTED: 'true', POINTS_SITE_ORIGIN: 'https://playlive.example' };
  const live = handlers(liveEnv);
  assert.deepEqual((await deliver(live, orderPayload(config, order))).body, { credited: false, reason: 'ENVIRONMENT_MISMATCH' });
  assert.deepEqual((await deliver(live, orderPayload(config, order, { attributes: { test_mode: false }, item: { test_mode: false } }))).body,
    { credited: false, reason: 'ENVIRONMENT_MISMATCH' });
  // A production database (accept_test_payments = false) refuses test/mock credits itself.
  await acceptTestPayments(false);
  try {
    assert.deepEqual((await deliver(h, orderPayload(config, order))).body, { credited: false, reason: 'TEST_PAYMENTS_DISABLED' });
    const mock = handlers(MOCK_ENV, null, bearer);
    const created = await startCheckout(mock, user);
    const token = new URL(created.body.checkoutUrl).searchParams.get('token');
    const paid = await (await mock.mock(post('/api/dev/points/mock-checkout', { orderId: created.body.order.id, token, outcome: 'paid' }, { Origin: ORIGIN }))).json();
    assert.deepEqual([paid.credited, paid.reason], [false, 'TEST_PAYMENTS_DISABLED']);
  } finally { await acceptTestPayments(true); }
  assert.equal(await balance(user), '0');
});

test('one account cannot inspect another account\'s purchase; unauthenticated requests fail', async () => {
  const owner = await newUser();
  const intruder = await newUser();
  const h = handlers(TEST_ENV, fakeLemonSqueezy().fetchImpl, bearer);
  const created = await startCheckout(h, owner);
  const read = (id, user) => h.orders.GET(get(`/api/v1/me/points/orders${id ? `?order=${id}` : ''}`, user ? { Authorization: `Bearer ${user}` } : {}));
  assert.equal((await read(created.body.order.id, owner)).status, 200);
  const denied = await read(created.body.order.id, intruder);
  assert.equal(denied.status, 404);
  assert.deepEqual(await denied.json(), { error: 'UNKNOWN_PURCHASE_INTENT' });
  assert.deepEqual(await (await read(null, intruder)).json(), { order: null });
  assert.equal((await read(created.body.order.id, null)).status, 401);
  assert.equal((await read('not-a-uuid', owner)).status, 400);
  assert.equal((await h.orders.POST(post('/api/v1/me/points/orders', { packId: 'starter' }))).status, 401);
  assert.equal((await startCheckout(h, owner, 'ultimate')).status, 400); // Not configured for sale.
});

test('closing checkout before confirmation still allows later delivery, even after the checkout link expires', async () => {
  const user = await newUser();
  const h = handlers(TEST_ENV, fakeLemonSqueezy().fetchImpl, bearer);
  const created = await startCheckout(h, user);
  // The launcher/browser is gone: nothing is called except later status reads.
  assert.equal(created.body.order.status, 'pending');
  await db.query("alter table public.point_checkout_orders disable trigger point_checkout_orders_immutable");
  await db.query("update public.point_checkout_orders set created_at = now() - interval '2 hours', checkout_expires_at = now() - interval '1 hour' where id = $1", [created.body.order.id]);
  await db.query("alter table public.point_checkout_orders enable trigger point_checkout_orders_immutable");
  const expired = await (await h.orders.GET(get('/api/v1/me/points/orders', { Authorization: `Bearer ${user}` }))).json();
  assert.equal(expired.order.status, 'expired');
  assert.equal(expired.order.checkoutUrl, null);
  const config = readLemonSqueezyConfig(TEST_ENV);
  const result = await deliver(h, orderPayload(config, await storedOrder(created.body.order.id)));
  assert.equal(result.body.credited, true);
  assert.equal(await balance(user), '5000');
  const status = await (await h.orders.GET(get('/api/v1/me/points/orders', { Authorization: `Bearer ${user}` }))).json();
  assert.equal(status.order.status, 'credited');
  // An expired order no longer blocks or is reused for a new checkout.
  assert.notEqual((await startCheckout(h, user)).body.order.id, created.body.order.id);
});

test('refunds are recorded against the credited order for operator reversal; a pre-credit refund blocks crediting', async () => {
  const user = await newUser();
  const operator = await newUser();
  const h = handlers(TEST_ENV, fakeLemonSqueezy().fetchImpl, bearer);
  const config = readLemonSqueezyConfig(TEST_ENV);
  const order = await storedOrder((await startCheckout(h, user)).body.order.id);
  await deliver(h, orderPayload(config, order, { id: '9300001' }));
  const refund = orderPayload(config, order, { id: '9300001', attributes: { status: 'refunded', refunded: true, refunded_amount: 500 } }, 'order_refunded');
  assert.deepEqual((await deliver(h, refund)).body, { refundRecorded: true, duplicate: false });
  assert.deepEqual((await deliver(h, refund)).body, { refundRecorded: true, duplicate: true });
  // Existing policy: no automatic reversal. Balance unchanged until an operator acts.
  assert.equal(await balance(user), '5000');
  let status = (await (await h.orders.GET(get(`/api/v1/me/points/orders?order=${order.id}`, { Authorization: `Bearer ${user}` }))).json()).order;
  assert.deepEqual([status.status, status.refundReported], ['credited', true]);
  const review = (await client.rpc('list_point_provider_refunds_for_review', {})).data;
  const item = review.find((value) => value.orderId === order.id);
  assert.equal(item.points, '5000');
  await asRole('service_role', 'select public.reverse_point_transaction($1::uuid,$2,$3,$4::uuid)',
    [item.transactionId, 'Refunded purchase', `admin-reversal:${randomUUID()}`, operator]);
  assert.equal(await balance(user), '0');
  status = (await (await h.orders.GET(get(`/api/v1/me/points/orders?order=${order.id}`, { Authorization: `Bearer ${user}` }))).json()).order;
  assert.equal(status.status, 'refunded');
  assert.ok(!(await client.rpc('list_point_provider_refunds_for_review', {})).data.some((value) => value.orderId === order.id));
  // Refund notification arriving before the (retried) paid notification: never credited.
  const late = await storedOrder((await startCheckout(h, user)).body.order.id);
  await deliver(h, orderPayload(config, late, { id: '9300002', attributes: { status: 'refunded', refunded: true, refunded_amount: 500 } }, 'order_refunded'));
  assert.deepEqual((await deliver(h, orderPayload(config, late, { id: '9300002' }))).body, { credited: false, reason: 'PURCHASE_REFUNDED' });
  assert.equal(await balance(user), '0');
});

test('ledger and order tables stay append-only and service-only', async () => {
  await assert.rejects(db.query("update public.point_provider_payments set points = 1"), /POINT_LEDGER_IMMUTABLE/);
  await assert.rejects(asRole('authenticated', 'select * from public.point_checkout_orders'), /permission denied/);
  await assert.rejects(asRole('authenticated', "select public.credit_point_checkout_order('mock','test','1',gen_random_uuid(),gen_random_uuid(),'1','1','USD',1,1)"), /permission denied/);
  await assert.rejects(asRole('anon', 'select public.get_point_checkout_order(gen_random_uuid(), null)'), /permission denied/);
});
