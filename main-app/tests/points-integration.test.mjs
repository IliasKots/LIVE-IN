import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pointsMutationsAllowed } from '../lib/points-policy.mjs';
import { readItchConfig, publicItchPacks, createItchCheckout } from '../lib/points-itch-core.mjs';
import { createPointsPacksHandler } from '../lib/points-packs-http.mjs';

const env = { NODE_ENV: 'test', POINTS_DEPLOYMENT_ENVIRONMENT: 'staging', POINTS_ENABLED: 'true', POINTS_MUTATIONS_ENABLED: 'true',
  POINTS_ITCH_CHECKOUT_ENABLED: 'true', POINTS_ITCH_CLAIMS_ENABLED: 'true', ITCH_POINTS_PRODUCTS_VERIFIED: 'true',
  POINTS_SITE_ORIGIN: 'https://staging.example.invalid', ITCH_POINTS_PROJECT_URL: 'https://seller.itch.io/points',
  ITCH_POINTS_REDEEM_SECRET: 'simulated-provider-secret-for-unit-tests',
  ITCH_POINTS_PACKS_JSON: JSON.stringify([{ id: 'creator', name: 'Creator', points: '9007199254740993', subProductId: '123', priceLabel: '€10', currency: 'EUR', priceMinor: '1000', enabled: true },
    { id: 'disabled', name: 'Disabled', points: '1000', subProductId: '124', priceLabel: '€5', currency: 'EUR', priceMinor: '500', enabled: false }]) };
const user = '11111111-1111-4111-8111-111111111111';

test('production mutation acceptance is independent of staging and unknown environments fail closed', () => {
  assert.equal(pointsMutationsAllowed(env), true);
  assert.equal(pointsMutationsAllowed({ ...env, POINTS_DEPLOYMENT_ENVIRONMENT: '' }), false);
  assert.equal(pointsMutationsAllowed({ ...env, POINTS_DEPLOYMENT_ENVIRONMENT: 'production' }), false);
  assert.equal(pointsMutationsAllowed({ ...env, POINTS_DEPLOYMENT_ENVIRONMENT: 'production', POINTS_PRODUCTION_ACCEPTED: 'true' }), true);
  assert.equal(pointsMutationsAllowed({ ...env, POINTS_MUTATIONS_ENABLED: 'false' }), false);
});

test('unverified products and disabled production acceptance cannot expose or buy placeholder packs', () => {
  for (const overrides of [{ ITCH_POINTS_PRODUCTS_VERIFIED: 'false' }, { POINTS_DEPLOYMENT_ENVIRONMENT: 'production' },
    { POINTS_ITCH_CLAIMS_ENABLED: 'false' }, { POINTS_MUTATIONS_ENABLED: 'false' }]) {
    const config = readItchConfig({ ...env, ...overrides });
    assert.deepEqual(publicItchPacks(config), []);
    assert.throws(() => createItchCheckout(config, user, 'creator'), /CHECKOUT_DISABLED/);
  }
  assert.throws(() => readItchConfig({ ...env, ITCH_POINTS_PACKS_JSON: env.ITCH_POINTS_PACKS_JSON.replace('€10', '') }), /CONFIGURATION/);
});

test('public pack endpoint serves only enabled safe server fields and exact decimal strings without auth', async () => {
  const handler = createPointsPacksHandler({ getPacks: () => publicItchPacks(readItchConfig(env)) });
  const response = handler();
  assert.equal(response.status, 200);
  assert.match(response.headers.get('cache-control'), /no-store/);
  assert.deepEqual(await response.json(), { checkoutEnabled: true,
    packs: [{ id: 'creator', name: 'Creator', points: '9007199254740993', priceLabel: '€10', currency: 'EUR', priceMinor: '1000' }] });
});

test('unavailable pack endpoint does not invent prices or disclose configuration and disabled packs remain empty', async () => {
  const failed = createPointsPacksHandler({ getPacks() { throw new Error('private configuration'); } })();
  assert.equal(failed.status, 503); assert.doesNotMatch(await failed.text(), /private configuration/);
  const disabled = createPointsPacksHandler({ getPacks: () => [] })();
  assert.deepEqual(await disabled.json(), { packs: [], checkoutEnabled: false });
});
