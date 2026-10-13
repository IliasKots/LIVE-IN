import 'server-only';
import { createAdminClient } from '@/lib/supabase/admin';
import { readStripeConfig, stripeSelected, createStripeCheckout } from './points-stripe-core.mjs';

// Server-only: the Stripe secret key and webhook secret never reach a client bundle.
export function getStripeConfig() { return readStripeConfig(process.env); }
export function isStripeSelected() { return stripeSelected(process.env); }
export const stripeRouteDependencies = { getConfig: getStripeConfig, getAdminClient: createAdminClient,
  providerCheckout: createStripeCheckout };
