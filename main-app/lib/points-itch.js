import 'server-only';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { readItchConfig, publicItchPacks } from './points-itch-core.mjs';

export function getItchConfig() { return readItchConfig(); }
export function getPublicItchPacks() {
  try { return publicItchPacks(getItchConfig()); } catch { return []; }
}
export async function authenticatePointsBrowser() {
  const client = await createClient();
  const { data: { user }, error } = await client.auth.getUser();
  return !error && user?.email_confirmed_at ? { userId: user.id } : null;
}
export const itchRouteDependencies = { getConfig: getItchConfig, authenticate: authenticatePointsBrowser, getAdminClient: createAdminClient };
