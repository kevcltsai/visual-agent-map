// Hypothesis research entry (P9a): the start window and the view code that opens it. The window cannot start with an empty proposition,
// and a press that arrives after the map changed (nodes, another map, closed view, a run already going) starts nothing. Unit level: the
// view method runs on a plain object that has only what it reads; the Modal is a stand-in.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load, obsidian } = require('./support.cjs');
const dom = require('./support-dom.cjs');

const opened = [];
const notices = [];
class Modal {
  constructor(app) { this.app = app; this.titleEl = dom.element('div'); this.contentEl = dom.element('div'); this.modalEl = dom.element('div'); this.modalEl.children.push(this.contentEl); }
  open() { opened.push(this); }
  close() { this.closed = true; }
}
class Notice { constructor(message) { notices.push(message); } }
const overrides = { obsidian: { ...obsidian, Modal, Notice } };
const { ArgumentStartModal } = load('ui/modals/argument-start-modal.ts', overrides);
const MODULES = load('main.ts', overrides, { createFragment: dom.createFragment });
const { VisualAgentMapView } = MODULES;
const Plugin = MODULES.default;

const find = dom.findAll;
const choices = [{ id: 'a', label: 'Model A' }, { id: 'b', label: 'Model B' }];

function openModal(claim, onStart, calls = 109) {
  const modal = new ArgumentStartModal({}, claim, choices, 'a', calls, onStart);
  modal.onOpen();
  const area = find(modal.contentEl, i => i.tag === 'textarea')[0];
  const select = find(modal.contentEl, i => i.tag === 'select')[0];
  const buttons = find(modal.modalEl, i => i.tag === 'button');
  return { modal, area, select, cancel: buttons.find(b => b.text === 'Cancel'), start: buttons.find(b => b.text === 'Start research') };
}
const type = (area, value) => { area.value = value; area.input(); };

test('start window: title, proposition (from the draft), model, usage and network note, cancel and start', () => {
  const m = openModal('Is it true?', () => {});
  assert.equal(m.modal.titleEl.text, 'Hypothesis research');
  assert.equal(m.area.value, 'Is it true?');
  assert.equal(m.area.attrs.rows, '2');
  assert.equal(m.select.value, 'a');
  assert.deepEqual(find(m.select, i => i.tag === 'option').map(o => o.text), ['Model A', 'Model B']);
  const hint = find(m.modal.contentEl, i => i.tag === 'p' && i.cls.includes('vam-hint'))[0];
  assert.equal(hint.text, 'Up to about 109 AI calls. Research connects to web pages the AI finds.');
  assert.equal(m.start.disabled, false);
  assert.ok(m.start.hasClass('mod-cta'));
  assert.equal(m.area.focused, true, 'focus in the proposition field');
});

test('counterexample: an empty or blank proposition cannot start, even when the press is forced', () => {
  const started = [];
  const m = openModal('   ', input => started.push(input));
  assert.equal(m.start.disabled, true, 'blank at open');
  m.start.fire('click');
  assert.equal(started.length, 0, 'a forced click starts nothing');
  type(m.area, 'x'); assert.equal(m.start.disabled, false);
  type(m.area, ' \n\t '); assert.equal(m.start.disabled, true, 'blank again after typing');
  m.start.fire('click');
  assert.equal(started.length, 0);
  type(m.area, '  claim  '); m.start.click();
  assert.deepEqual(JSON.parse(JSON.stringify(started)), [{ claim: 'claim', model: 'a' }], 'trimmed claim and the chosen model');
  assert.equal(m.modal.closed, true);
});

test('cancel and close hand nothing back', () => {
  const started = [];
  const m = openModal('claim', input => started.push(input));
  m.cancel.click();
  assert.equal(m.modal.closed, true);
  assert.equal(started.length, 0);
});

function fakeView(over = {}) {
  const calls = { starts: [], models: [], cleared: 0 };
  const view = {
    closed: false, path: 'M.vam', app: {},
    map: { id: 'm1', nodes: [], viewport: { x: 0, y: 0, zoom: 1 } },
    chatHero: () => true,
    chat: { clearDraft() { calls.cleared++; } },
    chatModelChoices: () => [{ value: 'a', label: 'Model A' }, { value: 'b', label: 'Model B' }],
    plugin: {
      settings: { cliModel: 'a' },
      argumentRuns: { isRunning: () => false, start(path, claim) { calls.starts.push([path, claim]); return Promise.resolve(); } },
      setCurrentModel: async model => { calls.models.push(model); }
    },
    ...over
  };
  return { view, calls };
}
const open = (view, draft = '  claim  ') => { opened.length = 0; VisualAgentMapView.prototype.openArgumentStart.call(view, draft); return opened[0]; };
const settle = () => new Promise(resolve => setImmediate(resolve));

