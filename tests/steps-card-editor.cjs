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

// ---- ticket 02: picture size (`topic-cover-size`, k = 0.3-1 of the content width)
const cover = S.load('experiences/visual-map/card-cover.ts', { obsidian: { parseYaml: () => ({}), stringifyYaml: () => '', normalizePath: p => p } });

test('size: parse accepts 0.3-1 as a number or a decimal string; anything else is the default 1, no error', () => {
  assert.equal(cover.COVER_SIZE_KEY, 'topic-cover-size');
  for (const [raw, k] of [[0.45, 0.45], ['0.45', 0.45], [' 0.3 ', 0.3], [1, 1], ['1', 1], [0.3, 0.3], ['.5', 0.5]]) assert.equal(cover.parseCoverSize(raw), k, JSON.stringify(raw));
  for (const raw of [undefined, null, '', 'big', 0, 0.29, 1.01, 2, -0.5, NaN, Infinity, '45%', '0.5 0.5', [0.5], { k: 0.5 }, true]) assert.equal(cover.parseCoverSize(raw), 1, JSON.stringify(raw));
});

test('size: serialise keeps two decimals and removes the key at the default', () => {
  assert.equal(cover.serialiseCoverSize(0.456), 0.46);
  assert.equal(cover.serialiseCoverSize(0.3), 0.3);
  assert.equal(cover.serialiseCoverSize(1), null);
  assert.equal(cover.serialiseCoverSize(0.999), null, 'rounds to the default');
  assert.equal(cover.serialiseCoverSize(5), null, 'out of range is the default');
});

test('size: withCoverLook writes the frame and the size in one write; the defaults remove both keys; other lines stay', () => {
  const note = '---\ntitle: "T"\ntopic-color: red\n---\n# Body\n';
  const looked = cover.withCoverLook(note, { frame: { x: 0.1, y: 0.2, w: 0.5, h: 0.5 }, size: 0.45 });
  assert.equal(looked, '---\ntitle: "T"\ntopic-color: red\ntopic-cover-frame: "0.1 0.2 0.5 0.5"\ntopic-cover-size: "0.45"\n---\n# Body\n');
  assert.equal(cover.withCoverLook(looked, { frame: null, size: 1 }), note);
  assert.equal(cover.withCoverLook(looked, { frame: null }), '---\ntitle: "T"\ntopic-color: red\ntopic-cover-size: "0.45"\n---\n# Body\n', 'no size: the size key is left alone');
  const resolved = cover.resolveCoverWithFrame({ frontmatter: { 'topic-cover-size': '0.45' }, embeds: [{ link: 'a.png' }] }, l => ({ path: l }));
  assert.equal(resolved.size, 0.45);
  assert.equal(cover.resolveCoverWithFrame({ frontmatter: { 'topic-cover-size': 7 }, embeds: [{ link: 'a.png' }] }, l => ({ path: l })).size, 1);
});

test('size: changing the picture or turning the cover off keeps the size (it is not tied to one picture)', () => {
  const note = '---\ntopic-cover: "[[a.png]]"\ntopic-cover-frame: "0 0 0.5 0.5"\ntopic-cover-size: "0.5"\n---\n';
  assert.match(cover.withCover(note, 'b.png'), /topic-cover-size: "0\.5"/);
  assert.match(cover.withCoverOff(note), /topic-cover-size: "0\.5"/);
});

test('display math with k: D = k × content width, centred; the window scales with D and the mask region never changes', () => {
  near(layout.coverDisplay(250, 1).width, 250, 'default');
  nearBox(layout.coverDisplay(250, 0.4), { left: 75, width: 100 }, 'k 40%');
  nearBox(layout.coverDisplay(250, 0.1), { left: 87.5, width: 75 }, 'below 30% is held at 30%');
  nearBox(layout.coverDisplay(250, 3), { left: 0, width: 250 }, 'above 100% is held at 100%');
  const frame = { x: 0.2, y: 0.3, w: 0.4, h: 0.4 };
  const full = layout.coverWindow(400, 200, frame, layout.coverDisplay(250, 1).width);
  const half = layout.coverWindow(400, 200, frame, layout.coverDisplay(250, 0.5).width);
  for (const key of ['left', 'width', 'height']) near(half[key], full[key] / 2, key);
  // The cap follows D too: a tall picture at k 0.5 is at most 0.75 × the content width tall.
  near(layout.coverWindow(100, 400, null, layout.coverDisplay(200, 0.5).width).height, 150, 'cap at 1.5 D');
});

