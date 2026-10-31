// Map export builders (map-images P2): SVG whitelist, limits and outline.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./support.cjs');
const ex = load('experiences/visual-map/map-export.ts');
const plain = value => JSON.parse(JSON.stringify(value));
const PNG = 'data:image/png;base64,iVBORw0KGgo=';
const base = { width: 400, height: 300, title: 'Map', theme: { background: '#fff', text: '#111' } };

function assertSafe(svg) {
  assert.ok(!/<script/i.test(svg), 'script');
  assert.ok(!/foreignObject/i.test(svg), 'foreignObject');
  assert.ok(!/style/i.test(svg), 'style');
  assert.ok(!/\son\w+\s*=/i.test(svg), 'on*=');
  assert.ok(!/url\(/i.test(svg), 'url(');
  for (const m of svg.matchAll(/href="([^"]*)"/g)) assert.match(m[1], /^data:image\/(png|jpeg|gif|webp);base64,/);
  const tags = new Set([...svg.matchAll(/<([a-zA-Z][\w-]*)/g)].map(m => m[1]));
  for (const tag of tags) assert.ok(['svg', 'g', 'rect', 'path', 'line', 'text', 'image', 'title'].includes(tag), tag);
}

test('a normal scene produces only whitelisted elements and an embedded image', () => {
  const svg = ex.buildMapSvg({ ...base, cards: [{ x: 10, y: 10, w: 100, h: 60, title: 'Hello', cover: { x: 10, y: 10, w: 100, h: 30, href: PNG } }], edges: [{ d: 'M 0 0 C 10 10, 20 20, 30 30' }], images: [{ x: 5, y: 5, w: 20, h: 20, href: PNG }], boundaries: [{ x: 0, y: 0, w: 50, h: 50, label: 'Group' }] });
  assertSafe(svg);
  assert.equal([...svg.matchAll(/<image /g)].length, 2);
  assert.match(svg, />Hello</);
});

test('counter-example 3: a title with <script> is only escaped text', () => {
  const evil = '<script>alert(1)</script><img src=x>"onload=x\'';
  const svg = ex.buildMapSvg({ ...base, title: evil, cards: [{ x: 0, y: 0, w: 100, h: 50, title: evil }], boundaries: [{ x: 0, y: 0, w: 50, h: 50, label: evil }] });
  assertSafe(svg);
  assert.ok(svg.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
});

test('counter-example 4: http: and file: image hrefs skip that image only', () => {
  const hrefs = ['http://example.com/a.png', 'file:///etc/passwd', 'https://x/y.png', 'data:image/svg+xml;base64,PHN2Zz4=', 'data:text/html;base64,PGI+', 'javascript:alert(1)', PNG + '" onload="x'];
  const svg = ex.buildMapSvg({ ...base, images: [...hrefs.map(href => ({ x: 0, y: 0, w: 10, h: 10, href })), { x: 0, y: 0, w: 10, h: 10, href: PNG }], cards: [{ x: 0, y: 0, w: 50, h: 50, title: 'c', cover: { x: 0, y: 0, w: 5, h: 5, href: hrefs[0] } }] });
  assertSafe(svg);
  assert.equal([...svg.matchAll(/<image /g)].length, 1);
  assert.match(svg, />c</);
});

test('unsafe colours, path data and non-finite numbers are dropped, not written', () => {
  const svg = ex.buildMapSvg({ ...base, theme: { background: 'url(http://x)', text: 'red;}</style>' }, edges: [{ d: 'M 0 0 <script>' }, { d: 'M 0 0 L 5 5', stroke: 'url(#x)' }], cards: [{ x: NaN, y: 0, w: 10, h: 10, title: 'bad' }, { x: 0, y: 0, w: 10, h: 10, title: 'ok', fill: 'red" onload="x' }] });
  assertSafe(svg);
  assert.ok(!svg.includes('bad'));
  assert.ok(svg.includes('>ok<'));
  assert.equal([...svg.matchAll(/<path /g)].length, 1);
  assert.equal(ex.buildMapSvg({ width: Infinity, height: 10 }), '');
});

test('counter-example 5: over the limits exportLimits returns scaleDown or refuse', () => {
  assert.deepEqual(plain(ex.exportLimits({ width: 4000, height: 3000 })), { action: 'ok', scale: 1 });
  const down = plain(ex.exportLimits({ width: 12000, height: 2000 }));
  assert.equal(down.action, 'scaleDown');
  assert.equal(down.scale, 8192 / 12000);
  assert.deepEqual(plain(ex.exportLimits({ width: 9000, height: 9000 })), { action: 'refuse', reason: 'pixels' });
  const big = 'data:image/png;base64,' + 'A'.repeat(Math.ceil((50 * 1024 * 1024 + 8) * 4 / 3));
  assert.deepEqual(plain(ex.exportLimits({ width: 100, height: 100, images: [{ x: 0, y: 0, w: 1, h: 1, href: big }] })), { action: 'refuse', reason: 'embedded' });
  assert.deepEqual(plain(ex.exportLimits({ width: 100, height: 100, cards: [{ x: 0, y: 0, w: 1, h: 1, title: 'c', cover: { x: 0, y: 0, w: 1, h: 1, href: big } }] })), { action: 'refuse', reason: 'embedded' });
  assert.deepEqual(plain(ex.exportLimits({ width: 0, height: 10 })), { action: 'refuse', reason: 'size' });
});

test('counter-example 6: the outline writes collapsed branches in full', () => {
  const nodes = [{ id: 'r', parentId: null, collapsed: true }, { id: 'a', parentId: 'r', collapsed: true }, { id: 'a1', parentId: 'a' }, { id: 'b', parentId: 'r' }, { id: 'orphan', parentId: 'gone' }];
  const titles = { r: 'Root', a: 'A\nline', a1: 'A1', b: 'B', orphan: 'Orphan' };
  assert.equal(ex.mapOutline(nodes, id => titles[id]), '- Root\n  - A line\n    - A1\n  - B\n- Orphan');
  assert.equal(ex.mapOutline([{ id: 'x', parentId: 'y' }, { id: 'y', parentId: 'x' }], id => id), '');
});
