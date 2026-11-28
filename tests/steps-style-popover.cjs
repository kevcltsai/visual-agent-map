// V3.3 B08: the toolbar "Style" popover (style-popover.ts) as a pure UI piece: one callback per click, nothing on hover,
// "apply to the whole branch", Esc returns the focus to the anchor, every control is a Tab stop. DOM stand-in from support-dom.cjs.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./support.cjs');
const dom = require('./support-dom.cjs');
const sp = load('experiences/visual-map/style-popover.ts');

const choice = (pop, id) => dom.find(pop.el, i => i.dataset?.styleChoice === id);
function open(state = {}) {
  const host = dom.element('div');
  const anchor = host.createEl('button', { text: 'Style' });
  const calls = { color: [], styles: [], close: 0 };
  const pop = sp.openStylePopover(host, anchor, { color: null, styles: [], hasBranch: true, ...state }, {
    onColor: (color, branch) => calls.color.push([color, branch]),
    // Copied into this realm: the module runs in its own vm context, so its arrays have another Array prototype.
    onStyles: (styles, branch) => calls.styles.push([[...styles], branch]),
    onClose: () => calls.close++
  });
  return { host, anchor, calls, pop };
}

test('style popover: a dialog with an accessible name, six colours plus none, three styles, three sizes and the branch box', () => {
  const { host, pop } = open();
  assert.ok(host.children.includes(pop.el));
  assert.equal(pop.el.attrs.role, 'dialog');
  assert.equal(pop.el.attrs['aria-label'], 'Card style');
  const ids = dom.findAll(pop.el, i => i.dataset?.styleChoice).map(i => i.dataset.styleChoice);
  assert.deepEqual(ids, ['color-none', 'color-red', 'color-orange', 'color-yellow', 'color-green', 'color-blue', 'color-purple', 'bold', 'border-thick', 'line-thick', 'size-small', 'size-medium', 'size-large', 'branch']);
  assert.deepEqual(['size-small', 'size-medium', 'size-large'].map(id => choice(pop, id).text), ['Small', 'Medium', 'Large']);
  assert.ok(dom.findAll(pop.el, i => i.text === 'Apply to the whole branch').length === 1);
});

test('style popover: each colour click calls onColor once with that colour (none is null); the pressed state follows', () => {
  const { calls, pop } = open({ color: 'blue' });
  assert.equal(choice(pop, 'color-blue').attrs['aria-pressed'], 'true');
  choice(pop, 'color-red').click();
  assert.deepEqual(calls.color, [['red', false]]);
  assert.equal(choice(pop, 'color-red').attrs['aria-pressed'], 'true');
  assert.equal(choice(pop, 'color-blue').attrs['aria-pressed'], 'false');
  choice(pop, 'color-none').click();
  assert.deepEqual(calls.color, [['red', false], [null, false]]);
  assert.deepEqual(calls.styles, []);
});

test('style popover: bold, thick border and thick line toggle; each click calls onStyles once with the full list to write', () => {
  const { calls, pop } = open({ styles: ['text-large'] });
  choice(pop, 'bold').click();
  assert.deepEqual(calls.styles, [[['text-large', 'bold'], false]]);
  assert.equal(choice(pop, 'bold').attrs['aria-pressed'], 'true');
  choice(pop, 'bold').click();
  assert.deepEqual(calls.styles.at(-1), [['text-large'], false]);
  choice(pop, 'line-thick').click();
  assert.deepEqual(calls.styles.at(-1), [['text-large', 'line-thick'], false]);
  assert.equal(calls.styles.length, 3);
  assert.deepEqual(calls.color, []);
});

