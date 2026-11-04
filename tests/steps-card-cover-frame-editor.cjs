// Card cover frame editor (cover-frame packet 03): the pure frame math, the dialog, and the one-undo write.
// The picture file is never changed or cropped; the dialog only edits the `topic-cover-frame` mask.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const S = require('./support.cjs');
const replay = require('./support-replay.cjs');
const dom = require('./support-dom.cjs');

const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const Modal = dom.makeModal();
const editor = S.load('experiences/visual-map/cover-frame-editor.ts', { obsidian: { ...S.obsidian, Modal } });
const cover = S.load('experiences/visual-map/card-cover.ts', { obsidian: { parseYaml: () => ({}), stringifyYaml: () => '', normalizePath: p => p } });
const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-9, `${message}: ${actual} vs ${expected}`);
const nearFrame = (actual, expected, message = 'frame') => {
  for (const key of ['x', 'y', 'w', 'h']) near(actual[key], expected[key], `${message}.${key}`);
};
const START = { x: 0.2, y: 0.3, w: 0.4, h: 0.4 };

// ---- pure math
test('frame math: moving by a delta keeps the size and stops at every picture edge', () => {
  nearFrame(editor.dragCoverFrame('move', START, 0.1, -0.1), { x: 0.3, y: 0.2, w: 0.4, h: 0.4 });
  nearFrame(editor.dragCoverFrame('move', START, 5, 5), { x: 0.6, y: 0.6, w: 0.4, h: 0.4 }, 'far bottom-right');
  nearFrame(editor.dragCoverFrame('move', START, -5, -5), { x: 0, y: 0, w: 0.4, h: 0.4 }, 'far top-left');
});

test('frame math: each edge handle moves only its own edge', () => {
  nearFrame(editor.dragCoverFrame('e', START, 0.1, 0.5), { x: 0.2, y: 0.3, w: 0.5, h: 0.4 });
  nearFrame(editor.dragCoverFrame('w', START, 0.1, 0.5), { x: 0.3, y: 0.3, w: 0.3, h: 0.4 });
  nearFrame(editor.dragCoverFrame('s', START, 0.5, 0.1), { x: 0.2, y: 0.3, w: 0.4, h: 0.5 });
  nearFrame(editor.dragCoverFrame('n', START, 0.5, 0.1), { x: 0.2, y: 0.4, w: 0.4, h: 0.3 });
});

test('frame math: a corner handle moves its two edges', () => {
  nearFrame(editor.dragCoverFrame('se', START, 0.1, 0.1), { x: 0.2, y: 0.3, w: 0.5, h: 0.5 });
  nearFrame(editor.dragCoverFrame('nw', START, 0.1, 0.1), { x: 0.3, y: 0.4, w: 0.3, h: 0.3 });
  nearFrame(editor.dragCoverFrame('ne', START, 0.1, 0.1), { x: 0.2, y: 0.4, w: 0.5, h: 0.3 });
  nearFrame(editor.dragCoverFrame('sw', START, 0.1, 0.1), { x: 0.3, y: 0.3, w: 0.3, h: 0.5 });
});

test('frame math: no side goes below 8 percent and nothing leaves the picture', () => {
  assert.equal(editor.MIN_FRAME_SIDE, 0.08);
  nearFrame(editor.dragCoverFrame('e', START, -5, 0), { x: 0.2, y: 0.3, w: 0.08, h: 0.4 }, 'east shrinks to the minimum');
  nearFrame(editor.dragCoverFrame('w', START, 5, 0), { x: 0.52, y: 0.3, w: 0.08, h: 0.4 }, 'west stops at the minimum, right edge fixed');
  nearFrame(editor.dragCoverFrame('s', START, 0, -5), { x: 0.2, y: 0.3, w: 0.4, h: 0.08 });
  nearFrame(editor.dragCoverFrame('n', START, 0, 5), { x: 0.2, y: 0.62, w: 0.4, h: 0.08 });
  nearFrame(editor.dragCoverFrame('se', START, 5, 5), { x: 0.2, y: 0.3, w: 0.8, h: 0.7 }, 'bottom-right stops at the picture');
  nearFrame(editor.dragCoverFrame('nw', START, -5, -5), { x: 0, y: 0, w: 0.6, h: 0.7 }, 'top-left stops at the picture');
  nearFrame(editor.dragCoverFrame('nw', START, 5, 5), { x: 0.52, y: 0.62, w: 0.08, h: 0.08 }, 'a corner squeezed to the minimum');
});

