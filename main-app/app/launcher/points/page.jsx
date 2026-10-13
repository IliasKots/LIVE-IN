import { createClient } from '@/lib/supabase/server';
import { getPointAccount } from '@/lib/points-core.mjs';
import { pointsEnabled } from '@/lib/points';
import { getPublicItchPacks } from '@/lib/points-itch';
import PointsShop from './PointsShop';
import styles from './points-shop.module.css';
import { PURCHASE_UUID } from '@/lib/points-purchases-core.mjs';

export const dynamic = 'force-dynamic';
export default async function PointsPage({ searchParams }) {
  const params = await searchParams;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  let balance = null;
  if (user && pointsEnabled()) {
    try { balance = (await getPointAccount(supabase, user.id)).balance; } catch { /* A failed read must not display a false zero. */ }
  }
  return <main className={styles.page}><PointsShop packs={getPublicItchPacks()} signedIn={Boolean(user?.email_confirmed_at)} balance={balance}
    selectedPackId={typeof params?.pack === 'string' ? params.pack : null}
    selectedIntentId={typeof params?.intent === 'string' && PURCHASE_UUID.test(params.intent) ? params.intent : null}
    autoCheckout={params?.checkout === '1'} /></main>;
}
