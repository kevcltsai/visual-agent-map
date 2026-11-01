// Card height (ticket card-height): the height data contract, share payload and viewer, view handles and export.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { load } = require('./support-replay.cjs');
const core = load('map-model.ts');
const graph = load('map-graph.ts');

const root = path.join(__dirname, '..');
const node = (id, parentId = null, extra = {}) => ({ id, parentId, path: `${id}.md`, x: 0, y: 0, collapsed: false, ...extra });
const doc = nodes => ({ version: 1, id: 'm', title: 'M', nodes, viewport: { x: 0, y: 0, zoom: 1 } });
const roundTrip = nodes => core.parseMap(core.serializeMap(doc(nodes))).nodes;
const heights = nodes => JSON.stringify(nodes.map(item => item.height ?? null));

test('card height constants and clamp', () => {
  assert.deepEqual([graph.CARD_HEIGHT_MIN, graph.CARD_HEIGHT_MAX, graph.CARD_HEIGHT_STEP], [80, 720, 40]);
  assert.equal(graph.clampCardHeight(50), 80);
  assert.equal(graph.clampCardHeight(9999), 720);
  assert.equal(graph.clampCardHeight(320.4), 320);
  assert.equal(graph.clampCardHeight('320'), undefined);
  assert.equal(graph.clampCardHeight(NaN), undefined);
  assert.equal(graph.clampCardHeight(Infinity), undefined);
  assert.equal(graph.clampCardHeight(null), undefined);
});

test('A1 height survives a round trip and parse cleans it; there is no default to drop', () => {
  const back = roundTrip([
    node('a', null, { height: 320 }), node('b', 'a', { height: 'tall' }), node('c', 'a', { height: 50 }), node('d', 'a', { height: 9999 }),
    node('e', 'a', { height: 333.6 }), node('f', 'a', { height: NaN }), node('g', 'a', { height: Infinity }), node('h', 'a', { height: 280 }), node('i', 'a')
  ]);
  assert.equal(heights(back), JSON.stringify([320, null, 80, 720, 334, null, null, 280, null]));
  for (const i of [1, 5, 6, 8]) assert.equal('height' in back[i], false);
  const both = roundTrip([node('a', null, { width: 400, height: 240 })])[0];
  assert.deepEqual([both.width, both.height], [400, 240]);
});

test('A1 a map without height is byte-identical after parse and serialize', () => {
  const text = core.serializeMap(doc([node('a'), node('b', 'a', { x: 360, y: 10, width: 400 })]));
  assert.equal(core.serializeMap(core.parseMap(text)), text);
  assert.equal(text.includes('height'), false);
});

test('A2 an older plugin (plain JSON read and write, no field whitelist) keeps height', () => {
  const text = core.serializeMap(doc([node('a', null, { height: 320 })]));
  const block = text.match(/```agent-map\n([\s\S]*?)\n```/)[1];
  const again = JSON.stringify(JSON.parse(block), null, 2);
  assert.equal(again, block);
  assert.equal(JSON.parse(again).nodes[0].height, 320);
});

test('A1 map-graph.ts still has no import and the viewer shares the height helpers', () => {
  const source = fs.readFileSync(path.join(root, 'map-graph.ts'), 'utf8');
  assert.equal((source.match(/^import/gm) || []).length, 0);
});

const viewerSource = () => fs.readFileSync(path.join(root, 'experiences', 'sharing', 'viewer', 'main.ts'), 'utf8');
const styles = () => fs.readFileSync(path.join(root, 'styles.css'), 'utf8');

test('A4 the viewer cleans the height, applies it in place() and marks clipped cards after layout', () => {
  const source = viewerSource();
  assert.match(source, /clampCardHeight\(item\.height\)/);
  assert.match(source, /card\.style\.height = `\$\{node\.height\}px`/);
  assert.match(source, /scrollHeight > card\.clientHeight/);
  assert.match(source, /vam-card-fade/);
  assert.match(source, /vam-card-more/);
});

test('A4 the clip rules are in the viewer stylesheet and keep the handles, scan line and shapes visible', () => {
  const bundle = load('experiences/sharing/viewer-bundle.generated.ts');
  const css = bundle.SHARE_VIEWER_CSS;
  assert.ok(css.includes('.vam-node.is-clipped { overflow: hidden; }'));
  assert.ok(css.includes('.vam-node.is-clipped > .vam-card-resize { right: 0; }'), 'the width handle moves inside the border while clipped');
  assert.ok(css.includes('.vam-node.is-clipped > .vam-card-fade'));
  assert.ok(css.includes('.vam-node.is-clipped > .vam-card-more'));
  const own = styles();
  // Obsidian's review rejects clip-path (scripts/check-css.mjs): the clip is overflow: hidden, so what sits on or past the border must move inside it while clipped.
  assert.doesNotMatch(own, /clip-path\s*:/);
  assert.ok(own.includes('.vam-node.is-clipped:not([data-aim-kind])[data-status="running"]::after { top: 0; }'), 'the scan line stays visible');
  assert.ok(own.includes('.vam-node.is-clipped > .vam-kind-shape {'), 'the shape outline stays visible');
  assert.match(own, /\.vam-card-resize \{[^}]*right: -5px/, 'the unclipped width handle is unchanged');
});
