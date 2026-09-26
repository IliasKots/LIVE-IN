import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

let View;
let Panel;
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

test('server panel isolates database failure and refuses invalid cursors before reads', async () => {
  const failing = { rpc: async () => { throw new Error('database outage'); } };
  const html = renderToStaticMarkup(await Panel({ supabase: failing, userId: '11111111-1111-4111-8111-111111111111' }));
  assert.match(html, /load your points/);
  const invalid = renderToStaticMarkup(await Panel({ supabase: failing, userId: 'any', cursor: ['1', '2'] }));
  assert.match(invalid, /history link is invalid/);
});
