// Smoke-test the compiled Next application using fake local-only configuration.
// It cannot authenticate or connect to a real Supabase project.
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

const probe = createServer();
probe.listen(0, '127.0.0.1');
await once(probe, 'listening');
const port = probe.address().port;
await new Promise((resolve) => probe.close(resolve));
const child = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', String(port)], {
  cwd: process.cwd(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1',
    NEXT_PUBLIC_SUPABASE_URL: 'https://points-test.invalid',
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'local-test-publishable-key',
    SUPABASE_SECRET_KEY: 'local-test-secret-key', POINTS_ENABLED: 'true', POINTS_MUTATIONS_ENABLED: 'false' },
});
let output = '';
child.stdout.on('data', (data) => { output += data.toString(); });
child.stderr.on('data', (data) => { output += data.toString(); });
const origin = `http://127.0.0.1:${port}`;
try {
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    if (child.exitCode !== null) throw new Error(`Next exited before readiness: ${output}`);
    try {
      const response = await fetch(`${origin}/faq`, { signal: AbortSignal.timeout(1500) });
      if (response.status === 200) { ready = true; break; }
    } catch { /* Wait for the local server to bind. */ }
    await delay(250);
  }
  assert.ok(ready, `Next failed to start: ${output}`);
  for (const path of ['/api/v1/me/points', '/api/v1/me/points/summary', '/api/v1/me/points/transactions']) {
    const response = await fetch(origin + path);
    assert.equal(response.status, 401, path);
    assert.deepEqual(await response.json(), { error: 'Unauthorized' });
    assert.match(response.headers.get('cache-control'), /no-store/);
    const post = await fetch(origin + path, { method: 'POST', body: JSON.stringify({ amount: '99999' }) });
    assert.equal(post.status, 405, `${path} must not accept mutations`);
    console.log(`PASS ${path}: anonymous 401, no-store, POST 405`);
  }
  const account = await fetch(`${origin}/launcher/account`, { redirect: 'manual' });
  if (account.status === 307) {
    assert.ok(account.headers.get('location').endsWith('/launcher/sign-in'));
  } else {
    // Next may have begun streaming before the server component redirects.
    assert.equal(account.status, 200);
    const html = await account.text();
    assert.ok(/http-equiv="refresh"[^>]*url=\/launcher\/sign-in/i.test(html)
      || html.includes('NEXT_REDIRECT;replace;/launcher/sign-in;307;'), 'Expected a streamed sign-in redirect');
    assert.doesNotMatch(html, /points available/);
  }
  console.log('PASS /launcher/account: signed-out redirect');
  console.log('PASS /faq: production HTTP 200');
} finally {
  child.kill();
  if (child.exitCode === null) await once(child, 'exit');
}
