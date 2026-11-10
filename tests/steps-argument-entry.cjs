// Hypothesis research entry (V6): the start window with the framing confirmation step, and the view code that opens it. Unit level: the
// Modal is a stand-in (Esc is the base class's Escape scope handler), the runner is a fake that can hold a call open. The window cannot
// call before the usage is accepted, cannot start before the confirm, and a late result is dropped.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { load, obsidian } = require('./support.cjs');
const dom = require('./support-dom.cjs');

const notices = [];
const opened = [];
const BaseModal = dom.makeModal();
class Modal extends BaseModal { open() { opened.push(this); super.open(); } }
class Notice { constructor(message) { notices.push(message); } }
const overrides = { obsidian: { ...obsidian, Modal, Notice } };
const { ArgumentStartModal } = load('ui/modals/argument-start-modal.ts', overrides);
const { WORST_CASE_AI_CALLS, MAX_FRAMING_CALLS } = load('core/argument-map/model.ts');
const MODULES = load('main.ts', overrides, { createFragment: dom.createFragment });
const { VisualAgentMapView } = MODULES;

const find = dom.findAll;
const choices = [{ id: 'a', label: 'Model A' }, { id: 'b', label: 'Model B' }];
const settle = () => new Promise(resolve => setImmediate(resolve));
const btn = (modal, text) => find(modal.modalEl, i => i.tag === 'button' && i.text === text)[0];
const type = (el, value) => { el.value = value; el.input(); };
const EVIL = '<img src=x onerror="alert(1)"><script>boom()</script>';

function framingResult(over = {}) {
  return {
    restatement: 'Is AI the main cause?',
    presuppositions: ['youth unemployment is high'], loadedTerms: ['blamed'], vagueTerms: ['young', 'high'], outOfScope: [],
    candidates: [
      { id: 'q1', question: 'Is AI one cause?', answerShape: 'partly', diff: 'weaker', kind: 'interpretation', unanswered: false },
      { id: 'q2', question: 'Is AI the main cause?', answerShape: 'largest', diff: 'stronger', kind: 'interpretation', unanswered: false },
      { id: 'q3', question: 'How many jobs did AI take?', answerShape: 'a number', diff: 'other', kind: 'related', unanswered: true }
    ],
    chosen: 'q2',
    claims: [
      { id: 'c1', text: 'Youth unemployment is above the average.', type: 'fact', role: 'premise', dependsOn: [], definitions: [{ term: 'young', meaning: '16-24' }], dataNeeds: ['rate'] },
      { id: 'c2', text: 'AI contributes most to the gap.', type: 'main_cause', role: 'testable', dependsOn: ['c1'], definitions: [{ term: 'main', meaning: 'largest estimated share' }], dataNeeds: [] }
    ],
    settings: ['Period: 2023 to 2026'],
    composition: 'c2 answers the original',
    ...over
  };
}

/** A runner whose frame calls are held open; `calls` records each, `settle(i, result|Error)` answers one. */
function fakeFramer() {
  const calls = [];
  return {
    calls,
    frame(original, options) {
      return new Promise((resolve, reject) => { calls.push({ original, options, resolve, reject }); });
    },
    answer(i, result) { calls[i].resolve(result); },
    fail(i) { calls[i].reject(new Error('provider down')); }
  };
}

function openModal(draft = 'Is it true?', extra = {}) {
  const framer = fakeFramer();
  const confirmed = [];
  const config = { draft, models: choices, defaultModel: 'a', calls: WORST_CASE_AI_CALLS, maxFraming: MAX_FRAMING_CALLS, framer, onConfirm: input => { confirmed.push(input); }, ...extra };
  const modal = new ArgumentStartModal({}, config);
  modal.open();
  return { modal, framer, confirmed, area: find(modal.contentEl, i => i.tag === 'textarea')[0], select: find(modal.contentEl, i => i.tag === 'select')[0] };
}
const texts = modal => dom.texts(modal.modalEl);
async function toConfirm(m, result = framingResult()) {
  btn(m.modal, 'Next').click();
  await settle();
  m.framer.answer(m.framer.calls.length - 1, result);
  await settle();
}

