// Card editor (tickets 01-03): the display math shared by the map card, the "Edit card" dialog and the export, the card
// copy the dialog edits, and the export of a mask window.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const S = require('./support.cjs');
const replay = require('./support-replay.cjs');
const dom = require('./support-dom.cjs');

const layout = S.load('experiences/visual-map/cover-layout.ts');
const ex = S.load('experiences/visual-map/map-export.ts');
const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-9, `${message}: ${actual} vs ${expected}`);
const nearBox = (actual, expected, message = 'window') => {
  for (const key of Object.keys(expected)) near(actual[key], expected[key], `${message}.${key}`);
};

// ---- display math: picture size, frame, D -> window size and offset
test('display math: the whole picture is D wide and as tall as its shape', () => {
  nearBox(layout.coverWindow(400, 200, null, 250), { left: 0, width: 250, height: 125, scale: 1 });
  nearBox(layout.coverWindow(400, 200, { x: 0, y: 0, w: 1, h: 1 }, 250), { left: 0, width: 250, height: 125, scale: 1 }, 'a whole frame');
});

test('display math: a mask is a window w·D wide, h·D·(height / width) tall, x·D from the left, at the same scale', () => {
  // 400 x 200 picture, D = 250: one picture width is 250 px and one picture height 125 px.
  nearBox(layout.coverWindow(400, 200, { x: 0.2, y: 0.3, w: 0.4, h: 0.4 }, 250), { left: 50, width: 100, height: 50, scale: 1 });
});

test('display math: hiding the left or right keeps the rest in place and at its size; only the width changes', () => {
  const whole = layout.coverWindow(400, 300, null, 300);
  const left = layout.coverWindow(400, 300, { x: 0.25, y: 0, w: 0.75, h: 1 }, 300);
  const right = layout.coverWindow(400, 300, { x: 0, y: 0, w: 0.5, h: 1 }, 300);
  nearBox(left, { left: 75, width: 225, height: whole.height, scale: 1 }, 'left hidden');
  nearBox(right, { left: 0, width: 150, height: whole.height, scale: 1 }, 'right hidden');
});

test('display math: hiding the top or bottom makes the window shorter by exactly that part; nothing else moves', () => {
  const top = layout.coverWindow(400, 300, { x: 0, y: 0.4, w: 1, h: 0.6 }, 300);
  const bottom = layout.coverWindow(400, 300, { x: 0, y: 0, w: 1, h: 0.5 }, 300);
  nearBox(top, { left: 0, width: 300, height: 0.6 * 225, scale: 1 }, 'top hidden');
  nearBox(bottom, { left: 0, width: 300, height: 0.5 * 225, scale: 1 }, 'bottom hidden');
});

test('display math: a window taller than 1.5·D is scaled down whole to 1.5·D and stays centred on its own place', () => {
  assert.equal(layout.COVER_MAX_HEIGHT_RATIO, 1.5);
  // 100 x 400 picture, D = 200: the whole picture would be 800 px tall; the cap is 300 px, scale 0.375.
  nearBox(layout.coverWindow(100, 400, null, 200), { left: 62.5, width: 75, height: 300, scale: 0.375 }, 'whole: letterboxed and centred');
  // The left half: unscaled 100 x 800 at 0; scaled 37.5 x 300, centred on 50.
  nearBox(layout.coverWindow(100, 400, { x: 0, y: 0, w: 0.5, h: 1 }, 200), { left: 31.25, width: 37.5, height: 300, scale: 0.375 }, 'a tall half');
  // A short band of the same picture is under the cap and keeps the full scale.
  nearBox(layout.coverWindow(100, 400, { x: 0, y: 0.5, w: 1, h: 0.25 }, 200), { left: 0, width: 200, height: 200, scale: 1 }, 'a short band');
});

test('display math: the window scales with D (pure proportions, no fixed pixels)', () => {
  const one = layout.coverWindow(640, 480, { x: 0.1, y: 0.2, w: 0.5, h: 0.3 }, 1);
  const big = layout.coverWindow(640, 480, { x: 0.1, y: 0.2, w: 0.5, h: 0.3 }, 280);
  for (const key of ['left', 'width', 'height']) near(big[key], one[key] * 280, key);
});

test('display math: a picture or D that cannot be measured gives no window', () => {
  for (const [w, h, d] of [[0, 10, 100], [10, 0, 100], [NaN, 10, 100], [-1, 5, 100], [10, 10, 0], [10, 10, NaN], [Infinity, 10, 100]])
    assert.equal(layout.coverWindow(w, h, null, d), null, `${w} ${h} ${d}`);
});

test('display math: coverFrameRatio is D over the window height', () => {
  for (const [w, h, frame] of [[400, 200, null], [400, 300, { x: 0, y: 0.4, w: 1, h: 0.6 }], [100, 400, { x: 0, y: 0, w: 0.5, h: 1 }], [300, 100, { x: 0.5, y: 0.5, w: 0.5, h: 0.5 }]])
    near(layout.coverFrameRatio(w, h, frame), 1 / layout.coverWindow(w, h, frame, 1).height, JSON.stringify([w, h, frame]));
});

