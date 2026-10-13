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
    SUPABASE_SECRET_KEY: 'local-test-secret-key', POINTS_ENABLED: 'true', POINTS_MUTATIONS_ENABLED: 'false',
    POINTS_ITCH_CHECKOUT_ENABLED: 'false', POINTS_ITCH_CLAIMS_ENABLED: 'false' },
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
  const packs = await fetch(origin + '/api/points/packs');
  assert.equal(packs.status, 200);
  assert.deepEqual(await packs.json(), { packs: [], checkoutEnabled: false });
  assert.match(packs.headers.get('cache-control'), /no-store/);
  const shop = await fetch(origin + '/launcher/points?pack=unconfigured');
  assert.equal(shop.status, 200);
  const shopHtml = await shop.text();
  // The site's client layout initially renders a loading overlay. The streamed
  // route data proves that the real shop (rather than a missing route) resolved.
  assert.ok(shopHtml.includes('selectedPackId') && shopHtml.includes('unconfigured'), 'Expected shop route data');
  assert.doesNotMatch(shopHtml, /seller\.itch\.io|local-test-secret-key/);
  console.log('PASS public packs and /launcher/points: published local routes, no placeholder checkout');
  for (const path of ['/api/v1/me/points/purchases', '/api/points/purchases']) {
    for (const method of ['GET', 'POST']) {
      const response = await fetch(origin + path, { method, ...(method === 'POST' ? {
        headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ packId: 'starter', points: '99999' }),
      } : {}) });
      assert.equal(response.status, 401, `${method} ${path}`);
      assert.match(response.headers.get('cache-control'), /no-store/);
    }
    console.log(`PASS ${path}: protected GET/POST, anonymous 401, no-store`);
  }
  for (const path of ['/api/v1/me/points/checkout', '/api/v1/me/points/claim',
    '/api/v1/me/points/purchases/claim', '/api/points/purchases/claim']) {
    const response = await fetch(origin + path, { method: 'POST', headers: { Origin: origin } });
    assert.equal(response.status, 503, `${path} disabled by default`);
    assert.match(response.headers.get('cache-control'), /no-store/);
    console.log(`PASS ${path}: fail-closed 503`);
  }
  const invalidClaim = await fetch(origin + '/api/points/itch/redeem?jwt=invalid-proof', { redirect: 'manual' });
  assert.equal(invalidClaim.status, 303);
  assert.ok(invalidClaim.headers.get('location').startsWith('/launcher/points/claim?status='));
  assert.doesNotMatch(invalidClaim.headers.get('location'), /jwt|invalid-proof/);
  assert.equal(invalidClaim.headers.get('referrer-policy'), 'no-referrer');
  console.log('PASS redeem callback: token-free redirect, no-referrer');
} finally {
  child.kill();
  if (child.exitCode === null) await once(child, 'exit');
}
