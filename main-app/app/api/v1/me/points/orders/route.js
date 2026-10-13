import { authenticateLauncherRequest } from '@/lib/launcher-auth';
import { pointsEnabled } from '@/lib/points';
import { lemonSqueezyRouteDependencies } from '@/lib/points-lemonsqueezy';
import { isStripeSelected, stripeRouteDependencies } from '@/lib/points-stripe';
import { createPointOrdersHandler } from '@/lib/points-lemonsqueezy-http.mjs';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// POINTS_PAYMENT_PROVIDER=stripe selects the Stripe sandbox; otherwise Lemon Squeezy (unchanged).
const lemonSqueezy = createPointOrdersHandler({ ...lemonSqueezyRouteDependencies,
  authenticate: authenticateLauncherRequest, readsEnabled: pointsEnabled });
const stripe = createPointOrdersHandler({ ...stripeRouteDependencies,
  authenticate: authenticateLauncherRequest, readsEnabled: pointsEnabled });
export function GET(request) { return (isStripeSelected() ? stripe : lemonSqueezy).GET(request); }
export function POST(request) { return (isStripeSelected() ? stripe : lemonSqueezy).POST(request); }