test('step 1: title, proposition from the draft, model, the usage from the shared constant, and no AI call before Next', () => {
  const m = openModal('Is it true?');
  assert.equal(m.modal.titleEl.text, 'Hypothesis research');
  assert.equal(m.area.value, 'Is it true?');
  assert.equal(m.area.attrs.rows, '2');
  assert.deepEqual(find(m.select, i => i.tag === 'option').map(o => o.text), ['Model A', 'Model B']);
  const usage = find(m.modal.contentEl, i => i.cls.includes('vam-argument-usage'))[0];
  assert.equal(usage.text, `Up to about ${WORST_CASE_AI_CALLS} AI calls. Research connects to web pages the AI finds.`);
  assert.equal(WORST_CASE_AI_CALLS, 146);
  assert.equal(m.framer.calls.length, 0, 'the usage is shown first; nothing is called yet');
  assert.ok(btn(m.modal, 'Next').hasClass('mod-cta'));
  assert.equal(m.area.focused, true, 'focus in the proposition field');
});

test('counterexample: a blank proposition cannot go to the next step, even when the press is forced', () => {
  const m = openModal('   ');
  assert.equal(btn(m.modal, 'Next').disabled, true);
  btn(m.modal, 'Next').fire('click');
  assert.equal(m.framer.calls.length, 0);
  type(m.area, 'x'); assert.equal(btn(m.modal, 'Next').disabled, false);
  type(m.area, ' \n\t '); assert.equal(btn(m.modal, 'Next').disabled, true);
});

test('Next makes exactly one frame call with the trimmed claim, attempt 1 and a live signal; the window shows it is working', async () => {
  const m = openModal('x');
  type(m.area, '  claim  ');
  btn(m.modal, 'Next').click();
  await settle();
  assert.equal(m.framer.calls.length, 1);
  assert.equal(m.framer.calls[0].original, 'claim');
  assert.equal(m.framer.calls[0].options.attempt, 1);
  assert.equal(m.framer.calls[0].options.signal.aborted, false);
  assert.ok(texts(m.modal).some(x => x.includes('Restating the question')));
  assert.equal(btn(m.modal, 'Next'), undefined, 'no second press while it runs');
  assert.equal(m.confirmed.length, 0);
});

test('Esc aborts the call and a late result is dropped: nothing is shown and nothing is confirmed', async () => {
  const m = openModal('claim');
  btn(m.modal, 'Next').click();
  await settle();
  const { signal } = m.framer.calls[0].options;
  assert.equal(m.modal.scope.press('Escape'), false);
  assert.equal(signal.aborted, true, 'Esc aborts');
  m.framer.answer(0, framingResult());
  await settle();
  assert.equal(find(m.modal.modalEl, i => i.tag === 'input').length, 0, 'the late result is not rendered');
  assert.equal(m.confirmed.length, 0);
});

test('Cancel while it runs also aborts and drops the late result', async () => {
  const m = openModal('claim');
  btn(m.modal, 'Next').click();
  await settle();
  btn(m.modal, 'Cancel').click();
  assert.equal(m.framer.calls[0].options.signal.aborted, true);
  m.framer.answer(0, framingResult());
  await settle();
  assert.equal(m.confirmed.length, 0);
  assert.equal(find(m.modal.modalEl, i => i.tag === 'input').length, 0);
});

test('a failure shows retry with the calls left; the third failure leaves no retry and no fourth call is possible', async () => {
  const m = openModal('claim');
  btn(m.modal, 'Next').click(); await settle();
  m.framer.fail(0); await settle();
  assert.ok(texts(m.modal).some(x => x.includes('Restating failed')));
  assert.ok(btn(m.modal, 'Retry (2 left)'));
  btn(m.modal, 'Retry (2 left)').click(); await settle();
  assert.equal(m.framer.calls[1].options.attempt, 2);
  m.framer.fail(1); await settle();
  assert.ok(btn(m.modal, 'Retry (1 left)'));
  btn(m.modal, 'Retry (1 left)').click(); await settle();
  assert.equal(m.framer.calls[2].options.attempt, 3);
  m.framer.fail(2); await settle();
  assert.equal(find(m.modal.modalEl, i => i.tag === 'button' && i.text.startsWith('Retry')).length, 0, 'the limit is reached: no retry');
  assert.ok(texts(m.modal).some(x => x.includes('No restatements left')));
  assert.equal(m.framer.calls.length, MAX_FRAMING_CALLS);
  assert.equal(m.confirmed.length, 0, 'a failure creates nothing');
});

