import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { economyFlags, sanitizeUsageEvent } from '../lib/points-economy-core.mjs';
import { createUsageHandlers, createProductHandlers, createRefundHandlers } from '../lib/points-economy-http.mjs';
import { readLemonSqueezyConfig, signWebhookBody, checkoutCustomData } from '../lib/points-lemonsqueezy-core.mjs';
import { createPointOrdersHandler, createLemonSqueezyWebhookHandler } from '../lib/points-lemonsqueezy-http.mjs';
import { readStripeConfig, createStripeCheckout, verifyStripeSignature, signStripeBody } from '../lib/points-stripe-core.mjs';
import { createStripeWebhookHandler } from '../lib/points-stripe-http.mjs';

// Executes ALL actual migrations in an isolated in-memory PostgreSQL engine.
// Gift IDs and Diamond quantities below are TEST FIXTURES, not real TikTok
// values: the production gift-value table ships empty (see the migration).
const ORIGIN = 'http://localhost:3000';
const GAME = 'disco';
const LIVE = 'streamer_live';
const GIFT_100 = '900001'; // fixture: 100 verified units per gift
const GIFT_1 = '900002';   // fixture: 1 verified unit per gift
const GIFT_UNPRICED = '900003';
const BASE = { NODE_ENV: 'test', POINTS_DEPLOYMENT_ENVIRONMENT: 'local', POINTS_ENABLED: 'true',
  POINTS_MUTATIONS_ENABLED: 'true', POINTS_SITE_ORIGIN: ORIGIN,
  POINTS_ORDER_REFERENCE_SECRET: 'local-test-order-reference-secret-0123456789abcdef' };
const ECONOMY_ENV = { ...BASE, POINTS_USAGE_BILLING_ENABLED: 'true', POINTS_PRODUCTS_ENABLED: 'true',
  POINTS_REFUND_REQUESTS_ENABLED: 'true', POINTS_REFUND_AUTOMATION_ENABLED: 'true' };
const LS_SECRET = 'local-test-webhook-secret-0123456789';
const LS_ENV = { ...ECONOMY_ENV, POINTS_PAYMENT_PROVIDER: 'lemonsqueezy', LEMONSQUEEZY_MODE: 'test',
  LEMONSQUEEZY_STORE_ID: '4242', LEMONSQUEEZY_API_KEY: 'local-fake-api-key-not-a-real-credential',
  LEMONSQUEEZY_WEBHOOK_SECRET: LS_SECRET, LEMONSQUEEZY_VARIANT_IDS_JSON: '{"starter":"777001"}',
  LEMONSQUEEZY_PRODUCTS_VERIFIED: 'true' };
const STRIPE_SECRET = 'whsec_localtestsecret0123456789';
const STRIPE_ENV = { ...ECONOMY_ENV, POINTS_PAYMENT_PROVIDER: 'stripe', STRIPE_SECRET_KEY: 'sk_test_localfakekey0123456789',
  STRIPE_WEBHOOK_SECRET: STRIPE_SECRET, STRIPE_PRICE_IDS_JSON: '{"starter":"price_TestStarter001"}',
  STRIPE_PRODUCTS_VERIFIED: 'true' };

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
  // Local test database opt-ins (an operator does this on staging only after verification).
  await db.exec(`
    update public.point_payment_settings set accept_test_payments = true where id = 1;
    update public.point_billing_settings set usage_billing_enabled = true,
      verified_quantity_sources = '{tiktok_creator_diamonds}' where id = 1;
    insert into public.point_billable_games(game_id, rate_version, billing_enabled) values ('${GAME}', 1, true), ('freegame', 1, false);
    insert into public.point_gift_values(quantity_source, gift_id, units_per_gift, evidence) values
      ('tiktok_creator_diamonds', ${GIFT_100}, 100, 'TEST FIXTURE - not a real TikTok gift value'),
      ('tiktok_creator_diamonds', ${GIFT_1}, 1, 'TEST FIXTURE - not a real TikTok gift value');
    insert into public.point_products(product_id, game_id, product_type, name, price_points, purchase_mode,
      duration_seconds, units_per_purchase, fulfillment, active) values
      ('disco.neon-overlay', '${GAME}', 'overlay', 'Neon overlay (test)', 2000, 'one_time', null, 1, 'overlay:neon', true),
      ('disco.confetti', '${GAME}', 'premium_feature', 'Confetti burst (test)', 300, 'consumable', null, 5, 'effect:confetti', true),
      ('disco.vip-hour', '${GAME}', 'game_upgrade', 'VIP hour (test)', 1000, 'timed', 3600, 1, 'upgrade:vip', true),
      ('disco.retired', '${GAME}', 'content', 'Retired item (test)', 10, 'one_time', null, 1, 'content:old', false);`);
});
after(async () => { await db?.close(); });

async function asRole(role, sql, args = []) {
  return db.transaction(async (tx) => {
    await tx.exec(`set local role ${role}`);
    await tx.query("select set_config('request.jwt.claim.sub', '', true), set_config('request.jwt.claim.role', $1, true)", [role]);
    return tx.query(sql, args);
  });
}
const client = { async rpc(name, args) {
  const keys = Object.keys(args);
  try {
    const result = await asRole('service_role', `select public.${name}(${keys.map((key, index) => `${key} => $${index + 1}`).join(', ')}) as result`,
      keys.map((key) => (args[key] !== null && typeof args[key] === 'object' ? JSON.stringify(args[key]) : args[key])));
    return { data: result.rows[0].result, error: null };
  } catch (error) { return { data: null, error: { message: error.message, code: error.code } }; }
} };
async function newUser() { const id = randomUUID(); await db.query('insert into auth.users(id) values ($1)', [id]); return id; }
async function balance(id) { return (await asRole('service_role', 'select public.get_point_account($1::uuid) as r', [id])).rows[0].r.balance; }
async function ledger(id) {
  return (await db.query('select id, sequence, amount::text, type, source_type, idempotency_key from public.point_transactions where user_id = $1 order by sequence', [id])).rows;
}
async function credit(userId, amount, sourceType = 'reward:test', sourceId = randomUUID()) {
  const { data, error } = await client.rpc('apply_point_transaction', { p_user_id: userId, p_amount: String(amount),
    p_type: 'award', p_reason: 'Test credit', p_source_type: sourceType, p_source_id: sourceId,
    p_idempotency_key: `${sourceType}:${sourceId}`, p_metadata: {}, p_actor_id: null, p_reversal_of: null });
  assert.equal(error, null);
  return data;
}
async function assertLotInvariant() {
  const { rows } = await db.query(`select a.user_id from public.point_accounts a where a.balance <>
    coalesce((select sum(l.original - l.consumed - l.revoked) from public.point_lots l where l.user_id = a.user_id), 0)`);
  assert.deepEqual(rows, [], 'every balance equals the sum of its unused lots');
}

