import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { pointPackArtwork } from '../lib/points-pack-art.mjs';

let View;
let Panel;
let Shop;
let Claim;
before(async () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const result = await build({
    entryPoints: [path.join(root, 'app/launcher/account/PointsPanel.jsx')],
    bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external',
    jsx: 'automatic', alias: { '@': root },
    plugins: [{ name: 'css-module-test', setup(builder) {
      builder.onLoad({ filter: /\.module\.css$/ }, async ({ path: file }) => {
        const css = await readFile(file, 'utf8');
        const classes = Object.fromEntries([...css.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((match) => [match[1], match[1]]));
        return { contents: `export default ${JSON.stringify(classes)}`, loader: 'js' };
      });
    } }],
  });
  const compiled = { exports: {} };
  new Function('require', 'module', 'exports', result.outputFiles[0].text)(createRequire(import.meta.url), compiled, compiled.exports);
  View = compiled.exports.PointsPanelView;
  Panel = compiled.exports.default;
  const extra = await build({
    stdin: { contents: `export {default as Shop} from './app/launcher/points/PointsShop.jsx'; export {default as Claim} from './app/launcher/points/claim/ClaimPoints.jsx';`, resolveDir: root, loader: 'jsx' },
    bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external', jsx: 'automatic', alias: { '@': root },
    plugins: [
      { name: 'navigation-test', setup(builder) {
        builder.onResolve({ filter: /^next\/navigation$/ }, () => ({ path: 'navigation', namespace: 'test' }));
        builder.onLoad({ filter: /.*/, namespace: 'test' }, () => ({ contents: 'export const useRouter=()=>({refresh(){}});', loader: 'js' }));
      } },
      { name: 'css-test', setup(builder) {
        builder.onLoad({ filter: /\.module\.css$/ }, async ({ path: file }) => ({ loader: 'js', contents: `export default ${JSON.stringify(Object.fromEntries([...(await readFile(file, 'utf8')).matchAll(/\.([a-zA-Z][\w-]*)/g)].map((match) => [match[1], match[1]])))}` }));
      } },
    ],
  });
  const extraCompiled = { exports: {} };
  new Function('require', 'module', 'exports', extra.outputFiles[0].text)(createRequire(import.meta.url), extraCompiled, extraCompiled.exports);
  Shop = extraCompiled.exports.Shop;
  Claim = extraCompiled.exports.Claim;
});

const emptyAccount = { balance: '0', lifetimeEarned: '0', lifetimeSpent: '0', updatedAt: null, version: '0' };
const emptyHistory = { items: [], nextCursor: null };
const render = (props) => renderToStaticMarkup(React.createElement(View, props));

test('zero state shows real zero and disabled Add Points without purchase links', () => {
  const html = render({ account: emptyAccount, history: emptyHistory });
  assert.match(html, /<strong>0<\/strong>/);
  assert.match(html, /No points activity yet/);
  assert.match(html, /disabled=""/);
  assert.match(html, /Add points/);
  assert.doesNotMatch(html, /checkout|purchase|MOCK/);
});

test('wallet links to points shop only when purchases are configured', () => {
  const html = render({ account: emptyAccount, history: emptyHistory, purchaseEnabled: true });
  assert.match(html, /href="\/launcher\/points"/);
  assert.match(html, /Buy points on itch.io/);
  assert.doesNotMatch(html, /coming soon/);
});

test('shop handles configured, unavailable and signed-out states without exposing purchase secrets', () => {
  const packs = [{ id: 'starter', name: 'Starter', points: '1000', priceLabel: '$5' }];
  const html = renderToStaticMarkup(React.createElement(Shop, { packs, signedIn: true, balance: '9900' }));
  assert.match(html, /1,000/); assert.match(html, /9,900/); assert.match(html, /Buy points/);
  assert.doesNotMatch(html, /disabled=""|metadata=|secret/);
  const guest = renderToStaticMarkup(React.createElement(Shop, { packs, signedIn: false }));
  assert.match(guest, /Sign in to buy points/); assert.match(guest, /disabled=""/);
  const empty = renderToStaticMarkup(React.createElement(Shop, { packs: [], signedIn: true }));
  assert.match(empty, /available here soon/); assert.doesNotMatch(empty, /<button[^>]*>Buy points/);
});

