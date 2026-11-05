// Card cover frame editor, now the "Edit card" dialog (card editor 01): the pure frame math, the dialog, and the one-undo write.
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
const editor = S.load('experiences/visual-map/cover-frame-editor.ts', { obsidian: { ...S.obsidian, Modal } }, { createDiv: o => dom.element('div', o) });
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

// ---- the dialog ("Edit card", owner 2026-11-04): the real card in the middle, the mask edited on its cover.
// The test picture is 400 x 200 (shape 2) and the cover is 400 px wide, so one picture width is 400 px and one picture
// height 200 px on screen.
const plainCard = () => {
  const c = dom.element('div', { cls: 'vam-node' });
  c.style.width = '300px';
  c.createDiv('vam-node-header');
  c.createEl('h3', { cls: 'vam-card-title', text: 'Topic title' });
  c.createEl('p', { cls: 'vam-card-summary', text: 'Summary' });
  return c;
};
function openEditor({ initial = null, src = 'app://res/img/a.png', shape = 2, card = plainCard } = {}) {
  const applied = [];
  const modal = new editor.CoverFrameModal({}, { src, initial, shape, card, onApply: async frame => { applied.push(frame); } });
  modal.open();
  const el = modal.contentEl;
  const cardEl = dom.find(el, i => dom.hasCls(i, 'vam-node'));
  const cover = dom.find(el, i => dom.hasCls(i, 'vam-card-cover'));
  cover.getBoundingClientRect = () => ({ left: 100, top: 50, width: 400, height: 200 });
  const box = dom.find(el, i => dom.hasCls(i, 'vam-card-frame-box'));
  const win = dom.find(el, i => dom.hasCls(i, 'vam-card-cover-window'));
  const named = dom.findAll(el, i => i.tag === 'button' && dom.hasCls(i, 'vam-card-frame-handle'));
  const handleOf = mode => named.find(b => b.dataset.mode === mode);
  const status = dom.find(el, i => dom.hasCls(i, 'vam-card-frame-status'));
  const text = label => dom.find(el, i => i.tag === 'button' && i.text === label);
  return { modal, el, cardEl, cover, box, win, named, handleOf, status, text, applied };
}
const pct = v => Math.round(v * 1e6) / 1e4;
const shown = ui => { const f = ui.modal.draft; return { x: pct(f.x), y: pct(f.y), w: pct(f.w), h: pct(f.h) }; };
const pointer = (target, type, x, y, extra = {}) => target.fire(type, { pointerId: 7, clientX: x, clientY: y, ...extra });
const withCapture = target => {
  const log = [];
  target.setPointerCapture = id => log.push(['set', id]);
  target.releasePointerCapture = id => log.push(['release', id]);
  target.hasPointerCapture = () => true;
  return log;
};
const num = value => parseFloat(value);

test('dialog: titled "Edit card"; the card itself sits in the middle with its own width, and only its cover, width handle, title and summary take input', () => {
  const ui = openEditor({ initial: START });
  assert.equal(ui.modal.titleEl.text, 'Edit card');
  assert.ok(ui.cardEl, 'the card is in the dialog');
  assert.equal(ui.cardEl.style.width, '300px', 'the card keeps its own width');
  assert.equal(ui.cardEl.children[1], ui.cover, 'the cover takes the cover place: after the header, before the title');
  // The card-width handle (ticket 04) also takes input; everything else is shown, not edited.
  // Ticket 05: the title and the summary take input too.
  const live = child => child === ui.cover || ['vam-card-frame-width', 'vam-card-title', 'vam-card-summary'].some(name => dom.hasCls(child, name));
  for (const child of ui.cardEl.children) assert.equal(child.attrs.inert, live(child) ? undefined : '', dom.hasCls(child, 'vam-card-cover') ? 'cover' : child.cls);
  assert.equal(dom.findAll(ui.el, i => dom.hasCls(i, 'vam-card-frame-image')).length, 0, 'no separate picture view');
});

test('dialog: an old cover in the copied card is replaced, not doubled', () => {
  const card = () => { const c = plainCard(); c.insertBefore(dom.element('div', { cls: 'vam-card-cover' }), c.children[1]); return c; };
  const ui = openEditor({ card });
  assert.equal(dom.findAll(ui.cardEl, i => dom.hasCls(i, 'vam-card-cover')).length, 1);
});

test('dialog: the cover is laid out by the map rule, and eight handles are real buttons with their own names', () => {
  const ui = openEditor({ initial: START });
  assert.equal(dom.findAll(ui.win, i => i.tag === 'img')[0].attrs.src, 'app://res/img/a.png');
  assert.equal(ui.named.length, 8);
  const names = ui.named.map(b => b.attrs['aria-label']);
  assert.ok(names.every(Boolean), 'every handle has a name');
  assert.equal(new Set(names).size, 8, 'the names differ');
  assert.equal(ui.cover.attrs.tabindex, '0', 'the cover can take focus');
  assert.equal(ui.cover.attrs['aria-label'], undefined, 'no aria-label: Obsidian would show it as a tooltip');
  const label = dom.find(ui.el, i => i.attrs.id === ui.cover.attrs['aria-labelledby']);
  assert.ok(label && label.text, 'the cover is named through aria-labelledby');
  // Window: 0.4 D wide at 0.2 D; region 0.4 x 0.4 of a 2:1 picture -> 0.4 D x 0.2 D, so the cover is D / 0.2 D = 5.
  near(num(ui.win.style.left), 20, 'window left');
  near(num(ui.win.style.width), 40, 'window width');
  near(Number(ui.win.style['aspect-ratio']), 2, 'window shape');
  near(Number(ui.cover.style['aspect-ratio']), 5, 'cover shape');
  for (const key of ['left', 'width', 'aspect-ratio']) assert.equal(ui.box.style[key], ui.win.style[key], `the mask box follows the window: ${key}`);
});

test('dialog: no percentage is shown; the numbers are only for screen readers', () => {
  const ui = openEditor({ initial: START });
  assert.ok(dom.hasCls(ui.status, 'vam-sr-only'), 'the status line is screen-reader text');
  assert.equal(ui.status.attrs['aria-live'], 'polite');
  assert.match(ui.status.text, /20/);
  const visible = dom.findAll(ui.el, i => i !== ui.status && i.text && !dom.hasCls(i, 'vam-card-frame-label')).map(i => i.text).join(' | ');
  assert.doesNotMatch(visible, /%/);
});

test('dialog: no frame starts as the whole picture', () => {
  assert.deepEqual(shown(openEditor()), { x: 0, y: 0, w: 100, h: 100 });
});

