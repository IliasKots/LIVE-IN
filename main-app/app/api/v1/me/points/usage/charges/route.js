import { economyRouteDependencies } from '@/lib/points-economy';
import { createUsageHandlers } from '@/lib/points-economy-http.mjs';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// POST {sessionId, events:[{eventKey, giftId, cumulativeCount, occurredAt?}]} (1..50 events)
export const { POST } = createUsageHandlers(economyRouteDependencies).charges;