test('style popover: text size small writes text-small, medium writes no size, large writes text-large; other styles stay', () => {
  const { calls, pop } = open({ styles: ['bold', 'text-small'] });
  assert.equal(choice(pop, 'size-small').attrs['aria-pressed'], 'true');
  choice(pop, 'size-large').click();
  assert.deepEqual(calls.styles, [[['bold', 'text-large'], false]]);
  choice(pop, 'size-medium').click();
  assert.deepEqual(calls.styles.at(-1), [['bold'], false]);
  assert.equal(choice(pop, 'size-medium').attrs['aria-pressed'], 'true');
  choice(pop, 'size-small').click();
  assert.deepEqual(calls.styles.at(-1), [['bold', 'text-small'], false]);
  assert.equal(calls.styles.length, 3);
});

test('style popover: with "apply to the whole branch" ticked every colour and style click passes branch=true; no branch box for a card without children', () => {
  const { calls, pop } = open();
  const box = choice(pop, 'branch');
  box.checked = true; box.change();
  choice(pop, 'color-green').click();
  choice(pop, 'bold').click();
  choice(pop, 'size-large').click();
  assert.deepEqual(calls.color, [['green', true]]);
  assert.deepEqual(calls.styles.map(c => c[1]), [true, true]);
  box.checked = false; box.change();
  choice(pop, 'color-none').click();
  assert.deepEqual(calls.color.at(-1), [null, false]);
  const leaf = open({ hasBranch: false });
  assert.equal(choice(leaf.pop, 'branch'), undefined);
});

test('style popover: hover and pointer movement over any control call nothing (no write while sliding over choices)', () => {
  const { calls, pop } = open({ color: 'red', styles: ['bold'] });
  for (const item of dom.findAll(pop.el, i => i.dataset?.styleChoice))
    for (const name of ['pointerenter', 'pointerover', 'pointermove', 'mouseenter', 'mouseover', 'mousemove', 'focus'])
      item.fire(name, { clientX: 1, clientY: 1 });
  assert.deepEqual(calls, { color: [], styles: [], close: 0 });
});

test('style popover: Esc closes it once and returns the focus to the anchor; close() is idempotent', () => {
  const { host, anchor, calls, pop } = open();
  choice(pop, 'bold').focus();
  let stopped = 0;
  pop.el.fire('keydown', { key: 'Escape', stopPropagation() { stopped++; } });
  assert.equal(host.children.includes(pop.el), false);
  assert.equal(dom.focusedNow(), anchor);
  assert.equal(calls.close, 1);
  assert.equal(stopped, 1, 'Esc stops here so the view does not also clear the selection');
  pop.close();
  assert.equal(calls.close, 1);
  pop.el.fire('keydown', { key: 'Tab' });
  assert.equal(calls.close, 1);
});

test('style popover: Tab reaches every control (no roving tabindex), and opening puts the focus inside the dialog', () => {
  const { pop } = open({ color: 'red' });
  const controls = dom.findAll(pop.el, i => i.dataset?.styleChoice);
  assert.equal(controls.length, 14);
  for (const item of controls) {
    assert.ok(['button', 'input'].includes(item.tag), `${item.dataset.styleChoice} is a native control`);
    assert.notEqual(item.tabIndex, -1, `${item.dataset.styleChoice} is a Tab stop`);
    assert.notEqual(item.disabled, true);
  }
  assert.ok(pop.el.contains(dom.focusedNow()));
});

test('style popover: update() repaints the pressed states from the saved note without calling anything', () => {
  const { calls, pop } = open({ color: 'red', styles: [] });
  pop.update({ color: null, styles: ['border-thick', 'text-large'], hasBranch: true });
  assert.equal(choice(pop, 'color-none').attrs['aria-pressed'], 'true');
  assert.equal(choice(pop, 'border-thick').attrs['aria-pressed'], 'true');
  assert.equal(choice(pop, 'size-large').attrs['aria-pressed'], 'true');
  assert.equal(choice(pop, 'size-medium').attrs['aria-pressed'], 'false');
  choice(pop, 'border-thick').click();
  assert.deepEqual(calls.styles, [[['text-large'], false]]);
  assert.deepEqual(calls.color, []);
});