test('the confirm page shows the framing: restatement, hidden things, candidates with markers, claims with type, role and dependency, definitions, settings, usage and the lock note', async () => {
  const m = openModal('Is AI to blame?');
  await toConfirm(m);
  const all = texts(m.modal);
  assert.equal(m.modal.titleEl.text, 'Confirm the question to research');
  for (const expected of ['Is AI the main cause?', 'Is AI to blame?', 'Youth unemployment is above the average.', 'Locked once confirmed. To ask differently, open a new research.']) {
    assert.ok(all.some(x => x.includes(expected)), expected);
  }
  assert.ok(all.some(x => x.includes('youth unemployment is high')), 'presupposition');
  assert.ok(all.some(x => x.includes('blamed')), 'loaded term');
  assert.ok(all.some(x => x === '：young'), 'vague term');
  assert.ok(all.some(x => x.includes('Fact・Premise')) && all.some(x => x.includes('Main cause・To test')), 'type and role');
  assert.ok(all.some(x => x === 'Depends on claim 1'), 'dependency');
  assert.ok(all.some(x => x.includes('AI recommends')), 'the recommended candidate');
  assert.ok(all.some(x => x.includes('Asks a related question') && x.includes('will not be answered')), 'related candidate is flagged');
  assert.ok(all.some(x => x === `Up to about ${WORST_CASE_AI_CALLS} AI calls. Research connects to web pages the AI finds.`), 'usage');
  const radios = find(m.modal.modalEl, i => i.tag === 'input' && i.type === 'radio');
  assert.deepEqual(radios.map(r => r.checked), [false, true, false], 'the suggestion is preselected');
  assert.ok(btn(m.modal, 'Restate again (2 left)'));
  assert.equal(m.confirmed.length, 0, 'nothing is confirmed by showing the page');
});

test('confirming hands back the user edits (chosen candidate, setting, definition) and closes; before that nothing is confirmed', async () => {
  const m = openModal('claim');
  await toConfirm(m);
  assert.equal(m.confirmed.length, 0);
  find(m.modal.modalEl, i => i.tag === 'input' && i.type === 'radio')[0].change();
  type(find(m.modal.modalEl, i => i.cls.includes('vam-argument-setting'))[0], 'Period: 2024');
  type(find(m.modal.modalEl, i => i.cls.includes('vam-argument-definition'))[0], '18-24');
  btn(m.modal, 'Confirm and start research').click();
  await settle();
  assert.equal(m.confirmed.length, 1);
  const [input] = m.confirmed;
  assert.equal(input.claim, 'claim');
  assert.equal(input.model, 'a');
  assert.equal(input.chosen, 'q1');
  assert.deepEqual(input.result.settings, ['Period: 2024']);
  assert.equal(input.result.claims[0].definitions[0].meaning, '18-24');
  assert.equal(input.result.claims[1].definitions[0].meaning, 'largest estimated share');
  assert.equal(input.attempts, 1);
  assert.equal(m.modal.closeCount >= 1, true);
});

test('counterexample: cancel or Esc on the confirm page confirms nothing', async () => {
  const a = openModal('claim'); await toConfirm(a);
  btn(a.modal, 'Cancel').click();
  assert.equal(a.confirmed.length, 0);
  const b = openModal('claim'); await toConfirm(b);
  b.modal.scope.press('Escape');
  assert.equal(b.confirmed.length, 0);
});

test('counterexample: a blank definition or setting cannot be confirmed', async () => {
  const m = openModal('claim');
  await toConfirm(m);
  const def = find(m.modal.modalEl, i => i.cls.includes('vam-argument-definition'))[0];
  type(def, '   ');
  assert.equal(btn(m.modal, 'Confirm and start research').disabled, true);
  btn(m.modal, 'Confirm and start research').fire('click');
  assert.equal(m.confirmed.length, 0);
  type(def, 'ok');
  assert.equal(btn(m.modal, 'Confirm and start research').disabled, false);
});

