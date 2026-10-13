import { lemonSqueezyRouteDependencies, isMockPaymentsAllowed } from '@/lib/points-lemonsqueezy';
import { createMockCheckoutHandler } from '@/lib/points-lemonsqueezy-http.mjs';
// DEVELOPMENT ONLY. Returns 404 unless local/staging mock payments are explicitly enabled.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const POST = createMockCheckoutHandler({ ...lemonSqueezyRouteDependencies, isAllowed: isMockPaymentsAllowed });
