import { economyRouteDependencies } from '@/lib/points-economy';
import { createProductHandlers } from '@/lib/points-economy-http.mjs';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// POST {productId, requestId}. Reuse the same requestId for every retry of one click.
export const { POST } = createProductHandlers(economyRouteDependencies).purchases;
