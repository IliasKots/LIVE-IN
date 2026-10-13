import { getPublicItchPacks } from '@/lib/points-itch';
import { createPointsPacksHandler } from '@/lib/points-packs-http.mjs';
import { getLemonSqueezyConfig, isLemonSqueezySelected } from '@/lib/points-lemonsqueezy';
import { createLemonSqueezyPacksHandler } from '@/lib/points-lemonsqueezy-http.mjs';
import { getStripeConfig, isStripeSelected } from '@/lib/points-stripe';
import { createStripePacksHandler } from '@/lib/points-stripe-http.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const itch = createPointsPacksHandler({ getPacks: getPublicItchPacks });
const lemonSqueezy = createLemonSqueezyPacksHandler({ getConfig: getLemonSqueezyConfig });
const stripe = createStripePacksHandler({ getConfig: getStripeConfig });
// POINTS_PAYMENT_PROVIDER=lemonsqueezy or stripe (sandbox) selects that provider;
// otherwise the existing itch.io catalog.
export function GET(request) {
  if (isStripeSelected()) return stripe(request);
  return isLemonSqueezySelected() ? lemonSqueezy(request) : itch(request);
}
