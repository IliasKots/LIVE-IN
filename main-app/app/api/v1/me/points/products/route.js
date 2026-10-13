import { economyRouteDependencies } from '@/lib/points-economy';
import { createProductHandlers } from '@/lib/points-economy-http.mjs';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// GET ?gameId= lists active products with their server prices.
export const { GET } = createProductHandlers(economyRouteDependencies).products;
