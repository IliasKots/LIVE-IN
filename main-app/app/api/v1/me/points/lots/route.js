import { economyRouteDependencies } from '@/lib/points-economy';
import { createRefundHandlers } from '@/lib/points-economy-http.mjs';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Purchased packages with how many of their Points were used.
export const { GET } = createRefundHandlers(economyRouteDependencies).lots;
