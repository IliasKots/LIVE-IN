import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';

const probe = createServer();
probe.listen(0, '127.0.0.1');
await once(probe, 'listening');
const port = probe.address().port;
await new Promise((resolve) => probe.close(resolve));
const origin = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ['scripts/preview-points.mjs'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, NODE_ENV: 'development', POINTS_PREVIEW_PORT: String(port) } });
let output = '';
child.stdout.on('data', (data) => { output += data; });
child.stderr.on('data', (data) => { output += data; });
try {
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    if (child.exitCode !== null) throw new Error(output);
    try { const response = await fetch(`${origin}/launcher/points`); if (response.ok) { ready = true; break; } } catch { /* Server not bound yet. */ }
    await delay(100);
  }
  assert.ok(ready, output);
  const post = (path, body, cookie = null) => fetch(origin + path, { method: 'POST', redirect: 'manual',
    headers: { Origin: origin, 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body === null ? null : JSON.stringify(body) });
  async function purchase() {
    const checkout = await post('/api/v1/me/points/checkout', { packId: 'starter' });
    assert.equal(checkout.status, 200);
    const details = await checkout.json();
    const paymentUrl = new URL(details.url);
    const pending = await fetch(origin + '/api/v1/me/points/purchases?intent=' + details.intentId);
    assert.equal((await pending.json()).purchase.status, 'pending', 'Checkout intent is not a paid receipt');
    assert.equal(paymentUrl.origin, origin, 'Demo must never navigate to a real payment provider');
    const paid = await fetch(origin + '/demo/pay', { method: 'POST', redirect: 'manual',
      body: new URLSearchParams({ metadata: paymentUrl.searchParams.get('metadata') }) });
    assert.equal(paid.status, 303);
    const redeem = await fetch(origin + paid.headers.get('location'), { redirect: 'manual' });
    assert.equal(redeem.status, 303);
    assert.equal(redeem.headers.get('location'), '/launcher/points/claim');
    return { cookie: redeem.headers.get('set-cookie').split(';')[0], intentId: details.intentId };
  }
  const abandoned = await post('/api/v1/me/points/checkout', { packId: 'starter' });
  assert.equal(abandoned.status, 200);
  const abandonedId = (await abandoned.json()).intentId;
  const stillPending = await fetch(origin + '/api/v1/me/points/purchases?intent=' + abandonedId);
  assert.equal((await stillPending.json()).purchase.status, 'pending');
  const untouched = await fetch(origin + '/launcher/points');
  assert.ok((await untouched.text()).includes('"balance":"0"'), 'Abandoned checkout must not credit points');
  console.log('PASS abandoned simulated checkout: wallet remains zero');
  const { cookie, intentId } = await purchase();
  const recoveredWithoutCookie = await post('/api/v1/me/points/purchases/claim',
    { intentId, points: '999999', paid: true });
  assert.equal(recoveredWithoutCookie.status, 200);
  assert.equal((await recoveredWithoutCookie.json()).purchase.status, 'credited');
  const first = await post('/api/v1/me/points/claim', null, cookie);
  assert.equal(first.status, 200);
  assert.equal((await first.json()).balance, '5000');
  for (const route of ['/api/points/purchases', '/api/v1/me/points/purchases']) {
    const recovered = await fetch(origin + route + '?intent=' + intentId);
    const receipt = (await recovered.json()).purchase;
    assert.equal(receipt.id, intentId); assert.equal(receipt.status, 'credited'); assert.ok(receipt.transactionId);
    assert.equal(receipt.points, '5000'); assert.equal(receipt.userId, undefined);
  }
  const repeated = await post('/api/v1/me/points/claim', null, cookie);
  const result = await repeated.json();
  assert.equal(result.duplicate, true); assert.equal(result.balance, '5000');
  const { cookie: secondCookie } = await purchase();
  const second = await post('/api/v1/me/points/claim', null, secondCookie);
  assert.equal((await second.json()).balance, '10000');
  console.log('PASS local HTTP flow: unpaid intent, simulated payment, saved evidence, cookie-free recovery, clean claim, duplicate retry, second purchase');
} finally {
  child.kill();
  if (child.exitCode === null) await once(child, 'exit');
}