test('restating again sends the note, counts against the limit, and a failure there can go back to the previous version', async () => {
  const m = openModal('claim');
  await toConfirm(m);
  type(find(m.modal.modalEl, i => i.cls.includes('vam-argument-note'))[0], '  narrower please ');
  btn(m.modal, 'Restate again (2 left)').click(); await settle();
  assert.equal(m.framer.calls[1].options.attempt, 2);
  assert.equal(m.framer.calls[1].options.note, 'narrower please');
  m.framer.fail(1); await settle();
  assert.ok(btn(m.modal, 'Back to the previous version'));
  btn(m.modal, 'Back to the previous version').click();
  assert.ok(btn(m.modal, 'Restate again (1 left)'), 'the failed call still counted');
  assert.equal(m.confirmed.length, 0);
});

test('counterexample: model replies are text only: a hostile string is shown as text and the window source has no HTML sink', async () => {
  const m = openModal('claim');
  await toConfirm(m, framingResult({ restatement: EVIL, vagueTerms: [EVIL], composition: EVIL,
    claims: [{ id: 'c1', text: EVIL, type: 'fact', role: 'premise', dependsOn: [], definitions: [{ term: EVIL, meaning: EVIL }], dataNeeds: [] }] }));
  const shown = find(m.modal.modalEl, i => i.text.includes('<img'));
  assert.ok(shown.length >= 4, 'it is shown literally');
  assert.equal(find(m.modal.modalEl, i => i.tag === 'img' || i.tag === 'script').length, 0, 'no element was created from it');
  assert.ok(shown.every(i => i.children.length === 0));
  const source = fs.readFileSync(path.join(__dirname, '..', 'ui', 'modals', 'argument-start-modal.ts'), 'utf8');
  assert.doesNotMatch(source, /innerHTML|outerHTML|insertAdjacentHTML|createFragment|DOMParser/);
});

test('once confirmed the breakdown cannot change: the claim list has no controls, and only chosen, settings and definitions are editable', async () => {
  const m = openModal('claim');
  await toConfirm(m);
  const list = find(m.modal.modalEl, i => i.tag === 'ol')[0];
  assert.equal(find(list, i => ['input', 'textarea', 'select', 'button'].includes(i.tag)).length, 0, 'the claim breakdown is read-only text');
  const editable = find(m.modal.contentEl, i => ['input', 'textarea', 'select'].includes(i.tag));
  assert.ok(editable.every(i => i.type === 'radio' || /vam-argument-(setting|definition|note)/.test(i.cls)), 'only the allowed controls exist');
  assert.equal(find(m.modal.contentEl, i => i.tag === 'textarea' && i.cls.includes('vam-argument-claim')).length, 0, 'the proposition itself is no longer editable');
  btn(m.modal, 'Confirm and start research').click();
  const after = find(m.modal.modalEl, i => i.tag === 'button' && i.text === 'Confirm and start research');
  after.forEach(b => b.fire('click'));
  assert.equal(m.confirmed.length, 1, 'a second press cannot confirm twice');
});

test('beforeFrame runs once before the first call; returning false calls nothing and closes', async () => {
  const seen = [];
  const m = openModal('claim', { beforeFrame: model => { seen.push(model); return false; } });
  select(m, 'b');
  btn(m.modal, 'Next').click(); await settle();
  assert.deepEqual(seen, ['b']);
  assert.equal(m.framer.calls.length, 0);
  assert.ok(m.modal.closeCount >= 1);
  function select(mm, v) { mm.select.value = v; mm.select.change(); }
});

