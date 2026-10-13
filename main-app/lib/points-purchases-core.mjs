import { PointsError, pointInteger } from './points-core.mjs';

export const PURCHASE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fail = (code, status = 503) => { throw new PointsError(code, status); };
export async function purchaseRpc(client, name, args) {
  const { data, error } = await client.rpc(name, args);
  if (error) {
    const codes = ['WRONG_ACCOUNT', 'PACK_MISMATCH', 'UNKNOWN_PURCHASE_INTENT', 'POINT_IDEMPOTENCY_CONFLICT', 'INVALID_PURCHASE', 'PURCHASE_REFUNDED'];
    const code = codes.find((value) => error.message?.includes(value));
    return fail(code || 'POINTS_UNAVAILABLE', code ? 409 : 503);
  }
  return data;
}
export async function getPurchaseIntent(client, userId, intentId = null) {
  if (!PURCHASE_UUID.test(userId) || (intentId !== null && !PURCHASE_UUID.test(intentId))) return fail('INVALID_PURCHASE_INTENT', 400);
  const value = await purchaseRpc(client, 'get_point_purchase', { p_user_id: userId, p_intent_id: intentId });
  if (value === null) return null;
  if (!value || !PURCHASE_UUID.test(value.id) || value.userId !== userId
    || !['pending', 'credited', 'refunded'].includes(value.status)) return fail('POINTS_UNAVAILABLE');
  pointInteger(value.points, { nonzero: true });
  if (value.status !== 'pending' && (!PURCHASE_UUID.test(value.transactionId) || !/^[1-9]\d{0,19}$/.test(value.purchaseId))) return fail('POINTS_UNAVAILABLE');
  return value;
}
export function publicPurchase(value) {
  if (!value) return null;
  const { id, packId, name, points, priceLabel, currency, status, createdAt, transactionId, creditedAt } = value;
  return { id, packId, name, points, priceLabel, currency, status, createdAt, transactionId, creditedAt };
}
export async function createPurchaseIntent(client, config, userId, packId) {
  if (!config.walletEnabled || !config.checkoutEnabled || !config.claimsEnabled) return fail('CHECKOUT_DISABLED', 503);
  if (!PURCHASE_UUID.test(userId)) return fail('UNAUTHORIZED', 401);
  const pack = config.packs.find((value) => value.id === packId && value.enabled);
  if (!pack) return fail('UNKNOWN_PACK', 400);
  // Legacy catalogs can serve outstanding claims, but cannot start new purchases without explicit currency/price.
  if (!pack.currency || !pack.priceMinor) return fail('PURCHASE_CONFIGURATION_UNAVAILABLE');
  const result = await purchaseRpc(client, 'create_point_purchase_intent', { p_user_id: userId,
    p_pack_id: pack.id, p_pack_name: pack.name, p_points: pack.points, p_project_url: config.projectUrl,
    p_sub_product_id: pack.subProductId, p_price_label: pack.priceLabel, p_currency: pack.currency, p_price_minor: pack.priceMinor });
  if (!result || !PURCHASE_UUID.test(result.id)) return fail('POINTS_UNAVAILABLE');
  return getPurchaseIntent(client, userId, result.id);
}
export async function validatePurchaseClaim(client, config, claim, userId) {
  const intent = await getPurchaseIntent(client, userId, claim.intentId);
  if (!intent || intent.projectUrl !== config.projectUrl || intent.packId !== claim.packId
    || intent.subProductId !== claim.subProductId || intent.points !== claim.points
    || intent.currency !== claim.currency || intent.priceMinor !== claim.priceMinor) return fail('PACK_MISMATCH', 409);
  if (claim.paidCurrency !== null && claim.paidCurrency !== intent.currency) return fail('PAYMENT_CURRENCY_MISMATCH', 409);
  if (claim.paidMinor !== null && BigInt(claim.paidMinor) < BigInt(intent.priceMinor)) return fail('PAYMENT_AMOUNT_MISMATCH', 409);
  return intent;
}
export async function creditPurchaseIntent(client, config, claim, userId) {
  const intent = await validatePurchaseClaim(client, config, claim, userId);
  return purchaseRpc(client, 'credit_point_purchase', { p_user_id: userId, p_intent_id: intent.id,
    p_purchase_id: claim.purchaseId, p_project_url: config.projectUrl, p_sub_product_id: claim.subProductId,
    p_pack_id: claim.packId, p_points: claim.points });
}
