import { itchRouteDependencies } from '@/lib/points-itch';
import { createPointsDeliveryHandler } from '@/lib/points-delivery-http.mjs';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const POST = createPointsDeliveryHandler({ ...itchRouteDependencies, browser: true });
