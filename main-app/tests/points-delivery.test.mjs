import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { PLAYLIVE_POINT_PACKS, configuredPlayLivePacks } from '../lib/points-catalog.mjs';
import { readItchConfig, createItchCheckout, verifyItchClaim } from '../lib/points-itch-core.mjs';
import { createItchRedeemHandler } from '../lib/points-itch-http.mjs';
import { createPointsDeliveryHandler } from '../lib/points-delivery-http.mjs';

const userId = '11111111-1111-4111-8111-111111111111';
const intentId = '33333333-3333-4333-8333-333333333333';
const env = { NODE_ENV: 'test', POINTS_DEPLOYMENT_ENVIRONMENT: 'local', POINTS_ENABLED: 'true',
  POINTS_MUTATIONS_ENABLED: 'true', ITCH_POINTS_PRODUCTS_VERIFIED: 'true', POINTS_ITCH_CHECKOUT_ENABLED: 'true',
  POINTS_ITCH_CLAIMS_ENABLED: 'true', POINTS_SITE_ORIGIN: 'http://localhost:3000',
  ITCH_POINTS_PROJECT_URL: 'https://seller.itch.io/points', ITCH_POINTS_REDEEM_SECRET: 'local-delivery-test-secret-only',
  ITCH_POINTS_PRODUCT_IDS_JSON: JSON.stringify({ starter: '101', regular: '102', pro: '103', max: '104', ultimate: '105' }) };
const config = readItchConfig(env);
function token(overrides = {}) {
  const pack = config.packs[0];
  const intent = { ...pack, id: intentId, userId, packId: pack.id, projectUrl: config.projectUrl };
  const metadata = JSON.parse(Buffer.from(new URL(createItchCheckout(config, userId, pack.id, intent))
    .searchParams.get('metadata').split('.')[1], 'base64url').toString());
  const time = Math.floor(Date.now() / 1000);
  const header = Buffer.from('{"alg":"HS256"}').toString('base64url');
  const body = Buffer.from(JSON.stringify({ iat: time, exp: time + 600, purchase_id: '1234',
    sub_product_id: '101', external_id: 'starter', metadata, ...overrides })).toString('base64url');
  return `${header}.${body}.${createHmac('sha256', config.secret).update(`${header}.${body}`).digest('base64url')}`;
}
const post = (body, origin = config.origin) => new Request(`${config.origin}/api/points/purchases/claim`,
  { method: 'POST', headers: { Origin: origin }, body: JSON.stringify(body) });

test('approved catalog totals and USD prices include bonuses exactly; only provider IDs are configurable', () => {
  assert.deepEqual(PLAYLIVE_POINT_PACKS.map(({ points, priceMinor }) => [points, priceMinor]),
    [['5000', '500'], ['10000', '1000'], ['27500', '2500'], ['57500', '5000'], ['120000', '10000']]);
  assert.equal(config.packs.length, 5);
  assert.ok(config.packs.every((pack) => pack.currency === 'USD'));
  assert.throws(() => configuredPlayLivePacks({ starter: '101', regular: '101' }), /CONFIGURATION/);
  assert.throws(() => configuredPlayLivePacks({ starter: 101 }), /CONFIGURATION/);
  assert.throws(() => configuredPlayLivePacks({ arbitrary: '101' }), /CONFIGURATION/);
  assert.throws(() => readItchConfig({ ...env, ITCH_POINTS_PACKS_JSON: '[{}]' }), /CONFIGURATION/);
  for (const override of [{ points: '4999' }, { currency: 'EUR' }, { priceMinor: '499' }]) {
    assert.throws(() => readItchConfig({ ...env, ITCH_POINTS_PRODUCT_IDS_JSON: undefined,
      ITCH_POINTS_PACKS_JSON: JSON.stringify([{ ...config.packs[0], ...override }]) }), /CONFIGURATION/);
  }
  assert.equal(readItchConfig({ ...env, ITCH_POINTS_PRODUCT_IDS_JSON: '{"starter":"101"}' }).packs.length, 1);
});

test('provider product identity must match account-bound selected pack; ownership/redirect alone is not evidence', () => {
  assert.equal(verifyItchClaim(config, token()).points, '5000');
  assert.throws(() => verifyItchClaim(config, token({ external_id: 'ultimate' })), /PACK_MISMATCH/);
  assert.throws(() => verifyItchClaim(config, token({ sub_product_id: '105' })), /PACK_MISMATCH/);
  assert.throws(() => verifyItchClaim(config, token({ purchase_id: undefined, owns: true })), /INVALID_PURCHASE/);
});