const auth = async (request) => { const id = request.headers.get('authorization')?.slice(7); return id ? { userId: id } : null; };
function economy(env = ECONOMY_ENV) {
  const deps = { authenticate: auth, getAdminClient: () => client, getFlags: () => economyFlags(env) };
  return { usage: createUsageHandlers(deps), products: createProductHandlers(deps), refunds: createRefundHandlers(deps) };
}
const post = (path, body, userId) => new Request(`${ORIGIN}${path}`, { method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(userId ? { Authorization: `Bearer ${userId}` } : {}) },
  body: typeof body === 'string' ? body : JSON.stringify(body) });
const get = (path, userId) => new Request(`${ORIGIN}${path}`, { headers: userId ? { Authorization: `Bearer ${userId}` } : {} });
async function call(handler, request) { const response = await handler(request); return { status: response.status, body: await response.json() }; }

async function startSession(h, userId, { gameId = GAME, liveId = LIVE, requestId = randomUUID() } = {}) {
  return call(h.usage.sessions.POST, post('/api/v1/me/points/usage/sessions', { requestId, gameId, liveId }, userId));
}
async function charge(h, userId, sessionId, events) {
  return call(h.usage.charges.POST, post('/api/v1/me/points/usage/charges', { sessionId, events }, userId));
}
async function sessionAction(h, userId, sessionId, action) {
  return call(h.usage.state.POST, post('/api/v1/me/points/usage/sessions/state', { sessionId, action }, userId));
}
const gift = (eventKey, giftId, cumulativeCount, extra = {}) => ({ eventKey, giftId, cumulativeCount: String(cumulativeCount), ...extra });

// ---------------------------------------------------------------------------
// Part A — TikTok Diamond usage billing
// ---------------------------------------------------------------------------

test('1. balance 5,000 and a verified 100-Diamond gift leaves 4,900, recorded with full audit metadata', async () => {
  const h = economy(); const user = await newUser(); await credit(user, 5000);
  const session = (await startSession(h, user)).body;
  assert.equal(session.billingEnabled, true);
  assert.equal(session.session.state, 'active');
  const result = await charge(h, user, session.session.id, [gift('room1|msg:1', GIFT_100, 1)]);
  assert.equal(result.status, 200);
  assert.equal(result.body.results[0].status, 'charged');
  assert.equal(result.body.results[0].points, '100');
  assert.equal(result.body.balance, '4900');
  assert.equal(await balance(user), '4900');
  assert.equal(result.body.session.pointsCharged, '100');
  assert.equal(result.body.session.unitsCharged, '100');
  const row = (await db.query(`select t.type, t.reason, t.source_type, t.metadata, e.rate_version, e.quantity_source, e.units
    from public.point_usage_events e join public.point_transactions t on t.id = e.transaction_id where e.user_id = $1`, [user])).rows[0];
  assert.equal(row.type, 'spend');
  assert.equal(row.source_type, 'tiktok_diamond_usage');
  assert.equal(row.metadata.reasonCode, 'TIKTOK_DIAMOND_USAGE');
  assert.equal(row.metadata.gameId, GAME);
  assert.equal(row.metadata.sessionId, session.session.id);
  assert.equal(row.metadata.liveId, LIVE);
  assert.equal(row.metadata.eventKey, 'room1|msg:1');
  assert.equal(row.metadata.quantitySource, 'tiktok_creator_diamonds');
  assert.equal(row.metadata.rateVersion, 1);
  assert.deepEqual([row.rate_version, row.quantity_source, String(row.units)], [1, 'tiktok_creator_diamonds', '100']);
});

test('2. a duplicate gift event deducts once, within one batch and across retries', async () => {
  const h = economy(); const user = await newUser(); await credit(user, 5000);
  const id = (await startSession(h, user)).body.session.id;
  const first = await charge(h, user, id, [gift('room1|msg:2', GIFT_100, 1), gift('room1|msg:2', GIFT_100, 1)]);
  assert.deepEqual(first.body.results.map((r) => r.status), ['charged', 'duplicate']);
  const retry = await charge(h, user, id, [gift('room1|msg:2', GIFT_100, 1)]);
  assert.equal(retry.body.results[0].status, 'duplicate');
  assert.equal(retry.body.results[0].charged, true, 'a retry after a lost response learns the gift was paid');
  assert.equal(retry.body.results[0].chargedInThisSession, true);
  assert.equal(await balance(user), '4900');
});

test('3. gift streak updates charge only the increment and never re-charge earlier gifts', async () => {
  const h = economy(); const user = await newUser(); await credit(user, 1000);
  const id = (await startSession(h, user)).body.session.id;
  const streak = 'room1|user:42|gift:900002|group:7';
  const r = await charge(h, user, id, [gift(streak, GIFT_1, 1), gift(streak, GIFT_1, 3), gift(streak, GIFT_1, 3),
    gift(streak, GIFT_1, 2), gift(streak, GIFT_1, 5)]);
  assert.deepEqual(r.body.results.map((x) => [x.status, x.increment ?? null]),
    [['charged', '1'], ['charged', '2'], ['duplicate', null], ['superseded', null], ['charged', '2']]);
  assert.equal(await balance(user), '995');
  assert.equal(r.body.session.charges, 3);
});

