// Trusted operator CLI. Load secrets from the environment, never command-line
// arguments. This deliberately exposes no browser-accessible admin endpoint.
import { createClient } from '@supabase/supabase-js';
import { getPointAccount, listPointTransactions, applyPointTransaction,
  reversePointTransaction } from '../lib/points-core.mjs';

const [command, ...args] = process.argv.slice(2);
const usage = `Usage (run from main-app; Node 22+):
  node --env-file=.env.local scripts/points-admin.mjs balance USER_UUID
  node --env-file=.env.local scripts/points-admin.mjs history USER_UUID
  node --env-file=.env.local scripts/points-admin.mjs adjust USER_UUID SIGNED_AMOUNT REQUEST_ID "Customer-safe reason"
  node --env-file=.env.local scripts/points-admin.mjs reverse TRANSACTION_UUID REQUEST_ID "Customer-safe reason"

Required: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SECRET_KEY, POINTS_ENABLED=true.
Writes additionally require POINTS_MUTATIONS_ENABLED=true and POINTS_OPERATOR_USER_ID.
The operator ID must be an existing auth.users UUID. Reuse the same request ID
after an interrupted command; do not invent a new key for a retry.`;

async function main() {
  const sizes = { balance: 1, history: 1, adjust: 4, reverse: 3 };
  if (!Object.hasOwn(sizes, command) || args.length !== sizes[command]) throw new Error(usage);
  if (process.env.POINTS_ENABLED !== 'true') throw new Error('POINTS_ENABLED must be true.');
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SECRET_KEY) throw new Error('Missing Supabase environment configuration.');
  const client = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SECRET_KEY,
    { auth: { persistSession: false, autoRefreshToken: false } });
  if (command === 'balance') return getPointAccount(client, args[0]);
  if (command === 'history') return listPointTransactions(client, args[0]);
  const actorId = process.env.POINTS_OPERATOR_USER_ID;
  if (process.env.POINTS_MUTATIONS_ENABLED !== 'true' || !actorId) throw new Error('Writes require POINTS_MUTATIONS_ENABLED=true and POINTS_OPERATOR_USER_ID.');
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
