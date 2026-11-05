// Token usage button and panel in the zoom controls (experiences/visual-map/usage-panel.ts). Unit level: a stand-in DOM,
// the real usage store on a temporary file. The look and the real Obsidian behaviour are checked by the UI tester.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { load } = require('./support-replay.cjs');
const { nodeFsAdapter } = require('./support-fs-adapter.cjs');
const dom = require('./support-dom.cjs');
const { obsidian } = require('./support.cjs');

const { AiUsageStore } = load('core/ai-usage-store.ts');
const { UsageControl, formatTokens, formatDuration } = load('experiences/visual-map/usage-panel.ts', { obsidian });
const { element, find, findAll } = dom;

const MAP = 'A/map.vam';
const row = (extra = {}) => ({ action: 'research', mapPath: MAP, provider: 'claude', model: 'claude:sonnet', inputTokens: 10, outputTokens: 5, estimated: false, ...extra });
async function newStore(records = []) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vam-usage-panel-')), 'ai-usage.json');
  const store = new AiUsageStore(nodeFsAdapter, file, () => {});
  await store.load();
  for (const record of records) store.record(row(record));
  return { store, file };
}
function rig(store) {
  const listeners = {};
  const doc = { activeElement: null, addEventListener(name, fn) { (listeners[name] ??= []).push(fn); }, removeEventListener(name, fn) { listeners[name] = (listeners[name] ?? []).filter(f => f !== fn); }, fire(name, event) { for (const fn of [...(listeners[name] ?? [])]) fn(event); }, listeners };
  const overlay = element('div', 'vam-canvas-controls');
  overlay.ownerDocument = doc;
  const bar = overlay.createDiv('vam-zoom-controls');
  const control = new UsageControl(store, () => MAP);
  control.start();
  const mount = () => { bar.empty(); control.mount(bar, overlay); };
  mount();
  const button = () => find(bar, i => i.tag === 'button');
  const panel = () => find(overlay, i => i.attrs.role === 'dialog');
  const key = (name, target = panel()) => { let prevented = false; let stopped = false; doc.fire('keydown', { key: name, target, preventDefault() { prevented = true; }, stopPropagation() { stopped = true; } }); return name === 'Escape' && !prevented !== !stopped ? 'mixed' : prevented; };
  return { control, overlay, bar, doc, button, panel, mount, key };
}
const texts = root => findAll(root, i => i.text).map(i => i.text);

test('formatTokens: whole under 1000, one decimal k to 99999 (never 100.0k), whole k from 100k', () => {
  assert.deepEqual([0, 7, 999, 1000, 1234, 12400, 99949, 99999, 100000, 312000, 312600].map(formatTokens), ['0', '7', '999', '1.0k', '1.2k', '12.4k', '99.9k', '99.9k', '100k', '312k', '313k']);
  assert.equal(formatDuration(18000), '18 s'); assert.equal(formatDuration(65000), '1 min 5 s'); assert.equal(formatDuration(undefined), '–');
});

test('the button is the first control of the zoom bar with a label, haspopup dialog and aria-expanded', async () => {
  const { store } = await newStore([{ inputTokens: 900, outputTokens: 500 }]);
  const h = rig(store);
  const button = h.button();
  assert.equal(h.bar.children[0], button);
  assert.equal(button.attrs['aria-label'], 'Token usage: today 1.4k');
  assert.equal(button.attrs['aria-haspopup'], 'dialog');
  assert.equal(button.attrs['aria-expanded'], 'false');
  assert.equal(find(button, i => i.cls === 'vam-usage-icon').iconName, 'gauge');
  assert.equal(find(button, i => i.cls === 'vam-usage-number').text, '1.4k');
});

test('click opens the panel; Esc, an outside press and a second click close it and the focus returns to the button', async () => {
  const { store } = await newStore([{}]);
  const h = rig(store);
  assert.equal(h.panel(), undefined);
  h.button().click();
  assert.ok(h.panel()); assert.equal(h.button().attrs['aria-expanded'], 'true');
  assert.equal(h.key('Enter'), false); assert.ok(h.panel());
  assert.equal(h.key('Escape'), true);
  assert.equal(h.panel(), undefined); assert.equal(h.button().attrs['aria-expanded'], 'false'); assert.equal(dom.focusedNow(), h.button());
  h.button().click();
  assert.equal(h.key('Escape', element('div')), false, 'Escape from elsewhere (an editor, a dialog) is not swallowed');
  assert.ok(h.panel(), 'and the panel stays open');
  h.doc.fire('pointerdown', { target: h.panel() }); assert.ok(h.panel(), 'a press inside stays open');
  h.doc.fire('pointerdown', { target: element('div') }); assert.equal(h.panel(), undefined, 'a press outside closes');
  h.button().click(); h.button().click(); assert.equal(h.panel(), undefined, 'the button toggles');
  assert.equal(h.doc.listeners.keydown.length + h.doc.listeners.pointerdown.length, 0, 'closed: no document listeners are left');
});

