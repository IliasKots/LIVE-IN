import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { readItchConfig, createItchCheckout, verifyItchClaim, redeemItchClaim } from '../lib/points-itch-core.mjs';
import { createHmac } from 'node:crypto';
import { createPurchaseIntent, getPurchaseIntent } from '../lib/points-purchases-core.mjs';
import { rememberVerifiedItchClaim, recoverPointDelivery } from '../lib/points-delivery-core.mjs';

// Executes the actual PostgreSQL migration in an isolated in-memory engine.
// This is NOT a mocked SQL parser. No staging/production connection is used.
let db;
let actor;
before(async () => {
  db = new PGlite();
  await db.exec(`
    create role anon nologin;
    create role authenticated nologin;
    create role service_role nologin bypassrls;
    create schema auth;
    create table auth.users (id uuid primary key);
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    create function auth.role() returns text language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.role', true), '') $$;
    grant usage on schema auth, public to anon, authenticated, service_role;
    grant execute on function auth.uid(), auth.role() to anon, authenticated, service_role;
  `);
  await db.exec(await readFile(new URL('../supabase/migrations/202609190001_points_ledger.sql', import.meta.url), 'utf8'));
  await db.exec(await readFile(new URL('../supabase/migrations/202610100002_points_purchase_intents.sql', import.meta.url), 'utf8'));
  await db.exec(await readFile(new URL('../supabase/migrations/202610110003_points_verified_delivery.sql', import.meta.url), 'utf8'));
  actor = await newUser();
});
after(async () => { await db?.close(); });

test('verified itch.io claims use the real ledger: concurrent retries credit once and cross-account claims fail', async () => {
  const id = await newUser();
  const secret = 'only-local-simulated-purchase-secret';
  const config = readItchConfig({ NODE_ENV: 'test', POINTS_ENABLED: 'true', POINTS_MUTATIONS_ENABLED: 'true',
    POINTS_DEPLOYMENT_ENVIRONMENT: 'local', ITCH_POINTS_PRODUCTS_VERIFIED: 'true',
    POINTS_ITCH_CHECKOUT_ENABLED: 'true', POINTS_ITCH_CLAIMS_ENABLED: 'true', POINTS_SITE_ORIGIN: 'http://localhost:3000',
    ITCH_POINTS_PROJECT_URL: 'https://seller.itch.io/points', ITCH_POINTS_REDEEM_SECRET: secret,
    ITCH_POINTS_PACKS_JSON: JSON.stringify([{ id: 'starter', name: 'Starter', points: '1000', subProductId: '101', priceLabel: '$5', enabled: true }]) });
  const metadata = JSON.parse(Buffer.from(new URL(createItchCheckout(config, id, 'starter')).searchParams.get('metadata').split('.')[1], 'base64url').toString());
  // Opening checkout and abandoning it creates neither a credit nor a wallet row.
  assert.equal((await summary(id)).balance, '0');
  assert.equal((await history(id)).items.length, 0);
  const header = Buffer.from('{"alg":"HS256"}').toString('base64url');
  const time = Math.floor(Date.now() / 1000);
  const body = Buffer.from(JSON.stringify({ purchase_id: 8001, sub_product_id: 101, iat: time, exp: time + 600, metadata })).toString('base64url');
  const claim = verifyItchClaim(config, `${header}.${body}.${createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url')}`);
  const client = { async rpc(name, args) {
    if (name === 'apply_point_transaction') return { data: (await asRole('service_role', null,
      'select public.apply_point_transaction($1::uuid,$2::bigint,$3,$4,$5,$6,$7,$8::jsonb,$9::uuid,$10::uuid) as result',
      [args.p_user_id, args.p_amount, args.p_type, args.p_reason, args.p_source_type, args.p_source_id,
        args.p_idempotency_key, JSON.stringify(args.p_metadata), args.p_actor_id, args.p_reversal_of])).rows[0].result };
    if (name === 'get_point_account') return { data: await summary(args.p_user_id) };
    throw new Error('Unexpected RPC');
  } };
  const results = await Promise.all(Array.from({ length: 8 }, () => redeemItchClaim(client, config, claim, id)));
  assert.equal(results.filter((value) => !value.duplicate).length, 1);
  assert.equal((await summary(id)).balance, '1000');
  assert.equal((await history(id)).items.length, 1);
  await assert.rejects(redeemItchClaim(client, config, claim, await newUser()), /WRONG_ACCOUNT/);
  // Another paid order of the same pack is a separate credit.
  await redeemItchClaim(client, config, { ...claim, purchaseId: '8002' }, id);
  assert.equal((await summary(id)).balance, '2000');
});