test('4. gifts while the game is not active are never charged', async () => {
  const h = economy(); const user = await newUser(); await credit(user, 1000);
  // A game without enabled billing never starts a paid session; it runs free as today.
  const free = await startSession(h, user, { gameId: 'freegame' });
  assert.deepEqual(free.body, { billingEnabled: false, reason: 'GAME_BILLING_DISABLED' });
  const unknown = await startSession(h, user, { gameId: 'not-registered' });
  assert.deepEqual(unknown.body, { billingEnabled: false, reason: 'GAME_NOT_BILLABLE' });
  const id = (await startSession(h, user)).body.session.id;
  assert.equal((await sessionAction(h, user, id, 'pause')).body.session.state, 'paused');
  const paused = await charge(h, user, id, [gift('room1|msg:4', GIFT_100, 1)]);
  assert.equal(paused.body.results[0].status, 'session_not_active');
  assert.equal(paused.body.results[0].charged, false);
  // A gift that happened before the session started is not billed either.
  await sessionAction(h, user, id, 'resume');
  const early = await charge(h, user, id, [gift('room1|msg:4b', GIFT_100, 1, { occurredAt: '2020-01-01T00:00:00Z' })]);
  assert.equal(early.body.results[0].status, 'before_session');
  assert.equal(await balance(user), '1000');
});

test('5. gifts after the session timed out are not charged and the session cannot be revived', async () => {
  const h = economy(); const user = await newUser(); await credit(user, 1000);
  const id = (await startSession(h, user)).body.session.id;
  await db.query(`update public.point_usage_sessions set last_seen_at = now() - interval '10 minutes' where id = $1`, [id]);
  const late = await charge(h, user, id, [gift('room1|msg:5', GIFT_100, 1)]);
  assert.equal(late.body.results[0].status, 'session_expired');
  assert.equal(late.body.session.state, 'expired');
  assert.equal(late.body.session.endReason, 'timeout');
  assert.equal((await sessionAction(h, user, id, 'heartbeat')).body.session.state, 'expired');
  assert.equal((await sessionAction(h, user, id, 'resume')).body.session.state, 'expired');
  assert.equal(await balance(user), '1000');
});

test('6. insufficient Points: no negative balance, no charge, and the unpaid part is never billed later', async () => {
  const h = economy(); const user = await newUser(); await credit(user, 50);
  const id = (await startSession(h, user)).body.session.id;
  const streak = 'room1|user:9|gift:900002|group:1';
  const result = await charge(h, user, id, [gift('room1|msg:6', GIFT_100, 1), gift(streak, GIFT_1, 60)]);
  assert.deepEqual(result.body.results.map((r) => [r.status, r.charged]), [['insufficient_points', false], ['insufficient_points', false]]);
  assert.equal(await balance(user), '50');
  await credit(user, 1000);
  // The streak continues after a top-up: only the new gifts are billed, not the 60 whose effect never ran.
  const later = await charge(h, user, id, [gift(streak, GIFT_1, 61)]);
  assert.deepEqual([later.body.results[0].status, later.body.results[0].points], ['charged', '1']);
  assert.equal(await balance(user), '1049');
  const negative = (await db.query('select count(*)::int as n from public.point_accounts where balance < 0')).rows[0].n;
  assert.equal(negative, 0);
});

test('7. simultaneous valid gift events leave the correct final balance', async () => {
  const h = economy(); const user = await newUser(); await credit(user, 1000);
  const id = (await startSession(h, user)).body.session.id;
  const calls = Array.from({ length: 12 }, (_, i) => charge(h, user, id, [gift(`room1|msg:7-${i}`, GIFT_100, 1)]));
  const statuses = (await Promise.all(calls)).map((r) => r.body.results[0].status);
  assert.equal(statuses.filter((s) => s === 'charged').length, 10);
  assert.equal(statuses.filter((s) => s === 'insufficient_points').length, 2);
  assert.equal(await balance(user), '0');
});

test('8. disconnect, reconnect, launcher restart and concurrent sessions never duplicate a charge', async () => {
  const h = economy(); const user = await newUser(); await credit(user, 5000);
  const a = (await startSession(h, user)).body.session.id;
  await charge(h, user, a, [gift('room1|grp:8', GIFT_1, 3)]);
  // TikTok connection drops and comes back: pause/resume the same session, then resend.
  await sessionAction(h, user, a, 'pause');
  await sessionAction(h, user, a, 'resume');
  assert.equal((await charge(h, user, a, [gift('room1|grp:8', GIFT_1, 3)])).body.results[0].status, 'duplicate');
  // Launcher restarts: a new session for the same LIVE re-delivers the gift.
  const b = (await startSession(h, user)).body.session.id;
  const resent = (await charge(h, user, b, [gift('room1|grp:8', GIFT_1, 3)])).body.results[0];
  assert.deepEqual([resent.status, resent.charged, resent.chargedInThisSession], ['duplicate', true, false]);
  assert.equal((await charge(h, user, b, [gift('room1|grp:8', GIFT_1, 4)])).body.results[0].increment, '1');
  // Two concurrent paid sessions of the same streamer report the same LIVE gift.
  const [x, y] = await Promise.all([charge(h, user, a, [gift('room1|msg:8c', GIFT_100, 1)]),
    charge(h, user, b, [gift('room1|msg:8c', GIFT_100, 1)])]);
  assert.deepEqual([x.body.results[0].status, y.body.results[0].status].sort(), ['charged', 'duplicate']);
  assert.equal(await balance(user), String(5000 - 3 - 1 - 100));
  // Starting with the same request ID (retried start) returns the same session.
  const requestId = randomUUID();
  const s1 = (await startSession(h, user, { requestId })).body;
  const s2 = (await startSession(h, user, { requestId })).body;
  assert.equal(s1.session.id, s2.session.id);
  assert.equal(s2.duplicate, true);
});

