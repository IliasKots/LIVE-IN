import { economyRouteDependencies } from '@/lib/points-economy';
import { createUsageHandlers } from '@/lib/points-economy-http.mjs';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// POST {requestId, gameId, liveId} starts (idempotently) a paid game session; GET ?session= reads it.
export const { GET, POST } = createUsageHandlers(economyRouteDependencies).sessions;
