// Trusted operator CLI. Load secrets from the environment, never command-line
// arguments. This deliberately exposes no browser-accessible admin endpoint.
import { createClient } from '@supabase/supabase-js';
import { pointsMutationsAllowed } from '../lib/points-policy.mjs';
import { getPointAccount, listPointTransactions, applyPointTransaction,
  reversePointTransaction } from '../lib/points-core.mjs';

const [command, ...args] = process.argv.slice(2);
const usage = `Usage (run from main-app; Node 22+):
  node --env-file=.env.local scripts/points-admin.mjs balance USER_UUID
  node --env-file=.env.local scripts/points-admin.mjs history USER_UUID
  node --env-file=.env.local scripts/points-admin.mjs adjust USER_UUID SIGNED_AMOUNT REQUEST_ID "Customer-safe reason"
  node --env-file=.env.local scripts/points-admin.mjs reverse TRANSACTION_UUID REQUEST_ID "Customer-safe reason"
  node --env-file=.env.local scripts/points-admin.mjs refunds
    (verified Lemon Squeezy refunds whose credit is not yet reversed; review, then use reverse)
  node --env-file=.env.local scripts/points-admin.mjs review
    (open refund/dispute review flags and customer refund requests, with per-purchase usage)
  node --env-file=.env.local scripts/points-admin.mjs resolve flag|refund-request ID "Resolution note"
  node --env-file=.env.local scripts/points-admin.mjs payments
    (verified payments not yet credited, and recent payments deliberately not credited, e.g. PRICE_MISMATCH)
  node --env-file=.env.local scripts/points-admin.mjs retry-payments
    (credits every verified-but-uncredited payment; safe to repeat)

Required: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SECRET_KEY, POINTS_ENABLED=true.
Writes additionally require POINTS_MUTATIONS_ENABLED=true, POINTS_OPERATOR_USER_ID,
POINTS_DEPLOYMENT_ENVIRONMENT=local|staging|production, and, for production,
POINTS_PRODUCTION_ACCEPTED=true.
The operator ID must be an existing auth.users UUID. Reuse the same request ID
after an interrupted command; do not invent a new key for a retry.`;

async function main() {
  const sizes = { balance: 1, history: 1, adjust: 4, reverse: 3, refunds: 0, review: 0, resolve: 3, payments: 0, 'retry-payments': 0 };
  if (!Object.hasOwn(sizes, command) || args.length !== sizes[command]) throw new Error(usage);
  if (process.env.POINTS_ENABLED !== 'true') throw new Error('POINTS_ENABLED must be true.');
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SECRET_KEY) throw new Error('Missing Supabase environment configuration.');
  const client = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SECRET_KEY,
    { auth: { persistSession: false, autoRefreshToken: false } });
  if (command === 'balance') return getPointAccount(client, args[0]);
  if (command === 'history') return listPointTransactions(client, args[0]);
  if (command === 'refunds') {
    const { data, error } = await client.rpc('list_point_provider_refunds_for_review');
    if (error) throw new Error('Points operation failed. Check configuration and retry with the same request ID.');
    return data;
  }
  if (command === 'payments') {
    const { data, error } = await client.rpc('list_point_payment_exceptions');
    if (error) throw new Error('Points operation failed. Check configuration and retry with the same request ID.');
    return data;
  }
  if (command === 'review') {
    const { data, error } = await client.rpc('list_point_review_queue');
    if (error) throw new Error('Points operation failed. Check configuration and retry with the same request ID.');
    return data;
  }
  const actorId = process.env.POINTS_OPERATOR_USER_ID;
  if (!pointsMutationsAllowed() || !actorId) throw new Error('Writes require an approved deployment environment, enabled mutations and POINTS_OPERATOR_USER_ID.');
  if (command === 'retry-payments') {
    const { data, error } = await client.rpc('retry_point_provider_payments', { p_order_id: null });
    if (error) throw new Error('Points operation failed. Check configuration and retry with the same request ID.');
    return data;
  }
  if (command === 'resolve') {
    if (!['flag', 'refund-request'].includes(args[0])) throw new Error(usage);
    const { data, error } = await client.rpc('resolve_point_review', { p_kind: args[0], p_id: args[1],
      p_actor_id: actorId, p_resolution: args[2] });
    if (error) throw new Error('Points operation failed. Check configuration and retry with the same request ID.');
    return data;
  }
  if (command === 'reverse') return reversePointTransaction(client,
    { originalId: args[0], idempotencyKey: `admin-reversal:${args[1]}`, reason: args[2], actorId });
  return applyPointTransaction(client, { userId: args[0], amount: args[1], type: 'admin_adjustment',
    sourceType: 'admin', sourceId: args[2], idempotencyKey: `admin:${args[2]}`, reason: args[3], actorId });
}

try { console.log(JSON.stringify(await main(), null, 2)); }
catch (error) {
  // Known validation codes and usage only. Never dump Supabase response bodies.
  console.error(error.code || (error.message?.includes('Usage') || /^(POINTS_|Missing |Writes require)/.test(error.message) ? error.message : 'Points operation failed. Check configuration and retry with the same request ID.'));
  process.exitCode = 1;
}
