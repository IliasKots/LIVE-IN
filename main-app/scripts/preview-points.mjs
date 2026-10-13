// Isolated visual demo. No real credentials, Supabase access or payment requests.
import { createServer } from 'node:http';
import { createHmac, randomUUID } from 'node:crypto';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { configuredPlayLivePacks } from '../lib/points-catalog.mjs';
import { createPointsDeliveryHandler } from '../lib/points-delivery-http.mjs';
import { readItchConfig, publicItchPacks } from '../lib/points-itch-core.mjs';
import { createItchCheckoutHandler, createItchRedeemHandler, createItchClaimHandler } from '../lib/points-itch-http.mjs';
import { createPointsPurchasesHandler } from '../lib/points-purchases-http.mjs';

if (process.env.NODE_ENV === 'production') throw new Error('The demo is for local development only.');
const port = Number(process.env.POINTS_PREVIEW_PORT || '4178');
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid local preview port.');
const origin = `http://127.0.0.1:${port}`;
const secret = 'local-visual-demo-secret-not-a-real-itch-secret';
const userId = '11111111-1111-4111-8111-111111111111';
const config = readItchConfig({ NODE_ENV: 'development', POINTS_ENABLED: 'true', POINTS_MUTATIONS_ENABLED: 'true',
  POINTS_DEPLOYMENT_ENVIRONMENT: 'local', ITCH_POINTS_PRODUCTS_VERIFIED: 'true',
  POINTS_ITCH_CHECKOUT_ENABLED: 'true', POINTS_ITCH_CLAIMS_ENABLED: 'true', POINTS_SITE_ORIGIN: origin,
  ITCH_POINTS_PROJECT_URL: 'https://demo.itch.io/points', ITCH_POINTS_REDEEM_SECRET: secret,
  ITCH_POINTS_PACKS_JSON: JSON.stringify(configuredPlayLivePacks({ starter: '101', regular: '102', pro: '103', max: '104', ultimate: '105' })) });
