import ClaimPoints from './ClaimPoints';
import styles from '../points-shop.module.css';

export const dynamic = 'force-dynamic';
export const metadata = { robots: { index: false, follow: false }, referrer: 'no-referrer' };
export default async function ClaimPage({ searchParams }) {
  const params = await searchParams;
  const allowed = ['CLAIM_EXPIRED', 'INVALID_PURCHASE', 'UNLINKED_PURCHASE', 'PACK_MISMATCH', 'CLAIMS_DISABLED', 'PURCHASE_CONFIGURATION_UNAVAILABLE', 'POINTS_UNAVAILABLE', 'PURCHASE_REFUNDED'];
  const status = typeof params?.status === 'string' && allowed.includes(params.status) ? params.status : null;
  return <main className={styles.page}><ClaimPoints initialStatus={status} /></main>;
}
