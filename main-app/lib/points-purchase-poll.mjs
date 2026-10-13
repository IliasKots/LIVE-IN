// One receipt read at a time, bounded even if a transport ignores cancellation.
// A caller returns true only for a confirmed terminal server receipt.
export function pollPointPurchase({ read, onError = () => {}, onPending = () => {}, onBusy = () => {},
  visible = () => true, durationMs = 120000, intervalMs = 5000, requestTimeoutMs = 15000,
  now = Date.now, schedule = setTimeout, clear = clearTimeout }) {
  const deadline = now() + durationMs;
  let stopped = false, running = false, next, active;
  const stop = () => {
    stopped = true; clear(next); clear(end); active?.abort(); onBusy(false);
  };
  const end = schedule(() => { if (!stopped) { stop(); onPending(); } }, durationMs);
  async function check() {
    if (stopped || running || !visible() || now() >= deadline) return;
    clear(next); running = true; onBusy(true);
    const controller = new AbortController(); active = controller;
    let timeout;
    const expired = new Promise((_, reject) => {
      timeout = schedule(() => { controller.abort(); reject(new Error('Confirmation request timed out.')); },
        Math.min(requestTimeoutMs, deadline - now()));
    });
    try {
      const terminal = await Promise.race([read(controller.signal), expired]);
      if (!stopped && !controller.signal.aborted && terminal) stop();
    } catch (error) { if (!stopped) onError(error); }
    finally {
      clear(timeout); active = null; running = false;
      if (!stopped) {
        onBusy(false);
        next = schedule(check, Math.min(intervalMs, Math.max(0, deadline - now())));
      }
    }
  }
  void check();
  return { check, stop };
}
