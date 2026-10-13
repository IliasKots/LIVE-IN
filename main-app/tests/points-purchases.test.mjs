import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPointsPurchasesHandler } from '../lib/points-purchases-http.mjs';
import { createItchCheckoutHandler } from '../lib/points-itch-http.mjs';
import { readItchConfig } from '../lib/points-itch-core.mjs';
import { createPurchaseIntent } from '../lib/points-purchases-core.mjs';
const userId = '11111111-1111-4111-8111-111111111111';
const id = '33333333-3333-4333-8333-333333333333';
const purchase = { id, userId, packId: 'pack', name: 'Configured', points: '9007199254740993', priceLabel: 'EUR 5',
  currency: 'EUR', priceMinor: '500', projectUrl: 'https://seller.itch.io/points', subProductId: '1',
  status: 'pending', transactionId: null, createdAt: '2026-10-10T12:00:00Z', creditedAt: null };
const config = readItchConfig({ NODE_ENV: 'test', POINTS_DEPLOYMENT_ENVIRONMENT: 'local', POINTS_ENABLED: 'true',
  POINTS_MUTATIONS_ENABLED: 'true', ITCH_POINTS_PRODUCTS_VERIFIED: 'true', POINTS_ITCH_CHECKOUT_ENABLED: 'true',
  POINTS_ITCH_CLAIMS_ENABLED: 'true', POINTS_SITE_ORIGIN: 'http://localhost:3000', ITCH_POINTS_PROJECT_URL: purchase.projectUrl,
  ITCH_POINTS_REDEEM_SECRET: 'only-local-test-redeem-secret', ITCH_POINTS_PACKS_JSON: JSON.stringify([
    { id: 'pack', name: 'Configured', points: purchase.points, subProductId: '1', priceLabel: 'EUR 5', currency: 'EUR', priceMinor: '500', enabled: true }]) });
const request = (method = 'GET', path = '', body = null) => new Request(`http://localhost:3000/api/v1/me/points/purchases${path}`,
  { method, headers: { Origin: 'http://localhost:3000' }, ...(body ? { body: JSON.stringify(body) } : {}) });

test('launcher purchase creation derives account from authentication and never accepts a client amount or price', async () => {
  let received;
  const route = createPointsPurchasesHandler({ authenticate: async () => ({ userId }), getConfig: () => config,
    getAdminClient: () => ({}), readsEnabled: () => true,
    createIntent: async (_, cfg, account, pack) => { received = { cfg, account, pack }; return purchase; },
    getIntent: async () => purchase });
  const result = await route.POST(request('POST', '', { packId: 'pack', amount: '999', price: '0', userId: id }));
  assert.equal(result.status, 200); assert.equal(received.account, userId); assert.equal(received.pack, 'pack');
  const data = await result.json(); assert.equal(data.purchase.points, purchase.points);
  assert.doesNotMatch(JSON.stringify(data), /secret|projectUrl|subProductId|userId/);
  assert.match(result.headers.get('cache-control'), /private, no-store/);
  assert.equal((await route.POST(request('POST', '', { packId: 'pack', extra: 'x'.repeat(1100) }))).status, 400);
});

test('purchase recovery checks authentication and validates intent IDs before reads, including expired login', async () => {
  let calls = 0;
  const route = createPointsPurchasesHandler({ authenticate: async () => null, readsEnabled: () => true,
    getAdminClient: () => { ++calls; return {}; }, getIntent: async () => purchase });
  assert.equal((await route.GET(request())).status, 401);
  assert.equal((await route.POST(request('POST', '', { packId: 'pack' }))).status, 401);
  assert.equal(calls, 0);
  const valid = createPointsPurchasesHandler({ authenticate: async () => ({ userId }), readsEnabled: () => true,
    getAdminClient: () => ({ rpc: async () => { ++calls; return { data: null }; } }) });
  assert.equal((await valid.GET(request('GET', '?intent=invalid'))).status, 400);
  assert.equal((await valid.GET(request('GET', `?intent=${id}&intent=${id}`))).status, 400);
  assert.equal(calls, 0);
  assert.deepEqual(await (await valid.GET(request())).json(), { purchase: null });
});

test('browser checkout resumes only its signed-in account intent and credited intents do not open another payment', async () => {
  const deps = { authenticate: async () => ({ userId }), getConfig: () => config, getAdminClient: () => ({}), getIntent: async () => purchase };
  const route = createItchCheckoutHandler(deps);
  const result = await route(request('POST', '', { packId: 'pack', intentId: id }));
  assert.equal(result.status, 200); const data = await result.json(); assert.equal(data.intentId, id);
  const metadata = JSON.parse(Buffer.from(new URL(data.url).searchParams.get('metadata').split('.')[1], 'base64url').toString());
  assert.equal(metadata.intentId, id); assert.equal(metadata.userId, userId);
  const wrong = createItchCheckoutHandler({ ...deps, getIntent: async () => null });
  assert.equal((await wrong(request('POST', '', { packId: 'pack', intentId: id }))).status, 404);
  const credited = createItchCheckoutHandler({ ...deps, getIntent: async () => ({ ...purchase, status: 'credited' }) });
  assert.deepEqual(await (await credited(request('POST', '', { packId: 'pack', intentId: id }))).json(), { intentId: id, alreadyCredited: true });
});

test('unpriced legacy packs can complete existing claims but cannot create real purchase intents', async () => {
  const legacy = { ...config, packs: [{ ...config.packs[0], currency: null, priceMinor: null }] };
  await assert.rejects(createPurchaseIntent({ rpc() { assert.fail('No database call'); } }, legacy, userId, 'pack'), /PURCHASE_CONFIGURATION_UNAVAILABLE/);
});
