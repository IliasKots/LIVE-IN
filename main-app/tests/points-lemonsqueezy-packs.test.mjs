import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { readLemonSqueezyConfig, signWebhookBody, checkoutCustomData, proposeVariantIds } from '../lib/points-lemonsqueezy-core.mjs';
import { createPointOrdersHandler, createLemonSqueezyWebhookHandler, createLemonSqueezyPacksHandler } from '../lib/points-lemonsqueezy-http.mjs';
import { listPointTransactions } from '../lib/points-core.mjs';

// All five Lemon Squeezy packs end to end against the actual migrations (isolated
// in-memory PostgreSQL). Lemon Squeezy is a local fake: variant IDs below are TEST
// FIXTURES, not the store's real IDs (those come from the --discover script).
const ORIGIN = 'http://localhost:3000';
const SECRET = 'local-test-webhook-secret-0123456789';
const VARIANTS = { starter: '880001', regular: '880002', pro: '880003', max: '880004', ultimate: '880005' };
const PACKS = [['starter', '5000', 500], ['regular', '10000', 1000], ['pro', '27500', 2500], ['max', '57500', 5000],
  ['ultimate', '120000', 10000]];
const ENV = { NODE_ENV: 'test', POINTS_PAYMENT_PROVIDER: 'lemonsqueezy', POINTS_DEPLOYMENT_ENVIRONMENT: 'local',
  POINTS_ENABLED: 'true', POINTS_MUTATIONS_ENABLED: 'true', POINTS_SITE_ORIGIN: ORIGIN,
  POINTS_ORDER_REFERENCE_SECRET: 'local-test-order-reference-secret-0123456789abcdef', LEMONSQUEEZY_MODE: 'test',
  LEMONSQUEEZY_STORE_ID: '4242', LEMONSQUEEZY_API_KEY: 'local-fake-api-key-not-a-real-credential',
  LEMONSQUEEZY_WEBHOOK_SECRET: SECRET, LEMONSQUEEZY_VARIANT_IDS_JSON: JSON.stringify(VARIANTS),
  LEMONSQUEEZY_PRODUCTS_VERIFIED: 'true', POINTS_REFUND_AUTOMATION_ENABLED: 'true' };

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
    '202610130005_points_lots_refunds.sql', '202610130006_points_usage_products.sql', '202610130007_points_payment_queue.sql'])
    await db.exec(await readFile(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8'));
  await db.exec('update public.point_payment_settings set accept_test_payments = true where id = 1');
});
after(async () => { await db?.close(); });

async function asRole(role, sql, args = []) {
  return db.transaction(async (tx) => {
    await tx.exec(`set local role ${role}`);
    await tx.query("select set_config('request.jwt.claim.sub', '', true), set_config('request.jwt.claim.role', $1, true)", [role]);
    return tx.query(sql, args);
  });
}
// Supabase-shaped service client. `failNext` simulates a temporary database error on one RPC.
const failNext = new Set();
const client = { async rpc(name, args) {
  if (failNext.delete(name)) return { data: null, error: { message: 'connection reset', code: '08006' } };
  const keys = Object.keys(args);
  try {
    const result = await asRole('service_role', `select public.${name}(${keys.map((key, index) => `${key} => $${index + 1}`).join(', ')}) as result`,
      keys.map((key) => (args[key] !== null && typeof args[key] === 'object' ? JSON.stringify(args[key]) : args[key])));
    return { data: result.rows[0].result, error: null };
  } catch (error) { return { data: null, error: { message: error.message, code: error.code } }; }
} };
async function newUser() { const id = randomUUID(); await db.query('insert into auth.users(id) values ($1)', [id]); return id; }
async function balance(id) { return (await asRole('service_role', 'select public.get_point_account($1::uuid) as r', [id])).rows[0].r.balance; }

