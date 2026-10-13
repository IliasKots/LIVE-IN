import { itchRouteDependencies } from '@/lib/points-itch';
import { pointsEnabled } from '@/lib/points';
import { createPointsPurchasesHandler } from '@/lib/points-purchases-http.mjs';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const { GET, POST } = createPointsPurchasesHandler({ ...itchRouteDependencies,
  readsEnabled: pointsEnabled, browser: true });
