import { authenticateLauncherRequest } from '@/lib/launcher-auth';
import { createAdminClient } from '@/lib/supabase/admin';
import { pointsEnabled } from '@/lib/points';
import { getItchConfig } from '@/lib/points-itch';
import { createPointsPurchasesHandler } from '@/lib/points-purchases-http.mjs';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const { GET, POST } = createPointsPurchasesHandler({ authenticate: authenticateLauncherRequest,
  getAdminClient: createAdminClient, getConfig: getItchConfig, readsEnabled: pointsEnabled });
