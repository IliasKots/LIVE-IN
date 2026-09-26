import { createHash } from 'node:crypto';

export async function authenticateLauncher(request, createAdminClient, now = Date.now()) {
  const header = request.headers.get('authorization');
  if (!header?.startsWith('Bearer ')) return null;
  const token = header.slice(7).trim();
  if (!token || token.length > 4096) return null;
  const supabase = createAdminClient();
  const { data: session, error } = await supabase.from('launcher_sessions')
    .select('id, user_id, access_expires_at, revoked_at')
    .eq('access_token_hash', createHash('sha256').update(token).digest('hex')).maybeSingle();
  if (error) throw new Error('LAUNCHER_AUTH_UNAVAILABLE');
  const expires = session?.access_expires_at ? Date.parse(session.access_expires_at) : NaN;
  if (!session?.user_id || session.revoked_at || !Number.isFinite(expires) || expires <= now) return null;
  return { session, userId: session.user_id, supabase };
}