test('frame math: the start frame is not modified', () => {
  const copy = { ...START };
  editor.dragCoverFrame('se', START, 0.2, 0.2);
  assert.deepEqual(START, copy);
});

test('frame math: arrow keys move 1 percent; Shift+arrows resize from the bottom-right 1 percent', () => {
  nearFrame(editor.nudgeCoverFrame(START, 'ArrowRight', false), { x: 0.21, y: 0.3, w: 0.4, h: 0.4 });
  nearFrame(editor.nudgeCoverFrame(START, 'ArrowLeft', false), { x: 0.19, y: 0.3, w: 0.4, h: 0.4 });
  nearFrame(editor.nudgeCoverFrame(START, 'ArrowDown', false), { x: 0.2, y: 0.31, w: 0.4, h: 0.4 });
  nearFrame(editor.nudgeCoverFrame(START, 'ArrowUp', false), { x: 0.2, y: 0.29, w: 0.4, h: 0.4 });
  nearFrame(editor.nudgeCoverFrame(START, 'ArrowRight', true), { x: 0.2, y: 0.3, w: 0.41, h: 0.4 });
  nearFrame(editor.nudgeCoverFrame(START, 'ArrowLeft', true), { x: 0.2, y: 0.3, w: 0.39, h: 0.4 });
  nearFrame(editor.nudgeCoverFrame(START, 'ArrowDown', true), { x: 0.2, y: 0.3, w: 0.4, h: 0.41 });
  nearFrame(editor.nudgeCoverFrame(START, 'ArrowUp', true), { x: 0.2, y: 0.3, w: 0.4, h: 0.39 });
  assert.equal(editor.nudgeCoverFrame(START, 'a', false), null, 'another key is not handled');
});

test('frame math: keyboard moves and resizes clamp at the edges and the minimum', () => {
  nearFrame(editor.nudgeCoverFrame({ x: 0, y: 0, w: 0.4, h: 0.4 }, 'ArrowLeft', false), { x: 0, y: 0, w: 0.4, h: 0.4 });
  nearFrame(editor.nudgeCoverFrame({ x: 0.6, y: 0.6, w: 0.4, h: 0.4 }, 'ArrowDown', false), { x: 0.6, y: 0.6, w: 0.4, h: 0.4 });
  nearFrame(editor.nudgeCoverFrame({ x: 0.6, y: 0.6, w: 0.4, h: 0.4 }, 'ArrowRight', true), { x: 0.6, y: 0.6, w: 0.4, h: 0.4 }, 'cannot grow past the right edge');
  nearFrame(editor.nudgeCoverFrame({ x: 0.1, y: 0.1, w: 0.08, h: 0.08 }, 'ArrowLeft', true), { x: 0.1, y: 0.1, w: 0.08, h: 0.08 }, 'cannot shrink below 8 percent');
});

test('whole-picture frames are recognised, and they are written as no frame', () => {
  assert.equal(editor.isWholeFrame({ x: 0, y: 0, w: 1, h: 1 }), true);
  assert.equal(editor.isWholeFrame({ x: 0, y: 0, w: 0.99996, h: 1 }), true, 'inside the 4-decimal precision of the note');
  assert.equal(editor.isWholeFrame({ x: 0, y: 0, w: 0.99, h: 1 }), false);
  assert.equal(editor.isWholeFrame({ x: 0.01, y: 0, w: 0.99, h: 1 }), false);
  assert.equal(editor.frameToWrite({ x: 0, y: 0, w: 1, h: 1 }), null);
  assert.deepEqual(editor.frameToWrite(START), START);
});

