import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { pointInteger, parsePointPage, getPointAccount, listPointTransactions,
  awardPoints, spendPoints, rewardTrustedEvent } from '../lib/points-core.mjs';
import { authenticateLauncher } from '../lib/launcher-auth-core.mjs';
import { createPointsHandler } from '../lib/points-http.mjs';

const id = '11111111-1111-4111-8111-111111111111';
const account = { balance: '9007199254740993', lifetimeEarned: '9007199254740993',
  lifetimeSpent: '0', version: '1', updatedAt: '2026-09-19T12:00:00Z' };
const client = (data, error = null) => ({ rpc: async () => ({ data, error }) });
const request = (query = '', token = 'test-token') => new Request(`https://example.test/api/v1/me/points${query}`,
  { headers: token === null ? {} : { Authorization: `Bearer ${token}` } });

test('64-bit integers never pass through JS number coercion', () => {
  for (const value of ['0', '9007199254740993', '9223372036854775807']) assert.equal(pointInteger(value), value);
  assert.equal(pointInteger('-9223372036854775807', { signed: true }), '-9223372036854775807');
  for (const value of [0, 9007199254740992, null, undefined, '', '1e3', '1.0', '01', '-0', '+1', '-1', ' 1', '9223372036854775808']) {
    assert.throws(() => pointInteger(value));
  }
  assert.throws(() => pointInteger('0', { nonzero: true }));
});

test('pagination is bounded and rejects injection/overflow', () => {
  assert.deepEqual(parsePointPage(new URLSearchParams()), { limit: 20, cursor: null });
  assert.deepEqual(parsePointPage(new URLSearchParams('limit=100&cursor=9007199254740993')), { limit: 100, cursor: '9007199254740993' });
  for (const query of ['limit=0', 'limit=101', 'limit=-1', 'limit=1.2', 'limit=Infinity', 'cursor=0', 'cursor=1%29%2Cor%28true', 'cursor=9223372036854775808']) {
    assert.throws(() => parsePointPage(new URLSearchParams(query)));
  }
});

test('account validation rejects numerical or inconsistent balances and hides errors', async () => {
  assert.deepEqual(await getPointAccount(client(account), id), account);
  for (const data of [null, {}, { ...account, balance: 9007199254740992 }, { ...account, balance: '1' }, { ...account, updatedAt: 'bad' }]) {
    await assert.rejects(getPointAccount(client(data), id), /POINTS_UNAVAILABLE/);
  }
  await assert.rejects(getPointAccount(client(null, { message: 'secret database details' }), id), /POINTS_UNAVAILABLE/);
});

test('history exposes only customer-safe fields and rejects rounded amounts', async () => {
  const item = { id, amount: '-100', balanceAfter: '9900', type: 'spend', description: 'Reward redeemed',
    createdAt: '2026-09-19T12:00:00Z', metadata: { private: 'secret' }, source_id: 'internal' };
  const page = await listPointTransactions(client({ items: [item], nextCursor: null }), id);
  assert.equal(page.items[0].amount, '-100');
  assert.equal(page.items[0].metadata, undefined);
  assert.equal(page.items[0].source_id, undefined);
  await assert.rejects(listPointTransactions(client({ items: [{ ...item, amount: -100 }], nextCursor: null }), id));
});

test('awards and spends send exact signed strings; client-supplied reward amounts are ignored', async () => {
  const calls = [];
  const api = { rpc: async (name, args) => { calls.push({ name, args }); return { data: { ok: true } }; } };
  const tx = { userId: id, amount: '9007199254740993', reason: 'Reward', sourceType: 'test', sourceId: 'event-1', idempotencyKey: 'event-1' };
  await awardPoints(api, tx);
  await spendPoints(api, tx);
  assert.equal(calls[0].args.p_amount, '9007199254740993');
  assert.equal(calls[1].args.p_amount, '-9007199254740993');
  await rewardTrustedEvent(api, { welcome: { enabled: true, amount: '100', description: 'Welcome reward' } },
    { ruleId: 'welcome', eventId: id, userId: id, amount: '99999' });
  assert.equal(calls[2].args.p_amount, '100');
  assert.throws(() => rewardTrustedEvent(api, {}, { ruleId: 'unknown', eventId: id, userId: id }), /POINT_RULE_DISABLED/);
});

