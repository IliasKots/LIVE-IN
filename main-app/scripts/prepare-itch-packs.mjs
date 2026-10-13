// Prints non-secret, server-authoritative configuration. Does not contact itch.io,
// open checkout, write .env files, or enable any gate. Never pass credentials here.
import { configuredPlayLivePacks } from '../lib/points-catalog.mjs';

try {
  const args = process.argv.slice(2);
  if (!args.length) throw new Error();
  const entries = args.map((arg) => {
    const match = /^(starter|regular|pro|max|ultimate)=([1-9]\d{0,19})$/.exec(arg);
    if (!match) throw new Error();
    return [match[1], match[2]];
  });
  if (new Set(entries.map(([id]) => id)).size !== entries.length) throw new Error();
  const ids = Object.fromEntries(entries);
  const packs = configuredPlayLivePacks(ids);
  console.log(`ITCH_POINTS_PRODUCT_IDS_JSON=${JSON.stringify(ids)}`);
  console.log('ITCH_POINTS_PACKS_JSON=[]');
  console.table(packs.map(({ name, points, priceLabel, subProductId }) => ({ name, points, price: priceLabel, subProductId })));
  console.log('All checkout/claim flags remain unchanged. Verify the dashboard and staging fulfillment before enabling real checkout.');
} catch {
  console.error('Usage: node scripts/prepare-itch-packs.mjs starter=ACTUAL_NUMERIC_ID [regular=ID pro=ID max=ID ultimate=ID]');
  console.error('Use distinct real dashboard sub-product IDs. No project/main-product ID, prices, amounts or secrets.');
  process.exitCode = 1;
}