test('panel shows totals, only the actions with usage, the recent rows with 約 for estimates, and the footer', async () => {
  const { store } = await newStore([
    { action: 'research', inputTokens: 1000, outputTokens: 200, topic: 'Sleep', durationMs: 18000 },
    { action: 'expand', inputTokens: 300, outputTokens: 100, topic: 'REM', estimated: true, durationMs: 9000 },
    { action: 'research', mapPath: 'B/map.vam', inputTokens: 5000, outputTokens: 0 }
  ]);
  const h = rig(store);
  h.button().click();
  const all = texts(h.panel());
  for (const expected of ['Token usage', 'This mind map', 'Today', 'This month', '1.6k', '6.6k', 'In 1.3k', 'Out 300', '~400', '18 s', '9 s', 'Sleep', 'REM']) assert.ok(all.includes(expected), expected + ' in ' + all.join('|'));
  const shown = findAll(h.panel(), i => i.cls === 'vam-usage-bar' && !i.hidden).map(i => i.children[0].text);
  assert.deepEqual(shown, ['Research', 'Expand']);
  assert.equal(findAll(h.panel(), i => i.tag === 'tr' && !i.hidden).length, 2, 'only this map\'s two requests');
  assert.ok(all.some(text => text.includes('subscription plans')));
});

test('a store change rewrites the numbers in the same elements: nothing is rebuilt', async () => {
  const { store } = await newStore([{ inputTokens: 100, outputTokens: 0 }]);
  const h = rig(store);
  h.button().click();
  const panel = h.panel(); const strong = find(panel, i => i.tag === 'strong'); const number = find(h.button(), i => i.cls === 'vam-usage-number');
  assert.equal(number.text, '100');
  store.record(row({ inputTokens: 900, outputTokens: 100 }));
  assert.equal(h.panel(), panel); assert.equal(find(h.panel(), i => i.tag === 'strong'), strong);
  assert.equal(number.text, '1.1k'); assert.equal(strong.text, '1.1k');
  assert.equal(h.button().attrs['aria-label'], 'Token usage: today 1.1k');
});

test('a render rebuilds the zoom bar: mount puts the button back and keeps an open panel open', async () => {
  const { store } = await newStore([{}]);
  const h = rig(store);
  h.button().click();
  h.mount();
  assert.ok(h.panel()); assert.equal(findAll(h.overlay, i => i.attrs.role === 'dialog').length, 1);
  assert.equal(h.button().attrs['aria-expanded'], 'true');
});

test('no usage yet: zeros and one empty-state sentence, no bars or request table', async () => {
  const { store } = await newStore();
  const h = rig(store);
  assert.equal(h.button().attrs['aria-label'], 'Token usage: today 0');
  h.button().click();
  const empty = find(h.panel(), i => i.cls === 'vam-usage-empty');
  assert.equal(empty.hidden, false);
  const sections = findAll(h.panel(), i => i.cls === 'vam-usage-section');
  assert.deepEqual(sections.map(s => s.hidden), [false, true, true]);
  assert.equal(find(h.panel(), i => i.tag === 'strong').text, '0');
});

test('an unreadable store shows the error sentence and a dash, never zero', async () => {
  const { store, file } = await newStore();
  fs.writeFileSync(file, '{ not json');
  const broken = new AiUsageStore(nodeFsAdapter, file, () => {});
  await broken.load();
  const h = rig(broken);
  assert.equal(h.button().attrs['aria-label'], 'Token usage: unavailable');
  assert.equal(find(h.button(), i => i.cls === 'vam-usage-number').text, '–');
  h.button().click();
  assert.equal(find(h.panel(), i => i.cls === 'vam-usage-error').hidden, false);
  assert.ok(findAll(h.panel(), i => i.cls === 'vam-usage-section').every(s => s.hidden));
});

test('stop unsubscribes from the store and closes the panel', async () => {
  const { store } = await newStore([{}]);
  const h = rig(store);
  h.button().click();
  h.control.stop();
  assert.equal(h.panel(), undefined);
  const number = find(h.button(), i => i.cls === 'vam-usage-number'); const before = number.text;
  store.record(row({ inputTokens: 5000 }));
  assert.equal(number.text, before, 'no update after stop');
  assert.equal(h.doc.listeners.keydown.length, 0);
});

test('wiring: the map view builds the control only when the plugin has a usage store, starts it on open and stops it on close; the share viewer has none', () => {
  const root = path.join(__dirname, '..');
  const view = fs.readFileSync(path.join(root, 'experiences/visual-map/view.ts'), 'utf8');
  assert.match(view, /this\.usageControl = this\.plugin\.usage \? new UsageControl\(this\.plugin\.usage, \(\) => this\.path\) : null;\s+this\.usageControl\?\.start\(\);/);
  assert.match(view, /this\.usageControl\?\.mount\(zoom, controls\);\s+\/\/ The hint/);
  assert.match(view, /this\.usageControl\?\.stop\(\);\s+this\.usageControl = null;/);
  assert.doesNotMatch(fs.readFileSync(path.join(root, 'experiences/sharing/viewer/main.ts'), 'utf8'), /usage/i);
});
