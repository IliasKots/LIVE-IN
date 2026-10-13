'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import styles from '../points-shop.module.css';

const messages = {
  PURCHASE_REFUNDED: 'This purchase is blocked from claiming because it was refunded or requires support review.',
  CLAIM_EXPIRED: 'This claim link has expired. Return to your itch.io purchase and try claiming again. If that fails, contact support with your purchase reference.',
  NO_PENDING_CLAIM: 'There is no active purchase claim in this browser. Return to your itch.io purchase and use its claim button.',
  INVALID_PURCHASE: 'We could not verify this purchase. Return to itch.io and try claiming again.',
  UNLINKED_PURCHASE: 'This purchase is not linked to a PlayLive account. Contact support with your itch.io purchase reference.',
  PACK_MISMATCH: 'The purchased pack does not match this checkout. Contact support with your purchase reference.',
  WRONG_ACCOUNT: 'Please sign in to the PlayLive account that started this purchase. Your claim has been saved in this browser.',
  UNAUTHORIZED: 'Sign in to finish adding your points. Your claim has been saved in this browser.',
  CLAIMS_DISABLED: 'Points claiming is temporarily unavailable. Please try again later.',
  PURCHASE_CONFIGURATION_UNAVAILABLE: 'Points claiming is temporarily unavailable. Please try again later.',
  POINT_LIMIT_EXCEEDED: 'This credit would exceed your wallet limit. Contact support with your purchase reference.',
  POINT_IDEMPOTENCY_CONFLICT: 'This purchase has already been recorded with different details. Contact support with your purchase reference.',
  PAYMENT_CURRENCY_MISMATCH: 'The purchase currency did not match this pack. Contact support with your purchase reference.',
  PAYMENT_AMOUNT_MISMATCH: 'The verified payment amount did not meet this pack’s configured price. Contact support with your purchase reference.',
  INVALID_PAYMENT_DETAILS: 'The payment details could not be verified. Contact support with your purchase reference.',
  PAYMENT_NOT_COMPLETE: 'This purchase is not confirmed as completed. Return to itch.io or contact support with your purchase reference.',
  UNKNOWN_PURCHASE_INTENT: 'This purchase could not be linked to its original checkout. Contact support with your purchase reference.',
};

export default function ClaimPoints({ initialStatus = null }) {
  const [state, setState] = useState({ status: initialStatus || 'loading' });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (initialStatus) return;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => {
      controller.abort();
      setState({ status: 'POINTS_UNAVAILABLE' });
    }, 15000);
    async function claim() {
      try {
        const response = await fetch('/api/v1/me/points/claim', { method: 'POST', signal: controller.signal });
        const data = await response.json();
        if (!controller.signal.aborted) setState(response.ok ? { status: 'success', ...data } : { status: data.error || 'POINTS_UNAVAILABLE' });
      } catch {
        if (!controller.signal.aborted) setState({ status: 'POINTS_UNAVAILABLE' });
      } finally {
        window.clearTimeout(timeout);
      }
    }
    claim();
    return () => { window.clearTimeout(timeout); controller.abort(); };
  }, [attempt, initialStatus]);

  const success = state.status === 'success';
  const loginNeeded = ['UNAUTHORIZED', 'WRONG_ACCOUNT'].includes(state.status);
  return (
    <section className={styles.shop} aria-labelledby="claim-title">
      <span className={styles.eyebrow}>PLAYLIVE POINTS</span>
      <h1 id="claim-title">{success ? (state.duplicate ? 'Points already added' : 'Your points are ready') : 'Claim your points'}</h1>
      <div role="status" aria-live="polite">
        {success ? <><p>{state.duplicate ? 'This purchase has already been credited to your account.' : `${BigInt(state.points).toLocaleString('en-GB')} points have been added to your wallet.`}</p><p className={styles.balance}>Current balance: <strong>{BigInt(state.balance).toLocaleString('en-GB')} points</strong></p><p>Return to the launcher; your balance and history refresh automatically when it regains focus.</p></>
          : <p>{state.status === 'loading' ? 'Verifying your purchase and updating your wallet…' : messages[state.status] || 'We could not add your points right now. Please retry; your purchase will only be credited once.'}</p>}
      </div>
      <div className={styles.actions}>
        {loginNeeded && <Link className={styles.primary} href="/launcher/sign-in?returnTo=%2Flauncher%2Fpoints%2Fclaim">Sign in to claim</Link>}
        {state.status === 'WRONG_ACCOUNT' && <form action="/api/auth/sign-out" method="POST"><button className={styles.secondary} type="submit">Sign out of this account</button></form>}
        {!initialStatus && !success && state.status !== 'loading' && <button className={styles.secondary} type="button" onClick={() => { setState({ status: 'loading' }); setAttempt((value) => value + 1); }}>Retry claim</button>}
        <Link href="/launcher/account#points-heading">View my wallet</Link>
        <Link href="/launcher/points">Points packs</Link>
      </div>
    </section>
  );
}