test('sizeCoverBox: a smaller picture narrows and centres the cover box; the default leaves the stylesheet width', () => {
  const box = dom.element('div');
  layout.sizeCoverBox(box, 0.45);
  assert.equal(box.style.width, '45%');
  assert.ok(box.classes.includes('is-resized'), 'centred by the stylesheet');
  layout.sizeCoverBox(box, 1);
  assert.equal(box.style.width, undefined);
  assert.ok(!box.classes.includes('is-resized'));
  assert.match(require('node:fs').readFileSync(require('node:path').join(__dirname, '../styles.css'), 'utf8'), /\.vam-card-cover\.is-resized \{ margin-left: auto; margin-right: auto; \}/);
});

// ---- ticket 03: picture position (`topic-cover-position`: top, bottom, left, right)
test('position: parse reads the four positions in any case; anything else is top; serialise drops top', () => {
  assert.equal(cover.COVER_POSITION_KEY, 'topic-cover-position');
  for (const [raw, p] of [['top', 'top'], ['bottom', 'bottom'], ['left', 'left'], ['right', 'right'], [' Left ', 'left'], ['RIGHT', 'right']]) assert.equal(cover.parseCoverPosition(raw), p, raw);
  for (const raw of [undefined, null, '', 'middle', 'l', 3, ['left'], { left: true }, true]) assert.equal(cover.parseCoverPosition(raw), 'top', JSON.stringify(raw));
  assert.equal(cover.serialiseCoverPosition('top'), null);
  assert.equal(cover.serialiseCoverPosition('nonsense'), null);
  assert.equal(cover.serialiseCoverPosition('left'), 'left');
});

test('position: written with frame and size in one write; top removes the key; it rides with the resolved cover', () => {
  const note = '---\ntitle: "T"\n---\n# Body\n';
  const looked = cover.withCoverLook(note, { frame: null, size: 0.45, position: 'left' });
  assert.equal(looked, '---\ntitle: "T"\ntopic-cover-size: "0.45"\ntopic-cover-position: "left"\n---\n# Body\n');
  assert.equal(cover.withCoverLook(looked, { frame: null, size: 1, position: 'top' }), note);
  assert.equal(cover.withCoverLook(looked, { frame: null }), looked, 'without size and position both keys are left alone');
  const resolve = l => ({ path: l });
  assert.equal(cover.resolveCoverWithFrame({ frontmatter: { 'topic-cover-position': 'bottom' }, embeds: [{ link: 'a.png' }] }, resolve).position, 'bottom');
  assert.equal(cover.resolveCoverWithFrame({ frontmatter: { 'topic-cover-position': 'up' }, embeds: [{ link: 'a.png' }] }, resolve).position, 'top');
});

// Content 250 wide, picture 2:1 (height = D / 2), text: 600 / width lines of 20 px (narrower text wraps taller).
const pictureOf = D => D / 2;
const textOf = width => Math.ceil(600 / width) * 20;
test('layout math: top is today\'s layout — picture D wide and centred over full-width text', () => {
  const at = layout.coverCardLayout('top', 250, 1, pictureOf, textOf);
  nearBox(at.picture, { x: 0, y: 8, width: 250, height: 125 }, 'picture');
  nearBox(at.text, { x: 0, y: 133, width: 250, height: 60 }, 'text');
  near(at.height, 193, 'height');
  nearBox(layout.coverCardLayout('top', 250, 0.4, pictureOf, textOf).picture, { x: 75, width: 100, height: 50 }, 'k 40% centred');
});

test('layout math: bottom puts the picture under the text', () => {
  const at = layout.coverCardLayout('bottom', 250, 0.6, pictureOf, textOf);
  nearBox(at.text, { x: 0, y: 0, width: 250, height: 60 }, 'text');
  nearBox(at.picture, { x: 50, y: 68, width: 150, height: 75 }, 'picture');
  near(at.height, 143, 'height');
});

