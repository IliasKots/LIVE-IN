'use client';

import { useState } from 'react';
import styles from '../points-shop.module.css';

const results = {
  paid: 'Mock payment confirmed. The order went through the signed webhook delivery path; return to the launcher.',
  duplicate: 'This mock order was already delivered. No additional points were added.',
  failed: 'Mock failed payment sent. No points were added.',
  cancelled: 'Mock checkout cancelled. No payment was simulated. You can close this window.',
};

export default function MockCheckout({ orderId, token }) {
  const [state, setState] = useState({ status: 'idle' });
  async function send(outcome) {
    setState({ status: 'busy' });
    try {
      const response = await fetch('/api/dev/points/mock-checkout', { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ orderId, token, outcome }) });
      const data = await response.json();
      if (!response.ok) return setState({ status: 'error', code: data.error || 'POINTS_UNAVAILABLE' });
      setState({ status: data.credited ? (data.duplicate ? 'duplicate' : 'paid') : outcome === 'failed' ? 'failed' : 'error', code: data.reason });
    } catch { setState({ status: 'error', code: 'POINTS_UNAVAILABLE' }); }
  }
  const finished = ['paid', 'duplicate', 'failed', 'cancelled'].includes(state.status);
  return (
    <section className={styles.shop} aria-labelledby="mock-title">
      <p className={styles.notice} role="note"><strong>MOCK CHECKOUT — development only.</strong> No money is charged and
        this is not a Lemon Squeezy sandbox test. It works only against local/staging test wallets.</p>
      <span className={styles.eyebrow}>PLAYLIVE POINTS · MOCK PROVIDER</span>
      <h1 id="mock-title">Simulated checkout</h1>
      <p>Order reference: <code>{orderId}</code></p>
      <div role="status" aria-live="polite">
        {finished && <p>{results[state.status]}</p>}
        {state.status === 'error' && <p>Mock delivery was not credited ({state.code}).</p>}
      </div>
      {!finished && <div className={styles.actions}>
        <button className={styles.primary} type="button" disabled={state.status === 'busy'} onClick={() => send('paid')}>Pay (mock)</button>
        <button className={styles.secondary} type="button" disabled={state.status === 'busy'} onClick={() => send('failed')}>Simulate failed payment</button>
        <button className={styles.secondary} type="button" disabled={state.status === 'busy'} onClick={() => setState({ status: 'cancelled' })}>Cancel</button>
      </div>}
    </section>
  );
}
