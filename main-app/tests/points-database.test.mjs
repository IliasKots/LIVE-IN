import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';

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
  actor = await newUser();
});
after(async () => { await db?.close(); });

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