// The view: wiring of the window to plugin.argumentRunsV2.
function fakeView(over = {}) {
  const calls = { starts: [], frames: [], models: [], cleared: 0 };
  const runs = {
    isRunning: () => false,
    frame: (original, options) => { calls.frames.push([original, options]); return Promise.resolve(framingResult()); },
    start: (p, locked) => { calls.starts.push([p, locked]); return Promise.resolve({ ok: true }); }
  };
  const view = {
    closed: false, path: 'M.vam', app: {},
    map: { id: 'm1', nodes: [], viewport: { x: 0, y: 0, zoom: 1 } },
    chatHero: () => true,
    chat: { clearDraft() { calls.cleared++; } },
    chatModelChoices: () => [{ value: 'a', label: 'Model A' }, { value: 'b', label: 'Model B' }],
    plugin: {
      settings: { cliModel: 'a' },
      argumentRunsV2: runs,
      setCurrentModel: async model => { calls.models.push(model); }
    },
    ...over
  };
  return { view, calls, runs };
}
const open = (view, draft = '  claim  ') => { opened.length = 0; VisualAgentMapView.prototype.openArgumentStart.call(view, draft); return opened[0]; };
const ok = modal => { modal.onOpen = modal.onOpen.bind(modal); return modal; };
async function drive(modal, mutate) {
  btn(modal, 'Next').click(); await settle(); await settle();
  mutate?.();
  const go = btn(modal, 'Confirm and start research');
  go.click(); await settle();
}

test('the window opens only on the opening screen and only when the V2 runner is wired', () => {
  assert.equal(open(fakeView({ chatHero: () => false }).view), undefined, 'not on the opening screen: no window');
  assert.equal(open(fakeView({ closed: true }).view), undefined, 'closed view: no window');
  const unwired = fakeView();
  delete unwired.view.plugin.argumentRunsV2;
  notices.length = 0;
  assert.equal(open(unwired.view), undefined, 'argumentRunsV2 missing: no window');
  assert.deepEqual(notices, ['Could not start hypothesis research on this mind map.']);
});

test('view: Next frames with the trimmed claim; confirm starts the run with a locked framing that carries the user edits', async () => {
  const { view, calls } = fakeView();
  const modal = ok(open(view));
  assert.ok(modal);
  const area = find(modal.contentEl, i => i.tag === 'textarea')[0];
  assert.equal(area.value, 'claim', 'the draft, trimmed');
  assert.equal(find(modal.contentEl, i => i.cls.includes('vam-argument-usage'))[0].text.includes('146'), true);
  assert.equal(calls.frames.length, 0);
  await drive(modal, () => {
    find(modal.modalEl, i => i.tag === 'input' && i.type === 'radio')[0].change();
    type(find(modal.modalEl, i => i.cls.includes('vam-argument-definition'))[0], '18-24');
  });
  assert.equal(calls.frames.length, 1);
  assert.equal(calls.frames[0][0], 'claim');
  assert.equal(calls.frames[0][1].attempt, 1);
  assert.equal(calls.starts.length, 1);
  const [p, locked] = calls.starts[0];
  assert.equal(p, 'M.vam');
  assert.equal(locked.framing.original, 'claim');
  assert.equal(locked.framing.chosen, 'q1', 'the picked candidate');
  assert.equal(locked.framing.attempts, 1);
  assert.match(locked.framing.lockedAt, /^\d{4}-\d\d-\d\dT/);
  assert.equal(locked.claims[0].definitions[0].meaning, '18-24', 'the edited definition reached the runner');
  assert.deepEqual(calls.models, [], 'same model: not switched');
  assert.equal(calls.cleared, 1, 'the draft is cleared');
});

test('view: before the confirm start is never called, and cancelling creates nothing (no start, draft kept)', async () => {
  const { view, calls } = fakeView();
  const modal = ok(open(view));
  btn(modal, 'Next').click(); await settle(); await settle();
  assert.equal(calls.frames.length, 1);
  assert.equal(calls.starts.length, 0, 'framed but not confirmed: no start');
  btn(modal, 'Cancel').click(); await settle();
  assert.equal(calls.starts.length, 0);
  assert.equal(calls.cleared, 0);
});

test('view: a different model becomes the current model before the first frame call', async () => {
  const { view, calls } = fakeView();
  const modal = ok(open(view));
  const select = find(modal.contentEl, i => i.tag === 'select')[0];
  select.value = 'b'; select.change();
  btn(modal, 'Next').click(); await settle(); await settle();
  assert.deepEqual(calls.models, ['b']);
  assert.equal(calls.frames.length, 1);
});