test('15. invalid or manipulated gift reports are never trusted', async () => {
  const h = economy(); const user = await newUser(); const other = await newUser(); await credit(user, 5000);
  const id = (await startSession(h, user)).body.session.id;
  // Client-supplied quantities and prices are dropped before the database.
  assert.deepEqual(sanitizeUsageEvent({ eventKey: 'k', giftId: '1', cumulativeCount: '1', diamonds: '999999',
    points: '-5', price: '0', userId: other }), { eventKey: 'k', giftId: '1', cumulativeCount: '1' });
  const r = await charge(h, user, id, [
    { eventKey: 'room1|msg:15a', giftId: GIFT_1, cumulativeCount: '1', diamonds: '1000000', points: '1' },
    gift('bad key with spaces', GIFT_100, 1),
    { eventKey: 'room1|msg:15b', giftId: Number(GIFT_100), cumulativeCount: '1' },
    gift('room1|msg:15c', GIFT_100, -1),
    gift('room1|msg:15d', GIFT_100, '1.5'),
    gift('room1|msg:15e', GIFT_UNPRICED, 1),
    'not-an-object',
  ]);
  assert.deepEqual(r.body.results.map((x) => x.status),
    ['charged', 'invalid', 'invalid', 'invalid', 'invalid', 'gift_value_unverified', 'invalid']);
  assert.equal(r.body.results[0].points, '1', 'priced from the server table, not the client field');
  assert.equal(await balance(user), '4999');
  // Another account cannot charge or read this session.
  assert.equal((await charge(h, other, id, [gift('room1|msg:15f', GIFT_100, 1)])).status, 404);
  assert.equal((await call(h.usage.sessions.GET, get(`/api/v1/me/points/usage/sessions?session=${id}`, other))).status, 404);
  // Unauthenticated and oversized requests are refused before any work.
  assert.equal((await charge(h, null, id, [gift('room1|msg:15g', GIFT_100, 1)])).status, 401);
  const tooMany = Array.from({ length: 51 }, (_, i) => gift(`room1|msg:15h-${i}`, GIFT_1, 1));
  assert.equal((await charge(h, user, id, tooMany)).status, 400);
  assert.equal(await balance(user), '4999');
});

test('17. stopping a game session prevents any further charge for it', async () => {
  const h = economy(); const user = await newUser(); await credit(user, 1000);
  const id = (await startSession(h, user)).body.session.id;
  await charge(h, user, id, [gift('room1|msg:17a', GIFT_100, 1)]);
  const stopped = await sessionAction(h, user, id, 'stop');
  assert.deepEqual([stopped.body.session.state, stopped.body.session.endReason], ['stopped', 'stopped']);
  const after = await charge(h, user, id, [gift('room1|msg:17b', GIFT_100, 1)]);
  assert.equal(after.body.results[0].status, 'session_not_active');
  assert.equal((await sessionAction(h, user, id, 'resume')).body.session.state, 'stopped');
  assert.equal(await balance(user), '900');
});

test('usage billing is unavailable unless every switch is on, and it fails closed', async () => {
  const user = await newUser(); await credit(user, 1000);
  const off = economy({ ...ECONOMY_ENV, POINTS_USAGE_BILLING_ENABLED: 'false' });
  assert.deepEqual((await startSession(off, user)).body, { error: 'USAGE_BILLING_DISABLED' });
  const noMutations = economy({ ...ECONOMY_ENV, POINTS_MUTATIONS_ENABLED: 'false' });
  assert.equal((await startSession(noMutations, user)).status, 503);
  // Database switch off: an existing session stops charging immediately.
  const h = economy(); const id = (await startSession(h, user)).body.session.id;
  await db.query(`update public.point_billing_settings set verified_quantity_sources = '{}' where id = 1`);
  try {
    assert.equal((await charge(h, user, id, [gift('room1|msg:off', GIFT_100, 1)])).body.results[0].status, 'billing_disabled');
    assert.deepEqual((await startSession(h, user)).body, { billingEnabled: false, reason: 'QUANTITY_SOURCE_UNVERIFIED' });
  } finally {
    await db.query(`update public.point_billing_settings set verified_quantity_sources = '{tiktok_creator_diamonds}' where id = 1`);
  }
  assert.equal(await balance(user), '1000');
});

test('billing rates are versioned and immutable; usage history cannot be edited', async () => {
  await assert.rejects(db.query('update public.point_billing_rates set points_per_unit = 2 where version = 1'), /POINT_LEDGER_IMMUTABLE/);
  await assert.rejects(db.query('delete from public.point_usage_events'), /POINT_LEDGER_IMMUTABLE/);
  for (const role of ['anon', 'authenticated']) {
    await assert.rejects(asRole(role, 'select * from public.point_usage_events'), /permission denied/);
    await assert.rejects(asRole(role, "select public.charge_point_usage(gen_random_uuid(), gen_random_uuid(), '[]'::jsonb)"), /permission denied/);
  }
});

// ---------------------------------------------------------------------------
// Part B — In-game Point products
// ---------------------------------------------------------------------------

async function buy(h, userId, productId, requestId = randomUUID()) {
  return call(h.products.purchases.POST, post('/api/v1/me/points/products/purchases', { productId, requestId }, userId));
}

test('9. a repeated in-game purchase request is charged and granted once', async () => {
  const h = economy(); const user = await newUser(); await credit(user, 5000);
  const listed = await call(h.products.products.GET, get(`/api/v1/me/points/products?gameId=${GAME}`, user));
  assert.deepEqual(listed.body.products.map((p) => [p.productId, p.price]),
    [['disco.confetti', '300'], ['disco.neon-overlay', '2000'], ['disco.vip-hour', '1000']]);
  const requestId = randomUUID();
  const results = await Promise.all([buy(h, user, 'disco.neon-overlay', requestId), buy(h, user, 'disco.neon-overlay', requestId),
    buy(h, user, 'disco.neon-overlay', requestId)]);
  assert.deepEqual(results.map((r) => r.body.status), ['granted', 'granted', 'granted']);
  assert.equal(results.filter((r) => r.body.duplicate === false).length, 1);
  assert.equal(await balance(user), '3000');
  // A one-time item already owned is not charged again, even with a new click.
  const again = await buy(h, user, 'disco.neon-overlay');
  assert.equal(again.body.status, 'already_owned');
  assert.equal(await balance(user), '3000');
  // Consumable and timed items accumulate per distinct purchase.
  await buy(h, user, 'disco.confetti'); const confetti = await buy(h, user, 'disco.confetti');
  assert.equal(confetti.body.entitlement.units, '10');
  const vip1 = await buy(h, user, 'disco.vip-hour'); const vip2 = await buy(h, user, 'disco.vip-hour');
  assert.ok(Date.parse(vip2.body.entitlement.expiresAt) - Date.parse(vip1.body.entitlement.expiresAt) >= 3599000);
  assert.equal(vip2.body.entitlement.active, true);
  assert.equal(await balance(user), String(3000 - 600 - 2000));
  const owned = await call(h.products.entitlements.GET, get(`/api/v1/me/points/entitlements?gameId=${GAME}`, user));
  assert.deepEqual(owned.body.entitlements.map((e) => e.productId), ['disco.confetti', 'disco.neon-overlay', 'disco.vip-hour']);
  // A request ID reused for a different product is a conflict, not a second purchase.
  assert.equal((await buy(h, user, 'disco.confetti', requestId)).status, 409);
});