// ---- the dialog
function openEditor({ initial = null, src = 'app://res/img/a.png' } = {}) {
  const applied = [];
  const modal = new editor.CoverFrameModal({}, { src, initial, onApply: async frame => { applied.push(frame); } });
  modal.open();
  const el = modal.contentEl;
  const stage = dom.find(el, i => dom.hasCls(i, 'vam-card-frame-stage'));
  stage.getBoundingClientRect = () => ({ left: 100, top: 50, width: 400, height: 200 });
  const box = dom.find(el, i => dom.hasCls(i, 'vam-card-frame-box'));
  const handle = name => dom.byLabel(el, name);
  const named = dom.findAll(el, i => i.tag === 'button' && dom.hasCls(i, 'vam-card-frame-handle'));
  const status = dom.find(el, i => dom.hasCls(i, 'vam-card-frame-status'));
  const text = label => dom.find(el, i => i.tag === 'button' && i.text === label);
  return { modal, el, stage, box, handle, named, status, text, applied };
}
const shown = ui => ({ x: parseFloat(ui.box.style.left), y: parseFloat(ui.box.style.top), w: parseFloat(ui.box.style.width), h: parseFloat(ui.box.style.height) });
const pointer = (target, type, x, y, extra = {}) => target.fire(type, { pointerId: 7, clientX: x, clientY: y, ...extra });
const withCapture = target => {
  const log = [];
  target.setPointerCapture = id => log.push(['set', id]);
  target.releasePointerCapture = id => log.push(['release', id]);
  target.hasPointerCapture = () => true;
  return log;
};

test('dialog: shows the whole picture, a frame box and eight handles that are real buttons with their own names', () => {
  const ui = openEditor({ initial: START });
  assert.equal(dom.find(ui.el, i => i.tag === 'img').attrs.src, 'app://res/img/a.png');
  assert.equal(ui.named.length, 8);
  const names = ui.named.map(b => b.attrs['aria-label']);
  assert.ok(names.every(Boolean), 'every handle has a name');
  assert.equal(new Set(names).size, 8, 'the names differ');
  assert.equal(ui.box.attrs.tabindex, '0', 'the frame can take focus');
  assert.equal(ui.box.attrs['aria-label'], undefined, 'no aria-label on the frame: Obsidian would show it as a tooltip over the status line');
  const labelId = ui.box.attrs['aria-labelledby'];
  const label = dom.find(ui.el, i => i.attrs.id === labelId);
  assert.ok(label && label.text, 'the frame is named through aria-labelledby');
  assert.deepEqual(shown(ui), { x: 20, y: 30, w: 40, h: 40 });
  assert.match(ui.status.text, /20/);
  assert.equal(ui.status.attrs['aria-live'], 'polite');
});

test('dialog: no frame starts as the whole picture', () => {
  assert.deepEqual(shown(openEditor()), { x: 0, y: 0, w: 100, h: 100 });
});

test('dialog: dragging the inside moves the frame with pointer capture and stops at the picture edge', () => {
  const ui = openEditor({ initial: START });
  const log = withCapture(ui.box);
  pointer(ui.box, 'pointerdown', 200, 100);
  assert.deepEqual(log[0], ['set', 7], 'pointer capture is taken');
  pointer(ui.box, 'pointermove', 240, 120); // +40px of 400 = +10%, +20px of 200 = +10%
  assert.deepEqual(shown(ui), { x: 30, y: 40, w: 40, h: 40 });
  pointer(ui.box, 'pointermove', 2000, 2000);
  assert.deepEqual(shown(ui), { x: 60, y: 60, w: 40, h: 40 });
  pointer(ui.box, 'pointerup', 2000, 2000);
  assert.deepEqual(log[log.length - 1], ['release', 7]);
  pointer(ui.box, 'pointermove', 100, 50);
  assert.deepEqual(shown(ui), { x: 60, y: 60, w: 40, h: 40 }, 'moves after release are ignored');
});

