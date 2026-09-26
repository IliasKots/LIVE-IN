import 'server-only';
import { createAdminClient } from '@/lib/supabase/admin';
import * as core from './points-core.mjs';

export const pointsEnabled = () => process.env.POINTS_ENABLED === 'true';
function mutationClient() {
  if (!pointsEnabled() || process.env.POINTS_MUTATIONS_ENABLED !== 'true') {
    throw new core.PointsError('POINT_MUTATIONS_DISABLED', 503);
  }
  return createAdminClient();
}
export const awardPoints = (transaction) => core.awardPoints(mutationClient(), transaction);
export const spendPoints = (transaction) => core.spendPoints(mutationClient(), transaction);
export const adjustPoints = (transaction) => core.applyPointTransaction(mutationClient(), { ...transaction, type: 'admin_adjustment' });
export const reversePointTransaction = (transaction) => core.reversePointTransaction(mutationClient(), transaction);
export function rewardTrustedEvent(event) {
  const rules = JSON.parse(process.env.POINTS_REWARD_RULES_JSON || '{}');
  return core.rewardTrustedEvent(mutationClient(), rules, event);
}
