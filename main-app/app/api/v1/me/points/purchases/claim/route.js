import { authenticateLauncherRequest } from '@/lib/launcher-auth';
import { createAdminClient } from '@/lib/supabase/admin';
import { getItchConfig } from '@/lib/points-itch';
import { createPointsDeliveryHandler } from '@/lib/points-delivery-http.mjs';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const POST = createPointsDeliveryHandler({ authenticate: authenticateLauncherRequest,
  getAdminClient: createAdminClient, getConfig: getItchConfig });