test('dialog: dragging a corner handle resizes, and the minimum holds', () => {
  const ui = openEditor({ initial: START });
  const se = ui.handle(ui.named[0].attrs['aria-label']);
  const handleOf = mode => ui.named.find(b => b.dataset.mode === mode);
  const corner = handleOf('se');
  assert.ok(se && corner);
  withCapture(corner);
  pointer(corner, 'pointerdown', 300, 130);
  pointer(corner, 'pointermove', 340, 150);
  assert.deepEqual(shown(ui), { x: 20, y: 30, w: 50, h: 50 });
  pointer(corner, 'pointermove', -9999, -9999);
  assert.deepEqual(shown(ui), { x: 20, y: 30, w: 8, h: 8 });
  pointer(corner, 'pointercancel', 0, 0);
  pointer(corner, 'pointermove', 400, 200);
  assert.deepEqual(shown(ui), { x: 20, y: 30, w: 8, h: 8 }, 'a cancelled drag stops following the pointer');
});

test('dialog: arrow keys move 1 percent and Shift+arrows resize from the bottom-right', () => {
  const ui = openEditor({ initial: START });
  let prevented = 0;
  ui.box.keydown({ key: 'ArrowRight', shiftKey: false, preventDefault() { prevented++; } });
  assert.deepEqual(shown(ui), { x: 21, y: 30, w: 40, h: 40 });
  ui.box.keydown({ key: 'ArrowDown', shiftKey: true });
  assert.deepEqual(shown(ui), { x: 21, y: 30, w: 40, h: 41 });
  assert.equal(prevented, 1, 'a handled arrow key does not scroll the page');
  ui.box.keydown({ key: 'a', shiftKey: false, preventDefault() { prevented++; } });
  assert.equal(prevented, 1, 'other keys are left alone');
  assert.match(ui.status.text, /21/, 'the status line follows');
});

test('dialog: reset puts the draft back to the whole picture without writing', () => {
  const ui = openEditor({ initial: START });
  ui.text('Reset to whole image').click();
  assert.deepEqual(shown(ui), { x: 0, y: 0, w: 100, h: 100 });
  assert.equal(ui.applied.length, 0);
});

test('dialog: apply hands over the frame once and closes; a whole-picture draft hands over null', async () => {
  const ui = openEditor({ initial: START });
  ui.box.keydown({ key: 'ArrowRight', shiftKey: false });
  ui.text('Apply').click();
  ui.text('Apply').click();
  await dom.tick();
  assert.equal(ui.applied.length, 1, 'a second click does not write again');
  nearFrame(ui.applied[0], { x: 0.21, y: 0.3, w: 0.4, h: 0.4 });
  assert.equal(ui.modal.closeCount, 1);
  const whole = openEditor({ initial: START });
  whole.text('Reset to whole image').click();
  whole.text('Apply').click();
  await dom.tick();
  assert.deepEqual(whole.applied, [null]);
});

test('dialog: cancel and close write nothing', async () => {
  const cancel = openEditor({ initial: START });
  cancel.box.keydown({ key: 'ArrowRight', shiftKey: false });
  cancel.text('Cancel').click();
  await dom.tick();
  assert.deepEqual(cancel.applied, []);
  assert.equal(cancel.modal.closeCount, 1);
  const close = openEditor({ initial: START });
  close.box.keydown({ key: 'ArrowRight', shiftKey: true });
  close.modal.close();
  await dom.tick();
  assert.deepEqual(close.applied, []);
});

test('dialog: a picture that cannot be loaded disables Apply', () => {
  const ui = openEditor({ initial: START });
  dom.find(ui.el, i => i.tag === 'img').fire('error');
  assert.equal(ui.text('Apply').disabled, true);
});