function handlers(env = ENV) {
  const deps = { getConfig: () => readLemonSqueezyConfig(env), getAdminClient: () => client };
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body); const id = randomUUID();
    return Response.json({ data: { type: 'checkouts', id, attributes: { store_id: Number(body.data.relationships.store.data.id),
      variant_id: Number(body.data.relationships.variant.data.id), test_mode: true,
      url: `https://playlivetiktokgames.lemonsqueezy.com/checkout/custom/${id}` } } }, { status: 201 });
  };
  return { config: readLemonSqueezyConfig(env), packs: createLemonSqueezyPacksHandler(deps),
    orders: createPointOrdersHandler({ ...deps, fetchImpl, readsEnabled: () => true,
      authenticate: async (request) => { const id = request.headers.get('authorization')?.slice(7); return id ? { userId: id } : null; } }),
    webhook: createLemonSqueezyWebhookHandler(deps) };
}
const auth = (userId) => ({ Authorization: `Bearer ${userId}` });
async function buy(h, userId, packId) {
  const response = await h.orders.POST(new Request(`${ORIGIN}/api/v1/me/points/orders`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', ...auth(userId) }, body: JSON.stringify({ packId }) }));
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  return (await client.rpc('get_point_checkout_order_for_delivery', { p_order_id: body.order.id })).data;
}
async function status(h, userId, orderId = null) {
  const response = await h.orders.GET(new Request(`${ORIGIN}/api/v1/me/points/orders${orderId ? `?order=${orderId}` : ''}`, { headers: auth(userId) }));
  return (await response.json()).order ?? null;
}
let nextOrder = 7700000;
// Lemon Squeezy-shaped order payload (documented order object fields).
function payload(config, order, { id = String(++nextOrder), event = 'order_created', attributes = {}, item = {}, custom } = {}) {
  const price = Number(order.priceMinor);
  return { meta: { event_name: event, custom_data: custom ?? checkoutCustomData(config, order) }, data: { type: 'orders', id,
    attributes: { store_id: Number(order.storeId), currency: 'USD', subtotal: price, setup_fee: 0, discount_total: 0, tax: 0,
      total: price, status: 'paid', refunded: false, test_mode: true,
      first_order_item: { variant_id: Number(order.variantId), price, test_mode: true, ...item }, ...attributes } } };
}
async function deliver(h, body, { secret = SECRET, signature } = {}) {
  const raw = JSON.stringify(body);
  const response = await h.webhook(new Request(`${ORIGIN}/api/points/lemonsqueezy/webhook`, { method: 'POST',
    headers: { 'X-Signature': signature ?? signWebhookBody(raw, secret), 'X-Event-Name': body.meta.event_name }, body: raw }));
  return { status: response.status, body: await response.json() };
}

test('the catalog offers all five packs with their fixed points and USD prices', async () => {
  const h = handlers();
  const body = await (await h.packs(new Request(`${ORIGIN}/api/points/packs`))).json();
  assert.equal(body.checkoutProvider, 'lemonsqueezy');
  assert.deepEqual(body.packs.map((p) => [p.id, p.points, p.priceMinor, p.currency]),
    PACKS.map(([id, points, price]) => [id, points, String(price), 'USD']));
});

for (const [packId, points] of PACKS) {
  test(`1-5. a ${packId} payment credits exactly ${points} Points to the buyer, once`, async () => {
    const h = handlers(); const user = await newUser();
    const order = await buy(h, user, packId);
    assert.equal(order.variantId, VARIANTS[packId]);
    const paid = payload(h.config, order);
    assert.deepEqual((await deliver(h, paid)).body, { credited: true, duplicate: false, points });
    assert.equal(await balance(user), points);
    const shown = await status(h, user, order.id);
    assert.deepEqual([shown.status, shown.points], ['credited', points]);
  });
}

test('6-8. bad signatures are rejected; duplicates are harmless; two purchases both credit', async () => {
  const h = handlers(); const user = await newUser();
  const order = await buy(h, user, 'starter');
  const paid = payload(h.config, order);
  assert.equal((await deliver(h, paid, { secret: 'wrong-secret-0123456789abcdef' })).status, 401);
  assert.equal((await deliver(h, paid, { signature: 'not-hex' })).status, 401);
  assert.equal(await balance(user), '0');
  const results = await Promise.all([deliver(h, paid), deliver(h, paid), deliver(h, paid)]);
  assert.equal(results.filter((r) => r.body.duplicate === false).length, 1);
  assert.equal(await balance(user), '5000');
  const second = await buy(h, user, 'regular');
  await deliver(h, payload(h.config, second));
  assert.equal(await balance(user), '15000');
});

test('9-11. cancelled checkout, failed payment and wrong variant credit nothing', async () => {
  const h = handlers(); const user = await newUser();
  const abandoned = await buy(h, user, 'starter'); // checkout opened, never paid
  assert.equal((await status(h, user, abandoned.id)).status, 'pending');
  const failed = await buy(h, user, 'pro');
  assert.deepEqual((await deliver(h, payload(h.config, failed, { attributes: { status: 'failed' } }))).body,
    { credited: false, reason: 'NOT_PAID' });
  const wrong = await buy(h, user, 'max');
  assert.deepEqual((await deliver(h, payload(h.config, wrong, { item: { variant_id: Number(VARIANTS.starter) } }))).body,
    { credited: false, reason: 'VARIANT_MISMATCH' });
  assert.equal(await balance(user), '0');
});

test("12. user A's paid order can never credit user B", async () => {
  const h = handlers(); const a = await newUser(); const b = await newUser();
  const orderA = await buy(h, a, 'starter'); const orderB = await buy(h, b, 'starter');
  // A's payment carrying B's order reference without B's signature.
  const forged = { ...checkoutCustomData(h.config, orderA), playlive_order: orderB.id };
  assert.deepEqual((await deliver(h, payload(h.config, orderA, { custom: forged }))).body,
    { credited: false, reason: 'TAMPERED_REFERENCE' });
  // A's valid payment credits A only; replaying it as another order changes nothing.
  const paidA = payload(h.config, orderA);
  await deliver(h, paidA);
  const replay = payload(h.config, orderB, { id: paidA.data.id });
  assert.equal((await deliver(h, replay)).body.credited, false);
  assert.deepEqual([await balance(a), await balance(b)], ['5000', '0']);
  assert.equal(await status(h, b, orderA.id), null, 'B cannot even read A\'s order');
});

test('13. an underpaid USD order is rejected and listed for the operator', async () => {
  const h = handlers(); const user = await newUser();
  const order = await buy(h, user, 'ultimate');
  const cheap = payload(h.config, order, { attributes: { subtotal: 100, total: 100 }, item: { price: 100 } });
  assert.deepEqual((await deliver(h, cheap)).body, { credited: false, reason: 'PRICE_MISMATCH' });
  assert.equal(await balance(user), '0');
  const exceptions = (await client.rpc('list_point_payment_exceptions', {})).data;
  assert.ok(exceptions.rejected.some((r) => r.orderId === order.id && r.reason === 'PRICE_MISMATCH'));
});

test('14. a late webhook, after the checkout link expired, still credits', async () => {
  const h = handlers(); const user = await newUser();
  const order = await buy(h, user, 'regular');
  await db.exec(`alter table public.point_checkout_orders disable trigger point_checkout_orders_immutable;
    update public.point_checkout_orders set created_at = now() - interval '3 days', checkout_expires_at = now() - interval '2 days'
      where id = '${order.id}';
    alter table public.point_checkout_orders enable trigger point_checkout_orders_immutable;`);
  assert.equal((await status(h, user, order.id)).status, 'expired');
  assert.equal((await deliver(h, payload(h.config, order))).body.credited, true);
  assert.equal(await balance(user), '10000');
});

test('15. a verified payment is never forgotten: a temporary error or a disabled wallet is retried safely', async () => {
  const h = handlers(); const user = await newUser();
  // Temporary database error while crediting: 503 (Lemon Squeezy retries) and the payment stays queued.
  const order = await buy(h, user, 'starter');
  const paid = payload(h.config, order);
  failNext.add('credit_point_checkout_order');
  assert.deepEqual(await deliver(h, paid), { status: 503, body: { error: 'POINTS_UNAVAILABLE', queued: true } });
  assert.equal(await balance(user), '0');
  assert.equal((await client.rpc('list_point_payment_exceptions', {})).data.uncredited.filter((u) => u.orderId === order.id).length, 1);
  // The launcher's next status check credits it, exactly once.
  assert.equal((await status(h, user, order.id)).status, 'credited');
  assert.equal(await balance(user), '5000');
  assert.equal((await deliver(h, paid)).body.duplicate, true);
  assert.equal(await balance(user), '5000');
  // Wallet writes switched off when the webhook arrives: acknowledged, kept, credited once switched on.
  const paused = handlers({ ...ENV, POINTS_MUTATIONS_ENABLED: 'false' });
  const later = await buy(h, user, 'pro');
  assert.deepEqual((await deliver(paused, payload(h.config, later))).body, { credited: false, queued: true });
  assert.equal((await status(paused, user, later.id)).status, 'pending', 'no credit while writes are off');
  assert.equal(await balance(user), '5000');
  const retried = (await client.rpc('retry_point_provider_payments', { p_order_id: null })).data;
  assert.equal(retried.credited, 1);
  assert.equal((await client.rpc('retry_point_provider_payments', { p_order_id: null })).data.credited, 0, 'safe to repeat');
  assert.equal(await balance(user), '32500');
  assert.equal((await client.rpc('list_point_payment_exceptions', {})).data.uncredited.filter((u) => u.userId === user).length, 0);
});

test('16-18. refunds: unused reversed once, used ones flagged, never negative or from other purchases', async () => {
  const h = handlers(); const user = await newUser();
  const unused = await buy(h, user, 'starter'); const paidUnused = payload(h.config, unused); await deliver(h, paidUnused);
  const refund = (paid, amount, refundStatus = 'refunded') => ({ ...paid, meta: { ...paid.meta, event_name: 'order_refunded' },
    data: { ...paid.data, attributes: { ...paid.data.attributes, status: refundStatus, refunded: refundStatus === 'refunded', refunded_amount: amount } } });
  assert.equal((await deliver(h, refund(paidUnused, 500))).body.settlement, 'reversed_unused');
  assert.equal((await deliver(h, refund(paidUnused, 500))).body.duplicate, true);
  assert.equal(await balance(user), '0');
  // A used purchase refunded by Lemon Squeezy: recorded and flagged; other purchases untouched.
  const used = await buy(h, user, 'starter'); const paidUsed = payload(h.config, used); await deliver(h, paidUsed);
  const other = await buy(h, user, 'regular'); const paidOther = payload(h.config, other); await deliver(h, paidOther);
  await client.rpc('apply_point_transaction', { p_user_id: user, p_amount: '-5000', p_type: 'spend', p_reason: 'Test usage',
    p_source_type: 'test', p_source_id: randomUUID(), p_idempotency_key: `test:${randomUUID()}`, p_metadata: {},
    p_actor_id: null, p_reversal_of: null });
  assert.equal((await deliver(h, refund(paidUsed, 500))).body.settlement, 'fully_consumed');
  assert.equal(await balance(user), '10000');
  const flags = (await client.rpc('list_point_review_queue', {})).data.flags.filter((f) => f.userId === user);
  assert.deepEqual(flags.map((f) => f.reason), ['REFUND_AFTER_CONSUMPTION']);
  // A partial refund never removes Points automatically.
  assert.equal((await deliver(h, refund(paidOther, 200, 'partial_refund'))).body.settlement, 'partial_refund_review');
  assert.equal(await balance(user), '10000');
});

test('19-20. history shows the purchases and a restarted launcher finds the latest order', async () => {
  const h = handlers(); const user = await newUser();
  const order = await buy(h, user, 'max'); await deliver(h, payload(h.config, order));
  const history = await listPointTransactions(client, user);
  assert.deepEqual(history.items.map((item) => [item.type, item.amount, item.description]), [['award', '57500', 'Points purchase']]);
  // What the launcher asks after a restart: the account's newest order, credited, with its credit time.
  const latest = await status(h, user);
  assert.deepEqual([latest.id, latest.status, latest.points], [order.id, 'credited', '57500']);
  assert.ok(latest.creditedAt);
  assert.equal(await balance(user), '57500');
});

test('order 4969721-style payments from a public share link (no PlayLive reference) are ignored', async () => {
  const h = handlers(); const user = await newUser();
  const order = await buy(h, user, 'starter');
  const share = payload(h.config, order, { id: '4969721' });
  delete share.meta.custom_data;
  assert.deepEqual((await deliver(h, share)).body, { ignored: 'NOT_A_POINTS_ORDER' });
  assert.equal(await balance(user), '0');
});

test('variant discovery proposes IDs only for exact, unambiguous name and price matches', () => {
  const product = (name, variants) => ({ name, variants });
  const variant = (variantId, price, extra = {}) => ({ variantId, price: String(price), status: 'published', ...extra });
  const store = [product('PlayLive Points – Starter', [variant('11', 500)]), product('PlayLive Points – Regular', [variant('12', 1000)]),
    product('PlayLive Points – Pro', [variant('13', 2500)]), product('PlayLive Points – Max', [variant('14', 5000)]),
    product('PlayLive Points – Ultimate', [variant('15', 10000)])];
  assert.deepEqual(proposeVariantIds(store), { proposal: { starter: '11', regular: '12', pro: '13', max: '14', ultimate: '15' }, problems: [] });
  const wrongPrice = structuredClone(store); wrongPrice[2].variants[0].price = '2400';
  assert.match(proposeVariantIds(wrongPrice).problems.join(), /pro .*0 matching/);
  const duplicate = [...store, product('Starter bundle', [variant('99', 500)])];
  assert.match(proposeVariantIds(duplicate).problems.join(), /starter .*2 matching/);
  const draft = structuredClone(store); draft[0].variants[0].status = 'draft';
  assert.ok(!('starter' in proposeVariantIds(draft).proposal));
});
