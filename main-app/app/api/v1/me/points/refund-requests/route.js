import { economyRouteDependencies } from '@/lib/points-economy';
import { createRefundHandlers } from '@/lib/points-economy-http.mjs';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// POST {transactionId} of a purchase credit. Evaluates usage; never moves money.
export const { POST } = createRefundHandlers(economyRouteDependencies).requests;
