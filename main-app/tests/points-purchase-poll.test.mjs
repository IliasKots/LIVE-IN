import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pollPointPurchase } from '../lib/points-purchase-poll.mjs';

const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function clock() {
  let time = 0, id = 0;
  const tasks = new Map();
  return {
    now: () => time,
    schedule: (callback, wait) => { tasks.set(++id, { callback, at: time + wait }); return id; },
    clear: (key) => tasks.delete(key),
    async advance(to) {
      await settle();
      for (;;) {
        const task = [...tasks].filter(([, value]) => value.at <= to).sort((a, b) => a[1].at - b[1].at)[0];
        if (!task) break;
        time = task[1].at; tasks.delete(task[0]); task[1].callback(); await settle();
      }
      time = to; await settle();
    },
  };
}
test('delayed server credit is checked serially and stops further reads', async () => {
  const timer = clock(); let requests = 0, confirmed = 0, pending = 0;
  const poll = pollPointPurchase({ ...timer, durationMs: 120, intervalMs: 5, requestTimeoutMs: 15,
    read: async () => { requests++; if (requests === 3) { confirmed++; return true; } return false; },
    onPending: () => pending++ });
  await timer.advance(100);
  assert.equal(requests, 3); assert.equal(confirmed, 1); assert.equal(pending, 0);
  await poll.check(); assert.equal(requests, 3); poll.stop();
});
test('focus and repeated checks do not overlap an outstanding confirmation request', async () => {
  const timer = clock(); let finish, requests = 0;
  const poll = pollPointPurchase({ ...timer, read: () => { requests++; return new Promise((resolve) => { finish = resolve; }); } });
  await Promise.all([poll.check(), poll.check(), poll.check()]);
  assert.equal(requests, 1); finish(false); await settle(); poll.stop();
});
test('unanswered requests and offline errors remain bounded without a false credit', async () => {
  const timer = clock(); let signal, pending = 0, errors = 0;
  pollPointPurchase({ ...timer, durationMs: 20, intervalMs: 5, requestTimeoutMs: 7,
    read: (value) => { signal = value; return new Promise(() => {}); },
    onError: () => errors++, onPending: () => pending++ });
  await timer.advance(25);
  assert.ok(signal.aborted); assert.equal(errors, 2); assert.equal(pending, 1);
});
test('logout/account-change cancellation suppresses a late transport response', async () => {
  const timer = clock(); let signal, finish, pending = 0, errors = 0;
  const poll = pollPointPurchase({ ...timer, durationMs: 20,
    read: (value) => { signal = value; return new Promise((resolve) => { finish = resolve; }); },
    onError: () => errors++, onPending: () => pending++ });
  poll.stop(); assert.ok(signal.aborted); finish(true); await timer.advance(100);
  assert.equal(pending, 0); assert.equal(errors, 0);
});
test('hidden checkout waits for focus, and a fresh watcher can recover a credited receipt', async () => {
  const timer = clock(); let visible = false, reads = 0;
  const poll = pollPointPurchase({ ...timer, visible: () => visible, read: async () => { reads++; return true; } });
  assert.equal(reads, 0); visible = true; await poll.check(); assert.equal(reads, 1);
  await timer.advance(130000); assert.equal(reads, 1);
});
