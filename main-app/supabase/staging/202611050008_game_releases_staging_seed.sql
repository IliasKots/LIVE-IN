-- STAGING ONLY. Publishes the two verified packages from release-manifest.json (2026-11-05).
-- Apply after migration 202611050008_game_releases.sql. Idempotent: existing versions are left untouched.
insert into public.game_releases (game_id, platform, version, bucket, filename, object_key,
  size_bytes, sha256, executable_path, status, verified_at, verification, published_at, publisher)
values
  ('disco-tiktok-live', 'windows-x64', '2.1.0', 'playlivetiktok-games', 'disco-tiktok-live-windows-x64-2.1.0.zip', 'disco-tiktok-live/2.1.0/disco-tiktok-live-windows-x64-2.1.0.zip',
   107229777, '743be29477183ddf60a47c98047845536d6b21fcd6b113f126b2bc6bf93dc67c', 'Disco Tiktok Live Game.exe',
   'ready', '2026-11-05T18:45:00Z'::timestamptz, '{"source":"E:/PlayLive-Workspace/Releases/R2-2026-11-05/release-manifest.json","remoteSha256":"743be29477183ddf60a47c98047845536d6b21fcd6b113f126b2bc6bf93dc67c","remoteSizeBytes":107229777,"remoteEtag":"4a968bf162172f101209a7b1f808ead6","verifiedAtUtc":"2026-11-05T18:45:00Z","zipStructure":"pass","cleanExtractionAndOfflineLaunch":"pass"}'::jsonb, now(), 'release 2026-11-05 (staging)'),
  ('squid-game-tiktok-live', 'windows-x64', '9.5', 'playlivetiktok-games', 'squid-game-tiktok-live-windows-x64-9.5.zip', 'squid-game-tiktok-live/9.5/squid-game-tiktok-live-windows-x64-9.5.zip',
   102772100, '047f6081fdd1c73837f48ee9b865e2844ec4e9b8cdb4e06eced8ba0d9851d449', 'Squid Game - Tiktok Live game V9.5.exe',
   'ready', '2026-11-05T19:21:34Z'::timestamptz, '{"source":"E:/PlayLive-Workspace/Releases/R2-2026-11-05/release-manifest.json","remoteSha256":"047f6081fdd1c73837f48ee9b865e2844ec4e9b8cdb4e06eced8ba0d9851d449","remoteSizeBytes":102772100,"remoteEtag":"e7ff52153ba9b1b9ef77dcf363485502","verifiedAtUtc":"2026-11-05T19:21:34Z","zipStructure":"pass","cleanExtractionAndOfflineLaunch":"pass"}'::jsonb, now(), 'release 2026-11-05 (staging)')
on conflict (game_id, platform, version) do nothing;

select game_id, version, size_bytes, sha256, executable_path, status from public.game_releases order by game_id;