test('dialog: dragging inside moves the mask with pointer capture over the still picture, and stops at the picture edge', () => {
  const ui = openEditor({ initial: START });
  const log = withCapture(ui.box);
  pointer(ui.box, 'pointerdown', 200, 100);
  assert.deepEqual(log[0], ['set', 7], 'pointer capture is taken');
  assert.ok(dom.hasCls(ui.cover, 'is-dragging'), 'the faint whole picture shows while dragging');
  pointer(ui.box, 'pointermove', 240, 120); // +40px of 400 = +10% of the picture width, +20px of 200 = +10% of its height
  assert.deepEqual(shown(ui), { x: 30, y: 40, w: 40, h: 40 });
  near(num(ui.win.style.left), 30, 'the window slides right with the pointer');
  near(num(ui.win.style.width), 40, 'and keeps its size');
  near(num(/translateY\(([-\d.e]+)%\)/.exec(ui.win.style.transform)[1]), 25, 'and moves down by the same 0.1 picture height (0.1 / 0.4 of itself)');
  const ghost = dom.find(ui.el, i => dom.hasCls(i, 'vam-card-frame-ghost'));
  near(num(ghost.style.left), 0, 'the picture does not move');
  near(num(ghost.style.top), -75, 'the picture top stays where it was at the start (0.3 picture heights above)');
  pointer(ui.box, 'pointermove', 2000, 2000);
  assert.deepEqual(shown(ui), { x: 60, y: 60, w: 40, h: 40 });
  pointer(ui.box, 'pointerup', 2000, 2000);
  assert.deepEqual(log[log.length - 1], ['release', 7]);
  assert.ok(!dom.hasCls(ui.cover, 'is-dragging'));
  assert.equal(ui.win.style.transform, 'translateY(0%)', 'after the drag the window starts at the top of the cover again, as on the map');
  pointer(ui.box, 'pointermove', 100, 50);
  assert.deepEqual(shown(ui), { x: 60, y: 60, w: 40, h: 40 }, 'moves after release are ignored');
});

test('dialog: a handle hides its side and the picture keeps its scale; left and right hiding keep the rest in place', () => {
  const ui = openEditor();
  const scale = () => num(ui.win.style.width) / (ui.modal.draft.w * 100);
  const w = ui.handleOf('w');
  withCapture(w);
  pointer(w, 'pointerdown', 100, 150);
  pointer(w, 'pointermove', 200, 150); // 100px of 400 = hide the left quarter
  assert.deepEqual(shown(ui), { x: 25, y: 0, w: 75, h: 100 });
  near(num(ui.win.style.left), 25, 'the rest stays where it was (it does not move left)');
  near(scale(), 1, 'nor does it stretch');
  near(Number(ui.cover.style['aspect-ratio']), 2, 'hiding a side does not change the height');
  pointer(w, 'pointerup', 200, 150);
  const n = ui.handleOf('n');
  withCapture(n);
  pointer(n, 'pointerdown', 250, 50);
  pointer(n, 'pointermove', 250, 100); // 50px of 200 = hide the top quarter
  assert.deepEqual(shown(ui), { x: 25, y: 25, w: 75, h: 75 });
  near(Number(ui.cover.style['aspect-ratio']), 1 / (0.75 * 0.5), 'hiding the top makes the cover, and so the card, shorter');
  near(scale(), 1, 'the picture keeps its scale');
  pointer(n, 'pointerup', 250, 100);
});

