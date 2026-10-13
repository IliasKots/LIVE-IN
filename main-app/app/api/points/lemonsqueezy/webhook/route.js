import { lemonSqueezyRouteDependencies } from '@/lib/points-lemonsqueezy';
import { createLemonSqueezyWebhookHandler } from '@/lib/points-lemonsqueezy-http.mjs';
// Configure in Lemon Squeezy: https://<site>/api/points/lemonsqueezy/webhook
// Events: order_created, order_refunded. Signing secret = LEMONSQUEEZY_WEBHOOK_SECRET.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const POST = createLemonSqueezyWebhookHandler(lemonSqueezyRouteDependencies);
