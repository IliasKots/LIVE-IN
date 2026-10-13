// Local HTTP smoke test for Lemon Squeezy points delivery. Real sockets and the
// real route handlers; the database is an in-memory PGlite running the actual
// migrations; "Lemon Squeezy" is a local fake. No account, credential, network
// payment or hosted database is used. This is NOT a Lemon Squeezy sandbox test.
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { readLemonSqueezyConfig, signWebhookBody, checkoutCustomData } from '../lib/points-lemonsqueezy-core.mjs';
import { createPointOrdersHandler, createLemonSqueezyWebhookHandler, createMockCheckoutHandler,
  createLemonSqueezyPacksHandler } from '../lib/points-lemonsqueezy-http.mjs';

if (process.env.NODE_ENV === 'production') throw new Error('Local smoke test only.');
const db = new PGlite();
await db.exec(`create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
  create schema auth; create table auth.users (id uuid primary key);
  create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  create function auth.role() returns text language sql stable as $$ select nullif(current_setting('request.jwt.claim.role', true), '') $$;
  grant usage on schema auth, public to anon, authenticated, service_role;
  grant execute on function auth.uid(), auth.role() to anon, authenticated, service_role;`);
for (const name of ['202609190001_points_ledger.sql', '202610100002_points_purchase_intents.sql',
  '202610110003_points_verified_delivery.sql', '202610110004_points_lemonsqueezy_orders.sql',
  '202610130007_points_payment_queue.sql'])
  await db.exec(await readFile(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8'));
await db.query('update public.point_payment_settings set accept_test_payments = true where id = 1');
const client = { async rpc(name, args) {
  const keys = Object.keys(args);
  try {
    const result = await db.transaction(async (tx) => {
      await tx.exec('set local role service_role');
      await tx.query("select set_config('request.jwt.claim.role', 'service_role', true)");
      return tx.query(`select public.${name}(${keys.map((key, i) => `${key} => $${i + 1}`).join(', ')}) as result`, keys.map((key) => args[key]));
    });
    return { data: result.rows[0].result, error: null };
  } catch (error) { return { data: null, error: { message: error.message } }; }
} };
const users = { buyer: randomUUID(), other: randomUUID() };
for (const id of Object.values(users)) await db.query('insert into auth.users(id) values ($1)', [id]);
const balance = async (id) => (await client.rpc('get_point_account', { p_user_id: id })).data.balance;

let env = {};
const fakeApi = async (url, init) => {
  const body = JSON.parse(init.body);
  const id = randomUUID();
  return Response.json({ data: { type: 'checkouts', id, attributes: { store_id: Number(body.data.relationships.store.data.id),
    variant_id: Number(body.data.relationships.variant.data.id), test_mode: body.data.attributes.test_mode,
    url: `https://playlive-smoke.lemonsqueezy.com/checkout/custom/${id}` } } }, { status: 201 });
};
const deps = { getConfig: () => readLemonSqueezyConfig(env), getAdminClient: () => client };
const orders = createPointOrdersHandler({ ...deps, fetchImpl: fakeApi, readsEnabled: () => true,
  authenticate: async (request) => { const id = request.headers.get('authorization')?.slice(7); return Object.values(users).includes(id) ? { userId: id } : null; } });
const routes = { 'GET /api/points/packs': createLemonSqueezyPacksHandler(deps), 'GET /api/v1/me/points/orders': orders.GET,
  'POST /api/v1/me/points/orders': orders.POST, 'POST /api/points/lemonsqueezy/webhook': createLemonSqueezyWebhookHandler(deps) };
const mock = createMockCheckoutHandler({ ...deps, isAllowed: () => readLemonSqueezyConfig(env).provider === 'mock' && readLemonSqueezyConfig(env).state === 'ready' });

const server = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const url = new URL(req.url, origin);
  const key = `${req.method} ${url.pathname}`;
  const handler = key === 'POST /api/dev/points/mock-checkout' ? mock : routes[key];
  const response = handler ? await handler(new Request(url, { method: req.method, headers: req.headers,
    ...(req.method === 'POST' ? { body: Buffer.concat(chunks), duplex: 'half' } : {}) })) : new Response(null, { status: 404 });
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const origin = `http://127.0.0.1:${server.address().port}`;
const BASE = { POINTS_PAYMENT_PROVIDER: 'lemonsqueezy', POINTS_DEPLOYMENT_ENVIRONMENT: 'local', POINTS_ENABLED: 'true',
  POINTS_MUTATIONS_ENABLED: 'true', POINTS_SITE_ORIGIN: origin, POINTS_ORDER_REFERENCE_SECRET: 'smoke-only-reference-secret-0123456789abcdef' };
const call = async (method, path, { user, body, headers = {} } = {}) => {
  const response = await fetch(origin + path, { method, headers: { 'Content-Type': 'application/json', Origin: origin,
    ...(user ? { Authorization: `Bearer ${user}` } : {}), ...headers }, ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}) });
  return { status: response.status, json: await response.json().catch(() => null) };
};
const log = (text) => console.log(`PASS ${text}`);

