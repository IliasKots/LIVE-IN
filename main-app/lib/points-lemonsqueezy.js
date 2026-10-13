import 'server-only';
import { createAdminClient } from '@/lib/supabase/admin';
import { readLemonSqueezyConfig, lemonSqueezySelected, mockPaymentsAllowed } from './points-lemonsqueezy-core.mjs';

// Server-only: API key, webhook secret and reference secret never reach a client bundle.
export function getLemonSqueezyConfig() { return readLemonSqueezyConfig(process.env); }
export function isLemonSqueezySelected() { return lemonSqueezySelected(process.env); }
export function isMockPaymentsAllowed() { return mockPaymentsAllowed(process.env); }
export const lemonSqueezyRouteDependencies = { getConfig: getLemonSqueezyConfig, getAdminClient: createAdminClient };