function trackedConfig() {
  return readItchConfig({ NODE_ENV: 'test', POINTS_DEPLOYMENT_ENVIRONMENT: 'local', POINTS_ENABLED: 'true',
    POINTS_MUTATIONS_ENABLED: 'true', ITCH_POINTS_PRODUCTS_VERIFIED: 'true', POINTS_ITCH_CHECKOUT_ENABLED: 'true',
    POINTS_ITCH_CLAIMS_ENABLED: 'true', POINTS_SITE_ORIGIN: 'http://localhost:3000',
    ITCH_POINTS_PROJECT_URL: 'https://seller.itch.io/tracked', ITCH_POINTS_REDEEM_SECRET: 'isolated-purchase-test-secret',
    ITCH_POINTS_PACKS_JSON: JSON.stringify([{ id: 'configured', name: 'Configured', points: '1000',
      subProductId: '700', priceLabel: '$5', currency: 'USD', priceMinor: '500', enabled: true }]) });
}
function trackedClient() {
  return { async rpc(name, args) {
    try {
      let result;
      if (name === 'create_point_purchase_intent') result = await asRole('service_role', null,
        'select public.create_point_purchase_intent($1::uuid,$2,$3,$4::bigint,$5,$6,$7,$8,$9::bigint) as result',
        [args.p_user_id, args.p_pack_id, args.p_pack_name, args.p_points, args.p_project_url, args.p_sub_product_id,
          args.p_price_label, args.p_currency, args.p_price_minor]);
      else if (name === 'get_point_purchase') result = await asRole('service_role', null,
        'select public.get_point_purchase($1::uuid,$2::uuid) as result', [args.p_user_id, args.p_intent_id]);
      else if (name === 'credit_point_purchase') result = await asRole('service_role', null,
        'select public.credit_point_purchase($1::uuid,$2::uuid,$3,$4,$5,$6,$7::bigint) as result',
        [args.p_user_id, args.p_intent_id, args.p_purchase_id, args.p_project_url, args.p_sub_product_id, args.p_pack_id, args.p_points]);
      else if (name === 'remember_verified_point_purchase') result = await asRole('service_role', null,
        'select public.remember_verified_point_purchase($1,$2::jsonb) as result', [args.p_project_url, JSON.stringify(args.p_claim)]);
      else if (name === 'get_verified_point_purchase') result = await asRole('service_role', null,
        'select public.get_verified_point_purchase($1::uuid,$2::uuid) as result', [args.p_user_id, args.p_intent_id]);
      else if (name === 'get_point_account') return { data: await summary(args.p_user_id) };
      else throw new Error('Unexpected tracked RPC');
      return { data: result.rows[0].result };
    } catch (error) { return { data: null, error: { message: error.message } }; }
  } };
}
function trackedProof(config, intent, purchaseId, extras = {}, metadataExtras = {}) {
  const metadata = JSON.parse(Buffer.from(new URL(createItchCheckout(config, intent.userId, intent.packId, intent))
    .searchParams.get('metadata').split('.')[1], 'base64url').toString());
  const time = Math.floor(Date.now() / 1000);
  const header = Buffer.from('{"alg":"HS256"}').toString('base64url');
  const body = Buffer.from(JSON.stringify({ purchase_id: purchaseId, sub_product_id: intent.subProductId,
    iat: time, exp: time + 600, metadata: { ...metadata, ...metadataExtras }, ...extras })).toString('base64url');
  return `${header}.${body}.${createHmac('sha256', config.secret).update(`${header}.${body}`).digest('base64url')}`;
}