test('10. a failed purchase grants nothing and charges nothing', async () => {
  const h = economy(); const user = await newUser(); await credit(user, 100);
  const result = await buy(h, user, 'disco.neon-overlay');
  assert.deepEqual(result.body, { status: 'insufficient_points' });
  assert.equal(await balance(user), '100');
  const counts = (await db.query(`select (select count(*)::int from public.point_entitlements where user_id = $1) as e,
    (select count(*)::int from public.point_product_purchases where user_id = $1) as p`, [user])).rows[0];
  assert.deepEqual(counts, { e: 0, p: 0 });
  assert.equal((await buy(h, user, 'disco.retired')).status, 404);
  assert.equal((await buy(h, user, 'unknown.product')).status, 404);
  const off = economy({ ...ECONOMY_ENV, POINTS_PRODUCTS_ENABLED: 'false' });
  assert.equal((await buy(off, user, 'disco.confetti')).status, 503);
  // Price changes require a new price version; past purchases keep their snapshot.
  await assert.rejects(db.query(`update public.point_products set price_points = 2500 where product_id = 'disco.neon-overlay'`),
    /POINT_PRICE_VERSION_REQUIRED/);
});

// ---------------------------------------------------------------------------
// Part C — Purchase lots, refunds and disputes (Lemon Squeezy path)
// ---------------------------------------------------------------------------

function lemonSqueezy(env = LS_ENV) {
  const deps = { getConfig: () => readLemonSqueezyConfig(env), getAdminClient: () => client };
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body); const id = randomUUID();
    return Response.json({ data: { type: 'checkouts', id, attributes: { store_id: Number(body.data.relationships.store.data.id),
      variant_id: Number(body.data.relationships.variant.data.id), test_mode: true,
      url: `https://playlive-test.lemonsqueezy.com/checkout/custom/${id}` } } }, { status: 201 });
  };
  return { orders: createPointOrdersHandler({ ...deps, fetchImpl, readsEnabled: () => true, authenticate: auth }),
    webhook: createLemonSqueezyWebhookHandler(deps), config: readLemonSqueezyConfig(env) };
}
function orderPayload(config, order, id, attributes = {}, event = 'order_created') {
  return { meta: { event_name: event, custom_data: checkoutCustomData(config, order) }, data: { type: 'orders', id,
    attributes: { store_id: Number(order.storeId), currency: 'USD', subtotal: 500, setup_fee: 0, discount_total: 0, tax: 0,
      total: 500, status: 'paid', refunded: false, test_mode: true,
      first_order_item: { variant_id: Number(order.variantId), price: 500, test_mode: true }, ...attributes } } };
}
async function deliver(ls, payload) {
  const raw = JSON.stringify(payload);
  const response = await ls.webhook(new Request(`${ORIGIN}/api/points/lemonsqueezy/webhook`, { method: 'POST',
    headers: { 'X-Signature': signWebhookBody(raw, LS_SECRET), 'X-Event-Name': payload.meta.event_name }, body: raw }));
  return { status: response.status, body: await response.json() };
}
let providerOrder = 9400000;
// Buys one Starter pack (5,000 Points) through the real order + signed webhook path.
async function buyStarter(ls, userId) {
  const created = await (await ls.orders.POST(post('/api/v1/me/points/orders', { packId: 'starter' }, userId))).json();
  const order = (await client.rpc('get_point_checkout_order_for_delivery', { p_order_id: created.order.id })).data;
  const id = String(++providerOrder);
  assert.equal((await deliver(ls, orderPayload(ls.config, order, id))).body.credited, true);
  const lot = (await db.query(`select l.transaction_id from public.point_provider_payments p join public.point_lots l
    on l.transaction_id = p.transaction_id where p.provider_order_id = $1`, [id])).rows[0];
  return { order, providerOrderId: id, lotId: lot.transaction_id };
}
const refundPayload = (ls, bought, refundedAmount, status = 'refunded') => orderPayload(ls.config, bought.order,
  bought.providerOrderId, { status, refunded: status === 'refunded', refunded_amount: refundedAmount }, 'order_refunded');
async function spendFromGifts(userId, points) {
  const h = economy(); const id = (await startSession(h, userId)).body.session.id;
  const r = await charge(h, userId, id, [gift(`spend|${randomUUID()}`, GIFT_1, points)]);
  assert.equal(r.body.results[0].status, 'charged');
}
async function lot(lotId) {
  return (await db.query('select kind, original::text, consumed::text, revoked::text from public.point_lots where transaction_id = $1', [lotId])).rows[0];
}

test('11 + 14. a refunded, fully unused purchase is reversed once, even when the webhook repeats', async () => {
  const ls = lemonSqueezy(); const user = await newUser();
  const bought = await buyStarter(ls, user);
  assert.equal(await balance(user), '5000');
  const first = await deliver(ls, refundPayload(ls, bought, 500));
  assert.deepEqual(first.body, { refundRecorded: true, duplicate: false, settlement: 'reversed_unused' });
  const repeat = await deliver(ls, refundPayload(ls, bought, 500));
  assert.deepEqual(repeat.body, { refundRecorded: true, duplicate: true, settlement: 'reversed_unused' });
  assert.equal(await balance(user), '0');
  const types = (await ledger(user)).map((row) => row.type);
  assert.deepEqual(types, ['award', 'refund'], 'history keeps the purchase and adds one reversal');
  const status = (await (await ls.orders.GET(get(`/api/v1/me/points/orders?order=${bought.order.id}`, user))).json()).order.status;
  assert.equal(status, 'refunded');
  await assertLotInvariant();
});