test('claim screens explain expired proof and wrong account without claiming a false success', () => {
  const expired = renderToStaticMarkup(React.createElement(Claim, { initialStatus: 'CLAIM_EXPIRED' }));
  assert.match(expired, /claim link has expired/); assert.doesNotMatch(expired, /points have been added/);
  const wrong = renderToStaticMarkup(React.createElement(Claim, { initialStatus: 'WRONG_ACCOUNT' }));
  assert.match(wrong, /account that started this purchase/); assert.match(wrong, /Sign in to claim/);
  assert.match(wrong, /Sign out of this account/);
});

test('browser sign-in preserves the selected intent and recovery directs paid users to claiming', () => {
  const props = { packs: [{ id: 'starter', name: 'Starter', points: '1000', priceLabel: '$5', currency: 'USD' }],
    selectedPackId: 'starter', selectedIntentId: '11111111-1111-4111-8111-111111111111', autoCheckout: false };
  const guest = renderToStaticMarkup(React.createElement(Shop, { ...props, signedIn: false }));
  assert.match(guest, /returnTo=%2Flauncher%2Fpoints%3Fpack%3Dstarter%26intent%3D11111111-1111-4111-8111-111111111111%26checkout%3D0/);
  assert.match(guest, /\(USD\)/); assert.match(guest, /return to your itch.io purchase receipt/);
  assert.match(guest, /href="\/launcher\/points\/claim"/); assert.doesNotMatch(guest, /Points added|metadata=|access_token/);
});

test('unavailable and invalid-link states never fabricate a zero balance', () => {
  const unavailable = render({ unavailable: true });
  assert.match(unavailable, /couldn&#x27;t load your points/);
  assert.doesNotMatch(unavailable, /points available/);
  const invalid = render({ invalidCursor: true });
  assert.match(invalid, /history link is invalid/);
  assert.match(invalid, /Latest|latest/);
  assert.doesNotMatch(invalid, /points available/);
});

test('maximum balance renders exactly; history escapes descriptions and paginates', () => {
  const html = render({ account: { ...emptyAccount, balance: '9223372036854775807', lifetimeEarned: '9223372036854775807' },
    history: { items: [{ id: 'id', amount: '-100', description: '<script>alert(1)</script>', createdAt: '2026-09-19T12:00:00Z' }], nextCursor: '5' }, olderPage: true });
  assert.match(html, /9,223,372,036,854,775,807/);
  assert.match(html, /-100/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /pointsCursor=5/);
  assert.match(html, /Latest activity/);
});

test('shop uses uploaded artwork only when server offer matches its embedded amount and price', async () => {
  const pack = { id: 'starter', name: 'Starter', points: '5000', priceLabel: '$5', currency: 'USD', priceMinor: '500' };
  const html = renderToStaticMarkup(React.createElement(Shop, { packs: [pack], signedIn: false }));
  assert.match(html, /points-packs.*starter/);
  assert.match(html, /5,000/);
  assert.match(html, /\$5/);
  assert.match(html, /disabled=""/);
  const changed = { ...pack, priceMinor: '600', priceLabel: '$6' };
  const changedHtml = renderToStaticMarkup(React.createElement(Shop, { packs: [changed], signedIn: false }));
  assert.doesNotMatch(changedHtml, /points-packs/);
  assert.match(changedHtml, /\$6/);
  assert.equal(pointPackArtwork({ ...pack, currency: 'EUR' }), null);
  assert.equal(pointPackArtwork({ ...pack, points: '1000' }), null);
  assert.equal(pointPackArtwork({ ...pack, points: 5000 }), null);
  assert.equal(pointPackArtwork({ ...pack, priceMinor: undefined }), null);
  for (const [points, priceMinor] of [['5000', '500'], ['10000', '1000'], ['27500', '2500'], ['57500', '5000'], ['120000', '10000']]) {
    const asset = pointPackArtwork({ ...pack, points, priceMinor });
    const bytes = await readFile(new URL('../public' + asset, import.meta.url));
    assert.equal(bytes.subarray(1, 4).toString(), 'PNG');
  }
});

test('server panel isolates database failure and refuses invalid cursors before reads', async () => {
  const failing = { rpc: async () => { throw new Error('database outage'); } };
  const html = renderToStaticMarkup(await Panel({ supabase: failing, userId: '11111111-1111-4111-8111-111111111111' }));
  assert.match(html, /load your points/);
  const invalid = renderToStaticMarkup(await Panel({ supabase: failing, userId: 'any', cursor: ['1', '2'] }));
  assert.match(invalid, /history link is invalid/);
});