test('unpaid/cancelled intents remain pending after restart; saved verified claims recover without cookie or token', async () => {
  const userId = await newUser(), config = trackedConfig();
  const intent = await createPurchaseIntent(trackedClient(), config, userId, 'configured');
  assert.equal((await recoverPointDelivery(trackedClient(), config, userId, intent.id)).purchase.status, 'pending');
  assert.equal((await summary(userId)).balance, '0');
  const claim = verifyItchClaim(config, trackedProof(config, intent, '92001'));
  await rememberVerifiedItchClaim(trackedClient(), config, claim);
  assert.equal((await summary(userId)).balance, '0', 'Saving provider evidence never changes balances');
  assert.equal((await history(userId)).items.length, 0);
  // Simulates new server/launcher sessions after verified ingress. No cookie/JWT
  // survives; the server-owned inbox and immutable intent are the authority.
  const attempts = await Promise.all(Array.from({ length: 8 }, () => recoverPointDelivery(trackedClient(), config, userId, intent.id)));
  assert.ok(attempts.every((result) => result.purchase.status === 'credited'));
  assert.equal((await summary(userId)).balance, '1000');
  assert.equal((await history(userId)).items.length, 1);
  await assert.rejects(recoverPointDelivery(trackedClient(), config, await newUser(), intent.id), /UNKNOWN_PURCHASE_INTENT/);
  await assert.rejects(recoverPointDelivery(trackedClient(), { ...config, blockedPurchaseIds: ['92001'] }, userId, intent.id), /PURCHASE_REFUNDED/);
});

test('verified inbox rejects mismatched intents, cross-account purchase reuse and customer reads/writes', async () => {
  const userId = await newUser(), config = trackedConfig();
  const intent = await createPurchaseIntent(trackedClient(), config, userId, 'configured');
  const claim = verifyItchClaim(config, trackedProof(config, intent, '92002'));
  for (const override of [{ points: '9999' }, { subProductId: '701' }, { currency: 'EUR' }, { priceMinor: '1' }]) {
    await assert.rejects(rememberVerifiedItchClaim(trackedClient(), config, { ...claim, ...override }), /PACK_MISMATCH/);
  }
  await rememberVerifiedItchClaim(trackedClient(), config, claim);
  await rememberVerifiedItchClaim(trackedClient(), config, claim);
  const other = await newUser(), otherIntent = await createPurchaseIntent(trackedClient(), config, other, 'configured');
  await assert.rejects(rememberVerifiedItchClaim(trackedClient(), config,
    { ...claim, intentId: otherIntent.id, userId: other }), /WRONG_ACCOUNT/);
  for (const role of ['anon', 'authenticated', 'service_role']) {
    await assert.rejects(asRole(role, userId, 'select claim from public.point_verified_purchases'), /permission denied/);
    await assert.rejects(asRole(role, userId, 'delete from public.point_verified_purchases'), /permission denied/);
  }
  for (const role of ['anon', 'authenticated']) await assert.rejects(asRole(role, userId,
    'select public.remember_verified_point_purchase($1,$2::jsonb)', [config.projectUrl, JSON.stringify(claim)]), /permission denied/);
  await assert.rejects(db.query('update public.point_verified_purchases set claim=$1::jsonb where provider_purchase_id=$2',
    [JSON.stringify({ points: '9999' }), claim.purchaseId]), /POINT_LEDGER_IMMUTABLE/);
  const stored = (await db.query('select claim from public.point_verified_purchases where provider_purchase_id=$1', [claim.purchaseId])).rows[0].claim;
  assert.doesNotMatch(JSON.stringify(stored), /secret|jwt|email|signature/i);
  assert.equal((await summary(userId)).balance, '0');
});

test('two simulated purchases of the same approved pack deliver fresh totals once; overpayment adds no extra points', async () => {
  const userId = await newUser();
  const base = trackedConfig();
  const config = readItchConfig({ NODE_ENV: 'test', POINTS_DEPLOYMENT_ENVIRONMENT: 'local', POINTS_ENABLED: 'true',
    POINTS_MUTATIONS_ENABLED: 'true', ITCH_POINTS_PRODUCTS_VERIFIED: 'true', POINTS_ITCH_CHECKOUT_ENABLED: 'true',
    POINTS_ITCH_CLAIMS_ENABLED: 'true', POINTS_SITE_ORIGIN: base.origin, ITCH_POINTS_PROJECT_URL: base.projectUrl,
    ITCH_POINTS_REDEEM_SECRET: base.secret, ITCH_POINTS_PRODUCT_IDS_JSON: '{"starter":"101"}' });
  for (const purchaseId of ['92003', '92004']) {
    const intent = await createPurchaseIntent(trackedClient(), config, userId, 'starter');
    const claim = verifyItchClaim(config, trackedProof(config, intent, purchaseId, { currency: 'USD', price: '$100.00' }));
    await rememberVerifiedItchClaim(trackedClient(), config, claim);
    await recoverPointDelivery(trackedClient(), config, userId, intent.id);
    await recoverPointDelivery(trackedClient(), config, userId, intent.id);
  }
  assert.equal((await summary(userId)).balance, '10000');
  assert.deepEqual((await history(userId)).items.map((item) => item.amount), ['5000', '5000']);
});