test('verified redeem persists evidence before clean redirect without crediting a wallet or exposing the proof', async () => {
  let stored;
  const route = createItchRedeemHandler({ getConfig: () => config, getAdminClient: () => ({}),
    rememberClaim: async (_, cfg, claim) => { assert.equal(cfg, config); stored = claim; } });
  const response = await route(new Request(`${config.origin}/redeem?jwt=${token()}`));
  assert.equal(stored.intentId, intentId); assert.equal(stored.userId, userId);
  assert.equal(response.headers.get('location'), '/launcher/points/claim');
  assert.doesNotMatch(response.headers.get('location'), /jwt|1234|11111111/);
  assert.match(response.headers.get('set-cookie'), /HttpOnly/);
  stored = null;
  await route(new Request(`${config.origin}/redeem?jwt=invalid`));
  assert.equal(stored, null, 'Invalid claims never reach persistence');
});

test('database failure after verification retains secure continuation for authenticated retry', async () => {
  const route = createItchRedeemHandler({ getConfig: () => config, getAdminClient: () => ({}),
    rememberClaim: async () => { throw new Error('sensitive connection details'); } });
  const response = await route(new Request(`${config.origin}/redeem?jwt=${token()}`));
  assert.equal(response.headers.get('location'), '/launcher/points/claim');
  assert.match(response.headers.get('set-cookie'), /HttpOnly/);
  assert.doesNotMatch(await response.text(), /sensitive/);
});

test('delivery recovery derives account from authenticated session and ignores client payment/points assertions', async () => {
  let received;
  const route = createPointsDeliveryHandler({ getConfig: () => config, authenticate: async () => ({ userId }),
    getAdminClient: () => ({}), browser: true, recover: async (_, cfg, account, id) => {
      received = { cfg, account, id }; return { purchase: { id, status: 'pending' } };
    } });
  const response = await route(post({ intentId, userId: intentId, amount: '999999', paid: true, purchaseId: '1234' }));
  assert.equal(response.status, 200); assert.equal(received.account, userId); assert.equal(received.id, intentId);
  assert.equal((await response.json()).purchase.status, 'pending');
  assert.match(response.headers.get('cache-control'), /no-store/);
  assert.equal((await route(post({ intentId }, 'https://attacker.invalid'))).status, 403);
  const expired = createPointsDeliveryHandler({ getConfig: () => config, authenticate: async () => null,
    getAdminClient: () => { assert.fail('Expired login cannot reach database'); } });
  assert.equal((await expired(post({ intentId }))).status, 401);
  const disabled = createPointsDeliveryHandler({ getConfig: () => ({ ...config, claimsEnabled: false }),
    authenticate: async () => ({ userId }), getAdminClient: () => { assert.fail(); } });
  assert.equal((await disabled(post({ intentId }))).status, 503);
});

test('private receipt diagnostic checks a simulated provider signature with operational sales gates off and never outputs tokens', () => {
  const proof = token();
  const result = spawnSync(process.execPath, ['scripts/verify-itch-receipt.mjs'], { encoding: 'utf8', input: proof,
    env: { ...env, POINTS_ENABLED: 'false', POINTS_MUTATIONS_ENABLED: 'false',
      POINTS_ITCH_CHECKOUT_ENABLED: 'false', POINTS_ITCH_CLAIMS_ENABLED: 'false' } });
  assert.equal(result.status, 0, result.stderr);
  const diagnostic = JSON.parse(result.stdout);
  assert.equal(diagnostic.signatureVerified, true); assert.equal(diagnostic.credited, false);
  assert.equal(diagnostic.points, '5000'); assert.equal(diagnostic.purchaseId, '1234');
  assert.doesNotMatch(result.stdout, /local-delivery-test-secret|eyJhbG|11111111/);
  const invalid = spawnSync(process.execPath, ['scripts/verify-itch-receipt.mjs'], { encoding: 'utf8', input: 'invalid-proof', env });
  assert.equal(invalid.status, 1);
  assert.equal(JSON.parse(invalid.stderr).credited, false);
  assert.doesNotMatch(invalid.stderr, /invalid-proof|secret/);
});