test('12. refund requests are evaluated per purchase: unused, partially used, fully used', async () => {
  const ls = lemonSqueezy(); const h = economy(); const user = await newUser();
  const a = await buyStarter(ls, user); const b = await buyStarter(ls, user); const c = await buyStarter(ls, user);
  await spendFromGifts(user, 6200); // FIFO: all of A (5,000), then 1,200 of B; C untouched
  const request = (transactionId) => call(h.refunds.requests.POST, post('/api/v1/me/points/refund-requests', { transactionId }, user));
  assert.equal((await request(c.lotId)).body.request.evaluation, 'eligible_unused');
  const partial = (await request(b.lotId)).body;
  assert.equal(partial.request.evaluation, 'manual_review_partially_consumed');
  assert.deepEqual([partial.lot.consumed, partial.lot.remaining, partial.lot.usage], ['1200', '3800', 'partially_consumed']);
  assert.equal((await request(a.lotId)).body.request.evaluation, 'manual_review_fully_consumed');
  assert.equal((await request(b.lotId)).body.duplicate, true, 'one open request per purchase');
  const lots = (await call(h.refunds.lots.GET, get('/api/v1/me/points/lots', user))).body.purchases;
  assert.deepEqual(lots.map((l) => [l.usage, l.refundRequest.evaluation]), [
    ['unused', 'eligible_unused'], ['partially_consumed', 'manual_review_partially_consumed'],
    ['fully_consumed', 'manual_review_fully_consumed']]);
  // A request never changes the balance or moves money.
  assert.equal(await balance(user), String(15000 - 6200));
  const other = await newUser();
  assert.equal((await call(h.refunds.requests.POST, post('/api/v1/me/points/refund-requests', { transactionId: c.lotId }, other))).status, 404);
});

test('13. a provider refund after the Points were used: auditable, no negative balance, no other purchase touched', async () => {
  const ls = lemonSqueezy(); const user = await newUser();
  const a = await buyStarter(ls, user); const b = await buyStarter(ls, user);
  await spendFromGifts(user, 5000); // uses all of A
  const before = await ledger(user);
  const refund = await deliver(ls, refundPayload(ls, a, 500));
  assert.equal(refund.body.settlement, 'fully_consumed');
  assert.equal(await balance(user), '5000', 'B is untouched and nothing goes negative');
  assert.deepEqual(await ledger(user), before, 'no ledger row was added or changed');
  assert.deepEqual(await lot(b.lotId), { kind: 'test_paid', original: '5000', consumed: '0', revoked: '0' });
  const queue = (await client.rpc('list_point_review_queue', {})).data;
  assert.ok(queue.flags.some((f) => f.lotId === a.lotId && f.reason === 'REFUND_AFTER_CONSUMPTION'));
  // Partly used purchase refunded by the provider: only ITS unused rest is removed.
  const c = await buyStarter(ls, user);
  await spendFromGifts(user, 6000); // rest of B (5,000) + 1,000 of C
  const partly = await deliver(ls, refundPayload(ls, c, 500));
  assert.equal(partly.body.settlement, 'revoked_remaining');
  assert.deepEqual(await lot(c.lotId), { kind: 'test_paid', original: '5000', consumed: '1000', revoked: '4000' });
  assert.equal(await balance(user), '0');
  assert.equal((await ledger(user)).at(-1).type, 'revocation');
  await assertLotInvariant();
});

test('partial refunds never remove Points automatically; with automation off, refunds stay operator-managed', async () => {
  const ls = lemonSqueezy(); const user = await newUser();
  const a = await buyStarter(ls, user);
  const partial = await deliver(ls, refundPayload(ls, a, 200, 'partial_refund'));
  assert.equal(partial.body.settlement, 'partial_refund_review');
  assert.equal(await balance(user), '5000');
  const manual = lemonSqueezy({ ...LS_ENV, POINTS_REFUND_AUTOMATION_ENABLED: 'false' });
  const b = await buyStarter(manual, user);
  assert.deepEqual((await deliver(manual, refundPayload(manual, b, 500))).body, { refundRecorded: true, duplicate: false });
  assert.equal(await balance(user), '10000', 'existing policy: an operator reverses it');
  // Operator reversal of a partly used purchase is refused rather than taking another
  // purchase's Points, even though the account balance alone would cover it.
  await buyStarter(manual, user);
  await spendFromGifts(user, 7000); // all of A, 2,000 of B; the third purchase untouched
  assert.equal(await balance(user), '8000');
  const operator = await newUser();
  await assert.rejects(asRole('service_role', 'select public.reverse_point_transaction($1::uuid,$2,$3,$4::uuid)',
    [b.lotId, 'Refunded purchase', `admin-reversal:${randomUUID()}`, operator]), /POINT_LOT_CONSUMED/);
  assert.equal(await balance(user), '8000');
});

test('16. purchased Points and promotional Points stay distinguishable; promotional Points are used first', async () => {
  const ls = lemonSqueezy(); const user = await newUser();
  const promo = await credit(user, 1000, 'reward:welcome');
  const bought = await buyStarter(ls, user);
  await spendFromGifts(user, 1500);
  assert.deepEqual(await lot(promo.id), { kind: 'promotional', original: '1000', consumed: '1000', revoked: '0' });
  assert.deepEqual(await lot(bought.lotId), { kind: 'test_paid', original: '5000', consumed: '500', revoked: '0' });
  const h = economy();
  const purchases = (await call(h.refunds.lots.GET, get('/api/v1/me/points/lots', user))).body.purchases;
  assert.deepEqual(purchases.map((p) => [p.kind, p.usage, p.remaining]), [['test_paid', 'partially_consumed', '4500']]);
  // Promotional credits can never be the subject of a refund request.
  assert.equal((await call(h.refunds.requests.POST, post('/api/v1/me/points/refund-requests', { transactionId: promo.id }, user))).status, 404);
  await assertLotInvariant();
});

