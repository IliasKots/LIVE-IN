
import 'server-only';
import { createAdminClient } from "@/lib/supabase/admin";
import { authenticateLauncher } from './launcher-auth-core.mjs';

export async function authenticateLauncherRequest(request) {
  return authenticateLauncher(request, createAdminClient);
}