test('layout math: left and right put a D-wide picture column beside text that takes the rest; height is the taller', () => {
  const left = layout.coverCardLayout('left', 250, 0.45, pictureOf, textOf);
  // D = 112.5, text width = 250 - 112.5 - 10 = 127.5 -> 5 lines = 100 px; picture 56.25 px.
  nearBox(left.picture, { x: 0, y: 8, width: 112.5, height: 56.25 }, 'left picture');
  nearBox(left.text, { x: 122.5, y: 8, width: 127.5, height: 100 }, 'left text');
  near(left.height, 108, 'the text is taller');
  const right = layout.coverCardLayout('right', 250, 0.45, pictureOf, textOf);
  nearBox(right.picture, { x: 137.5, width: 112.5 }, 'right picture');
  nearBox(right.text, { x: 0, width: 127.5 }, 'right text');
  const tall = layout.coverCardLayout('left', 250, 0.45, D => D * 1.5, () => 20);
  near(tall.height, 8 + 112.5 * 1.5, 'the picture is taller');
  assert.equal(layout.COVER_SIDE_GAP, 10);
  assert.match(require('node:fs').readFileSync(require('node:path').join(__dirname, '../styles.css'), 'utf8'), /\.vam-card-side \{ display: flex; gap: 10px;/, 'the stylesheet uses the same gap');
});

// arrangeCover on a stand-in card: header, cover, title, summary, error, "+", fade.
const builtCard = () => {
  const c = dom.element('div', { cls: 'vam-node' });
  c.createDiv('vam-node-header');
  const frame = c.createDiv('vam-card-cover');
  c.createEl('h3', { cls: 'vam-card-title' });
  c.createEl('p', { cls: 'vam-card-summary' });
  c.createEl('p', { cls: 'vam-card-error' });
  c.createEl('button', { cls: 'vam-add-child' });
  c.createSpan({ cls: 'vam-card-fade' });
  return { c, frame };
};
const order = el => el.children.map(child => child.cls.split(' ')[0] + (child.children.length && child.cls.startsWith('vam-card-side') ? `[${order(child).join(',')}]` : ''));

test('arrangeCover: top, bottom, left and right place the cover; calling again or switching back restores the card', () => {
  const { c, frame } = builtCard();
  const top = ['vam-node-header', 'vam-card-cover', 'vam-card-title', 'vam-card-summary', 'vam-card-error', 'vam-add-child', 'vam-card-fade'];
  layout.arrangeCover(c, frame, 'top');
  assert.deepEqual(order(c), top);
  layout.arrangeCover(c, frame, 'bottom');
  assert.deepEqual(order(c), ['vam-node-header', 'vam-card-title', 'vam-card-summary', 'vam-card-cover', 'vam-card-error', 'vam-add-child', 'vam-card-fade']);
  assert.ok(c.classes.includes('has-cover-bottom'));
  layout.arrangeCover(c, frame, 'left');
  assert.deepEqual(order(c), ['vam-node-header', 'vam-card-side[vam-card-cover,vam-card-side-text[vam-card-title,vam-card-summary,vam-card-error]]', 'vam-add-child', 'vam-card-fade']);
  assert.ok(c.classes.includes('has-cover-left') && !c.classes.includes('has-cover-bottom'));
  layout.arrangeCover(c, frame, 'right');
  assert.deepEqual(order(c), ['vam-node-header', 'vam-card-side[vam-card-cover,vam-card-side-text[vam-card-title,vam-card-summary,vam-card-error]]', 'vam-add-child', 'vam-card-fade'], 'one row, not two');
  assert.ok(c.classes.includes('has-cover-right') && !c.classes.includes('has-cover-left'));
  layout.arrangeCover(c, frame, 'top');
  assert.deepEqual(order(c), top);
  assert.ok(!c.classes.some(cls => cls.startsWith('has-cover-')));
});

test('arrangeCover: a bottom picture goes after the open summary field (and its hint), the add-summary line, or the text when a title field is open', () => {
  const cardWith = build => { const c = dom.element('div', { cls: 'vam-node' }); const frame = c.createDiv('vam-card-cover'); c.createEl('h3', { cls: 'vam-card-title' }); build(c); c.createDiv('vam-add-child'); return { c, frame }; };
  const summaryEdit = cardWith(c => { c.createEl('textarea', { cls: 'vam-card-summary-input' }); c.createDiv('vam-card-edit-hint'); });
  layout.arrangeCover(summaryEdit.c, summaryEdit.frame, 'bottom');
  assert.deepEqual(order(summaryEdit.c), ['vam-card-title', 'vam-card-summary-input', 'vam-card-edit-hint', 'vam-card-cover', 'vam-add-child'], 'below the field and its hint');
  const addLine = cardWith(c => c.createEl('p', { cls: 'vam-card-summary-add' }));
  layout.arrangeCover(addLine.c, addLine.frame, 'bottom');
  assert.deepEqual(order(addLine.c), ['vam-card-title', 'vam-card-summary-add', 'vam-card-cover', 'vam-add-child'], 'below the add-summary line');
  const titleEdit = cardWith(c => { c.createEl('input', { cls: 'vam-card-title-input' }); c.createDiv('vam-card-edit-hint'); c.createEl('p', { cls: 'vam-card-summary' }); });
  layout.arrangeCover(titleEdit.c, titleEdit.frame, 'bottom');
  assert.deepEqual(order(titleEdit.c), ['vam-card-title', 'vam-card-title-input', 'vam-card-edit-hint', 'vam-card-summary', 'vam-card-cover', 'vam-add-child'], 'a title edit keeps the picture under the summary');
});

test('arrangeCover: without a summary bottom follows the title; without a cover a side row is taken apart; an unbuilt card just gets the cover', () => {
  const { c, frame } = builtCard();
  c.children = c.children.filter(child => !child.cls.includes('vam-card-summary'));
  layout.arrangeCover(c, frame, 'bottom');
  assert.deepEqual(order(c).slice(1, 3), ['vam-card-title', 'vam-card-cover']);
  layout.arrangeCover(c, frame, 'left');
  frame.remove();
  layout.arrangeCover(c, null, 'left');
  assert.deepEqual(order(c), ['vam-node-header', 'vam-card-title', 'vam-card-error', 'vam-add-child', 'vam-card-fade']);
  const bare = dom.element('div');
  bare.createDiv('vam-node-header');
  const f = dom.element('div', { cls: 'vam-card-cover' });
  layout.arrangeCover(bare, f, 'left');
  assert.deepEqual(order(bare), ['vam-node-header', 'vam-card-cover']);
});

test('side layouts in the stylesheet: a row of picture and text, right reversed, and the clip rule for a short card', () => {
  const css = require('node:fs').readFileSync(require('node:path').join(__dirname, '../styles.css'), 'utf8');
  assert.match(css, /\.vam-node\.has-cover-right \.vam-card-side \{ flex-direction: row-reverse; \}/);
  assert.match(css, /\.vam-card-side-text \{ flex: 1 1 0; min-width: 0; \}/);
  assert.match(css, /\.vam-node\.is-clipped > \.vam-card-side \{ flex: 0 100 auto; min-height: 0; overflow: hidden; \}/, 'a short card cuts the row from its bottom');
  assert.match(css, /\.vam-card-side \{[^}]*align-items: flex-start/, 'the card is as tall as the taller column');
});

test('export: a placed title is drawn where the card has it', () => {
  const svg = ex.buildMapSvg({ width: 400, height: 400, cards: [{ x: 0, y: 0, w: 280, h: 200, title: 'Hello', titleAt: { x: 140, y: 30 }, cover: { x: 14, y: 22, w: 116, h: 80, href: 'data:image/png;base64,iVBORw0KGgo=', fit: 'contain' } }], edges: [] });
  assert.match(svg, /<text x="140" y="44"/);
  const old = ex.buildMapSvg({ width: 400, height: 400, cards: [{ x: 0, y: 0, w: 280, h: 200, title: 'Hello', titleAt: { x: 'bad', y: 30 } }], edges: [] });
  assert.match(old, /<text x="14" y="22"/, 'an invalid place falls back to the old rule');
});