test('18. restarting the launcher never alters persisted financial history', async () => {
  const ls = lemonSqueezy(); const user = await newUser();
  await buyStarter(ls, user);
  const first = economy(); const requestId = randomUUID();
  const id = (await startSession(first, user, { requestId })).body.session.id;
  await charge(first, user, id, [gift('room1|msg:18', GIFT_100, 1), gift('room1|grp:18', GIFT_1, 4)]);
  await buy(first, user, 'disco.confetti', requestId);
  const snapshot = { ledger: await ledger(user),
    usage: (await db.query('select * from public.point_usage_events where user_id = $1 order by created_at', [user])).rows,
    lots: (await db.query('select * from public.point_lots where user_id = $1 order by sequence', [user])).rows };
  // A "restarted" launcher has fresh handlers and replays everything it had queued.
  const restarted = economy();
  assert.equal((await startSession(restarted, user, { requestId })).body.session.id, id);
  await charge(restarted, user, id, [gift('room1|msg:18', GIFT_100, 1), gift('room1|grp:18', GIFT_1, 4)]);
  await buy(restarted, user, 'disco.confetti', requestId);
  assert.deepEqual(await ledger(user), snapshot.ledger);
  assert.deepEqual((await db.query('select * from public.point_usage_events where user_id = $1 order by created_at', [user])).rows, snapshot.usage);
  assert.deepEqual((await db.query('select * from public.point_lots where user_id = $1 order by sequence', [user])).rows, snapshot.lots);
  await assert.rejects(db.query('delete from public.point_lot_allocations'), /POINT_LEDGER_IMMUTABLE/);
  await assert.rejects(db.query('delete from public.point_refund_settlements'), /POINT_LEDGER_IMMUTABLE/);
  await assertLotInvariant();
});

// ---------------------------------------------------------------------------
// Stripe adapter (sandbox only)
// ---------------------------------------------------------------------------

function stripe(env = STRIPE_ENV) {
  const config = readStripeConfig(env);
  const deps = { getConfig: () => readStripeConfig(env), getAdminClient: () => client };
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url, init });
    const id = `cs_test_${randomUUID().replaceAll('-', '')}`;
    return Response.json({ object: 'checkout.session', id, livemode: false, url: `https://checkout.stripe.com/c/pay/${id}` });
  };
  return { config, requests, now: Math.floor(Date.now() / 1000),
    orders: createPointOrdersHandler({ ...deps, fetchImpl, readsEnabled: () => true, authenticate: auth,
      providerCheckout: createStripeCheckout }),
    webhook: createStripeWebhookHandler(deps) };
}
async function stripeEvent(s, type, object, { livemode = false, secret = STRIPE_SECRET, timestamp = Math.floor(Date.now() / 1000) } = {}) {
  const raw = JSON.stringify({ id: `evt_${randomUUID().replaceAll('-', '')}`, object: 'event', type, livemode, data: { object } });
  const response = await s.webhook(new Request(`${ORIGIN}/api/points/stripe/webhook`, { method: 'POST',
    headers: { 'Stripe-Signature': signStripeBody(raw, secret, timestamp) }, body: raw }));
  return { status: response.status, body: await response.json() };
}
async function stripeCheckout(s, userId) {
  const created = await (await s.orders.POST(post('/api/v1/me/points/orders', { packId: 'starter' }, userId))).json();
  const order = (await client.rpc('get_point_checkout_order_for_delivery', { p_order_id: created.order.id })).data;
  const sessionId = new URL(created.checkoutUrl).pathname.split('/').at(-1);
  const form = new URLSearchParams(s.requests.at(-1).init.body);
  const metadata = Object.fromEntries([...form].filter(([k]) => k.startsWith('metadata[')).map(([k, v]) => [k.slice(9, -1), v]));
  const paymentIntent = `pi_${randomUUID().replaceAll('-', '')}`;
  const session = (extra = {}) => ({ object: 'checkout.session', id: sessionId, mode: 'payment', status: 'complete',
    payment_status: 'paid', client_reference_id: order.id, metadata, currency: 'usd', amount_subtotal: 500,
    amount_total: 500, total_details: { amount_discount: 0 }, payment_intent: paymentIntent, ...extra });
  return { created, order, form, session, paymentIntent };
}

test('Stripe sandbox: live keys are refused; checkout sends only server data; signatures are verified', async () => {
  assert.equal(readStripeConfig({ ...STRIPE_ENV, STRIPE_SECRET_KEY: 'sk_live_realkey0123456789' }).state, 'invalid');
  assert.equal(readStripeConfig({ ...STRIPE_ENV, POINTS_DEPLOYMENT_ENVIRONMENT: 'production', POINTS_PRODUCTION_ACCEPTED: 'true' }).state, 'invalid');
  assert.equal(readStripeConfig({ ...STRIPE_ENV, STRIPE_PRODUCTS_VERIFIED: 'false' }).state, 'not_configured');
  const s = stripe(); const user = await newUser();
  const { created, form } = await stripeCheckout(s, user);
  assert.equal(created.order.provider, 'stripe');
  assert.equal(form.get('line_items[0][price]'), 'price_TestStarter001');
  assert.equal(form.get('line_items[0][quantity]'), '1');
  assert.equal(form.get('mode'), 'payment');
  assert.equal(s.requests.at(-1).init.headers['Idempotency-Key'], `playlive-order-${created.order.id}`);
  const raw = Buffer.from('{"a":1}'); const now = 1_800_000_000;
  const header = signStripeBody(raw, STRIPE_SECRET, now);
  assert.equal(verifyStripeSignature(raw, header, STRIPE_SECRET, now), true);
  assert.equal(verifyStripeSignature(raw, header, 'whsec_otherSecret012345', now), false);
  assert.equal(verifyStripeSignature(raw, header, STRIPE_SECRET, now + 301), false, 'replayed old event');
  assert.equal(verifyStripeSignature(Buffer.from('{"a":2}'), header, STRIPE_SECRET, now), false);
  assert.equal((await stripeEvent(s, 'checkout.session.completed', {}, { secret: 'whsec_wrongSecret0123456' })).status, 401);
});