function authClient(session, error = null) {
  const calls = {};
  const api = { from(table) { calls.table = table; return this; },
    select(columns) { calls.columns = columns; return this; },
    eq(column, value) { calls.column = column; calls.value = value; return this; },
    async maybeSingle() { return { data: session, error }; } };
  return { api, calls };
}

test('launcher auth uses access expiry, hashed token, and never returns the token', async () => {
  const { api, calls } = authClient({ id: 'session', user_id: id, access_expires_at: '2026-09-19T13:00:00Z', revoked_at: null });
  const auth = await authenticateLauncher(request(), () => api, Date.parse('2026-09-19T12:00:00Z'));
  assert.equal(auth.userId, id);
  assert.equal(auth.accessToken, undefined);
  assert.equal(calls.value, createHash('sha256').update('test-token').digest('hex'));
  assert.ok(calls.columns.includes('access_expires_at'));
  assert.ok(!calls.columns.includes('refresh_token_hash'));
});

test('expired, revoked, missing and malformed access expiry are unauthorized despite valid refresh expiry', async () => {
  for (const session of [null,
    { user_id: id, access_expires_at: null, expires_at: '2099-01-01' },
    { user_id: id, access_expires_at: 'invalid' },
    { user_id: id, access_expires_at: '2020-01-01', expires_at: '2099-01-01' },
    { user_id: id, access_expires_at: '2099-01-01', revoked_at: '2026-01-01' }]) {
    assert.equal(await authenticateLauncher(request(), () => authClient(session).api), null);
  }
  assert.equal(await authenticateLauncher(request('', null), () => { throw new Error('must not call database'); }), null);
  await assert.rejects(authenticateLauncher(request(), () => authClient(null, { message: 'outage' }).api), /LAUNCHER_AUTH_UNAVAILABLE/);
});

test('balance route preserves Unity contract and private no-store caching', async () => {
  const handler = createPointsHandler({ authenticate: async () => ({ supabase: client(account), userId: id }), isEnabled: () => true });
  const response = await handler(request('?userId=attacker'));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { balance: '9007199254740993' });
  assert.match(response.headers.get('cache-control'), /no-store/);
  assert.equal(response.headers.get('vary'), 'Authorization');
});

test('route reports 401 for invalid sessions, 503 when disabled, 500 for infrastructure failures', async () => {
  for (const [authenticate, enabled, expected] of [
    [async () => null, false, 401],
    [async () => ({ userId: id }), false, 503],
    [async () => { throw new Error('private failure'); }, true, 500],
    [async () => ({ userId: id, supabase: client(null, { message: 'SQL secret' }) }), true, 500],
  ]) {
    const response = await createPointsHandler({ authenticate, isEnabled: () => enabled })(request());
    assert.equal(response.status, expected);
    const body = await response.json();
    assert.equal(body.balance, undefined);
    assert.ok(!JSON.stringify(body).includes('secret'));
  }
});

test('history endpoint ignores supplied user IDs and validates cursor before database reads', async () => {
  let calls = 0;
  const api = { rpc: async (_name, args) => { calls++; assert.equal(args.p_user_id, id); return { data: { items: [], nextCursor: null } }; } };
  const handler = createPointsHandler({ authenticate: async () => ({ userId: id, supabase: api }), isEnabled: () => true, kind: 'history' });
  assert.equal((await handler(request('?cursor=invalid'))).status, 400);
  assert.equal(calls, 0);
  assert.equal((await handler(request('?userId=other'))).status, 200);
  assert.equal(calls, 1);
});
