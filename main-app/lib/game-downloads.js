import 'server-only';
import { createAdminClient } from '@/lib/supabase/admin';
import { authenticateLauncher } from './launcher-auth-core.mjs';
import { handleGameDownload, readDownloadConfig } from './game-downloads-core.mjs';
import { createR2Signer } from './r2-presign.mjs';

let cachedSigner = null;
let cachedKey = '';

function signerFor(config) {
  const key = `${config.endpoint}|${config.accessKeyId}`;
  if (!cachedSigner || cachedKey !== key) { cachedSigner = createR2Signer(config); cachedKey = key; }
  return cachedSigner;
}

async function rpc(supabase, name, args) {
  const { data, error } = await supabase.rpc(name, args);
  if (error) throw new Error(`GAME_DOWNLOAD_RPC_${name}`);
  return data;
}

export async function gameDownloadResponse(request, gameId) {
  const config = readDownloadConfig();
  let supabase = null;
  const admin = () => (supabase ||= createAdminClient());
  return handleGameDownload(request, gameId, {
    authenticate: (req) => authenticateLauncher(req, admin),
    async getUser(userId) {
      const { data, error } = await admin().auth.admin.getUserById(userId);
      if (error || !data?.user) return null;
      return { emailConfirmedAt: data.user.email_confirmed_at || null };
    },
    beginRequest: ({ requestId, userId, gameId: id, limit, windowSeconds }) => rpc(admin(), 'begin_game_download', {
      p_request_id: requestId, p_user_id: userId, p_game_id: id, p_limit: limit, p_window_seconds: windowSeconds }),
    finishRequest: (requestId, outcome, version) => rpc(admin(), 'finish_game_download', {
      p_request_id: requestId, p_outcome: outcome, p_version: version }),
    findReadyRelease: (id, platform) => rpc(admin(), 'get_ready_game_release', { p_game_id: id, p_platform: platform }),
    sign: (args) => signerFor(config)(args),
    now: () => Date.now(),
    // Never log URLs, tokens or signed query strings.
    log: (event) => console.info(JSON.stringify(event)),
  }, config);
}
