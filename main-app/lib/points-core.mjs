// Inject a server-created Supabase client. No customer mutation endpoint.
export const MAX_POINTS = 9223372036854775807n;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class PointsError extends Error {
  constructor(code, status = 500) {
    super(code);
    this.name = 'PointsError';
    this.code = code;
    this.status = status;
  }
}

export function pointInteger(value, { signed = false, nonzero = false } = {}) {
  // Reject JSON numbers: precision may already have been lost at deserialization.
  if (typeof value !== 'string' || value.length > 20 || !(signed ? /^-?[1-9]\d*$|^0$/ : /^[1-9]\d*$|^0$/).test(value)) {
    throw new PointsError('INVALID_POINT_INTEGER', 400);
  }
  const integer = BigInt(value);
  if (integer > MAX_POINTS || integer < -MAX_POINTS || (nonzero && integer === 0n)) {
    throw new PointsError('INVALID_POINT_INTEGER', 400);
  }
  return value;
}

function userId(value) {
  if (typeof value !== 'string' || !UUID.test(value)) throw new PointsError('INVALID_USER_ID', 400);
  return value;
}

function text(value, max, field) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new PointsError(`INVALID_${field}`, 400);
  }
  return value.trim();
}

async function rpc(client, name, args) {
  const { data, error } = await client.rpc(name, args);
  if (error) {
    const allowed = new Map([
      ['INSUFFICIENT_POINTS', 409], ['POINT_IDEMPOTENCY_CONFLICT', 409],
      ['POINT_ALREADY_REVERSED', 409], ['POINT_LIMIT_EXCEEDED', 409],
      ['INVALID_POINT_REVERSAL', 400], ['INVALID_POINT_TRANSACTION', 400],
      ['POINT_ACCESS_DENIED', 403], ['INVALID_POINT_PAGE', 400],
    ]);
    if (allowed.has(error.message)) throw new PointsError(error.message, allowed.get(error.message));
    if (error.code === '23505') throw new PointsError('POINT_SOURCE_ALREADY_PROCESSED', 409);
    throw new PointsError('POINTS_UNAVAILABLE');
  }
  return data;
}

export function parsePointPage(searchParams) {
  const limit = searchParams.get('limit') ?? '20';
  const cursor = searchParams.get('cursor');
  if (!/^[1-9]\d{0,2}$/.test(limit) || Number(limit) > 100) throw new PointsError('INVALID_POINT_PAGE', 400);
  if (cursor !== null) pointInteger(cursor, { nonzero: true });
  return { limit: Number(limit), cursor };
}

export function validateAccount(data) {
  if (!data || typeof data !== 'object') throw new PointsError('POINTS_UNAVAILABLE');
  try {
    for (const key of ['balance', 'lifetimeEarned', 'lifetimeSpent', 'version']) pointInteger(data[key]);
    if (BigInt(data.lifetimeEarned) - BigInt(data.lifetimeSpent) !== BigInt(data.balance)) throw new Error();
    if (data.updatedAt !== null && (typeof data.updatedAt !== 'string' || !Number.isFinite(Date.parse(data.updatedAt)))) throw new Error();
  } catch {
    throw new PointsError('POINTS_UNAVAILABLE');
  }
  return { balance: data.balance, lifetimeEarned: data.lifetimeEarned, lifetimeSpent: data.lifetimeSpent,
    version: data.version, updatedAt: data.updatedAt };
}

export async function getPointAccount(client, id) {
  return validateAccount(await rpc(client, 'get_point_account', { p_user_id: userId(id) }));
}

export async function listPointTransactions(client, id, { limit = 20, cursor = null } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new PointsError('INVALID_POINT_PAGE', 400);
  if (cursor !== null) pointInteger(cursor, { nonzero: true });
  const data = await rpc(client, 'list_point_transactions', { p_user_id: userId(id), p_limit: limit, p_before: cursor });
  try {
    if (!data || !Array.isArray(data.items) || data.items.length > limit) throw new Error();
    if (data.nextCursor !== null) pointInteger(data.nextCursor, { nonzero: true });
    return { items: data.items.map((item) => {
      if (!UUID.test(item.id) || !['award', 'spend', 'refund', 'admin_adjustment', 'revocation'].includes(item.type)
        || typeof item.description !== 'string' || item.description.length > 200
        || typeof item.createdAt !== 'string' || !Number.isFinite(Date.parse(item.createdAt))) throw new Error();
      return { id: item.id, amount: pointInteger(item.amount, { signed: true, nonzero: true }),
        balanceAfter: pointInteger(item.balanceAfter), type: item.type,
        description: item.description, createdAt: item.createdAt };
    }), nextCursor: data.nextCursor };
  } catch {
    throw new PointsError('POINTS_UNAVAILABLE');
  }
}

export async function applyPointTransaction(client, transaction) {
  const { userId: id, amount, type, reason, sourceType, sourceId, idempotencyKey,
    metadata = {}, actorId = null } = transaction;
  pointInteger(amount, { signed: true, nonzero: true });
  if (!['award', 'spend', 'admin_adjustment'].includes(type)
    || (type === 'award' && BigInt(amount) < 0n) || (type === 'spend' && BigInt(amount) > 0n)
    || (type === 'admin_adjustment' && !actorId)) throw new PointsError('INVALID_POINT_TRANSACTION', 400);
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)
    || Buffer.byteLength(JSON.stringify(metadata), 'utf8') > 4096) throw new PointsError('INVALID_POINT_METADATA', 400);
  return rpc(client, 'apply_point_transaction', {
    p_user_id: userId(id), p_amount: amount, p_type: type, p_reason: text(reason, 200, 'POINT_REASON'),
    p_source_type: text(sourceType, 64, 'POINT_SOURCE'), p_source_id: text(sourceId, 200, 'POINT_SOURCE'),
    p_idempotency_key: text(idempotencyKey, 200, 'POINT_KEY'), p_metadata: metadata,
    p_actor_id: actorId === null ? null : userId(actorId), p_reversal_of: null,
  });
}

export function awardPoints(client, transaction) {
  pointInteger(transaction.amount, { nonzero: true });
  return applyPointTransaction(client, { ...transaction, type: 'award' });
}

export function spendPoints(client, transaction) {
  pointInteger(transaction.amount, { nonzero: true });
  return applyPointTransaction(client, { ...transaction, amount: `-${transaction.amount}`, type: 'spend' });
}

export function reversePointTransaction(client, { originalId, reason, idempotencyKey, actorId }) {
  return rpc(client, 'reverse_point_transaction', { p_original_id: userId(originalId),
    p_reason: text(reason, 200, 'POINT_REASON'), p_idempotency_key: text(idempotencyKey, 200, 'POINT_KEY'),
    p_actor_id: userId(actorId) });
}

// Call only AFTER a trusted webhook/game backend has verified the event.
export function rewardTrustedEvent(client, rules, { ruleId, eventId, userId: id, metadata = {} }) {
  if (!Object.hasOwn(rules, ruleId)) throw new PointsError('POINT_RULE_DISABLED', 403);
  const rule = rules[ruleId];
  if (!rule || rule.enabled !== true) throw new PointsError('POINT_RULE_DISABLED', 403);
  return awardPoints(client, { userId: id, amount: pointInteger(rule.amount, { nonzero: true }),
    reason: rule.description, sourceType: `reward:${text(ruleId, 50, 'POINT_RULE')}`,
    sourceId: text(eventId, 200, 'POINT_EVENT'), idempotencyKey: `${ruleId}:${eventId}`,
    metadata });
}