test('restart prioritizes older verified delivery over a newer abandoned checkout', async () => {
  const userId = await newUser(), config = trackedConfig();
  const paid = await createPurchaseIntent(trackedClient(), config, userId, 'configured');
  const claim = verifyItchClaim(config, trackedProof(config, paid, '92005'));
  await rememberVerifiedItchClaim(trackedClient(), config, claim);
  const abandoned = await createPurchaseIntent(trackedClient(), config, userId, 'configured');
  const restored = await getPurchaseIntent(trackedClient(), userId);
  assert.equal(restored.id, paid.id, 'Newer unpaid intent cannot hide saved payment evidence');
  await recoverPointDelivery(trackedClient(), config, userId, restored.id);
  assert.equal((await summary(userId)).balance, '1000');
  assert.equal((await getPurchaseIntent(trackedClient(), userId, abandoned.id)).status, 'pending');
  assert.equal((await getPurchaseIntent(trackedClient(), userId)).id, abandoned.id);
});

test('fresh verified payments using the same checkout intent drain separately without reporting an incomplete order as credited', async () => {
  const userId = await newUser(), config = trackedConfig();
  const intent = await createPurchaseIntent(trackedClient(), config, userId, 'configured');
  for (const purchaseId of ['92006', '92007']) await rememberVerifiedItchClaim(trackedClient(), config,
    verifyItchClaim(config, trackedProof(config, intent, purchaseId)));
  assert.equal((await recoverPointDelivery(trackedClient(), config, userId, intent.id)).purchase.status, 'pending');
  assert.equal((await summary(userId)).balance, '1000');
  assert.equal((await recoverPointDelivery(trackedClient(), config, userId, intent.id)).purchase.status, 'credited');
  await recoverPointDelivery(trackedClient(), config, userId, intent.id);
  assert.equal((await summary(userId)).balance, '2000');
  assert.equal((await history(userId)).items.length, 2);
});

test('durable purchase status survives new clients; queued receipt retries credit once atomically (single PGlite backend)', async () => {
  const userId = await newUser(), config = trackedConfig();
  const intent = await createPurchaseIntent(trackedClient(), config, userId, 'configured');
  assert.equal(intent.status, 'pending'); assert.equal((await summary(userId)).balance, '0');
  assert.equal((await getPurchaseIntent(trackedClient(), userId)).id, intent.id, 'New client can recover pending intent');
  const claim = verifyItchClaim(config, trackedProof(config, intent, '91001'));
  const results = await Promise.all(Array.from({ length: 8 }, () => redeemItchClaim(trackedClient(), config, claim, userId)));
  assert.equal(results.filter((result) => !result.duplicate).length, 1);
  const recovered = await getPurchaseIntent(trackedClient(), userId, intent.id);
  assert.equal(recovered.status, 'credited'); assert.equal(recovered.transactionId, results[0].transactionId);
  assert.equal((await summary(userId)).balance, '1000'); assert.equal((await history(userId)).items.length, 1);
  assert.equal((await db.query('select count(*)::text as count from public.point_purchase_receipts where intent_id=$1', [intent.id])).rows[0].count, '1');
  const other = await newUser();
  assert.equal(await getPurchaseIntent(trackedClient(), other, intent.id), null);
  await assert.rejects(redeemItchClaim(trackedClient(), config, claim, other), /WRONG_ACCOUNT/);
  await assert.rejects(asRole('service_role', null, 'select public.credit_point_purchase($1::uuid,$2::uuid,$3,$4,$5,$6,$7::bigint)',
    [other, intent.id, claim.purchaseId, config.projectUrl, intent.subProductId, intent.packId, intent.points]), /WRONG_ACCOUNT/);
  assert.equal((await summary(other)).balance, '0');
});

