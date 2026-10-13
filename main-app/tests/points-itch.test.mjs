import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readItchConfig, publicItchPacks, createItchCheckout, verifyItchClaim, sealPendingClaim,
  openPendingClaim, redeemItchClaim } from '../lib/points-itch-core.mjs';
import { createItchCheckoutHandler, createItchRedeemHandler, createItchClaimHandler } from '../lib/points-itch-http.mjs';

export const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
export const SECRET = 'local-simulated-itch-secret-not-a-real-credential';
export const ENV = { NODE_ENV: 'test', POINTS_ENABLED: 'true', POINTS_MUTATIONS_ENABLED: 'true',
  POINTS_DEPLOYMENT_ENVIRONMENT: 'local', ITCH_POINTS_PRODUCTS_VERIFIED: 'true',
  POINTS_ITCH_CHECKOUT_ENABLED: 'true', POINTS_ITCH_CLAIMS_ENABLED: 'true',
  ITCH_POINTS_PROJECT_URL: 'https://seller.itch.io/playlive', POINTS_SITE_ORIGIN: 'http://localhost:3000',
  ITCH_POINTS_REDEEM_SECRET: SECRET,
  ITCH_POINTS_PACKS_JSON: JSON.stringify([{ id: 'starter', name: 'Starter', points: '5000', subProductId: '101', priceLabel: '$5', currency: 'USD', priceMinor: '500', enabled: true }]) };
export const config = () => readItchConfig(ENV);

test('our own signed checkout metadata alone is never accepted as proof of payment', () => {
  const metadata = new URL(createItchCheckout(config(), USER, 'starter')).searchParams.get('metadata');
  assert.throws(() => verifyItchClaim(config(), metadata), /INVALID_PURCHASE/);
});

