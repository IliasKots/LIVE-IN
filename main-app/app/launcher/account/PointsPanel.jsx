import Link from 'next/link';
import { getPointAccount, listPointTransactions, pointInteger } from '@/lib/points-core.mjs';
import styles from './points.module.css';

const format = (value) => BigInt(value).toLocaleString('en-GB');
const date = (value) => new Intl.DateTimeFormat('en-GB', {
  dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC',
}).format(new Date(value));

export function PointsPanelView({ account, history, unavailable = false, invalidCursor = false, olderPage = false }) {
  return (
    <section className={styles.panel} aria-labelledby="points-heading">
      <div className={styles.heading}>
        <div><span className={styles.eyebrow}>YOUR REWARDS</span><h2 id="points-heading">PlayLive Points</h2></div>
        <a className={styles.button} href="/launcher/account#points-heading">Refresh points</a>
      </div>
      {unavailable ? (
        <p role="status">We couldn&apos;t load your points. Please try again shortly.</p>
      ) : invalidCursor ? (
        <p role="status">This history link is invalid. <Link href="/launcher/account#points-heading">View your latest activity</Link>.</p>
      ) : (
        <>
          <div className={styles.balance}><strong>{format(account.balance)}</strong><span>points available</span></div>
          <dl className={styles.totals}>
            <div><dt>Total credited</dt><dd>{format(account.lifetimeEarned)}</dd></div>
            <div><dt>Total debited</dt><dd>{format(account.lifetimeSpent)}</dd></div>
          </dl>
          <p className={styles.note}>Totals include refunds and account adjustments.</p>
          <button className={styles.button} type="button" disabled>Add points — coming soon</button>
          <div className={styles.activityHeading}><h3>{olderPage ? 'Earlier activity' : 'Recent activity'}</h3><span>Dates shown in UTC</span></div>
          {history.items.length === 0 ? <p className={styles.note}>No points activity yet.</p> : (
            <ul className={styles.activity}>
              {history.items.map((item) => (
                <li key={item.id}>
                  <div><strong>{item.description}</strong><time dateTime={item.createdAt}>{date(item.createdAt)}</time></div>
                  <span className={BigInt(item.amount) > 0n ? styles.credit : styles.debit}>
                    {BigInt(item.amount) > 0n ? '+' : ''}{format(item.amount)}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <nav className={styles.navigation} aria-label="Points history">
            {olderPage && <Link href="/launcher/account#points-heading">Latest activity</Link>}
            {history.nextCursor && <Link href={`/launcher/account?pointsCursor=${encodeURIComponent(history.nextCursor)}#points-heading`}>Older activity →</Link>}
          </nav>
          {account.updatedAt && <p className={styles.note}>Balance updated {date(account.updatedAt)} UTC.</p>}
        </>
      )}
    </section>
  );
}

export default async function PointsPanel({ supabase, userId, cursor = null }) {
  if (cursor !== null) {
    try { pointInteger(cursor, { nonzero: true }); }
    catch { return <PointsPanelView invalidCursor />; }
  }
  let account;
  let history;
  try {
    [account, history] = await Promise.all([
      getPointAccount(supabase, userId), listPointTransactions(supabase, userId, { limit: 10, cursor }),
    ]);
  } catch {
    return <PointsPanelView unavailable />;
  }
  return <PointsPanelView account={account} history={history} olderPage={cursor !== null} />;
}