test('receipt insertion failure rolls back the wallet and ledger; records are immutable and owner-only', async () => {
  const userId = await newUser(), config = trackedConfig(), client = trackedClient();
  const intent = await createPurchaseIntent(client, config, userId, 'configured');
  const claim = verifyItchClaim(config, trackedProof(config, intent, '91002'));
  await rememberVerifiedItchClaim(client, config, claim);
  await db.exec(`create function public.test_receipt_failure() returns trigger language plpgsql as $$
    begin raise exception 'TEST_RECEIPT_FAILURE'; end; $$;
    create trigger test_receipt_failure before insert on public.point_purchase_receipts
    for each row execute function public.test_receipt_failure();`);
  try {
    await assert.rejects(recoverPointDelivery(client, config, userId, intent.id), /POINTS_UNAVAILABLE/);
    assert.equal((await summary(userId)).balance, '0'); assert.equal((await history(userId)).items.length, 0);
    assert.equal((await getPurchaseIntent(client, userId, intent.id)).status, 'pending');
  } finally { await db.exec('drop trigger test_receipt_failure on public.point_purchase_receipts; drop function public.test_receipt_failure();'); }
  await recoverPointDelivery(trackedClient(), config, userId, intent.id);
  await assert.rejects(db.query('update public.point_purchase_intents set points=2000 where id=$1', [intent.id]), /POINT_LEDGER_IMMUTABLE/);
  await assert.rejects(db.query('delete from public.point_purchase_receipts where intent_id=$1', [intent.id]), /POINT_LEDGER_IMMUTABLE/);
  const other = await newUser();
  assert.equal((await asRole('authenticated', other, 'select * from public.point_purchase_intents where id=$1', [intent.id])).rows.length, 0);
  assert.equal((await asRole('authenticated', other, 'select * from public.point_purchase_receipts where intent_id=$1', [intent.id])).rows.length, 0);
  await assert.rejects(asRole('authenticated', userId, 'select public.credit_point_purchase($1::uuid,$2::uuid,$3,$4,$5,$6,$7::bigint)',
    [userId, intent.id, claim.purchaseId, config.projectUrl, intent.subProductId, intent.packId, intent.points]), /permission denied/);
});

test('tracked claim validates available provider pricing and immutable pack snapshot; refund status remains authoritative', async () => {
  const userId = await newUser(), config = trackedConfig(), client = trackedClient();
  const intent = await createPurchaseIntent(client, config, userId, 'configured');
  await assert.rejects(redeemItchClaim(client, config,
    verifyItchClaim(config, trackedProof(config, intent, '91003', { currency: 'EUR', price: '€5.00' })), userId), /PAYMENT_CURRENCY_MISMATCH/);
  await assert.rejects(redeemItchClaim(client, config,
    verifyItchClaim(config, trackedProof(config, intent, '91003', { currency: 'USD', price: '$4.99' })), userId), /PAYMENT_AMOUNT_MISMATCH/);
  await assert.rejects(redeemItchClaim(client, config,
    verifyItchClaim(config, trackedProof(config, intent, '91003', {}, { points: '9999' })), userId), /PACK_MISMATCH/);
  assert.throws(() => verifyItchClaim(config, trackedProof(config, intent, '91003', { currency: 'USD', price: 500 })), /INVALID_PAYMENT_DETAILS/);
  assert.equal((await summary(userId)).balance, '0');
  const claim = verifyItchClaim(config, trackedProof(config, intent, '91003', { currency: 'USD', price: '$6.00' }));
  const credited = await redeemItchClaim(client, config, claim, userId);
  await reverse(credited.transactionId, 'tracked-refund-91003');
  assert.equal((await getPurchaseIntent(client, userId, intent.id)).status, 'refunded');
  assert.equal((await summary(userId)).balance, '0');
  await assert.rejects(redeemItchClaim(client, config, claim, userId), /PURCHASE_REFUNDED/);
  await assert.rejects(redeemItchClaim(client, { ...config, blockedPurchaseIds: ['91003'] }, claim, userId), /PURCHASE_REFUNDED/);
});

async function newUser() {
  const id = randomUUID();
  await db.query('insert into auth.users(id) values ($1)', [id]);
  return id;
}

async function asRole(role, id, sql, args = []) {
  assert.ok(['service_role', 'authenticated', 'anon'].includes(role));
  return db.transaction(async (tx) => {
    await tx.exec(`set local role ${role}`);
    await tx.query("select set_config('request.jwt.claim.sub', $1, true), set_config('request.jwt.claim.role', $2, true)", [id || '', role]);
    return tx.query(sql, args);
  });
}

