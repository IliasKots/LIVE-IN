import 'server-only';
import { createAdminClient } from '@/lib/supabase/admin';
import { authenticateLauncherRequest } from '@/lib/launcher-auth';
import { economyFlags } from './points-economy-core.mjs';

// Server-only. Every economy route authenticates the launcher session and uses
// the service client; the account is never read from a request body.
export const economyRouteDependencies = { authenticate: authenticateLauncherRequest,
  getAdminClient: createAdminClient, getFlags: () => economyFlags(process.env) };
