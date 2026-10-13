// Read-only operator check for Lemon Squeezy points configuration. Run on the
// private server/workstation with that environment's settings loaded:
//   node --env-file=.env.local scripts/verify-lemonsqueezy-config.mjs
// It only performs GET requests to the Lemon Squeezy API. It never creates a
// checkout, changes the store, touches the database or prints the API key.
// Set LEMONSQUEEZY_PRODUCTS_VERIFIED=true only after every check reports ok.
//
// Discovery (also GET-only), when the variant IDs are not known yet:
//   node --env-file=.env.local scripts/verify-lemonsqueezy-config.mjs --discover
// needs only LEMONSQUEEZY_API_KEY (test mode) and LEMONSQUEEZY_STORE_ID. It lists the
// store's products/variants with their public checkout links and PROPOSES
// LEMONSQUEEZY_VARIANT_IDS_JSON only when each pack matches exactly one variant by
// name and price. A person must confirm the proposal in the dashboard before using it.
import { readLemonSqueezyConfig, LEMONSQUEEZY_API, proposeVariantIds } from '../lib/points-lemonsqueezy-core.mjs';

// Ignore the products-verified/mutation gates here: this script is how they are earned.
const config = readLemonSqueezyConfig({ ...process.env, LEMONSQUEEZY_PRODUCTS_VERIFIED: 'true',
  POINTS_ENABLED: 'true', POINTS_MUTATIONS_ENABLED: 'true' });
const checks = [];
const check = (name, ok, detail = '') => { checks.push({ name, ok: Boolean(ok), ...(detail ? { detail } : {}) }); return ok; };

async function read(path) {
  const response = await fetch(`${LEMONSQUEEZY_API}${path}`, { redirect: 'error', signal: AbortSignal.timeout(15000),
    headers: { Accept: 'application/vnd.api+json', Authorization: `Bearer ${config.apiKey}` } });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${path.split('?')[0]}`);
  return response.json();
}

async function discover() {
  const storeId = (process.env.LEMONSQUEEZY_STORE_ID || '').trim();
  config.apiKey = config.apiKey || (process.env.LEMONSQUEEZY_API_KEY || '').trim();
  if (!config.apiKey) throw new Error('LEMONSQUEEZY_API_KEY is missing.');
  if (!/^[1-9]\d{0,19}$/.test(storeId)) throw new Error('LEMONSQUEEZY_STORE_ID is missing or not numeric.');
  const store = (await read(`/stores/${storeId}`)).data?.attributes;
  const products = (await read(`/products?filter[store_id]=${storeId}&page[size]=100`)).data ?? [];
  const listed = [];
  for (const product of products) {
    const variants = (await read(`/variants?filter[product_id]=${product.id}&page[size]=100`)).data ?? [];
    listed.push({ productId: product.id, name: product.attributes?.name, status: product.attributes?.status,
      testMode: product.attributes?.test_mode, checkoutLink: product.attributes?.buy_now_url,
      variants: variants.map((variant) => ({ variantId: variant.id, name: variant.attributes?.name,
        price: String(variant.attributes?.price), status: variant.attributes?.status,
        subscription: variant.attributes?.is_subscription === true,
        payWhatYouWant: variant.attributes?.pay_what_you_want === true })) });
  }
  const { proposal, problems } = proposeVariantIds(listed);
  console.log(JSON.stringify({ store: { id: storeId, name: store?.name, currency: store?.currency }, products: listed,
    proposedVariantIds: problems.length ? null : proposal, partialProposal: proposal, problems,
    next: problems.length ? 'Resolve the problems in the Lemon Squeezy dashboard, then run --discover again.'
      : 'Confirm each product, variant and checkout link in the dashboard, set LEMONSQUEEZY_VARIANT_IDS_JSON to '
        + 'proposedVariantIds, then run this script without --discover.' }, null, 2));
  if (problems.length) process.exitCode = 1;
}

const discovering = process.argv.includes('--discover');
if (discovering) {
  try { await discover(); }
  catch (error) { console.log(JSON.stringify({ ok: false, error: error.message }, null, 2)); process.exitCode = 1; }
} else try {
  check('configuration', config.state === 'ready', config.state === 'ready' ? '' : `missing: ${config.missing.join(', ') || '-'}; invalid: ${config.problems.join(', ') || '-'}`);
  if (config.provider === 'mock') throw new Error('LEMONSQUEEZY_MODE=mock has no Lemon Squeezy account to verify.');
  if (config.state !== 'ready') throw new Error('Fix configuration first.');
  const store = (await read(`/stores/${config.storeId}`)).data;
  check('store exists', store?.id === config.storeId, store?.attributes?.name);
  check('store currency is USD (catalog currency)', store?.attributes?.currency === 'USD', store?.attributes?.currency);
  for (const pack of config.packs) {
    const variant = (await read(`/variants/${pack.variantId}`)).data?.attributes;
    const label = `${pack.id} → variant ${pack.variantId}`;
    if (!check(`${label}: variant exists`, variant)) continue;
    check(`${label}: variant is ${config.environment === 'test' ? 'a test-mode' : 'a live'} object`, variant.test_mode === (config.environment === 'test'));
    check(`${label}: published`, variant.status === 'published' || variant.status === 'pending', variant.status);
    const product = (await read(`/products/${variant.product_id}`)).data?.attributes;
    check(`${label}: product belongs to store ${config.storeId}`, String(product?.store_id) === config.storeId);
    const prices = (await read(`/prices?filter[variant_id]=${pack.variantId}`)).data ?? [];
    // Lemon Squeezy keeps every earlier price of a variant; the current one is the newest.
    const price = prices.map((value) => value.attributes).filter(Boolean)
      .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0];
    check(`${label}: one-time standard price`, price?.category === 'one_time' && price?.scheme === 'standard', `${price?.category}/${price?.scheme}`);
    check(`${label}: not pay-what-you-want or subscription`, variant.pay_what_you_want !== true && variant.is_subscription !== true);
    check(`${label}: price ${pack.priceLabel} (${pack.priceMinor} cents)`, String(price?.unit_price ?? variant.price) === pack.priceMinor,
      `Lemon Squeezy: ${price?.unit_price ?? variant.price}`);
  }
} catch (error) {
  check('verification completed', false, error.message);
}
if (!discovering) {
  const ok = checks.every((value) => value.ok);
  console.log(JSON.stringify({ mode: config.mode, storeId: config.storeId, packs: config.packs.map((pack) => pack.id), checks, ok }, null, 2));
  if (!ok) process.exitCode = 1;
}
