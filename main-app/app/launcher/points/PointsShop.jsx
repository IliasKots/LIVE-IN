'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import Image from 'next/image';
import styles from './points-shop.module.css';
import { pollPointPurchase } from '@/lib/points-purchase-poll.mjs';
import { pointPackArtwork } from '@/lib/points-pack-art.mjs';

export default function PointsShop({ packs, signedIn, balance = null, selectedPackId = null,
  selectedIntentId = null, autoCheckout = false }) {
  const router = useRouter();
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(null);
  const [message, setMessage] = useState('');
  const [purchaseStarted, setPurchaseStarted] = useState(Boolean(selectedIntentId && !autoCheckout));
  const autoStarted = useRef(false);
  const [intentId, setIntentId] = useState(selectedIntentId);
  const [checkoutPackId, setCheckoutPackId] = useState(selectedPackId);
  const [checking, setChecking] = useState(false);
  const watcher = useRef(null);

  function checkPurchase() {
    if (!signedIn || !intentId) return;
    if (watcher.current) void watcher.current.check();
    else setPurchaseStarted(true);
  }

  useEffect(() => {
    if (!purchaseStarted || !signedIn || !intentId) return;
    const poll = pollPointPurchase({
      visible: () => document.visibilityState === 'visible', onBusy: setChecking,
      onError: () => setMessage('Purchase confirmation unavailable. Sign in or check again when connected.'),
      onPending: () => { setPurchaseStarted(false); setMessage('Confirmation still pending. Use the itch.io claim button after payment, then check again.'); },
      read: async (signal) => {
        // Resume only already verified evidence saved by the redeem endpoint.
        // Browser closure and a pending intent cannot establish payment.
        const response = await fetch('/api/points/purchases/claim', { method: 'POST', signal,
          headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ intentId }), cache: 'no-store' });
        const data = await response.json();
        if (signal.aborted) return false;
        if (response.status === 401) router.refresh();
        if (!response.ok || data.purchase?.id !== intentId) throw new Error('Receipt unavailable');
        const purchase = data.purchase;
        if (purchase.status === 'pending') return false;
        if (!['credited', 'refunded'].includes(purchase.status)
          || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(purchase.transactionId)) throw new Error('Invalid receipt');
        setMessage(purchase.status === 'credited' ? 'Points added. Your purchase has been credited to your PlayLive account.'
          : 'This purchase was reversed. Contact support with your itch.io purchase reference.');
        setPurchaseStarted(false); router.refresh(); return true;
      },
    });
    watcher.current = poll;
    const refresh = () => { void poll.check(); };
    window.addEventListener('focus', refresh);
    return () => { window.removeEventListener('focus', refresh); poll.stop(); watcher.current = null; };
  }, [purchaseStarted, signedIn, intentId, router]);

  // Only a launcher-created, account-bound intent may continue without a second
  // Buy click. Navigation in this already-open browser window avoids popup blocking.
  useEffect(() => {
    if (!signedIn || !autoCheckout || !selectedIntentId || autoStarted.current
      || !packs.some((pack) => pack.id === selectedPackId)) return;
    autoStarted.current = true;
    buy(selectedPackId, true);
    // The intent is immutable for this page visit; do not restart after polling refreshes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signedIn, autoCheckout, selectedIntentId, selectedPackId]);

  async function buy(packId, sameWindow = false) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(packId); setMessage('');
    setCheckoutPackId(packId); setPurchaseStarted(false);
    setIntentId(selectedIntentId && packId === selectedPackId ? selectedIntentId : null);
    const width = Math.min(650, window.screen.availWidth || 650);
    const height = Math.min(520, window.screen.availHeight || 520);
    const left = Math.max(0, window.screenX + (window.outerWidth - width) / 2);
    const top = Math.max(0, window.screenY + (window.outerHeight - height) / 2);
    let popup;
    try {
      // Reserve the window during the click; awaiting checkout first gets blocked.
      if (!sameWindow) popup = window.open('/launcher/points/checkout', '_blank',
        `popup=yes,width=${width},height=${height},left=${Math.round(left)},top=${Math.round(top)},resizable=yes,scrollbars=yes`);
      if (popup) popup.opener = null;
      const response = await fetch('/api/v1/me/points/checkout', { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ packId,
          ...(selectedIntentId && packId === selectedPackId ? { intentId: selectedIntentId } : {}) }), signal: AbortSignal.timeout(15000) });
      const data = await response.json();
      if (response.status === 401) router.refresh();
      if (!response.ok) throw new Error(data.error === 'UNAUTHORIZED'
        ? 'Please sign in again before buying points.' : ['UNKNOWN_PURCHASE_INTENT', 'WRONG_ACCOUNT'].includes(data.error)
          ? 'Sign in to the PlayLive account that started this purchase. The selected pack has been preserved.'
          : 'Checkout is temporarily unavailable. Please try again.');
      setIntentId(data.intentId);
      if (data.alreadyCredited) {
        if (popup && !popup.closed) popup.close();
        setPurchaseStarted(false); setMessage('Points added. This purchase has already been credited.'); router.refresh(); return;
      }
      if (typeof data.url !== 'string') throw new Error('Checkout is temporarily unavailable.');
      if (popup && !popup.closed) { popup.location.replace(data.url); popup.focus(); }
      else { window.location.assign(data.url); }
      setPurchaseStarted(true);
      setMessage('Complete payment on itch.io, then use its claim button to add your points.');
    } catch (error) {
      if (popup && !popup.closed) popup.close();
      setMessage(error.name === 'TimeoutError' ? 'Checkout took too long. Please try again.'
        : error.message || 'Could not open checkout. Please try again.');
    } finally { busyRef.current = false; setBusy(null); }
  }

  return (
    <section className={styles.shop} aria-labelledby="buy-points-title">
      <span className={styles.eyebrow}>PLAYLIVE POINTS</span>
      <h1 id="buy-points-title">Add points to your wallet</h1>
      <p>Choose a pack, pay on itch.io, then claim your points for your PlayLive account.</p>
      {balance !== null && <p className={styles.balance}>Your balance: <strong>{BigInt(balance).toLocaleString('en-GB')} points</strong></p>}
      {!signedIn && <p><Link className={styles.primary} href={`/launcher/sign-in?returnTo=${encodeURIComponent('/launcher/points'
        + (packs.some((pack) => pack.id === checkoutPackId) ? `?pack=${encodeURIComponent(checkoutPackId)}`
          + (intentId ? `&intent=${encodeURIComponent(intentId)}&checkout=${autoCheckout ? '1' : '0'}` : '') : ''))}`}>Sign in to buy points</Link></p>}
      {packs.length === 0 ? <div className={styles.notice} role="status">Points packs will be available here soon.</div> : (
        <div className={styles.packs}>
          {[...packs].sort((a, b) => Number(b.id === selectedPackId) - Number(a.id === selectedPackId)).map((pack) => (
            <article className={styles.pack} key={pack.id} aria-label={pack.id === selectedPackId ? `${pack.name} — selected in launcher` : pack.name}>
              {pack.id === selectedPackId && <small>Selected in your launcher</small>}
              {pointPackArtwork(pack) && <Image className={styles.artwork}
                src={pointPackArtwork(pack)} alt="" width={2086} height={754}
                sizes="(max-width: 640px) 90vw, 800px" />}
              <h2>{pack.name}</h2>
              <strong className={styles.amount}>{BigInt(pack.points).toLocaleString('en-GB')}</strong>
              <span>PlayLive points</span>
              <p>{pack.priceLabel || 'Price shown at checkout'}{pack.currency ? ` (${pack.currency})` : ''}</p>
              <button className={styles.primary} type="button" disabled={!signedIn || busy !== null} onClick={() => buy(pack.id)}>
                {busy === pack.id ? 'Opening checkout…' : 'Buy points'}
              </button>
              <small>Secure checkout on itch.io</small>
            </article>
          ))}
        </div>
      )}
      {message && <p role="status" className={styles.notice}>{message}</p>}
      {selectedIntentId && !autoCheckout && <div className={styles.notice} role="status">
        <p>If you already paid, return to your itch.io purchase receipt and use its claim button. Avoid paying again for that order.</p>
        <Link href="/launcher/points/claim">Continue a saved purchase claim</Link>
        <p>If no claim is available or the link has expired, contact PlayLive support with your itch.io purchase reference.</p>
      </div>}
      {signedIn && intentId && <button type="button" className={styles.secondary} disabled={checking}
        onClick={checkPurchase}>{checking ? 'Checking confirmation…' : 'Check purchase again'}</button>}
      <div className={styles.actions}>
        <Link href="/launcher/account#points-heading">Back to my account</Link>
        {signedIn && <button type="button" className={styles.secondary} onClick={() => router.refresh()}>Refresh balance</button>}
      </div>
    </section>
  );
}