async function apply(id, amount, options = {}) {
  const key = options.key || randomUUID();
  const result = await asRole('service_role', null,
    'select public.apply_point_transaction($1::uuid,$2::bigint,$3,$4,$5,$6,$7,$8::jsonb,$9::uuid,$10::uuid) as result',
    [id, amount, options.type || (BigInt(amount) > 0n ? 'award' : 'spend'), options.reason || 'Test reward',
      options.sourceType || 'test', options.sourceId || key, key, JSON.stringify(options.metadata || {}), options.actorId || null, options.reversalOf || null]);
  return result.rows[0].result;
}

async function summary(id, role = 'service_role', viewer = null) {
  return (await asRole(role, viewer, 'select public.get_point_account($1::uuid) as result', [id])).rows[0].result;
}

async function history(id, limit = 20, cursor = null, role = 'service_role', viewer = null) {
  return (await asRole(role, viewer, 'select public.list_point_transactions($1::uuid,$2::integer,$3::bigint) as result', [id, limit, cursor])).rows[0].result;
}

async function reverse(originalId, key) {
  return (await asRole('service_role', null, 'select public.reverse_point_transaction($1::uuid,$2,$3,$4::uuid) as result',
    [originalId, 'Refund', key, actor])).rows[0].result;
}

test('missing wallet reads as zero without creating a row', async () => {
  const id = await newUser();
  assert.deepEqual(await summary(id), { balance: '0', lifetimeEarned: '0', lifetimeSpent: '0', version: '0', updatedAt: null });
  assert.deepEqual(await history(id), { items: [], nextCursor: null });
  assert.equal((await db.query('select count(*)::int as count from public.point_accounts where user_id=$1', [id])).rows[0].count, 0);
});

test('award, debit, retry, conflict and insufficient balance are atomic', async () => {
  const id = await newUser();
  const first = await apply(id, '10000', { key: 'atomic-award' });
  assert.equal(first.balanceAfter, '10000');
  const again = await apply(id, '10000', { key: 'atomic-award' });
  assert.equal(again.id, first.id);
  assert.equal(again.duplicate, true);
  await assert.rejects(apply(id, '10001', { key: 'atomic-award' }), /POINT_IDEMPOTENCY_CONFLICT/);
  await assert.rejects(apply(id, '10000', { key: 'atomic-award', reason: 'Changed' }), /POINT_IDEMPOTENCY_CONFLICT/);
  await apply(id, '-100');
  await assert.rejects(apply(id, '-10000'), /INSUFFICIENT_POINTS/);
  assert.equal((await summary(id)).balance, '9900');
  assert.equal((await summary(id)).version, '2');
  assert.equal((await history(id)).items.length, 2);
});

test('source uniqueness prevents a second award using a new retry key', async () => {
  const id = await newUser();
  await apply(id, '100', { sourceId: 'verified-provider-event' });
  await assert.rejects(apply(id, '100', { sourceId: 'verified-provider-event' }), /unique constraint/);
  assert.equal((await summary(id)).balance, '100');
  const other = await newUser();
  await assert.rejects(apply(other, '100', { sourceId: 'verified-provider-event' }), /unique constraint/);
  assert.equal((await summary(other)).balance, '0');
});

test('global idempotency keys cannot cross users', async () => {
  const one = await newUser();
  const two = await newUser();
  await apply(one, '100', { key: 'global-idempotency' });
  await assert.rejects(apply(two, '100', { key: 'global-idempotency' }), /POINT_IDEMPOTENCY_CONFLICT/);
  assert.equal((await summary(two)).balance, '0');
});

test('BIGINT boundary is exact and overflow leaves ledger unchanged', async () => {
  const id = await newUser();
  await apply(id, '9223372036854775807');
  assert.equal((await summary(id)).balance, '9223372036854775807');
  assert.equal((await history(id)).items[0].amount, '9223372036854775807');
  await assert.rejects(apply(id, '1'), /POINT_LIMIT_EXCEEDED/);
  await apply(id, '-1');
  // Lifetime credited is also bounded even when the current balance has space.
  await assert.rejects(apply(id, '1'), /POINT_LIMIT_EXCEEDED/);
  assert.equal((await summary(id)).balance, '9223372036854775806');
});

