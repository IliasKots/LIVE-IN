import { economyRouteDependencies } from '@/lib/points-economy';
import { createUsageHandlers } from '@/lib/points-economy-http.mjs';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// POST {sessionId, action: heartbeat|pause|resume|stop}
export const { POST } = createUsageHandlers(economyRouteDependencies).state;
