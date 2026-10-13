import { notFound } from 'next/navigation';
import { isMockPaymentsAllowed } from '@/lib/points-lemonsqueezy';
import MockCheckout from './MockCheckout';
import styles from '../points-shop.module.css';

// DEVELOPMENT ONLY. 404 on any deployment where mock payments are not allowed.
export const dynamic = 'force-dynamic';
export const metadata = { title: 'MOCK checkout — PlayLive', robots: { index: false, follow: false }, referrer: 'no-referrer' };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export default async function MockCheckoutPage({ searchParams }) {
  if (!isMockPaymentsAllowed()) notFound();
  const params = await searchParams;
  const order = typeof params?.order === 'string' && UUID.test(params.order) ? params.order : null;
  const token = typeof params?.token === 'string' && /^[\w-]{43}$/.test(params.token) ? params.token : null;
  if (!order || !token) notFound();
  return <main className={styles.page}><MockCheckout orderId={order} token={token} /></main>;
}
