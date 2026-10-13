import styles from '../points-shop.module.css';

export default function CheckoutLoadingPage() {
  return <main className={styles.page}><section className={styles.shop} role="status"><h1>Opening itch.io checkout…</h1><p>Please keep this window open.</p></section></main>;
}
