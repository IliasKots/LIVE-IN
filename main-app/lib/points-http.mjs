import { getPointAccount, listPointTransactions, parsePointPage, PointsError } from './points-core.mjs';

function json(body, status = 200) {
  return Response.json(body, { status, headers: { 'Cache-Control': 'private, no-store, max-age=0',
    Vary: 'Authorization', ...(status === 401 ? { 'WWW-Authenticate': 'Bearer' } : {}) } });
}

export function createPointsHandler({ authenticate, isEnabled, kind = 'balance' }) {
  return async function GET(request) {
    try {
      const auth = await authenticate(request);
      if (!auth) return json({ error: 'Unauthorized' }, 401);
      if (!isEnabled()) return json({ error: 'Points are temporarily unavailable' }, 503);
      if (kind === 'history') {
        return json(await listPointTransactions(auth.supabase, auth.userId, parsePointPage(new URL(request.url).searchParams)));
      }
      const account = await getPointAccount(auth.supabase, auth.userId);
      return json(kind === 'balance' ? { balance: account.balance } : account);
    } catch (error) {
      if (error instanceof PointsError && error.status === 400) return json({ error: 'Invalid points request' }, 400);
      // An outage must not fabricate a zero balance or sign the launcher out.
      return json({ error: 'Points are temporarily unavailable' }, 500);
    }
  };
}