try {
  // 1. No account yet: clear "not configured" responses, nothing can be bought.
  env = { ...BASE, LEMONSQUEEZY_MODE: 'test' };
  const packs = await call('GET', '/api/points/packs');
  assert.deepEqual([packs.json.packs.length, packs.json.message], [0, 'Payments are not configured yet.']);
  const refused = await call('POST', '/api/v1/me/points/orders', { user: users.buyer, body: { packId: 'starter' } });
  assert.deepEqual([refused.status, refused.json.message], [503, 'Payments are not configured yet.']);
  log('unconfigured deployment reports "Payments are not configured yet." and creates no order');

  // 2. Development mock: full flow over HTTP through the shared signed-webhook delivery.
  env = { ...BASE, LEMONSQUEEZY_MODE: 'mock', POINTS_MOCK_PAYMENTS_ENABLED: 'true' };
  const mockPacks = await call('GET', '/api/points/packs');
  assert.deepEqual(mockPacks.json.packs.map((p) => [p.id, p.points, p.priceLabel]), [['starter', '5000', '$5.00']]);
  assert.equal(mockPacks.json.checkoutProvider, 'mock');
  const mockOrder = await call('POST', '/api/v1/me/points/orders', { user: users.buyer, body: { packId: 'starter', userId: users.other, points: '1' } });
  assert.equal(mockOrder.status, 200);
  const token = new URL(mockOrder.json.checkoutUrl).searchParams.get('token');
  // The launcher/checkout window is closed here; only status reads happen.
  assert.equal((await call('GET', `/api/v1/me/points/orders?order=${mockOrder.json.order.id}`, { user: users.buyer })).json.order.status, 'pending');
  assert.equal(await balance(users.buyer), '0');
  const paid = await Promise.all(Array.from({ length: 4 }, () => call('POST', '/api/dev/points/mock-checkout',
    { body: { orderId: mockOrder.json.order.id, token, outcome: 'paid' } })));
  assert.equal(paid.filter((r) => r.json.credited && !r.json.duplicate).length, 1);
  assert.equal(await balance(users.buyer), '5000');
  assert.equal(await balance(users.other), '0');
  const mockStatus = await call('GET', `/api/v1/me/points/orders?order=${mockOrder.json.order.id}`, { user: users.buyer });
  assert.deepEqual([mockStatus.json.order.status, mockStatus.json.order.points], ['credited', '5000']);
  assert.equal((await call('GET', `/api/v1/me/points/orders?order=${mockOrder.json.order.id}`, { user: users.other })).status, 404);
  log('mock: order created for the session account only, closed checkout still delivered, 4 concurrent pays credited exactly 5,000 once, other account gets 404');

  // 3. Test-mode Lemon Squeezy shape (fake provider API) with raw-body signed webhook over HTTP.
  const secret = 'smoke-only-webhook-secret-0123456789';
  env = { ...BASE, LEMONSQUEEZY_MODE: 'test', LEMONSQUEEZY_STORE_ID: '4242', LEMONSQUEEZY_API_KEY: 'smoke-fake-api-key-not-real-000',
    LEMONSQUEEZY_WEBHOOK_SECRET: secret, LEMONSQUEEZY_VARIANT_IDS_JSON: '{"starter":"777001"}', LEMONSQUEEZY_PRODUCTS_VERIFIED: 'true' };
  const order = await call('POST', '/api/v1/me/points/orders', { user: users.buyer, body: { packId: 'starter' } });
  assert.match(order.json.checkoutUrl, /^https:\/\/playlive-smoke\.lemonsqueezy\.com\//);
  const stored = (await client.rpc('get_point_checkout_order_for_delivery', { p_order_id: order.json.order.id })).data;
  const config = readLemonSqueezyConfig(env);
  const payload = { meta: { event_name: 'order_created', custom_data: checkoutCustomData(config, stored) },
    data: { type: 'orders', id: '5550001', attributes: { store_id: 4242, currency: 'USD', subtotal: 500, setup_fee: 0, discount_total: 0,
      tax: 0, total: 500, status: 'paid', refunded: false, test_mode: true, first_order_item: { variant_id: 777001, price: 500, test_mode: true } } } };
  // Whitespace differs from JSON.stringify(parse(raw)): proves the signature covers the exact raw bytes.
  const raw = JSON.stringify(payload, null, 2);
  const hook = (body, signature) => call('POST', '/api/points/lemonsqueezy/webhook', { body, headers: { 'X-Signature': signature, 'X-Event-Name': 'order_created' } });
  assert.equal((await hook(raw, signWebhookBody(JSON.stringify(payload), secret))).status, 401);
  assert.equal((await hook(raw, signWebhookBody(raw, 'wrong-secret-wrong-secret'))).status, 401);
  assert.equal(await balance(users.buyer), '5000');
  const deliveries = await Promise.all(Array.from({ length: 10 }, () => hook(raw, signWebhookBody(raw, secret))));
  assert.ok(deliveries.every((r) => r.status === 200));
  assert.equal(deliveries.filter((r) => r.json.credited && !r.json.duplicate).length, 1);
  assert.equal(await balance(users.buyer), '10000');
  log('test mode: invalid/re-serialized signatures rejected (401); 10 concurrent signed deliveries credited exactly +5,000 once');

  // 4. Production-shaped settings refuse the mock route.
  env = { ...BASE, POINTS_DEPLOYMENT_ENVIRONMENT: 'production', LEMONSQUEEZY_MODE: 'mock', POINTS_MOCK_PAYMENTS_ENABLED: 'true' };
  assert.equal((await call('POST', '/api/dev/points/mock-checkout', { body: { orderId: mockOrder.json.order.id, token, outcome: 'paid' } })).status, 404);
  assert.equal(await balance(users.buyer), '10000');
  log('production deployment settings: mock checkout route returns 404 and credits nothing');
} finally {
  server.close(); await db.close();
}