const STALE = {
  'the map got a node': v => { v.map.nodes.push({ id: 'n' }); },
  'another map is open': v => { v.map = { id: 'm2', nodes: [], viewport: v.map.viewport }; },
  'the tab shows another file': v => { v.path = 'Other.vam'; },
  'the view was closed': v => { v.closed = true; },
  'the map already has an argument key': v => { v.map.argumentMap = {}; },
  'a run is already going': v => { v.plugin.argumentRunsV2.isRunning = () => true; }
};
for (const [name, change] of Object.entries(STALE)) {
  test(`counterexample: ${name} after the window opened: Next calls nothing`, async () => {
    const { view, calls } = fakeView();
    const modal = ok(open(view));
    change(view);
    btn(modal, 'Next').click(); await settle(); await settle();
    assert.equal(calls.frames.length, 0);
    assert.equal(calls.starts.length, 0);
    assert.equal(calls.models.length, 0, 'no model switch either');
  });
  test(`counterexample: ${name} while the window is on the confirm page: confirming starts nothing`, async () => {
    const { view, calls } = fakeView();
    const modal = ok(open(view));
    await drive(modal, () => change(view));
    assert.equal(calls.starts.length, 0);
    assert.equal(calls.cleared, 0, 'the draft stays');
  });
}

test('counterexample: the map changes while the model switch is awaited: no frame call', async () => {
  const { view, calls } = fakeView();
  view.plugin.setCurrentModel = async model => { calls.models.push(model); view.map.nodes.push({ id: 'n' }); };
  const modal = ok(open(view));
  const select = find(modal.contentEl, i => i.tag === 'select')[0];
  select.value = 'b'; select.change();
  btn(modal, 'Next').click(); await settle(); await settle();
  assert.equal(calls.frames.length, 0);
});

test('a refused or thrown start shows a notice and releases the focus mark; the run is not awaited', async () => {
  for (const fail of [() => Promise.resolve({ ok: false, refusal: 'exists' }), () => Promise.reject(new Error('x'))]) {
    const { view, calls } = fakeView();
    view.plugin.argumentRunsV2.start = fail;
    notices.length = 0;
    const modal = ok(open(view));
    await drive(modal); await settle();
    assert.deepEqual(notices, ['Could not start hypothesis research on this mind map.']);
    assert.equal(calls.cleared, 1);
    assert.equal(view.argumentFocusMapId, null);
  }
});

// focusNode only pans the camera; the real keyboard focus (still in the opening screen's composer) must be moved onto the card itself.
test('the proposition card takes the keyboard focus once, not just the camera, when the argument map first shows', () => {
  const machine = load('core/argument-map/machine.ts');
  const roles = { proposition: 'p', situation: 's', conclusion: 'c', verified: 'v', eliminated: 'e' };
  const doc = { activeElement: null };
  const composer = dom.element('textarea'); composer.root = doc; composer.focus();
  const card = dom.element('div'); card.root = doc;
  const cardFocus = card.focus.bind(card);
  card.focus = options => { card.focusOptions = options; cardFocus(); };
  const panned = [];
  const view = {
    argumentFocusMapId: 'm1',
    map: { id: 'm1', nodes: [{ id: 'p' }, { id: 's' }, { id: 'c' }, { id: 'v' }, { id: 'e' }], argumentMap: machine.newArgumentMap(roles, 'run') },
    cardEls: new Map([['p', card]]),
    focusNode: node => panned.push(node.id)
  };
  VisualAgentMapView.prototype.focusArgumentRootOnce.call(view);
  assert.deepEqual(panned, ['p']);
  assert.equal(doc.activeElement, card, 'the card, not the composer, holds the focus');
  assert.equal(card.focusOptions.preventScroll, true);
  assert.equal(view.argumentFocusMapId, null);
  composer.focus();
  VisualAgentMapView.prototype.focusArgumentRootOnce.call(view);
  assert.equal(doc.activeElement, composer, 'only once: a later sync does not steal focus again');
});
