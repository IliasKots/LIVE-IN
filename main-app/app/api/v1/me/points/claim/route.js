import { createItchClaimHandler } from '@/lib/points-itch-http.mjs';
import { itchRouteDependencies } from '@/lib/points-itch';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const POST = createItchClaimHandler(itchRouteDependencies);