// ---- the write
const { begin } = S.load('experiences/visual-map/map-transaction.ts', { obsidian: S.obsidian });
const { VisualAgentMapView } = replay.load(
  'experiences/visual-map/view.ts',
  { obsidian: { ...S.obsidian, Component: class {}, MarkdownRenderChild: class {}, Modal } },
  { window: { setTimeout, clearTimeout }, CSS: { escape: s => s }, createDiv: o => dom.element('div', o), createEl: (tag, o) => dom.element(tag, o) }
);
const NOTE = 'Topics/m.md';
async function harness(text, { cache = { frontmatter: {}, embeds: [{ link: 'img/a.png' }] } } = {}) {
  const { repo, app, contents } = S.fixture('en', { linkIndex: true });
  await app.vault.create(NOTE, text);
  await app.vault.create('Topics/Map.md', S.core.serializeMap({ id: 'map-u', title: 'map-u', version: 1, nodes: [], viewport: { x: 0, y: 0, zoom: 1 } }));
  const view = Object.assign(Object.create(VisualAgentMapView.prototype), {
    app, selection: new (S.load('experiences/visual-map/topic-selection.ts').TopicSelection)(),
    plugin: { repo }, map: { nodes: [], viewport: { x: 0, y: 0, zoom: 1 } }, path: 'Topics/Map.md', history: { entries: [], push(entry) { this.entries.push(entry); } },
    beginMapTransaction: () => begin({ repo, rebuildDerivedData: async () => {}, onApplied: () => {}, checkConflict: async () => {} }),
    refreshAfterSavedChange: async () => {}
  });
  const vault = app.vault;
  const getFile = vault.getAbstractFileByPath.bind(vault);
  vault.getAbstractFileByPath = p => (p === 'img/a.png' ? new S.obsidian.TFile('img/a.png') : getFile(p));
  vault.getResourcePath = f => `app://res/${f.path}`;
  app.metadataCache = { getFileCache: () => cache, getFirstLinkpathDest: link => (link === 'img/a.png' ? new S.obsidian.TFile('img/a.png') : null) };
  return { view, contents };
}
const TEXT = '---\ntype: topic\ntitle: M\ntopic-color: red\n---\n\nBody line\n';

test('write: applying a frame is one history entry, one undo returns the note byte for byte, redo writes it again', async () => {
  const h = await harness(TEXT);
  const entry = await h.view.changeTopicCoverFrame({ id: 'm', path: NOTE }, START);
  assert.ok(entry);
  assert.equal(h.view.history.entries.length, 1, 'exactly one undo entry');
  assert.match(h.contents.get(NOTE), /topic-color: red\ntopic-cover-frame: "0\.2 0\.3 0\.4 0\.4"\n---\n\nBody line\n$/);
  await entry.undo();
  assert.equal(h.contents.get(NOTE), TEXT);
  await entry.redo();
  assert.match(h.contents.get(NOTE), /topic-cover-frame: "0\.2 0\.3 0\.4 0\.4"/);
});

test('write: a whole-picture frame removes the key, and undo brings the old frame line back', async () => {
  const framed = cover.withCoverFrame(TEXT, START);
  const h = await harness(framed);
  const entry = await h.view.changeTopicCoverFrame({ id: 'm', path: NOTE }, { x: 0, y: 0, w: 1, h: 1 });
  assert.doesNotMatch(h.contents.get(NOTE), /topic-cover-frame/);
  assert.equal(h.contents.get(NOTE), TEXT);
  await entry.undo();
  assert.equal(h.contents.get(NOTE), framed);
  const viaNull = await h.view.changeTopicCoverFrame({ id: 'm', path: NOTE }, null);
  assert.ok(viaNull);
  assert.equal(h.contents.get(NOTE), TEXT);
});

test('write: a topic that is not editable is refused and nothing is written', async () => {
  const h = await harness(TEXT);
  h.view.selection.toggleMultiSelect();
  assert.equal(await h.view.changeTopicCoverFrame({ id: 'm', path: NOTE }, START), null);
  assert.equal(h.contents.get(NOTE), TEXT);
  assert.equal(h.view.history.entries.length, 0);
});