let balance = 0n;
let purchaseId = 1;
const credits = new Map();
const intents = new Map();
const receipts = new Map();
const verified = new Map();
const client = { async rpc(name, args) {
  if (name === 'remember_verified_point_purchase') {
    const previous = verified.has(args.p_claim.purchaseId);
    verified.set(args.p_claim.purchaseId, args.p_claim);
    return { data: { duplicate: previous } };
  }
  if (name === 'get_verified_point_purchase') return { data: [...verified.values()]
    .find((item) => item.intentId === args.p_intent_id && item.userId === args.p_user_id) ?? null };
  if (name === 'create_point_purchase_intent') {
    const id = randomUUID();
    intents.set(id, { id, userId: args.p_user_id, packId: args.p_pack_id, name: args.p_pack_name,
      points: args.p_points, projectUrl: args.p_project_url, subProductId: args.p_sub_product_id,
      priceLabel: args.p_price_label, currency: args.p_currency, priceMinor: args.p_price_minor,
      createdAt: new Date().toISOString(), status: 'pending', transactionId: null, purchaseId: null, creditedAt: null });
    return { data: { id } };
  }
  if (name === 'get_point_purchase') {
    const intent = args.p_intent_id ? intents.get(args.p_intent_id) : [...intents.values()].filter((item) => item.userId === args.p_user_id).at(-1);
    return { data: intent?.userId === args.p_user_id ? intent : null };
  }
  if (name === 'credit_point_purchase') {
    const intent = intents.get(args.p_intent_id);
    const existing = receipts.get(args.p_purchase_id);
    if (existing) return { data: { ...existing, duplicate: true } };
    if (!intent || intent.userId !== args.p_user_id) throw new Error('Wrong demo intent');
    balance += BigInt(intent.points);
    const credit = { id: randomUUID(), duplicate: false };
    receipts.set(args.p_purchase_id, credit); credits.set(args.p_purchase_id, credit);
    Object.assign(intent, { status: 'credited', purchaseId: args.p_purchase_id, transactionId: credit.id, creditedAt: new Date().toISOString() });
    return { data: credit };
  }
  if (name === 'apply_point_transaction') {
    const existing = credits.get(args.p_idempotency_key);
    if (existing) return { data: { ...existing, duplicate: true } };
    balance += BigInt(args.p_amount);
    const data = { id: randomUUID(), amount: args.p_amount, balanceAfter: String(balance), duplicate: false };
    credits.set(args.p_idempotency_key, data);
    return { data };
  }
  if (name === 'get_point_account') return { data: { balance: String(balance), lifetimeEarned: String(balance), lifetimeSpent: '0', version: String(credits.size), updatedAt: new Date().toISOString() } };
  throw new Error('Unexpected demo RPC');
} };
const deps = { getConfig: () => config, authenticate: async () => ({ userId }), getAdminClient: () => client };
const purchases = createPointsPurchasesHandler({ ...deps, readsEnabled: () => true });
const checkout = createItchCheckoutHandler(deps);
const redeem = createItchRedeemHandler(deps);
const claim = createItchClaimHandler(deps);
const recovery = createPointsDeliveryHandler(deps);
const result = await build({ stdin: { contents: `import React from 'react'; import {createRoot} from 'react-dom/client';
  import PointsShop from './app/launcher/points/PointsShop.jsx'; import ClaimPoints from './app/launcher/points/claim/ClaimPoints.jsx';
  const props=window.previewProps; createRoot(document.getElementById('root')).render(props.claim
    ? <ClaimPoints initialStatus={props.status} /> : <PointsShop {...props} />);`, resolveDir: process.cwd(), loader: 'jsx' },
  bundle: true, write: false, outdir: 'preview', platform: 'browser', jsx: 'automatic', alias: { '@': process.cwd() },
  plugins: [{ name: 'preview-next', setup(builder) {
    builder.onResolve({ filter: /^next\/(link|navigation|image)$/ }, ({ path: target }) => ({ path: target, namespace: 'preview' }));
    builder.onLoad({ filter: /.*/, namespace: 'preview' }, ({ path: target }) => ({ loader: 'js', resolveDir: process.cwd(), contents: target === 'next/link'
      ? `import React from 'react'; export default function Link({children,...props}) { return React.createElement('a',props,children); }`
      : target === 'next/image' ? `import React from 'react'; export default function Image({src,alt,width,height,className}) { return React.createElement('img',{src,alt,width,height,className}); }`
      : `export function useRouter(){return router} const router={refresh(){location.reload()}};` }));
  } }],
});
const js = result.outputFiles.find((file) => file.path.endsWith('.js')).text;
const css = result.outputFiles.find((file) => file.path.endsWith('.css')).text;
const html = (content) => `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>PlayLive points — local demo</title><link rel="stylesheet" href="/demo.css"><style>body{margin:0;padding:24px;background:#edfaf8;font-family:Arial,sans-serif} .demo-banner{padding:12px;margin-bottom:24px;background:#fff4cf;border-radius:8px;font-size:14px}</style><body><div class="demo-banner">LOCAL DEMO — fake purchases, no money charged</div>${content}</body></html>`;
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, origin);
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();
    const request = new Request(url, { method: req.method, headers: req.headers, ...(req.method === 'POST' ? { body } : {}) });
    let response;
    if (url.pathname === '/demo.js') response = new Response(js, { headers: { 'Content-Type': 'text/javascript' } });
    else if (/^\/points-packs\/(starter|regular|pro|max|ultimate)\.png$/.test(url.pathname))
      response = new Response(await readFile(new URL(`../public${url.pathname}`, import.meta.url)), { headers: { 'Content-Type': 'image/png' } });
    else if (url.pathname === '/demo.css') response = new Response(css, { headers: { 'Content-Type': 'text/css' } });
    else if (url.pathname === '/api/points/purchases' || url.pathname === '/api/v1/me/points/purchases')
      response = await purchases[req.method](request);
    else if (url.pathname === '/api/points/purchases/claim' || url.pathname === '/api/v1/me/points/purchases/claim')
      response = await recovery(request);
    else if (url.pathname === '/api/v1/me/points/checkout') {
      response = await checkout(request);
      if (response.ok) {
        const data = await response.json();
        const remote = new URL(data.url);
        response = Response.json({ url: `${origin}/demo/payment?metadata=${remote.searchParams.get('metadata')}`, intentId: data.intentId });
      }
    } else if (url.pathname === '/demo/payment') {
      const metadata = url.searchParams.get('metadata');
      if (!/^[\w.-]+$/.test(metadata || '')) throw new Error('Invalid demo metadata');
      response = new Response(html(`<h1>Simulated itch.io checkout</h1><p>No actual payment is made.</p><form method="POST" action="/demo/pay"><input type="hidden" name="metadata" value="${metadata}"><button>Simulate payment and claim points</button></form>`), { headers: { 'Content-Type': 'text/html' } });
    } else if (url.pathname === '/demo/pay') {
      const encoded = new URLSearchParams(body).get('metadata');
      const metadata = JSON.parse(Buffer.from(encoded.split('.')[1], 'base64url').toString());
      const time = Math.floor(Date.now() / 1000);
      const header = Buffer.from('{"alg":"HS256"}').toString('base64url');
      const payload = Buffer.from(JSON.stringify({ purchase_id: purchaseId++, sub_product_id: metadata.subProductId, iat: time, exp: time + 600, metadata })).toString('base64url');
      const token = `${header}.${payload}.${createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url')}`;
      response = new Response(null, { status: 303, headers: { Location: `/api/points/itch/redeem?jwt=${token}` } });
    } else if (url.pathname === '/api/points/itch/redeem') response = await redeem(request);
    else if (url.pathname === '/api/v1/me/points/claim') response = await claim(request);
    else if (url.pathname === '/launcher/points/checkout') response = new Response(html('<h1>Preparing demo checkout…</h1>'), { headers: { 'Content-Type': 'text/html' } });
    else {
      const props = { claim: url.pathname === '/launcher/points/claim', status: url.searchParams.get('status'),
        packs: url.searchParams.has('empty') ? [] : publicItchPacks(config), signedIn: !url.searchParams.has('guest'), balance: String(balance),
        selectedPackId: url.searchParams.get('pack'), selectedIntentId: url.searchParams.get('intent'), autoCheckout: url.searchParams.get('checkout') === '1' };
      response = new Response(html(`<div id="root"></div><script>window.previewProps=${JSON.stringify(props).replace(/</g, '\\u003c')}</script><script src="/demo.js"></script>`), { headers: { 'Content-Type': 'text/html' } });
    }
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch { res.writeHead(500); res.end('Local demo request failed.'); }
});
server.listen(port, '127.0.0.1', () => console.log(`Local points demo: ${origin}/launcher/points`));
