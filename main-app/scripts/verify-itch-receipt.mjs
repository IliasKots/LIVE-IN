// Read-only operator diagnostic. Supply a provider-issued JWT through stdin on
// the private server, with its existing server environment loaded. No DB access,
// checkout, external request, ledger credit or token output is possible here.
import { readItchConfig, verifyItchClaim } from '../lib/points-itch-core.mjs';

let token = '';
try {
  if (process.stdin.isTTY) throw new Error('USE_PRIVATE_STDIN');
  for await (const bytes of process.stdin) {
    token += bytes.toString();
    if (token.length > 4098) throw new Error('INVALID_PURCHASE');
  }
  // Override operational gates in this isolated verifier ONLY. Nothing is enabled
  // in the app, and no mutation function or database client is imported/called.
  const config = readItchConfig({ ...process.env, POINTS_DEPLOYMENT_ENVIRONMENT: 'local',
    POINTS_ENABLED: 'true', POINTS_MUTATIONS_ENABLED: 'true', ITCH_POINTS_PRODUCTS_VERIFIED: 'true',
    POINTS_ITCH_CHECKOUT_ENABLED: 'false', POINTS_ITCH_CLAIMS_ENABLED: 'true' });
  const claim = verifyItchClaim(config, token.trim());
  console.log(JSON.stringify({ signatureVerified: true, algorithm: 'HS256', purchaseId: claim.purchaseId,
    subProductId: claim.subProductId, packId: claim.packId, intentId: claim.intentId ?? null,
    points: claim.points, linkedToIntent: Boolean(claim.intentId), credited: false }));
} catch (error) {
  console.error(JSON.stringify({ signatureVerified: false,
    error: ['INVALID_PURCHASE', 'CLAIM_EXPIRED', 'PACK_MISMATCH', 'UNLINKED_PURCHASE',
      'PURCHASE_REFUNDED', 'PAYMENT_NOT_COMPLETE', 'PURCHASE_CONFIGURATION_UNAVAILABLE'].includes(error.code)
      ? error.code : 'RECEIPT_VERIFICATION_FAILED', credited: false }));
  process.exitCode = 1;
} finally { token = ''; }
