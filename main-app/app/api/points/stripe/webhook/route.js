import { stripeRouteDependencies } from '@/lib/points-stripe';
import { createStripeWebhookHandler } from '@/lib/points-stripe-http.mjs';
// SANDBOX ONLY. Configure in the Stripe dashboard (test mode): https://<site>/api/points/stripe/webhook
// Events: checkout.session.completed, checkout.session.async_payment_succeeded,
// checkout.session.async_payment_failed, charge.refunded, charge.dispute.created, charge.dispute.closed.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const POST = createStripeWebhookHandler(stripeRouteDependencies);
