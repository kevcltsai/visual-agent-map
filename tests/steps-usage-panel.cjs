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
const { UsageControl, formatTokens } = load('experiences/visual-map/usage-panel.ts', { obsidian });
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

test('panel shows totals and the footer; no by-action bars, no request history', async () => {
  const { store } = await newStore([
    { action: 'research', inputTokens: 1000, outputTokens: 200, topic: 'Sleep', durationMs: 18000 },
    { action: 'expand', inputTokens: 300, outputTokens: 100, topic: 'REM', estimated: true, durationMs: 9000 },
    { action: 'research', mapPath: 'B/map.vam', inputTokens: 5000, outputTokens: 0 }
  ]);
  const h = rig(store);
  h.button().click();
  const all = texts(h.panel());
  for (const expected of ['Token usage', 'This mind map', 'Today', 'This month', '~1.6k', '~6.6k', 'In 1.3k', 'Out 300']) assert.ok(all.includes(expected), expected + ' in ' + all.join('|'));
  for (const gone of ['18 s', '9 s', 'Sleep', 'REM', 'LAST 10 REQUESTS']) assert.ok(!all.includes(gone), gone + ' (history) must not be shown');
  for (const gone of ['THIS MIND MAP · BY ACTION', 'Research', 'Expand', 'Synthesize', 'Write to note', 'Other']) assert.ok(!all.includes(gone), gone + ' (by-action section) must be gone');
  assert.equal(findAll(h.panel(), i => i.cls === 'vam-usage-bar' || i.cls === 'vam-usage-bars').length, 0, 'no bars');
  assert.equal(findAll(h.panel(), i => i.cls === 'vam-usage-section').length, 1, 'totals is the only section');
  assert.equal(findAll(h.panel(), i => i.tag === 'tr').length, 0, 'no request-history table');
  assert.ok(all.includes('Counts only AI requests sent by VAM.'));
  assert.ok(all.includes('Values marked ~ are estimates.'));
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

test('no usage yet: zeros and one empty-state sentence, totals section hidden state unchanged', async () => {
  const { store } = await newStore();
  const h = rig(store);
  assert.equal(h.button().attrs['aria-label'], 'Token usage: today 0');
  h.button().click();
  const empty = find(h.panel(), i => i.cls === 'vam-usage-empty');
  assert.equal(empty.hidden, false);
  const sections = findAll(h.panel(), i => i.cls === 'vam-usage-section');
  assert.deepEqual(sections.map(s => s.hidden), [false]);
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

// ---- provider split (Total | Claude | Codex) and the two-line footer ----
const radios = h => findAll(h.panel(), i => i.attrs.role === 'radio');
const checked = h => radios(h).filter(r => r.attrs['aria-checked'] === 'true').map(r => r.text);
const pick = (h, label) => radios(h).find(r => r.text === label).click();
const foot = h => find(h.panel(), i => i.cls === 'vam-usage-foot').children;
const strongs = h => findAll(h.panel(), i => i.tag === 'strong').map(i => i.text);
const mixed = [
  { provider: 'claude', inputTokens: 1000, outputTokens: 200, topic: 'C1' },
  { provider: 'codex', model: 'codex:x', action: 'expand', inputTokens: 300, outputTokens: 100, topic: 'X1', estimated: true },
  { provider: 'codex', model: 'codex:x', action: 'expand', inputTokens: 50, outputTokens: 50, topic: 'X2' }
];

test('three-way radiogroup Total|Claude|Codex: default Total, exactly one aria-checked, only one tab stop', async () => {
  const h = rig((await newStore(mixed)).store);
  h.button().click();
  const group = find(h.panel(), i => i.attrs.role === 'radiogroup');
  assert.ok(group);
  assert.deepEqual(radios(h).map(r => r.text), ['Total', 'Claude', 'Codex']);
  assert.deepEqual(checked(h), ['Total']);
  assert.deepEqual(radios(h).map(r => r.attrs.tabindex), ['0', '-1', '-1']);
  pick(h, 'Codex');
  assert.deepEqual(checked(h), ['Codex']);
  assert.ok(radios(h)[2].classes.includes('is-selected'));
  assert.ok(!radios(h)[0].classes.includes('is-selected'));
});

test('arrow keys move the choice (wrapping) and the focus; other keys do nothing', async () => {
  const h = rig((await newStore(mixed)).store);
  h.button().click();
  const group = find(h.panel(), i => i.attrs.role === 'radiogroup');
  const press = key => { let prevented = false; group.fire('keydown', { key, target: radios(h)[0], preventDefault() { prevented = true; } }); return prevented; };
  assert.equal(press('ArrowRight'), true); assert.deepEqual(checked(h), ['Claude']); assert.equal(dom.focusedNow(), radios(h)[1]);
  press('ArrowRight'); assert.deepEqual(checked(h), ['Codex']);
  press('ArrowRight'); assert.deepEqual(checked(h), ['Total'], 'wraps');
  press('ArrowLeft'); assert.deepEqual(checked(h), ['Codex'], 'wraps back');
  assert.equal(press('a'), false); assert.deepEqual(checked(h), ['Codex']);
});

test('the filter narrows the totals; the zoom-bar number stays Total', async () => {
  const h = rig((await newStore(mixed)).store);
  h.button().click();
  pick(h, 'Claude');
  assert.equal(strongs(h)[0], '1.2k');
  assert.equal(find(h.button(), i => i.cls === 'vam-usage-number').text, '1.7k');
  assert.equal(h.button().attrs['aria-label'], 'Token usage: today 1.7k');
  pick(h, 'Codex');
  assert.equal(strongs(h)[0], '~500');
});

test('counter-example: Codex chosen with no Codex records shows zeros and the empty sentence, no error', async () => {
  const h = rig((await newStore([{ inputTokens: 100, outputTokens: 0 }])).store);
  h.button().click();
  pick(h, 'Codex');
  assert.equal(find(h.panel(), i => i.cls === 'vam-usage-error').hidden, true);
  assert.equal(find(h.panel(), i => i.cls === 'vam-usage-empty').hidden, false);
  assert.deepEqual(strongs(h), ['0', '0', '0']);
  assert.deepEqual(findAll(h.panel(), i => i.cls === 'vam-usage-section').map(s => s.hidden), [false]);
});

test('counter-example: Claude chosen, panel closed and opened again: back on Total', async () => {
  const h = rig((await newStore(mixed)).store);
  h.button().click(); pick(h, 'Claude'); assert.deepEqual(checked(h), ['Claude']);
  h.button().click(); h.button().click();
  assert.deepEqual(checked(h), ['Total']);
});

test('counter-example: footer line 2 only while a shown number is estimated; line 1 always', async () => {
  const none = rig((await newStore([{ inputTokens: 10 }, { provider: 'codex', model: 'codex:x', inputTokens: 5 }])).store);
  none.button().click();
  assert.equal(foot(none).length, 2);
  assert.equal(foot(none)[0].text, 'Counts only AI requests sent by VAM.'); assert.equal(foot(none)[0].hidden, false);
  assert.equal(foot(none)[1].text, 'Values marked ~ are estimates.'); assert.equal(foot(none)[1].hidden, true, 'all real values: no second line');
  const h = rig((await newStore(mixed)).store);
  h.button().click();
  assert.equal(foot(h)[1].hidden, false, 'Total includes the estimated Codex row');
  pick(h, 'Claude'); assert.equal(foot(h)[1].hidden, true, 'a provider without estimates hides it again');
  assert.equal(foot(h)[0].hidden, false);
  pick(h, 'Codex'); assert.equal(foot(h)[1].hidden, false);
});

test('estimated sums get the 約 mark (totals)', async () => {
  const h = rig((await newStore(mixed)).store);
  h.button().click(); pick(h, 'Codex');
  const all = texts(h.panel());
  assert.ok(all.includes('~500'), 'totals with an estimated part: ' + all.join('|'));
  pick(h, 'Claude');
  assert.ok(!texts(h.panel()).some(text => text.startsWith('~')));
});

test('counter-example: an unreadable store keeps the switch visible, shows the error, no zeros, no second footer line', async () => {
  const { store, file } = await newStore();
  fs.writeFileSync(file, '{ not json');
  const broken = new AiUsageStore(nodeFsAdapter, file, () => {});
  await broken.load();
  const h = rig(broken);
  h.button().click();
  assert.deepEqual(radios(h).map(r => r.text), ['Total', 'Claude', 'Codex']);
  pick(h, 'Codex');
  assert.deepEqual(checked(h), ['Codex']);
  assert.equal(find(h.panel(), i => i.cls === 'vam-usage-error').hidden, false);
  assert.ok(findAll(h.panel(), i => i.cls === 'vam-usage-section').every(s => s.hidden));
  assert.equal(foot(h)[1].hidden, true);
});

test('counter-example: a map whose usage is only folded away (older months) is not empty', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vam-usage-panel-')), 'ai-usage.json');
  const store = new AiUsageStore(nodeFsAdapter, file, () => {});
  await store.load();
  store.record(row({ at: new Date(Date.now() - 200 * 86_400_000).toISOString(), inputTokens: 400, outputTokens: 100 }));
  assert.equal(store.recent(MAP, 10).value.length, 0, 'the row really is folded: no detail row left');
  const h = rig(store);
  h.button().click();
  assert.equal(find(h.panel(), i => i.cls === 'vam-usage-empty').hidden, true, 'folded usage is usage: no empty state');
  assert.equal(strongs(h)[0], '500');
});