test('placeCoverFrame: the map card gets the same numbers as inline percentages', () => {
  const frame = dom.element('div'), win = dom.element('div'), img = dom.element('img');
  const placed = layout.placeCoverFrame({ frame, window: win, img }, 2, { x: 0.2, y: 0.3, w: 0.4, h: 0.4 });
  near(placed.left, 0.2, 'returns the window');
  assert.ok(frame.classes.includes('is-sized'));
  near(Number(frame.style['aspect-ratio']), 5, 'box');
  near(parseFloat(win.style.left), 20, 'left');
  near(parseFloat(win.style.width), 40, 'width');
  near(Number(win.style['aspect-ratio']), 2, 'window shape');
  near(parseFloat(img.style.width), 250, 'picture width');
  near(parseFloat(img.style.left), -50, 'picture left');
  near(parseFloat(img.style.top), -75, 'picture top');
  const plain = dom.element('div');
  layout.placeCoverFrame({ frame: plain, window: null, img: dom.element('img') }, 2, null);
  near(Number(plain.style['aspect-ratio']), 2, 'whole picture: its own shape');
  assert.equal(layout.placeCoverFrame({ frame: dom.element('div'), window: null, img: dom.element('img') }, 0, null), null);
});

// ---- export: the text starts under the shown window, not under the whole picture behind it
test('export: a masked cover puts the title under the window, not under the hidden part of the picture', () => {
  const PNG = 'data:image/png;base64,iVBORw0KGgo=';
  const svg = ex.buildMapSvg({
    width: 400, height: 400,
    cards: [{ x: 0, y: 0, w: 280, h: 200, title: 'Hello', cover: { x: -100, y: -200, w: 560, h: 400, href: PNG, fit: 'fill', window: { x: 14, y: 8, w: 200, h: 60 } } }],
    edges: []
  });
  assert.match(svg, /<text x="14" y="90"/, 'title baseline 22 below the window bottom (8 + 60)');
});

// ---- the card copy the dialog edits
const Modal = dom.makeModal();
const { VisualAgentMapView } = replay.load(
  'experiences/visual-map/view.ts',
  { obsidian: { ...S.obsidian, Component: class {}, MarkdownRenderChild: class {}, Modal } },
  { window: { setTimeout, clearTimeout }, CSS: { escape: s => s }, createDiv: o => dom.element('div', o), createEl: (tag, o) => dom.element(tag, o) }
);

test('card copy: the dialog gets the map card itself, without tools, handles, map states, position or set height', () => {
  const live = dom.element('div', { cls: 'vam-node is-selected is-clipped' });
  Object.assign(live.style, { left: '120px', top: '40px', width: '360px', height: '90px' });
  live.attrs = { id: 'x', role: 'treeitem', tabindex: '0', 'aria-level': '2', 'data-node-id': 'm', 'data-topic-color': 'red' };
  live.createDiv('vam-node-header').createSpan({ cls: 'vam-status', text: 'Done' });
  live.createDiv('vam-node-tools');
  live.createEl('button', { cls: 'vam-add-child' });
  live.createDiv('vam-card-cover');
  live.createEl('h3', { cls: 'vam-card-title', text: 'Title' });
  live.createEl('p', { cls: 'vam-card-summary', text: 'Summary' });
  for (const cls of ['vam-card-resize', 'vam-card-resize-y', 'vam-card-fade', 'vam-card-more']) live.createSpan({ cls });
  live.cloneNode = () => {
    const copy = dom.element('div', { cls: live.cls });
    Object.assign(copy.style, live.style);
    copy.attrs = { ...live.attrs };
    copy.children = live.children.map(child => { const c = dom.element(child.tag, { cls: child.cls, text: child.text }); c.children = child.children.map(g => dom.element(g.tag, { cls: g.cls })); c.children.forEach(g => { g.parent = c; }); c.parent = copy; return c; });
    copy.getAttributeNames = () => Object.keys(copy.attrs);
    copy.removeAttribute = name => { delete copy.attrs[name]; };
    copy.style.removeProperty = name => { delete copy.style[name]; };
    return copy;
  };
  const view = Object.assign(Object.create(VisualAgentMapView.prototype), { cardEls: new Map([['m', live]]), notes: new Map() });
  const copy = view.cardForEditor({ id: 'm', path: 'Topics/m.md' });
  assert.notEqual(copy, live, 'a copy; the map card is untouched');
  assert.equal(copy.style.width, '360px', 'the card keeps its own width');
  for (const key of ['left', 'top', 'height']) assert.equal(copy.style[key], undefined, key);
  assert.deepEqual(copy.classes, ['vam-node']);
  assert.deepEqual(Object.keys(copy.attrs), ['data-topic-color'], 'look attributes stay; ids, roles and map focus go');
  const left = copy.children.map(c => c.cls);
  assert.deepEqual(left, ['vam-node-header', 'vam-card-cover', 'vam-card-title', 'vam-card-summary']);
  assert.equal(copy.children[0].children.length, 1, 'the header shows as on the map');
  assert.equal(live.children.length, 10, 'the map card keeps everything');
});

test('card copy: a topic whose card is not drawn gets a plain card with its width, title and summary', () => {
  const view = Object.assign(Object.create(VisualAgentMapView.prototype), { cardEls: new Map(), notes: new Map([['m', { title: 'Mars', summary: 'Red planet' }]]) });
  const card = view.cardForEditor({ id: 'm', path: 'Topics/m.md', width: 320 });
  assert.equal(card.style.width, '320px');
  assert.deepEqual(card.children.map(c => [c.tag, c.text]), [['h3', 'Mars'], ['p', 'Red planet']]);
});