export function proof({ purchaseId = 7, userId = USER, time = Math.floor(Date.now() / 1000), metadata, ...overrides } = {}) {
  const url = new URL(createItchCheckout(config(), userId, 'starter'));
  const payload = { purchase_id: purchaseId, sub_product_id: 101, iat: time, exp: time + 600,
    metadata: metadata || JSON.parse(Buffer.from(url.searchParams.get('metadata').split('.')[1], 'base64url').toString()), ...overrides };
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.${createHmac('sha256', SECRET).update(`${header}.${body}`).digest('base64url')}`;
}
const post = (path, body = null, cookie = null, origin = ENV.POINTS_SITE_ORIGIN) => new Request(`${origin}${path}`, {
  method: 'POST', headers: { Origin: origin, ...(cookie ? { Cookie: cookie } : {}) }, body: body === null ? null : JSON.stringify(body),
});

test('purchase switches fail closed; public packs expose no credentials', () => {
  assert.deepEqual(publicItchPacks(readItchConfig({})), []);
  assert.throws(() => createItchCheckout(readItchConfig({}), USER, 'starter'), /CHECKOUT_DISABLED/);
  assert.deepEqual(publicItchPacks(config()), [{ id: 'starter', name: 'Starter', points: '5000', priceLabel: '$5', currency: 'USD', priceMinor: '500' }]);
  assert.deepEqual(publicItchPacks(readItchConfig({ ...ENV, POINTS_MUTATIONS_ENABLED: 'false' })), []);
  assert.deepEqual(publicItchPacks({ ...config(), claimsEnabled: false }), []);
  for (const url of ['http://seller.itch.io/playlive', 'https://itch.io.evil.com/playlive', 'https://u:p@seller.itch.io/playlive', 'https://seller.itch.io/playlive?x=1']) {
    assert.throws(() => readItchConfig({ ...ENV, ITCH_POINTS_PROJECT_URL: url }), /CONFIGURATION/);
  }
  assert.throws(() => readItchConfig({ ...ENV, NODE_ENV: 'production' }), /CONFIGURATION/);
});

test('checkout signs account and immutable pack data; client amount/user cannot control it', () => {
  const url = new URL(createItchCheckout(config(), USER, 'starter'));
  assert.equal(url.origin, 'https://seller.itch.io');
  assert.equal(url.searchParams.get('popup'), '1');
  assert.equal(url.searchParams.get('sub_product_id'), '101');
  assert.ok(url.searchParams.get('metadata').length < 1024);
  assert.throws(() => verifyItchClaim(config(), url.searchParams.get('metadata')), /INVALID_PURCHASE/);
  assert.throws(() => createItchCheckout(config(), USER, 'not-a-pack'), /UNKNOWN_PACK/);
});

test('claim rejects bad signatures, algorithms, expired/future proofs, pack mismatch and missing account binding', () => {
  const valid = proof({ time: 1000 });
  assert.equal(verifyItchClaim(config(), valid, 1001).points, '5000');
  const parts = valid.split('.');
  parts[1] = Buffer.from(JSON.stringify({ purchase_id: 999 })).toString('base64url');
  assert.throws(() => verifyItchClaim(config(), parts.join('.'), 1001), /INVALID_PURCHASE/);
  assert.throws(() => verifyItchClaim(config(), 'eyJhbGciOiJub25lIn0.e30.fake', 1001), /INVALID_PURCHASE/);
  assert.throws(() => verifyItchClaim(config(), valid, 1600), /CLAIM_EXPIRED/);
  assert.throws(() => verifyItchClaim(config(), valid, 900), /INVALID_PURCHASE/);
  assert.throws(() => verifyItchClaim(config(), proof({ sub_product_id: 102 })), /PACK_MISMATCH/);
  assert.throws(() => verifyItchClaim(config(), proof({ metadata: {} })), /UNLINKED_PURCHASE/);
  assert.throws(() => verifyItchClaim(config(), proof({ purchaseId: Number.MAX_SAFE_INTEGER + 1 })), /INVALID_PURCHASE/);
  assert.throws(() => verifyItchClaim(config(), proof({ nbf: Math.floor(Date.now() / 1000) + 600 })), /INVALID_PURCHASE/);
});

test('a signed proof exposing an unpaid or reversed status cannot credit points', () => {
  for (const status of ['pending', 'failed', 'cancelled', 'refunded', '', false]) {
    assert.throws(() => verifyItchClaim(config(), proof({ status })), /PAYMENT_NOT_COMPLETE/);
  }
  assert.equal(verifyItchClaim(config(), proof({ status: 'complete' })).purchaseId, '7');
});

test('pending claim survives original proof expiry; encrypted continuation resists tampering and expires', () => {
  const claim = verifyItchClaim(config(), proof({ time: 1000 }), 1001);
  const sealed = sealPendingClaim(claim, SECRET, 1001);
  assert.deepEqual(openPendingClaim(sealed, SECRET, 2000), claim);
  assert.throws(() => openPendingClaim(sealed, SECRET, 1001 + 7 * 86400), /NO_PENDING_CLAIM/);
  assert.throws(() => openPendingClaim(sealed, `${SECRET}different`, 1002), /NO_PENDING_CLAIM/);
  assert.throws(() => openPendingClaim(`A${sealed.slice(1)}`, SECRET, 1002), /NO_PENDING_CLAIM/);
  assert.doesNotMatch(sealed, /11111111|Starter/);
});

test('already-issued purchase keeps its points when catalog is renamed or disabled', () => {
  const token = proof();
  const changed = readItchConfig({ ...ENV, ITCH_POINTS_PACKS_JSON: '[]', POINTS_ITCH_CHECKOUT_ENABLED: 'false' });
  assert.equal(verifyItchClaim(changed, token).points, '5000');
  assert.throws(() => createItchCheckout(changed, USER, 'starter'), /CHECKOUT_DISABLED/);
});

test('wrong account and disabled claims never reach the database', async () => {
  const client = { rpc() { assert.fail('Database must not be called'); } };
  const claim = verifyItchClaim(config(), proof());
  await assert.rejects(redeemItchClaim(client, config(), claim, OTHER), /WRONG_ACCOUNT/);
  await assert.rejects(redeemItchClaim(client, { ...config(), claimsEnabled: false }, claim, USER), /CLAIMS_DISABLED/);
  const blockedConfig = { ...config(), blockedPurchaseIds: [claim.purchaseId] };
  await assert.rejects(redeemItchClaim(client, blockedConfig, claim, USER), /PURCHASE_REFUNDED/);
  assert.throws(() => verifyItchClaim(blockedConfig, proof()), /PURCHASE_REFUNDED/);
});

test('HTTP checkout requires same-origin authenticated browser and ignores client identity/amount', async () => {
  const checkout = createItchCheckoutHandler({ getConfig: config, authenticate: async () => ({ userId: USER }), getAdminClient: () => ({}),
    createIntent: async (_, cfg, userId, packId) => ({ userId, packId,
      projectUrl: cfg.projectUrl, ...cfg.packs.find((pack) => pack.id === packId), id: '33333333-3333-4333-8333-333333333333', status: 'pending' }) });
  const response = await checkout(post('/checkout', { packId: 'starter', amount: '999999', userId: OTHER }));
  assert.equal(response.status, 200);
  const metadata = JSON.parse(Buffer.from(new URL((await response.json()).url).searchParams.get('metadata').split('.')[1], 'base64url').toString());
  assert.equal(metadata.userId, USER); assert.equal(metadata.points, '5000');
  assert.match(response.headers.get('cache-control'), /no-store/);
  assert.equal((await checkout(post('/checkout', { packId: 'starter' }, null, 'https://evil.invalid'))).status, 403);
  const anonymous = createItchCheckoutHandler({ getConfig: config, authenticate: async () => null });
  assert.equal((await anonymous(post('/checkout', { packId: 'starter' }))).status, 401);
  assert.equal((await checkout(post('/checkout', { packId: 'starter', extra: 'x'.repeat(1024) }))).status, 400);
});

test('redeem consumes raw proof into HttpOnly cookie and redirects to a token-free page', async () => {
  const handler = createItchRedeemHandler({ getConfig: config });
  const response = await handler(new Request(`http://localhost:3000/api/points/itch/redeem?jwt=${proof()}`));
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('location'), '/launcher/points/claim');
  assert.match(response.headers.get('set-cookie'), /HttpOnly; SameSite=Lax/);
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  const cookie = response.headers.get('set-cookie').split(';')[0];
  const anonymous = createItchClaimHandler({ getConfig: config, authenticate: async () => null });
  assert.equal((await anonymous(post('/claim', null, cookie))).status, 401);
  const wrong = createItchClaimHandler({ getConfig: config, authenticate: async () => ({ userId: OTHER }), getAdminClient: () => ({ rpc() { assert.fail(); } }) });
  assert.equal((await wrong(post('/claim', null, cookie))).status, 403);
  const invalid = await handler(new Request('http://localhost:3000/redeem?jwt=bad&jwt=also-bad'));
  assert.match(invalid.headers.get('location'), /INVALID_PURCHASE/);
  assert.equal(invalid.headers.get('set-cookie'), null);
});

test('a database outage returns a retryable error without consuming the saved claim', async () => {
  const claim = verifyItchClaim(config(), proof());
  const cookie = `playlive_itch_claim=${sealPendingClaim(claim, SECRET)}`;
  const handler = createItchClaimHandler({ getConfig: config, authenticate: async () => ({ userId: USER }),
    getAdminClient: () => ({ rpc: async () => { throw new Error('private database details'); } }) });
  const response = await handler(post('/claim', null, cookie));
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'POINTS_UNAVAILABLE' });
  assert.equal(response.headers.get('set-cookie'), null);
});
