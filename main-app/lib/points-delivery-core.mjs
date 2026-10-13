import { PointsError } from './points-core.mjs';
import { PURCHASE_UUID, purchaseRpc, validatePurchaseClaim, getPurchaseIntent, publicPurchase } from './points-purchases-core.mjs';
import { redeemItchClaim } from './points-itch-core.mjs';

// Called only with an already signature-verified provider claim. No raw token,
// cookie, email address or payment credential is written to the database.
export async function rememberVerifiedItchClaim(client, config, claim) {
  if (!config.claimsEnabled || !config.walletEnabled) throw new PointsError('CLAIMS_DISABLED', 503);
  if (!claim.intentId) return; // Preserve prior signed claims; all new checkout has an intent.
  await validatePurchaseClaim(client, config, claim, claim.userId);
  await purchaseRpc(client, 'remember_verified_point_purchase', { p_project_url: config.projectUrl, p_claim: claim });
}

export async function recoverPointDelivery(client, config, userId, intentId) {
  if (!config.claimsEnabled || !config.walletEnabled) throw new PointsError('CLAIMS_DISABLED', 503);
  if (!PURCHASE_UUID.test(userId)) throw new PointsError('UNAUTHORIZED', 401);
  if (!PURCHASE_UUID.test(intentId)) throw new PointsError('INVALID_PURCHASE_INTENT', 400);
  const intent = await getPurchaseIntent(client, userId, intentId);
  if (!intent) throw new PointsError('UNKNOWN_PURCHASE_INTENT', 404);
  const claim = await purchaseRpc(client, 'get_verified_point_purchase', { p_user_id: userId, p_intent_id: intentId });
  if (claim) await redeemItchClaim(client, config, claim, userId);
  // No evidence means pending, not paid; a saved intent alone never credits.
  return { purchase: publicPurchase(await getPurchaseIntent(client, userId, intentId)) };
}
