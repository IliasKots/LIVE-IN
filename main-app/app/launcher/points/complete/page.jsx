import styles from '../points-shop.module.css';

// Return page after Lemon Squeezy checkout. It NEVER credits points: delivery
// happens only through the signed webhook, so this page needs no sign-in.
export const dynamic = 'force-static';
export const metadata = { title: 'Payment submitted — PlayLive', robots: { index: false, follow: false }, referrer: 'no-referrer' };
export default function PointsCheckoutCompletePage() {
  return <main className={styles.page}>
    <section className={styles.shop} aria-labelledby="complete-title">
      <span className={styles.eyebrow}>PLAYLIVE POINTS</span>
      <h1 id="complete-title">Thanks — you can return to PlayLive</h1>
      <p>Your points are added to your PlayLive account automatically as soon as the payment is confirmed,
        usually within a minute. You can close this window; closing it does not affect delivery.</p>
      <p className={styles.notice}>No code or claim step is needed. If your balance has not updated after a few
        minutes, keep your order receipt email and contact PlayLive support.</p>
    </section>
  </main>;
}