test('the window opens only on the opening screen and starts the run with the trimmed proposition', async () => {
  const none = fakeView({ chatHero: () => false });
  assert.equal(open(none.view), undefined, 'not on the opening screen: no window');
  const closed = fakeView({ closed: true });
  assert.equal(open(closed.view), undefined, 'closed view: no window');
  const { view, calls } = fakeView();
  const modal = open(view);
  assert.ok(modal);
  modal.onOpen();
  const area = find(modal.contentEl, i => i.tag === 'textarea')[0];
  assert.equal(area.value, 'claim', 'the draft, trimmed');
  find(modal.modalEl, i => i.tag === 'button' && i.text === 'Start research')[0].click();
  await settle();
  assert.deepEqual(calls.starts, [['M.vam', 'claim']]);
  assert.deepEqual(calls.models, [], 'same model: not switched');
  assert.equal(calls.cleared, 1, 'the draft is cleared');
});

test('a different model in the window becomes the current model before the run starts', async () => {
  const { view, calls } = fakeView();
  const modal = open(view); modal.onOpen();
  const select = find(modal.contentEl, i => i.tag === 'select')[0];
  select.value = 'b'; select.change();
  find(modal.modalEl, i => i.tag === 'button' && i.text === 'Start research')[0].click();
  await settle();
  assert.deepEqual(calls.models, ['b']);
  assert.equal(calls.starts.length, 1);
});

const STALE = {
  'the map got a node': v => { v.map.nodes.push({ id: 'n' }); },
  'another map is open': v => { v.map = { id: 'm2', nodes: [], viewport: v.map.viewport }; },
  'the tab shows another file': v => { v.path = 'Other.vam'; },
  'the view was closed': v => { v.closed = true; },
  'the map already has an argument key': v => { v.map.argumentMap = {}; },
  'a run is already going': v => { v.plugin.argumentRuns.isRunning = () => true; }
};
for (const [name, change] of Object.entries(STALE)) {
  test(`counterexample: ${name} after the window opened: pressing start starts nothing`, async () => {
    const { view, calls } = fakeView();
    const modal = open(view); modal.onOpen();
    change(view);
    find(modal.modalEl, i => i.tag === 'button' && i.text === 'Start research')[0].click();
    await settle();
    assert.equal(calls.starts.length, 0);
    assert.equal(calls.cleared, 0, 'the draft stays');
    assert.equal(calls.models.length, 0, 'no model switch either');
  });
}

test('counterexample: the map changes while the model switch is awaited: nothing starts', async () => {
  const { view, calls } = fakeView();
  view.plugin.setCurrentModel = async model => { calls.models.push(model); view.map.nodes.push({ id: 'n' }); };
  const modal = open(view); modal.onOpen();
  const select = find(modal.contentEl, i => i.tag === 'select')[0];
  select.value = 'b'; select.change();
  find(modal.modalEl, i => i.tag === 'button' && i.text === 'Start research')[0].click();
  await settle();
  assert.equal(calls.starts.length, 0);
});

test('counterexample: a forced callback with a blank proposition starts nothing', async () => {
  const { view, calls } = fakeView();
  const modal = open(view);
  await modal.onStart({ claim: '   ', model: 'a' });
  assert.equal(calls.starts.length, 0);
});

test('a refused start shows a notice; the run is not awaited', async () => {
  const plugin = new Plugin();
  const refusal = await plugin.argumentRuns.start('p', '').catch(error => error);
  const { view, calls } = fakeView();
  view.plugin.argumentRuns.start = () => Promise.reject(refusal);
  notices.length = 0;
  const modal = open(view); modal.onOpen();
  find(modal.modalEl, i => i.tag === 'button' && i.text === 'Start research')[0].click();
  await settle();
  assert.deepEqual(notices, ['Could not start hypothesis research on this mind map.']);
  assert.equal(calls.cleared, 1);
});