test('RLS prevents cross-account reads; customers cannot mutate or invoke trusted functions', async () => {
  const owner = await newUser();
  const other = await newUser();
  await apply(owner, '100');
  assert.equal((await summary(owner, 'authenticated', owner)).balance, '100');
  assert.equal((await history(owner, 20, null, 'authenticated', owner)).items.length, 1);
  await assert.rejects(summary(owner, 'authenticated', other), /POINT_ACCESS_DENIED/);
  await assert.rejects(history(owner, 20, null, 'authenticated', other), /POINT_ACCESS_DENIED/);
  assert.equal((await asRole('authenticated', other, 'select balance from public.point_accounts')).rows.length, 0);
  await assert.rejects(asRole('authenticated', owner, 'select metadata from public.point_transactions'), /permission denied/);
  for (const role of ['anon', 'authenticated', 'service_role']) {
    await assert.rejects(asRole(role, owner, "update public.point_accounts set balance=999 where user_id=$1", [owner]), /permission denied/);
  }
  for (const role of ['anon', 'authenticated']) {
    await assert.rejects(asRole(role, owner, "select public.apply_point_transaction($1,100,'award','hack','hack','hack','hack')", [owner]), /permission denied/);
    await assert.rejects(asRole(role, owner, 'select public.reverse_point_transaction($1,$2,$3,$4)', [randomUUID(), 'hack', 'hack', owner]), /permission denied/);
  }
  await assert.rejects(summary(owner, 'anon'), /permission denied/);
});

test('ledger is append-only even for the table owner', async () => {
  const id = await newUser();
  const entry = await apply(id, '100');
  await assert.rejects(db.query('update public.point_transactions set amount=200 where id=$1', [entry.id]), /POINT_LEDGER_IMMUTABLE/);
  await assert.rejects(db.query('delete from public.point_transactions where id=$1', [entry.id]), /POINT_LEDGER_IMMUTABLE/);
});

test('refunds exactly reverse original transaction once, without rewriting history', async () => {
  const id = await newUser();
  const grant = await apply(id, '1000');
  const debit = await apply(id, '-100');
  const refund = await reverse(debit.id, 'refund-debit');
  assert.equal(refund.amount, '100');
  assert.equal(refund.balanceAfter, '1000');
  assert.equal((await reverse(debit.id, 'refund-debit')).duplicate, true);
  await assert.rejects(reverse(debit.id, 'different-refund-key'), /POINT_ALREADY_REVERSED/);
  await assert.rejects(reverse(refund.id, 'reverse-a-refund'), /INVALID_POINT_REVERSAL/);
  await reverse(grant.id, 'refund-award');
  assert.equal((await summary(id)).balance, '0');
  assert.equal((await history(id)).items.length, 4);
});

test('spent award cannot be reversed into a negative wallet', async () => {
  const id = await newUser();
  const grant = await apply(id, '100');
  await apply(id, '-100');
  await assert.rejects(reverse(grant.id, 'spent-award-refund'), /INSUFFICIENT_POINTS/);
  assert.equal((await history(id)).items.length, 2);
});

test('stable sequence pagination has no duplicates when new activity arrives', async () => {
  const id = await newUser();
  for (let n = 0; n < 5; n++) await apply(id, '10');
  const first = await history(id, 2);
  assert.equal(first.nextCursor, '4');
  await apply(id, '10');
  const second = await history(id, 2, first.nextCursor);
  const third = await history(id, 2, second.nextCursor);
  const ids = [...first.items, ...second.items, ...third.items].map((item) => item.id);
  assert.equal(ids.length, 5);
  assert.equal(new Set(ids).size, 5);
  assert.equal(third.nextCursor, null);
  await assert.rejects(history(id, 101), /INVALID_POINT_PAGE/);
});

test('invalid sign, missing actor, zero and arbitrary refund are rejected', async () => {
  const id = await newUser();
  for (const [amount, options] of [['0', {}], ['-1', { type: 'award' }], ['1', { type: 'spend' }],
    ['1', { type: 'admin_adjustment' }], ['1', { type: 'refund' }], ['-9223372036854775808', {}]]) {
    await assert.rejects(apply(id, amount, options), /INVALID_POINT_TRANSACTION/);
  }
  await apply(id, '25', { type: 'admin_adjustment', actorId: actor });
  assert.equal((await summary(id)).balance, '25');
});

test('overlapping requests retain invariants (single-backend engine; not a multi-connection lock test)', async () => {
  const id = await newUser();
  await apply(id, '100');
  const results = await Promise.allSettled([apply(id, '-80'), apply(id, '-80')]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal((await summary(id)).balance, '20');
});