test('Stripe sandbox: paid sessions credit once; unpaid, live, tampered and discounted ones credit nothing', async () => {
  const s = stripe(); const user = await newUser();
  const a = await stripeCheckout(s, user);
  assert.deepEqual((await stripeEvent(s, 'checkout.session.completed', a.session({ payment_status: 'unpaid' }))).body,
    { credited: false, pending: true });
  assert.equal((await stripeEvent(s, 'checkout.session.completed', a.session(), { livemode: true })).body.ignored, 'LIVE_MODE_DISABLED');
  assert.equal(await balance(user), '0');
  const paid = await stripeEvent(s, 'checkout.session.async_payment_succeeded', a.session());
  assert.deepEqual([paid.body.credited, paid.body.duplicate], [true, false]);
  assert.equal((await stripeEvent(s, 'checkout.session.completed', a.session())).body.duplicate, true);
  assert.equal(await balance(user), '5000');
  const b = await stripeCheckout(s, user);
  const tampered = { ...b.session().metadata, playlive_account: 'x'.repeat(32) };
  assert.equal((await stripeEvent(s, 'checkout.session.completed', b.session({ metadata: tampered }))).body.reason, 'TAMPERED_REFERENCE');
  assert.equal((await stripeEvent(s, 'checkout.session.completed', b.session({ total_details: { amount_discount: 100 }, amount_total: 400 }))).body.reason,
    'DISCOUNT_NOT_ALLOWED');
  assert.equal((await stripeEvent(s, 'checkout.session.completed', b.session({ currency: 'eur' }))).body.reason, 'CURRENCY_MISMATCH');
  const c = await stripeCheckout(s, user);
  assert.equal((await stripeEvent(s, 'checkout.session.async_payment_failed', c.session({ payment_status: 'unpaid' }))).body.reason, 'NOT_PAID');
  assert.equal(await balance(user), '5000');
  const status = (await (await s.orders.GET(get(`/api/v1/me/points/orders?order=${a.order.id}`, user))).json()).order;
  assert.deepEqual([status.provider, status.status], ['stripe', 'credited']);
});

test('Stripe sandbox: refunds, partial refunds and disputes settle per purchase', async () => {
  const s = stripe(); const user = await newUser();
  const a = await stripeCheckout(s, user); await stripeEvent(s, 'checkout.session.completed', a.session());
  const b = await stripeCheckout(s, user); await stripeEvent(s, 'checkout.session.completed', b.session());
  const charge = (x, extra) => ({ object: 'charge', payment_intent: x.paymentIntent, amount: 500, currency: 'usd', ...extra });
  const dispute = (x, extra) => ({ object: 'dispute', payment_intent: x.paymentIntent, amount: 500, currency: 'usd', ...extra });
  // Partial refund: recorded for review, Points unchanged.
  assert.equal((await stripeEvent(s, 'charge.refunded', charge(a, { amount_refunded: 200, refunded: false }))).body.settlement,
    'partial_refund_review');
  assert.equal(await balance(user), '10000');
  // Dispute opened: review only. Lost: that purchase's unused Points are removed, once.
  assert.equal((await stripeEvent(s, 'charge.dispute.created', dispute(b, { status: 'needs_response' }))).body.settlement, 'dispute_review');
  await spendFromGifts(user, 6000); // all of A, 1,000 of B
  const lost = await stripeEvent(s, 'charge.dispute.closed', dispute(b, { status: 'lost' }));
  assert.equal(lost.body.settlement, 'revoked_remaining');
  assert.equal((await stripeEvent(s, 'charge.dispute.closed', dispute(b, { status: 'lost' }))).body.duplicate, true);
  assert.equal(await balance(user), '0');
  // Full refund of the used-up purchase A: no change, flagged.
  assert.equal((await stripeEvent(s, 'charge.refunded', charge(a, { amount_refunded: 500, refunded: true }))).body.settlement, 'fully_consumed');
  const reasons = (await client.rpc('list_point_review_queue', {})).data.flags.filter((f) => f.userId === user).map((f) => f.reason).sort();
  assert.deepEqual(reasons, ['DISPUTE_LOST_AFTER_CONSUMPTION', 'DISPUTE_OPENED', 'PARTIAL_REFUND_REVIEW', 'REFUND_AFTER_CONSUMPTION']);
  // An unknown PaymentIntent is not ours.
  assert.equal((await stripeEvent(s, 'charge.refunded', charge({ paymentIntent: 'pi_unknown000' }, { amount_refunded: 500, refunded: true }))).body.ignored,
    'NOT_A_POINTS_ORDER');
  await assertLotInvariant();
});

test('Stripe sandbox: with refund automation off, a lost dispute only flags the purchase', async () => {
  const s = stripe({ ...STRIPE_ENV, POINTS_REFUND_AUTOMATION_ENABLED: 'false' }); const user = await newUser();
  const a = await stripeCheckout(s, user); await stripeEvent(s, 'checkout.session.completed', a.session());
  const lost = await stripeEvent(s, 'charge.dispute.closed', { object: 'dispute', payment_intent: a.paymentIntent,
    amount: 500, currency: 'usd', status: 'lost' });
  assert.equal(lost.body.settlement, 'review_only');
  assert.equal(await balance(user), '5000');
});

test('the database itself refuses live Stripe credits and new ledger types stay service-only', async () => {
  const user = await newUser();
  const { error } = await client.rpc('credit_point_checkout_order', { p_provider: 'stripe', p_environment: 'live',
    p_provider_order_id: 'cs_live_abc', p_order_id: randomUUID(), p_user_id: user, p_store_id: 'stripe',
    p_variant_id: 'price_x', p_currency: 'USD', p_subtotal_minor: '500', p_total_minor: '500' });
  assert.match(error.message, /STRIPE_LIVE_DISABLED/);
  for (const role of ['anon', 'authenticated']) {
    await assert.rejects(asRole(role, 'select * from public.point_lots'), /permission denied/);
    await assert.rejects(asRole(role, `select public.settle_point_provider_refund('stripe','test','cs_test_x','refund','refunded',500,'USD',true)`),
      /permission denied/);
    await assert.rejects(asRole(role, `select public.purchase_point_product(gen_random_uuid(), gen_random_uuid(), 'disco.confetti')`),
      /permission denied/);
  }
  await assertLotInvariant();
});