test('dialog: dragging a corner handle moves two sides, and the 8 percent minimum holds', () => {
  const ui = openEditor({ initial: START });
  const corner = ui.handleOf('se');
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

test('dialog: touch works the same way (pointer events), and a touch shows the handles', () => {
  const ui = openEditor({ initial: START });
  withCapture(ui.box);
  pointer(ui.box, 'pointerdown', 200, 100, { pointerType: 'touch', pointerId: 3 });
  pointer(ui.box, 'pointermove', 160, 100, { pointerType: 'touch', pointerId: 3 });
  assert.deepEqual(shown(ui), { x: 10, y: 30, w: 40, h: 40 });
  pointer(ui.box, 'pointermove', 100, 100, { pointerType: 'touch', pointerId: 9 });
  assert.deepEqual(shown(ui), { x: 10, y: 30, w: 40, h: 40 }, 'another finger does not take over');
  assert.ok(dom.hasCls(ui.cover, 'is-active'), 'handles stay visible after a touch');
});

test('dialog: arrow keys move the mask 1 percent, Shift+arrows resize from the bottom-right, a handle moves only its edges', () => {
  const ui = openEditor({ initial: START });
  let prevented = 0;
  ui.cover.keydown({ key: 'ArrowRight', shiftKey: false, preventDefault() { prevented++; } });
  assert.deepEqual(shown(ui), { x: 21, y: 30, w: 40, h: 40 });
  ui.cover.keydown({ key: 'ArrowDown', shiftKey: true });
  assert.deepEqual(shown(ui), { x: 21, y: 30, w: 40, h: 41 });
  assert.equal(prevented, 1, 'a handled arrow key does not scroll the page');
  ui.cover.keydown({ key: 'a', shiftKey: false, preventDefault() { prevented++; } });
  assert.equal(prevented, 1, 'other keys are left alone');
  assert.match(ui.status.text, /21/, 'the screen-reader status follows');
  let stopped = 0;
  ui.handleOf('w').keydown({ key: 'ArrowRight', preventDefault() {}, stopPropagation() { stopped++; } });
  assert.deepEqual(shown(ui), { x: 22, y: 30, w: 39, h: 41 }, 'the left handle hides 1 percent more of the left');
  assert.equal(stopped, 1, 'the cover does not also move the mask');
  ui.handleOf('w').keydown({ key: 'ArrowDown', preventDefault() {}, stopPropagation() {} });
  assert.deepEqual(shown(ui), { x: 22, y: 30, w: 39, h: 41 }, 'an edge handle ignores the other direction');
  ui.handleOf('ne').keydown({ key: 'ArrowUp', preventDefault() {}, stopPropagation() {} });
  assert.deepEqual(shown(ui), { x: 22, y: 29, w: 39, h: 42 });
});

test('handle keys: pure edge nudges clamp like drags', () => {
  nearFrame(editor.nudgeCoverFrameEdge('e', START, 'ArrowRight'), { x: 0.2, y: 0.3, w: 0.41, h: 0.4 });
  nearFrame(editor.nudgeCoverFrameEdge('s', START, 'ArrowUp'), { x: 0.2, y: 0.3, w: 0.4, h: 0.39 });
  nearFrame(editor.nudgeCoverFrameEdge('nw', { x: 0, y: 0, w: 0.5, h: 0.5 }, 'ArrowLeft'), { x: 0, y: 0, w: 0.5, h: 0.5 });
  assert.equal(editor.nudgeCoverFrameEdge('n', START, 'ArrowLeft'), null);
  assert.equal(editor.nudgeCoverFrameEdge('e', START, 'Enter'), null);
});

test('dialog: "Show whole picture" puts the draft back to the whole picture without writing', () => {
  const ui = openEditor({ initial: START });
  ui.text('Show whole picture').click();
  assert.deepEqual(shown(ui), { x: 0, y: 0, w: 100, h: 100 });
  near(num(ui.win.style.left), 0, 'whole picture: from the left edge');
  near(num(ui.win.style.width), 100, 'whole picture: full width');
  assert.equal(ui.applied.length, 0);
});

test('dialog: apply hands over the frame once and closes; a whole-picture draft hands over null', async () => {
  const ui = openEditor({ initial: START });
  ui.cover.keydown({ key: 'ArrowRight', shiftKey: false });
  ui.text('Apply').click();
  ui.text('Apply').click();
  await dom.tick();
  assert.equal(ui.applied.length, 1, 'a second click does not write again');
  nearFrame(ui.applied[0].frame, { x: 0.21, y: 0.3, w: 0.4, h: 0.4 });
  assert.equal(ui.applied[0].size, 1, 'the size is handed over with the frame (default)');
  assert.equal(ui.modal.closeCount, 1);
  const whole = openEditor({ initial: START });
  whole.text('Show whole picture').click();
  whole.text('Apply').click();
  await dom.tick();
  assert.deepEqual(whole.applied.map(edit => edit.frame), [null]);
});

test('dialog: Cancel and closing write nothing, after a mask move, a size change or a position change; a note without a size starts at 100 percent', async () => {
  {
    const cancel = openEditor({ initial: START });
    cancel.cover.keydown({ key: 'ArrowRight', shiftKey: false });
    cancel.text('Cancel').click();
    await dom.tick();
    assert.deepEqual(cancel.applied, []);
    assert.equal(cancel.modal.closeCount, 1);
    const close = openEditor({ initial: START });
    close.cover.keydown({ key: 'ArrowRight', shiftKey: true });
    close.modal.close();
    await dom.tick();
    assert.deepEqual(close.applied, []);
  }
  {
    const applied = [];
    const modal = new editor.CoverFrameModal({}, { src: 'x', initial: null, shape: 2, card: plainCard, onApply: async edit => { applied.push(edit); } });
    modal.open();
    const slider = dom.find(modal.contentEl, i => i.tag === 'input');
    assert.equal(slider.value, '100');
    slider.value = '50';
    slider.input();
    modal.close();
    await dom.tick();
    assert.deepEqual(applied, []);
  }
  {
    const cancel = openPlaced();
    cancel.choice('Left').click();
    cancel.modal.close();
    await dom.tick();
    assert.deepEqual(cancel.applied, []);
  }
});

test('dialog: a picture that cannot be loaded disables Apply and says so', () => {
  const ui = openEditor({ initial: START });
  dom.find(ui.win, i => i.tag === 'img').fire('error');
  assert.equal(ui.text('Apply').disabled, true);
  assert.ok(dom.find(ui.el, i => dom.hasCls(i, 'vam-card-frame-error')));
});

test('dialog: without a known shape the cover waits for the picture, then sizes from it', () => {
  const ui = openEditor({ initial: START, shape: null });
  assert.equal(ui.cover.style['aspect-ratio'], undefined, 'the 96 px placeholder until the picture is measured');
  pointer(ui.box, 'pointerdown', 200, 100);
  assert.ok(!dom.hasCls(ui.cover, 'is-dragging'), 'no drag before the size is known');
  const img = dom.find(ui.win, i => i.tag === 'img');
  img.naturalWidth = 400; img.naturalHeight = 200;
  img.fire('load');
  near(Number(ui.cover.style['aspect-ratio']), 5, 'sized from the loaded picture');
});

test('dialog: without a card the dialog still edits a plain card', () => {
  const ui = openEditor({ initial: START, card: undefined });
  assert.ok(ui.cardEl && ui.cover);
});

// ---- the write
const { begin } = S.load('experiences/visual-map/map-transaction.ts', { obsidian: S.obsidian });
const { VisualAgentMapView } = replay.load(
  'experiences/visual-map/view.ts',
  { obsidian: { ...S.obsidian, Component: class {}, MarkdownRenderChild: class {}, Modal } },
  { window: { setTimeout, clearTimeout }, CSS: { escape: s => s }, createDiv: o => dom.element('div', o), createEl: (tag, o) => dom.element(tag, o) }
);
const NOTE = 'Topics/m.md';
const { History } = S.load('map-model.ts');
const realHistory = () => { const history = new History(); Object.defineProperty(history, 'entries', { get: () => history.past }); return history; };
async function harness(text, { cache = { frontmatter: {}, embeds: [{ link: 'img/a.png' }] }, nodes = [] } = {}) {
  const { repo, app, contents } = S.fixture('en', { linkIndex: true });
  await app.vault.create(NOTE, text);
  await app.vault.create('Topics/Map.md', S.core.serializeMap({ id: 'map-u', title: 'map-u', version: 1, nodes, viewport: { x: 0, y: 0, zoom: 1 } }));
  const view = Object.assign(Object.create(VisualAgentMapView.prototype), {
    app, selection: new (S.load('experiences/visual-map/topic-selection.ts').TopicSelection)(), updateHistoryButtons() {},
    plugin: { repo }, map: { nodes: JSON.parse(JSON.stringify(nodes)), viewport: { x: 0, y: 0, zoom: 1 } }, path: 'Topics/Map.md', history: realHistory(),
    beginMapTransaction: () => begin({ repo, rebuildDerivedData: async () => {}, onApplied: () => {}, checkConflict: async () => {} }),
    refreshAfterSavedChange: async () => {}
  });
  const vault = app.vault;
  const getFile = vault.getAbstractFileByPath.bind(vault);
  vault.getAbstractFileByPath = p => (p === 'img/a.png' ? new S.obsidian.TFile('img/a.png') : getFile(p));
  vault.getResourcePath = f => `app://res/${f.path}`;
  app.metadataCache = { getFileCache: () => cache, getFirstLinkpathDest: link => (link === 'img/a.png' ? new S.obsidian.TFile('img/a.png') : null) };
  return { view, contents, repo };
}
const TEXT = '---\ntype: topic\ntitle: M\ntopic-color: red\n---\n\nBody line\n';

test('write: frame, size and position are ONE history entry; one undo returns the note byte for byte, redo writes it again', async () => {
  {
    // frame only: no size or position line appears
    const h = await harness(TEXT);
    const entry = await h.view.changeTopicCoverFrame({ id: 'm', path: NOTE }, START);
    assert.ok(entry);
    assert.equal(h.view.history.entries.length, 1, 'exactly one undo entry');
    assert.match(h.contents.get(NOTE), /topic-color: red\ntopic-cover-frame: "0\.2 0\.3 0\.4 0\.4"\n---\n\nBody line\n$/);
    await entry.undo();
    assert.equal(h.contents.get(NOTE), TEXT);
    await entry.redo();
    assert.match(h.contents.get(NOTE), /topic-cover-frame: "0\.2 0\.3 0\.4 0\.4"/);
  }
  {
    // frame + size, and the default size removes the key
    const h = await harness(TEXT);
    const entry = await h.view.changeTopicCoverFrame({ id: 'm', path: NOTE }, START, { size: 0.5 });
    assert.equal(h.view.history.entries.length, 1, 'exactly one undo entry');
    assert.match(h.contents.get(NOTE), /topic-cover-frame: "0\.2 0\.3 0\.4 0\.4"\ntopic-cover-size: "0\.5"\n---/);
    await entry.undo();
    assert.equal(h.contents.get(NOTE), TEXT);
    const sized = await harness('---\ntype: topic\ntopic-cover-size: "0.5"\n---\n');
    await sized.view.changeTopicCoverFrame({ id: 'm', path: NOTE }, null, { size: 1 });
    assert.equal(sized.contents.get(NOTE), '---\ntype: topic\n---\n', 'the default size removes the key');
  }
  {
    // frame + size + position
    const h = await harness(TEXT);
    const entry = await h.view.changeTopicCoverFrame({ id: 'm', path: NOTE }, START, { size: 0.45, position: 'left' });
    assert.equal(h.view.history.entries.length, 1);
    assert.match(h.contents.get(NOTE), /topic-cover-frame: "0\.2 0\.3 0\.4 0\.4"\ntopic-cover-size: "0\.45"\ntopic-cover-position: "left"\n---/);
    await entry.undo();
    assert.equal(h.contents.get(NOTE), TEXT);
  }
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

test('open: the dialog starts from the note frame and shows the cover picture', async () => {
  const framed = cover.withCoverFrame(TEXT, START);
  const h = await harness(framed, { cache: { frontmatter: { 'topic-cover-frame': '0.2 0.3 0.4 0.4' }, embeds: [{ link: 'img/a.png' }] } });
  let opened = null;
  const Real = h.view.openCoverFrameEditor;
  assert.equal(typeof Real, 'function');
  h.view.enqueue = fn => fn();
  const modal = h.view.openCoverFrameEditor({ id: 'm', path: NOTE });
  opened = modal;
  assert.ok(opened, 'a dialog opens for a note with a cover picture');
  nearFrame(opened.draft, START, 'the dialog starts from the note frame');
  assert.equal(dom.find(dom.find(opened.contentEl, i => dom.hasCls(i, 'vam-card-cover-window')), i => i.tag === 'img').attrs.src, 'app://res/img/a.png');
});

test('open: Cancel or closing the dialog, after any change, leaves note and map bytes unchanged with no history', async () => {
  {
    // a framed note, closed after a mask move
      const framed = cover.withCoverFrame(TEXT, START);
      const h = await harness(framed, { cache: { frontmatter: { 'topic-cover-frame': '0.2 0.3 0.4 0.4' }, embeds: [{ link: 'img/a.png' }] } });
      let opened = null;
      const Real = h.view.openCoverFrameEditor;
      assert.equal(typeof Real, 'function');
      h.view.enqueue = fn => fn();
      const modal = h.view.openCoverFrameEditor({ id: 'm', path: NOTE });
      opened = modal;
      assert.ok(opened, 'a dialog opens for a note with a cover picture');
      nearFrame(opened.draft, START, 'the dialog starts from the note frame');
      assert.equal(dom.find(dom.find(opened.contentEl, i => dom.hasCls(i, 'vam-card-cover-window')), i => i.tag === 'img').attrs.src, 'app://res/img/a.png');
      dom.find(opened.contentEl, i => dom.hasCls(i, 'vam-card-cover')).keydown({ key: 'ArrowRight', shiftKey: false });
      opened.close();
      await dom.tick();
      assert.equal(h.contents.get(NOTE), framed, 'byte-identical');
      assert.equal(h.view.history.entries.length, 0);
  }
  {
    // a width change, closed
      const h = await harness(TEXT, { nodes: mapNodes() });
      const mapBefore = await h.repo.readMap('Topics/Map.md');
      h.view.enqueue = fn => fn();
      const modal = h.view.openCoverFrameEditor({ id: 'm', path: NOTE, width: 360 });
      const handle = dom.find(modal.contentEl, i => dom.hasCls(i, 'vam-card-frame-width'));
      assert.equal(handle.attrs['aria-valuenow'], '360', 'starts at the map width');
      handle.keydown({ key: 'End' });
      modal.close();
      await dom.tick();
      assert.equal(h.contents.get(NOTE), TEXT);
      assert.deepEqual(await h.repo.readMap('Topics/Map.md'), mapBefore);
      assert.equal(h.view.history.entries.length, 0);
  }
  {
    // a typed title and summary, Cancel button
      const h = await textHarness();
      const mapBefore = await h.repo.readMap('Topics/Map.md');
      const ui = openText(h);
      ui.type(ui.title, 'Nope');
      ui.type(ui.summary, 'Nope either');
      ui.cancel.click();
      await dom.tick(); await dom.tick();
      assert.equal(noteOf(h), SUMMARY_TEXT);
      assert.deepEqual(await h.repo.readMap('Topics/Map.md'), mapBefore);
      assert.equal(h.view.history.past.length, 0);
  }
});

test('open: no dialog when the topic has no cover picture or the cover is off', async () => {
  for (const cache of [{ frontmatter: {}, embeds: [] }, { frontmatter: { 'topic-cover': 'none' }, embeds: [{ link: 'img/a.png' }] }]) {
    const h = await harness(TEXT, { cache });
    assert.equal(h.view.openCoverFrameEditor({ id: 'm', path: NOTE }), null);
  }
});

// ---- the panel button
test('panel: "Edit card" appears with the cover switch only when the topic has a cover picture, and opens the dialog', async () => {
  const withPicture = await harness(TEXT);
  const calls = [];
  Object.assign(withPicture.view, { enqueue: fn => fn(), openCoverFrameEditor: node => { calls.push(node.id); return null; } });
  const panel = dom.element('div');
  withPicture.view.renderCoverSection(panel, { id: 'm', path: NOTE });
  const adjust = dom.find(panel, i => i.tag === 'button' && i.text === 'Edit card');
  assert.ok(adjust, 'the button is there');
  adjust.click();
  assert.deepEqual(calls, ['m']);
  for (const cache of [{ frontmatter: {}, embeds: [] }, { frontmatter: { 'topic-cover': 'none' }, embeds: [{ link: 'img/a.png' }] }]) {
    const none = await harness(TEXT, { cache });
    const p = dom.element('div');
    none.view.renderCoverSection(p, { id: 'm', path: NOTE });
    assert.equal(dom.find(p, i => i.tag === 'button' && i.text === 'Edit card'), undefined, 'no picture or cover off: no button');
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

test('the dialog cover does not clip its handles: it overflows the card box instead of moving them inward', () => {
  const css = read('styles.css');
  assert.match(css, /\.vam-card-frame-stage \.vam-card-cover\.is-framed \{[^}]*overflow: visible/);
  assert.doesNotMatch(css, /is-at-[nswe]/, 'no inward-moved handles any more');
  assert.match(css, /\.vam-card-cover:hover \.vam-card-frame-handle[^{]*\{[^}]*opacity: 1/, 'handles show on hover, focus or touch');
});

// ---- entries on the card itself (owner 2026-11-04: "I cannot click the picture to frame it")
const boxEl = (left, top, right, bottom) => ({ getBoundingClientRect: () => ({ left, top, right, bottom }) });
function dblHarnessView(view) {
  const calls = { open: [], rename: [] };
  view.openCoverFrameEditor = node => { calls.open.push(node.id); return {}; };
  view.startCardTitleEdit = node => calls.rename.push(node.id);
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

test('card: double-clicking the cover picture opens "Edit card"; the title edits in place; elsewhere nothing', async () => {
  const h = await harness(TEXT);
  const d = dblHarnessView(h.view);
  assert.equal(d.fire(100, 75), true);
  assert.deepEqual(d.calls.open, ['m']);
  assert.deepEqual(d.calls.rename, []);
  d.fire(50, 170);
  assert.deepEqual(d.calls.rename, ['m']);
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

test('card: the right-click menu has "Edit card" only for an editable topic with a cover picture', async () => {
  const items = h => {
    const titles = [];
    const menu = { addItem(fn) { const item = { setTitle(x) { titles.push(x); return item; }, setIcon() { return item; }, setWarning() { return item; }, onClick(cb) { item.cb = cb; return item; } }; fn(item); }, addSeparator() {} };
    h.view.notes = new Map([['m', { title: 'M', summary: 's' }]]);
    h.view.map = { nodes: [{ id: 'm', path: NOTE }], viewport: { x: 0, y: 0, zoom: 1 } };
    h.view.canEditText = () => false;
    h.view.addCardMenuActions(menu, h.view.map.nodes[0]);
    return titles;
  };
  assert.ok(items(await harness(TEXT)).includes('Edit card'));
  for (const cache of [{ frontmatter: {}, embeds: [] }, { frontmatter: { 'topic-cover': 'none' }, embeds: [{ link: 'img/a.png' }] }])
    assert.equal(items(await harness(TEXT, { cache })).includes('Edit card'), false);
  const locked = await harness(TEXT);
  locked.view.selection.toggleMultiSelect();
  assert.equal(items(locked).includes('Edit card'), false);
});

// ---- ticket 02: the picture size slider
test('size slider: in the tool row above the card, 30-100 percent, starts from the note; it narrows the cover and never changes the mask', async () => {
  const applied = [];
  const modal = new editor.CoverFrameModal({}, { src: 'app://res/img/a.png', initial: START, size: 0.8, shape: 2, card: plainCard, onApply: async edit => { applied.push(edit); } });
  modal.open();
  const el = modal.contentEl;
  const tools = dom.find(el, i => dom.hasCls(i, 'vam-card-frame-tools'));
  const stage = dom.find(el, i => dom.hasCls(i, 'vam-card-frame-stage'));
  assert.ok(el.children.indexOf(tools) < el.children.indexOf(stage), 'the tool row is above the card');
  const slider = dom.find(tools, i => i.tag === 'input');
  assert.equal(slider.type, 'range');
  assert.deepEqual([slider.attrs.min, slider.attrs.max], ['30', '100']);
  assert.equal(slider.value, '80');
  assert.ok(dom.findAll(tools, i => i.text === 'Picture size').length, 'labelled "Picture size"');
  const cover = dom.find(el, i => dom.hasCls(i, 'vam-card-cover'));
  assert.equal(cover.style.width, '80%');
  slider.value = '45';
  slider.input();
  assert.equal(cover.style.width, '45%', 'the cover follows the slider at once');
  assert.equal(slider.attrs['aria-valuetext'], '45%');
  nearFrame(modal.draft, START, 'the mask is the same region');
  const win = dom.find(el, i => dom.hasCls(i, 'vam-card-cover-window'));
  near(parseFloat(win.style.left), 20, 'and sits at the same share of D');
  slider.value = '10';
  slider.input();
  assert.equal(cover.style.width, '30%', 'held at the minimum');
  slider.value = '100';
  slider.change();
  assert.equal(cover.style.width, undefined, 'full size: the stylesheet width');
  slider.value = '45';
  slider.input();
  dom.find(el, i => i.tag === 'button' && i.text === 'Apply').click();
  await dom.tick();
  assert.equal(applied.length, 1);
  assert.equal(applied[0].size, 0.45);
  nearFrame(applied[0].frame, START);
});

test('open: the dialog gets the note size, and Apply sends frame and size to one write', async () => {
  const h = await harness(TEXT, { cache: { frontmatter: { 'topic-cover-size': '0.6' }, embeds: [{ link: 'img/a.png' }] } });
  h.view.enqueue = fn => fn();
  const modal = h.view.openCoverFrameEditor({ id: 'm', path: NOTE });
  assert.equal(dom.find(modal.contentEl, i => i.tag === 'input').value, '60');
  dom.find(modal.contentEl, i => i.tag === 'button' && i.text === 'Apply').click();
  await dom.tick(); await dom.tick();
  assert.match(h.contents.get(NOTE), /topic-cover-size: "0\.6"/);
  assert.equal(h.view.history.entries.length, 1);
});

// ---- ticket 03: picture position (top, bottom, left, right)
function openPlaced({ size = 1, position, initial = START } = {}) {
  const applied = [];
  const modal = new editor.CoverFrameModal({}, { src: 'x', initial, size, position, shape: 2, card: plainCard, onApply: async edit => { applied.push(edit); } });
  modal.open();
  const el = modal.contentEl;
  const choices = dom.findAll(el, i => i.tag === 'button' && dom.hasCls(i, 'vam-card-frame-position'));
  const choice = name => choices.find(b => b.text === name);
  const slider = dom.find(el, i => i.tag === 'input');
  const cardEl = dom.find(el, i => dom.hasCls(i, 'vam-node'));
  const coverEl = dom.find(el, i => dom.hasCls(i, 'vam-card-cover'));
  return { modal, el, choices, choice, slider, cardEl, coverEl, applied };
}

test('position: a radio group of Top, Bottom, Left, Right in the tool row, starting from the note', () => {
  const ui = openPlaced({ position: 'bottom' });
  const group = dom.find(ui.el, i => dom.hasCls(i, 'vam-card-frame-positions'));
  assert.equal(group.attrs.role, 'radiogroup');
  assert.ok(dom.find(ui.el, i => i.attrs.id === group.attrs['aria-labelledby'] && i.text === 'Picture position'));
  assert.deepEqual(ui.choices.map(b => [b.text, b.attrs.role, b.attrs['aria-checked']]), [['Top', 'radio', 'false'], ['Bottom', 'radio', 'true'], ['Left', 'radio', 'false'], ['Right', 'radio', 'false']]);
  assert.ok(ui.cardEl.classes.includes('has-cover-bottom'), 'the dialog card shows the note position');
  assert.equal(openPlaced().choices[0].attrs['aria-checked'], 'true', 'no position: top');
});

test('position: switching to left or right with a picture over half the width sets it to 45 percent; at or under half it stays', () => {
  const big = openPlaced({ size: 0.8 });
  big.choice('Left').click();
  assert.equal(big.slider.value, '45');
  assert.equal(big.coverEl.style.width, '45%');
  assert.ok(big.cardEl.classes.includes('has-cover-left'));
  assert.ok(dom.find(big.cardEl, i => dom.hasCls(i, 'vam-card-side')).children.includes(big.coverEl), 'the cover is the picture column');
  assert.equal(big.coverEl.attrs.inert, undefined, 'the cover still takes input');
  const text = dom.find(big.cardEl, i => dom.hasCls(i, 'vam-card-side-text'));
  assert.ok(text.children.every(child => (child.attrs.inert === '') === !(dom.hasCls(child, 'vam-card-title') || dom.hasCls(child, 'vam-card-summary'))), 'the text column is shown, only the title and summary take input');
  big.slider.value = '90';
  big.slider.input();
  big.choice('Right').click();
  assert.equal(big.slider.value, '90', 'left to right is not a switch to a side');
  assert.ok(big.cardEl.classes.includes('has-cover-right'));
  const small = openPlaced({ size: 0.5 });
  small.choice('Right').click();
  assert.equal(small.slider.value, '50');
  assert.equal(small.coverEl.style.width, '50%');
  const back = openPlaced({ size: 0.4, position: 'left' });
  back.choice('Top').click();
  assert.ok(!back.cardEl.classes.some(cls => cls.startsWith('has-cover-')), 'back to top restores the card');
  assert.equal(back.cardEl.children[1], back.coverEl);
  assert.equal(back.slider.value, '40', 'going back to top keeps the size');
});

test('position: arrow keys move between the choices; Apply hands over frame, size and position once', async () => {
  const ui = openPlaced({ size: 0.8 });
  let prevented = 0;
  ui.choices[0].keydown({ key: 'ArrowRight', preventDefault() { prevented++; } });
  assert.equal(ui.choices[1].attrs['aria-checked'], 'true');
  assert.equal(ui.choices[1].focused, true);
  ui.choices[1].keydown({ key: 'ArrowLeft', preventDefault() { prevented++; } });
  ui.choices[0].keydown({ key: 'ArrowLeft', preventDefault() { prevented++; } });
  assert.equal(ui.choices[3].attrs['aria-checked'], 'true', 'wraps around');
  assert.equal(prevented, 3);
  dom.find(ui.el, i => i.tag === 'button' && i.text === 'Apply').click();
  await dom.tick();
  assert.equal(ui.applied.length, 1);
  assert.equal(ui.applied[0].position, 'right');
  assert.equal(ui.applied[0].size, 0.45);
  nearFrame(ui.applied[0].frame, START, 'the mask is unchanged by the position');
});

test('open: a copied side-layout card is taken apart and rebuilt around the editable cover', async () => {
  const h = await harness(TEXT, { cache: { frontmatter: { 'topic-cover-position': 'right', 'topic-cover-size': '0.4' }, embeds: [{ link: 'img/a.png' }] } });
  const modal = h.view.openCoverFrameEditor({ id: 'm', path: NOTE });
  const card = dom.find(modal.contentEl, i => dom.hasCls(i, 'vam-node'));
  assert.ok(card.classes.includes('has-cover-right'));
  assert.equal(dom.findAll(card, i => dom.hasCls(i, 'vam-card-cover')).length, 1);
  assert.equal(dom.find(modal.contentEl, i => i.tag === 'input').value, '40');
});

// ---- ticket 04: card width in the dialog (same setting and limits as dragging the card edge on the map)
const graph = S.load('map-graph.ts');
const widthHandle = ui => dom.find(ui.cardEl, i => dom.hasCls(i, 'vam-card-frame-width'));
const dialogWidth = ui => ui.cardEl.style.width;
const openWide = (width, extra = {}) => {
  const applied = [];
  const modal = new editor.CoverFrameModal({}, { src: 'app://res/img/a.png', initial: null, shape: 2, card: plainCard, width, onApply: async e => { applied.push(e); }, ...extra });
  modal.open();
  const cardEl = dom.find(modal.contentEl, i => dom.hasCls(i, 'vam-node'));
  return { modal, cardEl, applied, handle: dom.find(cardEl, i => dom.hasCls(i, 'vam-card-frame-width')), apply: dom.find(modal.contentEl, i => i.tag === 'button' && i.text === 'Apply') };
};

test('width: the dialog has a focusable separator on the card edge with the map limits and the card-width label', () => {
  const ui = openWide(360);
  assert.ok(ui.handle, 'the right-edge handle exists');
  assert.equal(ui.handle.attrs.role, 'separator');
  assert.equal(ui.handle.attrs.tabindex, '0');
  assert.equal(ui.handle.attrs['aria-label'], 'Card width');
  assert.equal(ui.handle.attrs['aria-valuemin'], String(graph.CARD_WIDTH_MIN));
  assert.equal(ui.handle.attrs['aria-valuemax'], String(graph.CARD_WIDTH_MAX));
  assert.equal(ui.handle.attrs['aria-valuenow'], '360');
  for (const lang of ['en', 'zh-TW', 'zh-CN']) assert.match(read(`i18n/${lang}.ts`), /"ui\.card_resize_label": "[^"]+"/, lang);
});

test('width: dragging the right edge changes the card width live and clamps to the map limits (200-560)', () => {
  const ui = openWide(undefined);
  assert.equal(ui.handle.attrs['aria-valuenow'], String(graph.CARD_WIDTH), 'no stored width: the standard width');
  const at = (type, x) => ui.handle.fire(type, { pointerId: 3, clientX: x, clientY: 0 });
  at('pointerdown', 500);
  at('pointermove', 540);
  assert.equal(dialogWidth(ui), '320px', 'live, before Apply');
  at('pointermove', 5000);
  assert.equal(dialogWidth(ui), `${graph.CARD_WIDTH_MAX}px`, 'clamped to the map maximum');
  at('pointermove', -5000);
  assert.equal(dialogWidth(ui), `${graph.CARD_WIDTH_MIN}px`, 'clamped to the map minimum');
  at('pointerup', -5000);
  at('pointermove', 600);
  assert.equal(dialogWidth(ui), `${graph.CARD_WIDTH_MIN}px`, 'a finished drag stays put');
});

test('width: arrows step by the map step, Home/End jump to the limits, Enter restores the standard width', () => {
  const ui = openWide(360);
  const key = k => ui.handle.keydown({ key: k });
  key('ArrowRight');
  assert.equal(dialogWidth(ui), `${360 + graph.CARD_WIDTH_STEP}px`);
  key('ArrowLeft'); key('ArrowLeft');
  assert.equal(dialogWidth(ui), `${360 - graph.CARD_WIDTH_STEP}px`);
  key('End');
  assert.equal(dialogWidth(ui), `${graph.CARD_WIDTH_MAX}px`);
  key('ArrowRight');
  assert.equal(dialogWidth(ui), `${graph.CARD_WIDTH_MAX}px`, 'cannot pass the maximum');
  key('Home');
  assert.equal(dialogWidth(ui), `${graph.CARD_WIDTH_MIN}px`);
  key('ArrowLeft');
  assert.equal(dialogWidth(ui), `${graph.CARD_WIDTH_MIN}px`, 'cannot pass the minimum');
  key('Enter');
  assert.equal(dialogWidth(ui), `${graph.CARD_WIDTH}px`);
  assert.equal(ui.handle.attrs['aria-valuenow'], String(graph.CARD_WIDTH));
});

test('width: Apply hands over the width only when it changed; Cancel hands over nothing', async () => {
  const same = openWide(360);
  same.handle.keydown({ key: 'ArrowRight' }); same.handle.keydown({ key: 'ArrowLeft' });
  same.apply.click();
  await dom.tick();
  assert.equal(same.applied.length, 1);
  assert.ok(!('width' in same.applied[0]), 'unchanged width is not part of the edit');
  const changed = openWide(360);
  changed.handle.keydown({ key: 'End' });
  changed.apply.click();
  await dom.tick();
  assert.equal(changed.applied[0].width, graph.CARD_WIDTH_MAX);
  const cancelled = openWide(360);
  cancelled.handle.keydown({ key: 'End' });
  cancelled.modal.close();
  await dom.tick();
  assert.deepEqual(cancelled.applied, []);
});

const mapNodes = () => [{ id: 'm', path: NOTE, parentId: null, x: 0, y: 0, collapsed: false, width: 360 }, { id: 'k', path: 'Topics/k.md', parentId: 'm', x: 400, y: 0, collapsed: false }];
const savedNode = async (h, id = 'm') => (await h.repo.readMap('Topics/Map.md')).nodes.find(n => n.id === id);

test('width: Apply writes note and map width as ONE undo step; one undo restores both, redo writes both', async () => {
  const h = await harness(TEXT, { nodes: mapNodes() });
  const before = await h.repo.readMap('Topics/Map.md');
  const entry = await h.view.changeTopicCoverFrame({ id: 'm', path: NOTE }, START, { size: 0.5 }, 480);
  assert.equal(h.view.history.entries.length, 1, 'exactly one undo entry');
  assert.equal((await savedNode(h)).width, 480);
  assert.match(h.contents.get(NOTE), /topic-cover-frame: "0\.2 0\.3 0\.4 0\.4"/);
  const other = await savedNode(h, 'k');
  assert.deepEqual([other.x, other.y, other.parentId], [400, 0, 'm'], 'layout and links of other cards unchanged');
  await entry.undo();
  assert.equal(h.contents.get(NOTE), TEXT, 'note restored');
  assert.deepEqual(await h.repo.readMap('Topics/Map.md'), before, 'map file restored');
  await entry.redo();
  assert.equal((await savedNode(h)).width, 480);
  assert.match(h.contents.get(NOTE), /topic-cover-size: "0\.5"/);
});

test('width: the standard width removes the key; an over-limit value is clamped to the map limit; no width leaves the map alone', async () => {
  const h = await harness(TEXT, { nodes: mapNodes() });
  await h.view.changeTopicCoverFrame({ id: 'm', path: NOTE }, START, {}, graph.CARD_WIDTH);
  assert.equal('width' in (await savedNode(h)), false);
  await h.view.changeTopicCoverFrame({ id: 'm', path: NOTE }, START, {}, 9999);
  assert.equal((await savedNode(h)).width, graph.CARD_WIDTH_MAX);
  await h.view.changeTopicCoverFrame({ id: 'm', path: NOTE }, null);
  assert.equal((await savedNode(h)).width, graph.CARD_WIDTH_MAX, 'a call without width keeps the stored width');
});

// ---- ticket 05: title and summary are typed in place
const SUMMARY_TEXT = '---\ntype: topic\ntitle: M\nsummary: Old summary\ntopic-color: red\n---\n\n# M\n\n## Current Summary\n\nOld summary\n\n## Preview\n\nOld summary\n\n## Detail\n\nBody line\n';
async function textHarness(text = SUMMARY_TEXT) {
  const h = await harness(text, { nodes: mapNodes() });
  Object.assign(h.view, {
    notes: new Map(), render() {}, enqueue: fn => fn(),
    plugin: { repo: h.repo, topicRuns: { stopTask() {}, dropPending() {}, flushPending: async () => {} }, pendingResearchOptions: new Map() }
  });
  h.view.notes.set('m', await h.repo.readNote(NOTE));
  return h;
}
const openText = h => {
  const modal = h.view.openCoverFrameEditor({ id: 'm', path: NOTE, width: 360 });
  const find = cls => dom.find(modal.contentEl, i => dom.hasCls(i, cls));
  return {
    modal, title: find('vam-card-title'), summary: find('vam-card-summary'), hint: find('vam-card-frame-hint'),
    apply: dom.find(modal.contentEl, i => i.tag === 'button' && i.text === 'Apply'),
    cancel: dom.find(modal.contentEl, i => i.tag === 'button' && i.text === 'Cancel'),
    type(el, value) { el.text = value; el.fire('input'); }
  };
};
const noteOf = h => h.contents.get(NOTE);
const stamp = text => text.replace(/^updated: .*\n/m, '');
const FRAMED = { cache: { frontmatter: {}, embeds: [{ link: 'img/a.png' }] } };

test('text: the title and the summary of the dialog card are editable plain text, filled from the note', async () => {
  const h = await textHarness();
  const ui = openText(h);
  assert.equal(ui.title.text, 'M');
  assert.equal(ui.summary.text, 'Old summary');
  for (const el of [ui.title, ui.summary]) {
    assert.equal(el.attrs.contenteditable, 'plaintext-only');
    assert.equal(el.attrs.inert, undefined);
    assert.ok(el.attrs['aria-label']);
  }
  assert.equal(ui.apply.disabled, false);
});

test('text: changing the title writes what the map rename writes, byte for byte', async () => {
  const viaRename = await textHarness();
  await viaRename.view.noteChange({ id: 'm', path: NOTE }, { title: 'New name' });
  const h = await textHarness();
  const ui = openText(h);
  ui.type(ui.title, '  New   name \n');
  ui.apply.click();
  await dom.tick(); await dom.tick();
  assert.match(noteOf(h), /title: New name\n/);
  assert.equal(stamp(noteOf(h).replace(/topic-cover-[^\n]*\n/g, '')), stamp(noteOf(viaRename)));
});

test('text: changing the summary writes what the existing summary write writes, and the preview follows', async () => {
  const FOLLOW = '---\ntype: topic\ntitle: M\nsummary: Old summary\ntopic-color: red\n---\n\n# M\n\n## Current Summary\n\nOld summary\n\n## Detail\n\nBody line\n';
  const viaSummary = await textHarness(FOLLOW);
  await viaSummary.view.noteChange({ id: 'm', path: NOTE }, { summary: 'A new, longer summary' });
  const h = await textHarness(FOLLOW);
  const ui = openText(h);
  ui.type(ui.summary, 'A new, longer summary');
  ui.apply.click();
  await dom.tick(); await dom.tick();
  assert.equal(stamp(noteOf(h)), stamp(noteOf(viaSummary)), 'identical bytes to the existing summary write (the updated stamp aside)');
  assert.match(noteOf(h), /## Current Summary\n\nA new, longer summary\n/);
  assert.match(noteOf(h), /\[!info\]- Preview\n> A new, longer summary\n/, 'the preview follows the summary');
  assert.match(noteOf(h), /Body line/);
});

test('text: a summary over the 2000-character limit is cut to it', async () => {
  const h = await textHarness();
  const ui = openText(h);
  ui.type(ui.summary, 'x'.repeat(2500));
  ui.apply.click();
  await dom.tick(); await dom.tick();
  assert.equal((await h.repo.readNote(NOTE)).summary.length, 2000);
});

test('text: an unchanged title and summary are not written; only the cover write remains', async () => {
  const h = await textHarness();
  const ui = openText(h);
  ui.apply.click();
  await dom.tick(); await dom.tick();
  assert.match(noteOf(h), /title: M\n/);
  assert.equal(h.view.history.past.length, 1);
});

test('text: an empty title is refused: Apply is off, a hint says why, Enter does not apply, and nothing is written', async () => {
  const h = await textHarness();
  const ui = openText(h);
  ui.type(ui.title, '   ');
  assert.equal(ui.apply.disabled, true);
  assert.equal(ui.hint.text, 'Enter a name to save.');
  assert.equal(ui.title.attrs['aria-invalid'], 'true');
  ui.apply.click(); // a disabled button does not click; and the guard in apply() also holds
  ui.title.keydown({ key: 'Enter', isComposing: false, preventDefault() {} });
  await dom.tick(); await dom.tick();
  assert.equal(noteOf(h), SUMMARY_TEXT, 'bytes unchanged');
  assert.equal(h.view.history.past.length, 0);
  ui.type(ui.title, 'Back');
  assert.equal(ui.apply.disabled, false);
  assert.equal(ui.hint.text, '');
  ui.type(ui.title, 'Bad [[link]]');
  assert.equal(ui.apply.disabled, true, 'the rename dialog\'s title checks apply too');
  assert.ok(ui.hint.text);
});

test('text: Enter in the title or summary applies; Enter while an input method composes does nothing', async () => {
  const h = await textHarness();
  const ui = openText(h);
  ui.type(ui.title, 'Composed');
  let prevented = 0;
  for (const el of [ui.title, ui.summary]) {
    el.keydown({ key: 'Enter', isComposing: true, preventDefault() { prevented++; } });
  }
  await dom.tick(); await dom.tick();
  assert.equal(prevented, 0, 'the composing Enter is left to the input method');
  assert.equal(ui.modal.closeCount, 0, 'the dialog stays open');
  assert.equal(noteOf(h), SUMMARY_TEXT, 'nothing written');
  ui.summary.keydown({ key: 'Enter', isComposing: false, preventDefault() { prevented++; } });
  await dom.tick(); await dom.tick();
  assert.equal(prevented, 1, 'a real Enter inserts no line break');
  assert.match(noteOf(h), /title: Composed\n/, 'a real Enter applies');
});

test('text: everything from the dialog (mask, size, position, width, title, summary) is ONE undo step; undo restores all bytes, redo writes all', async () => {
  const h = await textHarness();
  const mapBefore = await h.repo.readMap('Topics/Map.md');
  const ui = openText(h);
  dom.find(ui.modal.contentEl, i => dom.hasCls(i, 'vam-card-frame-width')).keydown({ key: 'End' });
  ui.modal.setDraft(START);
  ui.type(ui.title, 'Renamed');
  ui.type(ui.summary, 'Fresh summary');
  ui.apply.click();
  await dom.tick(); await dom.tick();
  assert.equal(h.view.history.past.length, 1, 'exactly one undo step');
  assert.equal((await savedNode(h)).width, graph.CARD_WIDTH_MAX);
  assert.match(noteOf(h), /title: Renamed\n/);
  assert.match(noteOf(h), /topic-cover-frame/);
  const afterNote = noteOf(h);
  const afterMap = await h.repo.readMap('Topics/Map.md');
  await h.view.history.undo().undo();
  assert.equal(noteOf(h), SUMMARY_TEXT, 'note bytes restored, rename and summary included');
  assert.deepEqual(await h.repo.readMap('Topics/Map.md'), mapBefore, 'map file restored');
  await h.view.history.future.at(-1).redo();
  assert.equal(stamp(noteOf(h)), stamp(afterNote), 'redo writes the same note (the updated stamp aside)');
  assert.deepEqual(await h.repo.readMap('Topics/Map.md'), afterMap);
});

test('text: a topic without a summary gets an empty one to type in, right under the title; clearing the summary is allowed', async () => {
  const h = await textHarness(TEXT);
  const ui = openText(h);
  assert.equal(ui.summary.text, '');
  assert.equal(ui.summary.attrs['data-placeholder'], 'Add a summary');
  assert.equal(ui.summary.parent.children.indexOf(ui.summary), ui.summary.parent.children.indexOf(ui.title) + 1);
  ui.type(ui.summary, 'Typed from nothing');
  ui.apply.click();
  await dom.tick(); await dom.tick();
  assert.equal((await h.repo.readNote(NOTE)).summary, 'Typed from nothing');
});

test('text: i18n has the new labels in every language, and the dialog shows the wrapped text in full', () => {
  for (const lang of ['en', 'zh-TW', 'zh-CN']) {
    const text = read(`i18n/${lang}.ts`);
    for (const key of ['ui.card_edit_title_label', 'ui.card_edit_summary_label', 'ui.card_edit_summary_placeholder']) assert.ok(text.includes(`"${key}"`), `${lang} ${key}`);
  }
  assert.match(read('styles.css'), /\.vam-card-frame-stage \.vam-node \.vam-card-summary\.is-editable[^{]*\{[^}]*-webkit-line-clamp: unset/);
});