test('open: the dialog starts from the note frame, and cancelling leaves the file byte-identical with no history', async () => {
  const framed = cover.withCoverFrame(TEXT, START);
  const h = await harness(framed, { cache: { frontmatter: { 'topic-cover-frame': '0.2 0.3 0.4 0.4' }, embeds: [{ link: 'img/a.png' }] } });
  let opened = null;
  const Real = h.view.openCoverFrameEditor;
  assert.equal(typeof Real, 'function');
  h.view.enqueue = fn => fn();
  const modal = h.view.openCoverFrameEditor({ id: 'm', path: NOTE });
  opened = modal;
  assert.ok(opened, 'a dialog opens for a note with a cover picture');
  const box = dom.find(opened.contentEl, i => dom.hasCls(i, 'vam-card-frame-box'));
  assert.equal(box.style.left, '20%');
  assert.equal(dom.find(opened.contentEl, i => i.tag === 'img').attrs.src, 'app://res/img/a.png');
  box.keydown({ key: 'ArrowRight', shiftKey: false });
  opened.close();
  await dom.tick();
  assert.equal(h.contents.get(NOTE), framed, 'byte-identical');
  assert.equal(h.view.history.entries.length, 0);
});

test('open: no dialog when the topic has no cover picture or the cover is off', async () => {
  for (const cache of [{ frontmatter: {}, embeds: [] }, { frontmatter: { 'topic-cover': 'none' }, embeds: [{ link: 'img/a.png' }] }]) {
    const h = await harness(TEXT, { cache });
    assert.equal(h.view.openCoverFrameEditor({ id: 'm', path: NOTE }), null);
  }
});

// ---- the panel button
test('panel: "Adjust area" appears with the cover switch only when the topic has a cover picture, and opens the dialog', async () => {
  const withPicture = await harness(TEXT);
  const calls = [];
  Object.assign(withPicture.view, { enqueue: fn => fn(), openCoverFrameEditor: node => { calls.push(node.id); return null; } });
  const panel = dom.element('div');
  withPicture.view.renderCoverSection(panel, { id: 'm', path: NOTE });
  const adjust = dom.find(panel, i => i.tag === 'button' && i.text === 'Adjust area');
  assert.ok(adjust, 'the button is there');
  adjust.click();
  assert.deepEqual(calls, ['m']);
  for (const cache of [{ frontmatter: {}, embeds: [] }, { frontmatter: { 'topic-cover': 'none' }, embeds: [{ link: 'img/a.png' }] }]) {
    const none = await harness(TEXT, { cache });
    const p = dom.element('div');
    none.view.renderCoverSection(p, { id: 'm', path: NOTE });
    assert.equal(dom.find(p, i => i.tag === 'button' && i.text === 'Adjust area'), undefined, 'no picture or cover off: no button');
  }
  const locked = await harness(TEXT);
  locked.view.selection.toggleMultiSelect();
  const p = dom.element('div');
  locked.view.renderCoverSection(p, { id: 'm', path: NOTE });
  assert.equal(dom.findAll(p, i => i.tag === 'button').length, 0, 'not editable: no section');
});

test('i18n: every language has the new strings; the stylesheet uses no CSS variable for the frame editor', () => {
  for (const lang of ['en', 'zh-TW', 'zh-CN']) {
    const text = read(`i18n/${lang}.ts`);
    for (const key of ['ui.topic_cover_frame_adjust', 'ui.topic_cover_frame_title', 'ui.topic_cover_frame_reset', 'ui.topic_cover_frame_apply', 'ui.topic_cover_frame_box', 'ui.topic_cover_frame_status', 'ui.topic_cover_frame_load_failed', 'ui.topic_cover_frame_handle_nw', 'ui.topic_cover_frame_handle_se'])
      assert.ok(text.includes(`"${key}"`), `${lang} ${key}`);
  }
  const lines = read('styles.css').split('\n').filter(l => /\.vam-card-frame/.test(l));
  assert.ok(lines.length >= 5);
  assert.doesNotMatch(lines.join('\n'), /var\(--/);
  assert.match(lines.join('\n'), /touch-action: none/);
});

test('decision 10: at a whole-picture frame every handle moves inward; away from the edges none does', () => {
  const whole = openEditor();
  for (const side of ['w', 'e', 'n', 's']) assert.ok(whole.box.classes.includes(`is-at-${side}`), side);
  const inner = openEditor({ initial: { x: 0.2, y: 0.2, w: 0.5, h: 0.5 } });
  assert.ok(!inner.box.classes.some(c => c.startsWith('is-at-')));
  const css = read('styles.css');
  assert.match(css, /\.vam-card-frame-box\.is-at-w[^{]*\{[^}]*margin-left: 9px/);
  assert.match(css, /\.vam-card-frame-box\.is-at-e[^{]*\{[^}]*margin-left: -9px/);
  assert.match(css, /\.vam-card-frame-box\.is-at-n[^{]*\{[^}]*margin-top: 9px/);
  assert.match(css, /\.vam-card-frame-box\.is-at-s[^{]*\{[^}]*margin-top: -9px/);
});

// ---- entries on the card itself (owner 2026-11-04: "I cannot click the picture to frame it")
const boxEl = (left, top, right, bottom) => ({ getBoundingClientRect: () => ({ left, top, right, bottom }) });
function dblHarnessView(view) {
  const calls = { open: [], rename: [] };
  view.openCoverFrameEditor = node => { calls.open.push(node.id); return {}; };
  view.renameNode = (node, name) => calls.rename.push(name);
  const cover = boxEl(0, 0, 200, 150);
  const title = boxEl(0, 160, 200, 180);
  const card = { querySelector: sel => (sel === '.vam-card-cover' ? cover : null) };
  const fire = (x, y, target = card) => {
    let prevented = false;
    view.onCardDoubleClick({ clientX: x, clientY: y, target, preventDefault() { prevented = true; } }, card, title, { id: 'm', path: NOTE }, 'M');
    return prevented;
  };
  return { calls, fire, cover, title, card };
}

test('card: double-clicking the cover picture opens "Adjust cover area"; the title still renames; elsewhere nothing', async () => {
  const h = await harness(TEXT);
  const d = dblHarnessView(h.view);
  assert.equal(d.fire(100, 75), true);
  assert.deepEqual(d.calls.open, ['m']);
  assert.deepEqual(d.calls.rename, []);
  d.fire(50, 170);
  assert.deepEqual(d.calls.rename, ['M']);
  d.fire(50, 400);
  assert.deepEqual([d.calls.open.length, d.calls.rename.length], [1, 1]);
  const picture = { closest: sel => (sel === '.vam-card-cover' ? d.cover : null) };
  assert.equal(d.fire(999, 999, picture), true, 'the picture itself as target opens the dialog too');
  assert.deepEqual(d.calls.open, ['m', 'm']);
});

test('card: when the dialog cannot open (cover off, not editable) a double-click on the picture does nothing', async () => {
  const h = await harness(TEXT);
  const d = dblHarnessView(h.view);
  h.view.openCoverFrameEditor = () => null;
  assert.equal(d.fire(100, 75), false);
  assert.deepEqual(d.calls.rename, []);
});

test('card: the right-click menu has "Adjust cover area" only for an editable topic with a cover picture', async () => {
  const items = h => {
    const titles = [];
    const menu = { addItem(fn) { const item = { setTitle(x) { titles.push(x); return item; }, setIcon() { return item; }, setWarning() { return item; }, onClick(cb) { item.cb = cb; return item; } }; fn(item); }, addSeparator() {} };
    h.view.notes = new Map([['m', { title: 'M', summary: 's' }]]);
    h.view.map = { nodes: [{ id: 'm', path: NOTE }], viewport: { x: 0, y: 0, zoom: 1 } };
    h.view.canEditText = () => false;
    h.view.addCardMenuActions(menu, h.view.map.nodes[0]);
    return titles;
  };
  assert.ok(items(await harness(TEXT)).includes('Adjust cover area'));
  for (const cache of [{ frontmatter: {}, embeds: [] }, { frontmatter: { 'topic-cover': 'none' }, embeds: [{ link: 'img/a.png' }] }])
    assert.equal(items(await harness(TEXT, { cache })).includes('Adjust cover area'), false);
  const locked = await harness(TEXT);
  locked.view.selection.toggleMultiSelect();
  assert.equal(items(locked).includes('Adjust cover area'), false);
});
