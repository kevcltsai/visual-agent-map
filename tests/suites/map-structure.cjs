// Map structure proposals (Phase C): the proposal list's kinds, the AI outline generator in the import window and
// in quick-explore, and the AI structure review. Dialogs run against tests/support-dom.cjs; the AI is a fake.
const assert = require('node:assert/strict');
const { test, integrationTest, load, plain, obsidian } = require('../support.cjs');
const dom = require('../support-dom.cjs');
const { hasCls, element, find, findAll, button, tick } = dom;

// ---- C1: proposal kinds ----------------------------------------------------------------------------------------
const proposals = () => load('experiences/visual-map/modals.ts', { obsidian });

test('proposal list: add, move, merge and remove each show their kind and reason', () => {
  const { renderProposalList } = proposals();
  const parent = element('div');
  renderProposalList(parent, [
    { kind: 'add', title: 'Sleep stages', task: 't', contribution: '', parentTitle: '', reason: 'The branch lacks the basics.' },
    { kind: 'move', title: 'Naps', task: '', contribution: '', parentTitle: '', reason: 'Belongs under habits.', destination: 'Habits' },
    { kind: 'merge', title: 'REM', task: '', contribution: '', parentTitle: '', reason: 'Same as dreaming.', destination: 'Dreaming' },
    { kind: 'remove', title: 'Misc', task: '', contribution: '', parentTitle: '', reason: 'Adds nothing.' }
  ], () => {});
  const rows = findAll(parent, i => hasCls(i, 'vam-proposal'));
  assert.deepEqual(rows.map(row => find(row, i => hasCls(i, 'vam-proposal-kind')).text), ['Add', 'Move', 'Merge', 'Remove']);
  assert.deepEqual(rows.map(row => find(row, i => hasCls(i, 'vam-proposal-kind')).cls.split(' ')[1]), ['vam-proposal-kind-add', 'vam-proposal-kind-move', 'vam-proposal-kind-merge', 'vam-proposal-kind-remove']);
  assert.deepEqual(rows.map(row => find(row, i => hasCls(i, 'vam-proposal-reason')).text), ['The branch lacks the basics.', 'Belongs under habits.', 'Same as dreaming.', 'Adds nothing.']);
  assert.equal(find(rows[1], i => hasCls(i, 'vam-proposal-destination')).text, 'To: Habits');
  assert.equal(find(rows[2], i => hasCls(i, 'vam-proposal-destination')).text, 'Into: Dreaming');
  // Only a new topic can be renamed or given a task; the others name an existing card.
  assert.deepEqual(rows.map(row => find(row, i => hasCls(i, 'vam-proposal-title')).readOnly), [false, true, true, true]);
  assert.deepEqual(rows.map(row => !!find(row, i => hasCls(i, 'vam-proposal-more'))), [true, false, false, false]);
});

test('proposal list: an add-only list renders as before, with no kind badge or reason', () => {
  const { renderProposalList } = proposals();
  const parent = element('div');
  const list = renderProposalList(parent, [{ title: 'Heat', task: 'Why', contribution: 'Base', parentTitle: '' }], () => {});
  assert.equal(find(parent, i => hasCls(i, 'vam-proposal-kind') || hasCls(i, 'vam-proposal-reason') || hasCls(i, 'vam-proposal-destination')), undefined);
  assert.ok(find(parent, i => hasCls(i, 'vam-proposal-more')));
  assert.equal(JSON.stringify(list.selected()), JSON.stringify([{ title: 'Heat', task: 'Why', contribution: 'Base', parentTitle: '' }]));
});

test('proposal list: keyed rows link children by key, so repeated titles stay in their own branch', () => {
  const { renderProposalList } = proposals();
  const parent = element('div');
  const list = renderProposalList(parent, [
    { key: '1', parentKey: '', title: 'Body', task: '', contribution: '' },
    { key: '2', parentKey: '1', title: 'Definition', task: '', contribution: '' },
    { key: '3', parentKey: '', title: 'Mind', task: '', contribution: '' },
    { key: '4', parentKey: '3', title: 'Definition', task: '', contribution: '' }
  ], () => {}, { compact: true });
  const rows = findAll(parent, i => hasCls(i, 'vam-proposal'));
  assert.deepEqual(rows.map(row => find(row, i => hasCls(i, 'vam-proposal-title')).value), ['Body', 'Definition', 'Mind', 'Definition']);
  assert.equal(find(parent, i => hasCls(i, 'vam-proposal-more')), undefined, 'compact rows have no details');
  const checks = findAll(parent, i => i.type === 'checkbox');
  checks[2].checked = false; checks[2].change();
  assert.deepEqual(checks.map(c => c.checked), [true, true, false, false], 'only the second Definition follows its parent');
  assert.equal(JSON.stringify(list.selected().map(item => [item.key, item.parentKey, item.title, item.parentTitle])), JSON.stringify([['1', '', 'Body', ''], ['2', '1', 'Definition', 'Body']]));
});

test('proposal list: review mode has no checkboxes and hands each row to the caller', () => {
  const { renderProposalList } = proposals();
  const parent = element('div');
  const handed = [];
  renderProposalList(parent, [
    { kind: 'remove', title: 'Misc', task: '', contribution: '', reason: 'r' },
    { kind: 'add', title: 'New', task: '', contribution: '', reason: 'r' }
  ], () => {}, { compact: true, apply: (item, row) => { handed.push(item.title); row.head.createEl('button', { text: 'Apply' }); } });
  assert.deepEqual(handed, ['Misc', 'New']);
  assert.ok(findAll(parent, i => i.type === 'checkbox').every(c => c.hidden && !c.checked));
  assert.equal(find(parent, i => hasCls(i, 'vam-proposal-toolbar')).hidden, true);
  assert.equal(findAll(parent, i => i.tag === 'button' && i.text === 'Apply').length, 2);
});

integrationTest('the plugin constructs the outline generator and the structure review next to reframing', () => {
  const { default: Plugin } = load('main.ts', { obsidian });
  const plugin = new Plugin();
  assert.equal(plugin.outlineGeneration.constructor.name, 'OutlineGenerationService');
  assert.equal(plugin.structureReview.constructor.name, 'StructureReviewService');
  assert.equal(typeof plugin.outlineGeneration.generate, 'function');
  assert.equal(typeof plugin.structureReview.review, 'function');
});


// ---- C2: AI outline in the import window ------------------------------------------------------------------------
function importHarness({ generate, presets = [], initialTopic = 'Sleep', language = 'en', prefill } = {}) {
  const Modal = dom.makeModal();
  const notices = [];
  const mod = load('experiences/visual-map/outline-import-modal.ts', { obsidian: { ...obsidian, Modal, Notice: class { constructor(m) { notices.push(m); } } } });
  const host = { settings: { language, promptPresets: presets }, saves: 0, async saveSettings() { this.saves++; } };
  const requests = [], created = [], startedInputs = [];
  // Owner decision 2026-10-19: the host calls `started` once AI starts (usage confirmed); the window then hides itself.
  const generator = { presets: host, initialTopic, ...(prefill ? { prefill } : {}), generate: generate ?? (async (request, _signal, started) => { requests.push(request); startedInputs.push(started()); return '# Sleep\n## Stages\n### REM\n'; }) };
  const modal = new mod.OutlineImportModal({}, async request => { created.push(request); }, undefined, [{ id: 't1', name: 'Template one' }], { map: 'editable', selected: { id: 'n1', title: 'Sleep' } }, 'under', generator);
  modal.open();
  const ai = find(modal.contentEl, i => i.tag === 'details' && hasCls(i, 'vam-outline-ai'));
  const status = () => find(ai, i => hasCls(i, 'vam-outline-ai-status')).text;
  const textarea = () => find(modal.contentEl, i => hasCls(i, 'vam-outline-text'));
  return { modal, host, mod, requests, created, startedInputs, ai, status, textarea, notices };
}
const byLabel = (root, label) => find(root, i => i.attrs['aria-label'] === label);

test('outline import: Generate hides the window once AI starts; the result comes back by reopening, and nothing is added until the user confirms (a, e)', async () => {
  const h = importHarness({ presets: [{ id: 'mine', kind: 'outline', name: 'Mine', text: 'Short tree for {research topic}' }, { id: 'tone', kind: 'tone', name: 'Tone', text: 'x' }] });
  assert.equal(find(h.ai, i => i.tag === 'summary').text, 'Generate an outline with AI');
  assert.equal(byLabel(h.ai, 'Research topic').value, 'Sleep', 'the selected topic is offered');
  const select = byLabel(h.ai, 'Outline preset');
  assert.deepEqual(plain(select.children.map(o => o.text)), ['Knowledge tree generator', 'Mine'], 'outline presets only');
  assert.equal(select.value, 'knowledge-tree');
  // Unsaved preset text, a research choice and the placement are all part of the run.
  byLabel(h.ai, 'Preset instructions').value = 'Unsaved wording';
  find(h.modal.contentEl, i => i.type === 'checkbox' && hasCls(i.parent ?? {}, 'vam-outline-check')).checked = true;
  button(h.ai, 'Generate outline').click(); await tick();
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].topic, 'Sleep');
  assert.match(h.requests[0].presetText, /Unsaved wording/);
  assert.equal(h.modal.closeCount, 1, 'the window hid itself once the host said AI started');
  assert.equal(h.textarea().value, '', 'the hidden window is not written');
  assert.deepEqual(h.created, [], 'generating writes nothing');
  assert.deepEqual(plain(h.startedInputs[0]), { topic: 'Sleep', presetId: 'knowledge-tree', presetText: 'Unsaved wording', placement: 'under', target: { map: 'editable', selected: { id: 'n1', title: 'Sleep' } }, shallow: true, depth: 'fast' });
  // Reopened by the host with the result: every input is back and the box is filled.
  const reopened = importHarness({ prefill: { inputs: h.startedInputs[0], markdown: '# Sleep\n## Stages\n### REM\n' } });
  assert.equal(byLabel(reopened.ai, 'Research topic').value, 'Sleep');
  assert.equal(byLabel(reopened.ai, 'Preset instructions').value, 'Unsaved wording', 'the unsaved preset text is restored');
  assert.equal(find(reopened.modal.contentEl, i => i.type === 'checkbox' && hasCls(i.parent ?? {}, 'vam-outline-check')).checked, true, 'shallow research is restored');
  assert.equal(reopened.textarea().value, '# Sleep\n## Stages\n### REM');
  assert.ok(find(reopened.modal.contentEl, i => i.text === '3 topics, 3 levels'), 'previewed like pasted text');
  assert.equal(reopened.status(), '3 headings filled in below. Edit them before adding.');
  assert.deepEqual(reopened.created, [], 'reopening writes nothing');
  // The user edits the result before adding it.
  reopened.textarea().value = '# Sleep\n## Stages'; reopened.textarea().fire('input');
  button(reopened.modal.modalEl, 'Add to mind map').click(); await tick();
  assert.deepEqual(plain(reopened.created[0].nodes.map(node => node.title)), ['Sleep', 'Stages']);
  assert.equal(reopened.created[0].source, null);
});

test('outline import: the note style chosen when AI starts is kept in the draft inputs and restored on the reopened window', async () => {
  const h = importHarness();
  find(h.modal.contentEl, i => i.type === 'checkbox' && hasCls(i.parent ?? {}, 'vam-outline-check')).checked = true;
  const style = byLabel(h.modal.contentEl, 'Note style'); style.value = 'preset:textbook'; style.fire('change');
  button(h.ai, 'Generate outline').click(); await tick();
  assert.equal(h.startedInputs[0].template, 'textbook'); assert.equal(h.startedInputs[0].tone, 'academic');
  const reopened = importHarness({ prefill: { inputs: h.startedInputs[0], markdown: '# Sleep\n## Stages' } });
  assert.equal(byLabel(reopened.modal.contentEl, 'Note style').value, 'preset:textbook');
  assert.equal(find(reopened.modal.contentEl, i => hasCls(i, 'vam-note-style-custom')).hidden, true);
  // A pair that is not a preset comes back under Custom…, with its template restored.
  const custom = importHarness({ prefill: { inputs: { ...h.startedInputs[0], template: 't1', tone: undefined }, markdown: '# Sleep\n## Stages' } });
  assert.equal(byLabel(custom.modal.contentEl, 'Note style').value, 'custom');
  assert.equal(find(custom.modal.contentEl, i => hasCls(i, 'vam-note-style-custom')).hidden, false);
  assert.equal(byLabel(custom.modal.contentEl, 'Content template').value, 't1');
  // Nothing chosen: the first option, and the draft inputs carry no style.
  const none = importHarness(); button(none.ai, 'Generate outline').click(); await tick();
  assert.equal('template' in none.startedInputs[0], false); assert.equal('tone' in none.startedInputs[0], false);
});

test('outline import: an empty topic, a failure before AI starts and Stop each leave the outline box alone and say why; the window stays open', async () => {
  const empty = importHarness({ initialTopic: '' });
  button(empty.ai, 'Generate outline').click(); await tick();
  assert.equal(empty.requests.length, 0); assert.equal(empty.status(), 'Enter a research topic before generating an outline.');
  // A decline or any failure before AI starts never calls `started`: the window stays with the reason.
  const bad = importHarness({ generate: async () => { throw new Error('The outline generation did not start.'); } });
  bad.textarea().value = '# Mine'; bad.textarea().fire('input');
  button(bad.ai, 'Generate outline').click(); await tick();
  assert.equal(bad.textarea().value, '# Mine');
  assert.match(bad.status(), /did not start/);
  assert.equal(bad.modal.closeCount, 0);
  let signal;
  const stop = importHarness({ generate: (_request, s) => { signal = s; return new Promise((_resolve, reject) => s.addEventListener('abort', () => reject(new Error('aborted')))); } });
  button(stop.ai, 'Generate outline').click(); await tick();
  assert.equal(stop.status(), 'AI is writing the outline…');
  button(stop.ai, 'Stop').click(); await tick();
  assert.equal(signal.aborted, true); assert.equal(stop.status(), 'Outline generation stopped.');
  assert.ok(button(stop.ai, 'Generate outline'), 'ready to run again');
  const closing = importHarness({ generate: (_request, s) => { signal = s; return new Promise(() => {}); } });
  button(closing.ai, 'Generate outline').click(); closing.modal.close();
  assert.equal(signal.aborted, true, 'closing the window before AI started stops the generation');
  // After AI started the window hid itself; closing it again does not stop the run (c) and a late result is not written.
  let late, hiddenSignal;
  const hidden = importHarness({ generate: (_request, s, started) => { hiddenSignal = s; started(); return new Promise(resolve => { late = resolve; }); } });
  button(hidden.ai, 'Generate outline').click(); await tick();
  assert.equal(hidden.modal.closeCount, 1); hidden.modal.close();
  assert.equal(hiddenSignal.aborted, false, 'the hidden run is stopped from the status bar, not by the window');
  late('# Late\n'); await tick(); await tick();
  assert.equal(hidden.textarea().value, ''); assert.equal(hidden.status(), 'AI is writing the outline…', 'nothing is written into the hidden window');
});

test('outline import: presets can be edited for one run, saved as a new preset, saved and deleted (asks twice)', async () => {
  const h = importHarness();
  const select = byLabel(h.ai, 'Outline preset');
  const editor = find(h.ai, i => hasCls(i, 'vam-outline-ai-editor'));
  assert.equal(editor.hidden, true);
  button(h.ai, 'Edit').click();
  assert.equal(editor.hidden, false);
  const text = byLabel(editor, 'Preset instructions'), name = byLabel(editor, 'Preset name');
  assert.equal(button(editor, 'Save').disabled, true, 'a built-in cannot be overwritten');
  assert.equal(button(h.ai, 'Delete').disabled, true, 'nor deleted');
  assert.equal(name.value, 'Knowledge tree generator copy');
  // An unsaved edit is used for the next run only.
  text.value = 'Edited for {research topic}';
  button(h.ai, 'Generate outline').click(); await tick();
  assert.equal(h.requests[0].presetText, 'Edited for {research topic}');
  assert.equal(h.host.saves, 0);
  // Save as a new custom preset; it becomes the selection.
  name.value = 'Brief tree';
  button(editor, 'Save as new preset').click(); await tick();
  assert.deepEqual(plain(h.host.settings.promptPresets.map(p => [p.kind, p.name, p.text])), [['outline', 'Brief tree', 'Edited for {research topic}']]);
  const id = h.host.settings.promptPresets[0].id;
  assert.equal(select.value, id); assert.equal(h.status(), 'Preset saved.');
  // Edit and save the custom one.
  assert.equal(button(editor, 'Save').disabled, false);
  byLabel(editor, 'Preset instructions').value = 'Tighter'; byLabel(editor, 'Preset name').value = 'Brief';
  button(editor, 'Save').click(); await tick();
  assert.deepEqual(plain(h.host.settings.promptPresets[0]), { id, kind: 'outline', name: 'Brief', text: 'Tighter' });
  // Delete asks twice.
  const remove = button(h.ai, 'Delete');
  remove.click(); await tick();
  assert.equal(h.host.settings.promptPresets.length, 1, 'the first press only arms');
  assert.equal(remove.text, 'Delete preset?');
  assert.match(h.status(), /Press again within 5 seconds/);
  remove.click(); await tick();
  assert.deepEqual(plain(h.host.settings.promptPresets), []);
  assert.equal(select.value, 'knowledge-tree');
  assert.equal(h.host.saves, 3);
  h.modal.close();
});

test('built-in outline presets put the topic into their placeholder in both languages', () => {
  const presets = load('ai/prompt-presets.ts');
  const outline = load('core/outline-generation-service.ts', { obsidian });
  for (const language of ['en', 'zh-TW']) {
    const [preset] = presets.builtinPresets(language, 'outline');
    const text = outline.applyTopicToPreset(preset.text, 'Sleep', language);
    assert.ok(text.includes('"Sleep"'), language);
    assert.equal(text.includes(presets.OUTLINE_TOPIC_PLACEHOLDER[language]), false, `${language}: no placeholder left`);
  }
});

// ---- C2: quick explore in the Next Step dialog --------------------------------------------------------------------
function quickHarness(quickOutline) {
  const notices = [];
  const Modal = dom.makeModal();
  const { NextStepModal } = load('main.ts', { obsidian: { ...obsidian, Modal, setIcon: () => {}, Notice: class { constructor(message) { notices.push(message); } } } });
  const modelState = provider => ({ provider, status: 'ready', models: provider === 'codex' ? ['gpt-test'] : [] });
  const plugin = { settings: { codexUsageNoticeSeen: true, claudeUsageNoticeSeen: true, models: 'gpt-test', cliModel: 'gpt-test', cliReasoning: 'low', language: 'en' },
    aiReadyForModel: async () => true, confirmAiUsage: async (_model, run) => { await run(); return true; }, saveSettings: async () => {}, activeTasks: new Map(), availableModels: () => ['gpt-test'], modelLabel: model => model,
    modelDiscoveryState: modelState, subscribeModelDiscovery: () => () => {}, refreshModelDiscovery: async provider => modelState(provider) };
  const expandCalls = [];
  // Owner decision 2026-10-19: Generate hides the dialog; the finished outline is handed to the view, which keeps it
  // for review. `reopen()` plays the card badge / Notice: a new dialog straight at the review.
  const handed = { begins: 0, ends: 0, ready: undefined, controller: undefined };
  const background = { begin: controller => { handed.begins++; handed.controller = controller; }, end: () => { handed.ends++; }, outlineReady: outline => { handed.ready = outline; } };
  const build = extra => new NextStepModal({}, 'Sleep', 'normal', 0, 0, plugin, async () => {}, async options => { expandCalls.push(options); }, async () => {},
    { model: 'gpt-test', modelSource: 'workspace', reasoning: 'low', save: async () => {}, topicStatus: 'completed', quickOutline, background, ...extra });
  const modal = build({});
  modal.open();
  const actions = () => find(modal.modalEl, i => hasCls(i, 'vam-next-actions'));
  const adjust = find(modal.contentEl, i => i.tag === 'details' && hasCls(i, 'vam-next-adjust'));
  button(adjust, 'Quickly explore a map').click();
  const harness = { modal, notices, actions, adjust, expandCalls, handed, discarded: 0 };
  harness.reopen = () => {
    const reopened = build({ pendingOutline: { ...handed.ready, discard: () => { harness.discarded++; } } });
    reopened.open();
    harness.reopened = reopened;
    return reopened;
  };
  return harness;
}
const outlineNodes = (markdown) => plain(load('experiences/visual-map/outline-import.ts', { obsidian }).parseOutline(markdown).nodes);

integrationTest('quick explore: a preset select plus levels and size fields, defaulting to 2 levels and up to 15', () => {
  const h = quickHarness({ presets: [{ id: 'knowledge-tree', name: 'Knowledge tree generator' }, { id: 'mine', name: 'Mine' }], generate: async () => [], create: async () => {} });
  const limits = find(h.adjust, i => hasCls(i, 'vam-quick-limits'));
  assert.equal(hasCls(limits, 'is-hidden'), false);
  assert.deepEqual(plain(byLabel(limits, 'Outline preset').children.map(o => o.text)), ['Knowledge tree generator', 'Mine']);
  assert.equal(byLabel(limits, 'Levels').value, '2'); assert.equal(byLabel(limits, 'Most subtopics').value, '15');
  assert.equal(button(h.actions(), 'Generate outline').hidden, false);
});

integrationTest('quick explore: Generate hides the dialog; the outline is reviewed in a reopened dialog before anything is created', async () => {
  const requests = [], created = [];
  const h = quickHarness({
    presets: [{ id: 'knowledge-tree', name: 'Knowledge tree generator' }, { id: 'mine', name: 'Mine' }],
    generate: async (request, signal) => { requests.push({ ...request, signal }); return outlineNodes('# Sleep\n## Body\n### Definition\n## Mind\n### Definition'); },
    create: async (nodes, options) => { created.push({ nodes, options }); }
  });
  byLabel(h.adjust, 'Outline preset').value = 'mine';
  button(h.actions(), 'Generate outline').click(); await tick(); await tick();
  assert.equal(requests.length, 1); assert.equal(requests[0].presetId, 'mine'); assert.equal(requests[0].language, 'en');
  assert.equal(h.modal.closeCount, 1, 'the dialog hides itself once the outline starts');
  assert.deepEqual(created, [], 'nothing is created before review');
  assert.equal(h.expandCalls.length, 0, 'the old quick expansion is not used');
  assert.equal(findAll(h.modal.contentEl, i => hasCls(i, 'vam-proposal')).length, 0, 'nothing is written into the hidden dialog');
  assert.deepEqual([h.handed.begins, h.handed.ends], [1, 1], 'the card shows the run until the outline is ready');
  const reopened = h.reopen();
  const titles = findAll(reopened.contentEl, i => hasCls(i, 'vam-proposal-title')).map(i => i.value);
  assert.deepEqual(titles, ['Body', 'Definition', 'Mind', 'Definition'], 'the topic itself is not proposed again');
  // Uncheck one branch and rename a row, then create.
  const checks = findAll(reopened.contentEl, i => i.type === 'checkbox' && hasCls(i.parent ?? {}, 'vam-proposal-head'));
  checks[2].checked = false; checks[2].change();
  findAll(reopened.contentEl, i => hasCls(i, 'vam-proposal-title'))[1].value = 'What it is';
  button(reopened.contentEl, 'Create subtopics (2)').click(); await tick(); await tick();
  assert.equal(created.length, 1);
  assert.deepEqual(plain(created[0].nodes.map(node => [node.index, node.title, node.parent])), [[0, 'Body', null], [1, 'What it is', 0]]);
  assert.equal(reopened.closeCount, 1); assert.ok(h.notices.includes('Subtopics created.'));
  assert.equal(h.discarded, 1, 'creating consumes the waiting outline');
});

integrationTest('quick explore: the reopened review keeps the dialog options and the generated nodes (including the dropped count)', async () => {
  const h = quickHarness({ presets: [{ id: 'knowledge-tree', name: 'Knowledge tree generator' }], create: async () => {},
    generate: async () => outlineNodes('# Sleep\n## A\n### A1\n#### Too deep\n## B') });
  byLabel(h.adjust, 'Levels').value = '2';
  find(h.adjust, i => i.tag === 'textarea').value = 'Keep it short';
  const shallow = findAll(h.adjust, i => i.tag === 'input' && i.type === 'checkbox')[0];
  shallow.checked = true; shallow.change();
  button(h.actions(), 'Generate outline').click(); await tick(); await tick();
  assert.equal(h.handed.ready.dropped, 1); assert.equal(h.handed.ready.options.shallowResearch, true); assert.equal(h.handed.ready.options.requirements, 'Keep it short');
  const reopened = h.reopen();
  assert.ok(find(reopened.contentEl, i => /Left out beyond the chosen levels or size: 1 heading/.test(i.text ?? '')), 'the review says what was left out');
  assert.deepEqual(findAll(reopened.contentEl, i => hasCls(i, 'vam-proposal-title')).map(i => i.value), ['A', 'A1', 'B']);
  assert.equal(findAll(reopened.contentEl, i => i.tag === 'input' && i.type === 'checkbox')[0].checked, true, 'the shallow research choice is restored');
  assert.equal(button(reopened.contentEl, 'Create subtopics (3)').disabled, false, 'the reopened review can create straight away');
});

integrationTest('quick explore: the chosen levels and size reach the generator and an over-deep or over-long reply is trimmed before review', async () => {
  const requests = [];
  const h = quickHarness({
    presets: [{ id: 'knowledge-tree', name: 'Knowledge tree generator' }],
    generate: async request => { requests.push(request); return outlineNodes('# Sleep\n## Body\n### Definition\n#### Too deep\n## Mind\n## Dreams\n## Extra'); },
    create: async () => {}
  });
  const levels = byLabel(h.adjust, 'Levels'), size = byLabel(h.adjust, 'Most subtopics');
  levels.value = '2'; size.value = '5';
  button(h.actions(), 'Generate outline').click(); await tick(); await tick();
  assert.deepEqual(plain(requests[0].limits), { levels: 2, maxTopics: 5 });
  const titles = findAll(h.reopen().contentEl, i => hasCls(i, 'vam-proposal-title')).map(i => i.value);
  assert.deepEqual(titles, ['Body', 'Definition', 'Mind', 'Dreams', 'Extra'], 'the level-3 heading is left out');
  assert.ok(find(h.reopened.contentEl, i => /Left out beyond the chosen levels or size: 1 heading/.test(i.text ?? '')), 'the review says what was left out');
});
integrationTest('quick explore: when the AI writes too many topics, every main branch is kept before any grows deeper', async () => {
  const h = quickHarness({ presets: [{ id: 'knowledge-tree', name: 'Knowledge tree generator' }], create: async () => {},
    generate: async () => outlineNodes('# Sleep\n## A\n### A1\n### A2\n## B\n### B1\n### B2\n## C\n### C1\n### C2') });
  byLabel(h.adjust, 'Levels').value = '2'; byLabel(h.adjust, 'Most subtopics').value = '5';
  button(h.actions(), 'Generate outline').click(); await tick(); await tick();
  const titles = findAll(h.reopen().contentEl, i => hasCls(i, 'vam-proposal-title')).map(i => i.value);
  assert.deepEqual(titles, ['A', 'A1', 'A2', 'B', 'C'], 'A, B and C all survive; the extra depth is what gets cut');
});
integrationTest('quick explore: out-of-range levels and size are clamped to 1–6 and 1–30', async () => {
  const requests = [];
  const h = quickHarness({ presets: [{ id: 'knowledge-tree', name: 'Knowledge tree generator' }], generate: async request => { requests.push(request); return outlineNodes('# Sleep\n## Body'); }, create: async () => {} });
  byLabel(h.adjust, 'Levels').value = '99'; byLabel(h.adjust, 'Most subtopics').value = '0';
  button(h.actions(), 'Generate outline').click(); await tick(); await tick();
  assert.deepEqual(plain(requests[0].limits), { levels: 6, maxTopics: 1 });
});

integrationTest('quick explore: Stop on the card aborts the hidden outline, hands nothing to the view and writes nothing; hiding the dialog alone does not stop it (f)', async () => {
  let signal; const created = [];
  const h = quickHarness({ presets: [{ id: 'knowledge-tree', name: 'Knowledge tree generator' }], generate: (_request, s) => { signal = s; return new Promise(resolve => s.addEventListener('abort', () => resolve(outlineNodes('# Sleep\n## Late')))); }, create: async nodes => { created.push(nodes); } });
  button(h.actions(), 'Generate outline').click(); await tick(); await tick();
  assert.equal(h.modal.closeCount, 1); assert.equal(signal.aborted, false, 'hiding the dialog does not stop the AI');
  h.modal.close(); await tick();
  assert.equal(signal.aborted, false, 'closing the hidden dialog again never aborts it');
  h.handed.controller.abort(); await tick(); await tick();
  assert.equal(signal.aborted, true);
  assert.deepEqual(created, []);
  assert.equal(h.handed.ready, undefined, 'a late result after Stop is dropped');
  assert.equal(findAll(h.modal.contentEl, i => hasCls(i, 'vam-proposal')).length, 0, 'no review shown in the closed dialog');
});

integrationTest('quick explore: a failure after the dialog hid is a Notice and hands nothing to the view', async () => {
  const h = quickHarness({ presets: [{ id: 'knowledge-tree', name: 'Knowledge tree generator' }], create: async () => {}, generate: async () => { throw new Error('The AI outline has 101 headings; the limit is 100.'); } });
  button(h.actions(), 'Generate outline').click(); await tick(); await tick(); await tick();
  assert.equal(h.modal.closeCount, 1, 'the run had already started, so the dialog is hidden');
  assert.ok(h.notices.some(message => /101 headings/.test(message)), 'the failure is announced by a Notice');
  assert.equal(h.handed.ready, undefined);
});

test('outline proposals round-trip: the root is dropped, keys keep repeated titles apart, parents come first', () => {
  const { outlineProposals, proposalOutline } = load('experiences/visual-map/modals.ts', { obsidian });
  const items = outlineProposals(outlineNodes('# Root\n## A\n### Same\n## B\n### Same'));
  assert.equal(JSON.stringify(items.map(i => [i.key, i.parentKey, i.title])), JSON.stringify([['1', '', 'A'], ['2', '1', 'Same'], ['3', '', 'B'], ['4', '3', 'Same']]));
  const nodes = proposalOutline([items[2], items[3]]);
  assert.equal(JSON.stringify(nodes.map(n => [n.index, n.title, n.parent, n.level])), JSON.stringify([[0, 'B', null, 1], [1, 'Same', 0, 2]]));
  assert.throws(() => proposalOutline([items[3]]), /parent/);
});

// ---- C3: AI structure review --------------------------------------------------------------------------------------
const { fixture, core, DEFAULT_SETTINGS, withExpansionCoordinator, until } = require('../support.cjs');

const sampleReview = { suggestions: [
  { kind: 'strengthen', targetId: 'root', title: 'Sleep hygiene', reason: 'Habits are missing.', basis: {} },
  { kind: 'move', targetId: 'c', newParentId: 'b', reason: 'REM is about the mind.', basis: {} },
  { kind: 'merge', targetId: 'd', mergeIntoId: 'b', reason: 'Dreams repeat Mind.', basis: {} },
  { kind: 'reduce', targetId: 'a', reason: 'Body is out of scope.', basis: {} }
], rejected: [{ index: 4, code: 'unknown_target' }] };
// The window alone, against a fake host.
function windowHarness({ review, stale = () => null, apply, initial } = {}) {
  const Modal = dom.makeModal();
  const mod = load('experiences/visual-map/structure-review-modal.ts', { obsidian: { ...obsidian, Modal } });
  const calls = { review: 0, apply: [], highlight: [], consumed: 0 };
  const titles = { root: 'Sleep', a: 'Body', b: 'Mind', c: 'REM', d: 'Dreams' };
  const host = {
    scope: 'map',
    // Owner decision 2026-10-19: once AI starts the host calls `started`, the window hides and the result waits in the host.
    review: review ?? (async (_signal, started) => { calls.review++; started(); return sampleReview; }),
    ...(initial ? { initial, consumed: () => { calls.consumed++; } } : {}),
    titleOf: id => titles[id] ?? '',
    staleReason: suggestion => stale(suggestion),
    apply: apply ?? (async (suggestion, title) => { calls.apply.push([suggestion.kind, title]); return true; }),
    highlight: ids => calls.highlight.push([...ids])
  };
  const modal = new mod.StructureReviewModal({}, host);
  modal.open();
  const rows = () => findAll(modal.contentEl, i => hasCls(i, 'vam-proposal'));
  const applyOf = row => find(row, i => i.tag === 'button' && hasCls(i, 'vam-structure-apply'));
  const noteOf = row => find(row, i => hasCls(i, 'vam-structure-note')).text;
  return { modal, host, calls, rows, applyOf, noteOf };
}

test('structure review window: starts on Close and runs only on request; Start hides the window once AI starts and closing it later never cancels the review (a, c)', async () => {
  let signal;
  const h = windowHarness({ review: (s, started) => { signal = s; started(); return new Promise(() => {}); } });
  assert.equal(h.modal.titleEl.text, 'Review the whole map');
  assert.ok(button(h.modal.modalEl, 'Close').focused, 'an Enter cannot start the review');
  assert.equal(signal, undefined, 'nothing runs before Start');
  button(h.modal.modalEl, 'Start review').click(); await tick();
  assert.equal(h.modal.closeCount, 1, 'the window hid itself once the host said AI started');
  assert.equal(signal.aborted, false); h.modal.close();
  assert.equal(signal.aborted, false, 'closing the hidden window does not stop the review: Stop is on the status bar');
  assert.equal(h.rows().length, 0, 'nothing is written into the hidden window');
});

test('structure review window: reopened with the finished result it lists every kind with its reason, marks the cards, has no Start and clears on close (e)', async () => {
  const h = windowHarness({ initial: sampleReview });
  assert.equal(h.modal.titleEl.text, 'Review the whole map');
  assert.equal(button(h.modal.modalEl, 'Start review'), undefined, 'a reopened result has no Start');
  assert.equal(h.calls.review, 0);
  assert.deepEqual(h.rows().map(row => find(row, i => hasCls(i, 'vam-proposal-kind')).text), ['Add', 'Move', 'Merge', 'Remove']);
  assert.deepEqual(h.rows().map(row => find(row, i => hasCls(i, 'vam-proposal-reason')).text), ['Habits are missing.', 'REM is about the mind.', 'Dreams repeat Mind.', 'Body is out of scope.']);
  assert.deepEqual(h.rows().map(row => find(row, i => hasCls(i, 'vam-proposal-title')).value), ['Sleep hygiene', 'REM', 'Dreams', 'Body']);
  assert.deepEqual(h.rows().map(row => find(row, i => hasCls(i, 'vam-proposal-destination'))?.text), ['Under: Sleep', 'To: Mind', 'Into: Mind', undefined]);
  assert.ok(find(h.modal.contentEl, i => i.text === '1 suggestions could not be used (an unknown card, the root, a loop, a duplicate or no change) and were left out.'));
  assert.deepEqual(h.calls.highlight.at(-1), ['root', 'c', 'b', 'd', 'b', 'a'], 'every suggested card is marked');
  assert.deepEqual(h.calls.apply, [], 'nothing is applied until asked');
  assert.equal(h.calls.consumed, 0);
  h.modal.close();
  assert.deepEqual(h.calls.highlight.at(-1), [], 'closing clears the marks');
  assert.equal(h.calls.consumed, 1, 'closing the reopened window drops the waiting result');
});

test('structure review window: each suggestion is applied on its own; a new topic name can be edited first', async () => {
  const h = windowHarness({ initial: sampleReview });
  const [add, move] = h.rows();
  find(add, i => hasCls(i, 'vam-proposal-title')).value = 'Sleep habits';
  h.applyOf(add).click(); await tick(); await tick();
  assert.deepEqual(h.calls.apply, [['strengthen', 'Sleep habits']]);
  assert.equal(h.applyOf(add).text, 'Applied'); assert.equal(h.applyOf(add).disabled, true); assert.ok(hasCls(add, 'is-applied'));
  assert.equal(h.noteOf(add), 'Applied. Undo reverts this change.');
  assert.deepEqual(h.calls.highlight.at(-1), ['c', 'b', 'd', 'b', 'a'], 'an applied suggestion is no longer marked');
  h.applyOf(add).click(); await tick();
  assert.equal(h.calls.apply.length, 1, 'applied once');
  h.applyOf(move).click(); await tick(); await tick();
  assert.deepEqual(h.calls.apply.map(c => c[0]), ['strengthen', 'move']);
});

test('structure review window: a stale suggestion is refused with its reason; a cancelled confirmation or a failure leaves it applicable', async () => {
  let staleIds = new Set();
  const outcomes = { merge: false, reduce: 'error' };
  const h = windowHarness({ stale: s => staleIds.has(s.targetId) ? 'This suggestion is out of date: the card was renamed or moved after the review.' : null,
    apply: async s => { h.calls.apply.push([s.kind]); if (outcomes[s.kind] === 'error') throw new Error('Disk is read-only'); return outcomes[s.kind] ?? true; }, initial: sampleReview });
  const [add, , merge, reduce] = h.rows();
  staleIds = new Set(['root']);
  h.applyOf(add).click(); await tick();
  assert.deepEqual(h.calls.apply, [], 'a stale suggestion is never applied');
  assert.equal(h.applyOf(add).disabled, true); assert.ok(hasCls(add, 'is-stale'));
  assert.equal(h.noteOf(add), 'This suggestion is out of date: the card was renamed or moved after the review.');
  h.applyOf(merge).click(); await tick(); await tick();
  assert.deepEqual(h.calls.apply, [['merge']]);
  assert.equal(h.applyOf(merge).disabled, false, 'a cancelled confirmation can be applied later'); assert.equal(hasCls(merge, 'is-applied'), false);
  h.applyOf(reduce).click(); await tick(); await tick();
  assert.equal(h.noteOf(reduce), 'Disk is read-only'); assert.equal(h.applyOf(reduce).disabled, false);
});

test('structure review window: Cancel during the review and closing early write nothing', async () => {
  let signal;
  const h = windowHarness({ review: s => { signal = s; return new Promise((_resolve, reject) => s.addEventListener('abort', () => reject(new Error('aborted')))); } });
  button(h.modal.modalEl, 'Start review').click(); await tick();
  button(h.modal.modalEl, 'Cancel').click(); await tick(); await tick();
  assert.equal(signal.aborted, true);
  assert.ok(find(h.modal.modalEl, i => i.text === 'Review cancelled. Nothing was changed.'));
  assert.deepEqual(h.calls.apply, []); assert.equal(h.rows().length, 0);
  const late = windowHarness({ review: s => { signal = s; return new Promise(() => {}); } });
  button(late.modal.modalEl, 'Start review').click(); late.modal.close();
  assert.equal(signal.aborted, true); assert.deepEqual(late.calls.apply, []);
});

test('structure review window: a review that still resolves after Cancel offers Start again and shows nothing', async () => {
  let finish, reviews = 0;
  const suggestions = { suggestions: [{ kind: 'reduce', targetId: 'a', reason: 'Body is out of scope.', basis: {} }], rejected: [] };
  const h = windowHarness({ review: () => { reviews++; return new Promise(resolve => { finish = resolve; }); } });
  button(h.modal.modalEl, 'Start review').click(); await tick();
  const cancel = button(h.modal.modalEl, 'Cancel');
  cancel.click(); finish(suggestions); await tick(); await tick();
  assert.ok(find(h.modal.modalEl, i => i.text === 'Review cancelled. Nothing was changed.'));
  assert.equal(button(h.modal.modalEl, 'Cancel'), undefined, 'the button no longer reads Cancel');
  const start = button(h.modal.modalEl, 'Start review');
  assert.equal(start, cancel); assert.ok(hasCls(start, 'mod-cta'));
  assert.equal(h.rows().length, 0, 'the late review is not shown'); assert.deepEqual(h.calls.apply, []);
  assert.equal(reviews, 1);
  start.click(); await tick();
  assert.equal(reviews, 2, 'Start runs a new review only when it says so');
  assert.equal(button(h.modal.modalEl, 'Cancel'), start);
});

test('structure review window: a reopened result puts the focus on the first suggestion, and each Apply names its suggestion', async () => {
  const h = windowHarness({ initial: sampleReview });
  const [add, move, merge, reduce] = h.rows();
  assert.equal(h.applyOf(add).focused, true, 'the first suggestion takes the focus');
  assert.deepEqual([add, move, merge, reduce].map(row => h.applyOf(row).attrs['aria-label']), ['Apply: Sleep hygiene', 'Apply: REM', 'Apply: Dreams', 'Apply: Body']);
  const name = find(add, i => hasCls(i, 'vam-proposal-title'));
  name.value = 'Sleep habits'; name.input();
  assert.equal(h.applyOf(add).attrs['aria-label'], 'Apply: Sleep habits');
  h.applyOf(move).click(); await tick(); await tick();
  assert.equal(h.applyOf(move).attrs['aria-label'], 'Applied: REM');
});

test('structure review window: a reopened result with no suggestions puts the focus on Close', async () => {
  const h = windowHarness({ initial: { suggestions: [], rejected: [] } });
  assert.equal(button(h.modal.modalEl, 'Close').focused, true);
  assert.ok(find(h.modal.contentEl, i => i.text === 'AI has no structure suggestions for this part of the map.'));
});

// The real view and repository, with a fake provider behind the real structure review service.
class Setting {
  constructor(el) { this.el = el; }
  setName() { return this; } setDesc() { return this; }
  addButton(callback) { const b = { setButtonText(text) { this.text = text; return this; }, onClick(fn) { this.run = fn; return this; }, setDestructive() { return this; } }; callback(b); (this.el.choiceButtons ??= []).push(b); return this; }
}
async function viewHarness(reply, { fragments = false } = {}) {
  const { repo, app } = fixture('en');
  const settings = { ...DEFAULT_SETTINGS, language: 'en', cliModel: 'gpt-6-luna' };
  repo.settings = settings;
  const mapPath = 'Agent Workspace/Topics/map-a/Map.md';
  const mapDoc = { id: 'map-a', title: 'Sleep map', version: 1, nodes: [], viewport: { x: 0, y: 0, zoom: 1 } };
  await repo.ensureTopicFolders('Agent Workspace/Topics/map-a');
  const ids = {};
  const add = async (key, title, parent) => {
    const created = await repo.createNote(title, 'gpt-6-luna', mapDoc, mapPath, parent ? 'inherited' : 'workspace');
    Object.assign(created, { parentId: parent ? ids[parent] : null, x: parent ? 400 : 80, y: 80 + mapDoc.nodes.length * 200 });
    mapDoc.nodes.push(created); ids[key] = created.id;
    return created;
  };
  await add('root', 'Sleep'); await add('a', 'Body', 'root'); await add('b', 'Mind', 'root'); await add('c', 'REM', 'a');
  await add('d', 'Dreams', 'b'); await add('e', 'Misc', 'root'); await add('f', 'Leftover', 'e');
  await app.vault.create(mapPath, core.serializeMap(mapDoc));
  await repo.rebuildDerivedData();
  const body = mapDoc.nodes.find(n => n.id === ids.a);
  await repo.updateNote(body.path, { summary: 'How the body sleeps.', detail: '### Findings\n\nSECRET FULL NOTE BODY' });
  const opened = [], notices = [];
  const Base = dom.makeModal();
  class Modal extends Base { open() { opened.push(this); super.open(); } }
  const control = { gate: null, decline: false };
  const plugin = withExpansionCoordinator({ repo, settings, running: new Set(), abortChartJobs: () => {}, addChartsAfterWrite: () => {}, rebuildDerivedData: () => repo.rebuildDerivedData(), mutate: async work => work(), releaseOutline() {}, confirmAiUsage: async (_model, run) => { if (control.decline) return false; await run(); return true; } });
  const Notice = fragments ? dom.makeNotice(notices) : class { constructor(m) { notices.push(m); } };
  const { VisualAgentMapView } = load('main.ts', { obsidian: { ...obsidian, Modal, Setting, Notice } }, fragments ? { createFragment: dom.createFragment } : {});
  const { StructureReviewService } = load('core/structure-review-service.ts');
  const requests = [];
  plugin.structureReview = new StructureReviewService(async request => { requests.push(request); if (control.gate) await control.gate.promise; return JSON.stringify(typeof reply === 'function' ? reply(ids) : reply); });
  const view = new VisualAgentMapView({ app }, plugin);
  const reload = async () => { view.notes = new Map(await Promise.all(view.map.nodes.map(async n => [n.id, await repo.readNote(n.path)]))); };
  view.path = mapPath; view.map = await repo.readMap(mapPath); view.render = () => {}; view.focusNode = () => {}; view.hydrate = reload;
  await reload();
  const cards = new Map(view.map.nodes.map(n => [n.id, element('div', 'vam-node')]));
  for (const [id, card] of cards) view.cardEls.set(id, card);
  const saved = async () => (await repo.readMap(mapPath)).nodes;
  const parentOf = async key => (await saved()).find(n => n.id === ids[key])?.parentId;
  // Owner decision 2026-10-19: Start hides the window and the review runs in the view; the finished result is read
  // by reopening from the status bar / Notice, which `start` plays.
  const start = async scope => {
    view.openStructureReview(scope);
    const first = opened.at(-1);
    button(first.modalEl, 'Start review').click();
    await until(() => view.structureReviewTask && view.structureReviewTask.state !== 'running');
    const task = view.structureReviewTask;
    assert.equal(first.closeCount, 1, 'the window hid itself once the review started');
    view.reopenStructureReview(task);
    const modal = opened.at(-1);
    const rows = () => findAll(modal.contentEl, i => hasCls(i, 'vam-proposal'));
    const apply = async (index, settle = true) => { find(rows()[index], i => hasCls(i, 'vam-structure-apply')).click(); if (settle) { await tick(); await tick(); } };
    return { modal, rows, apply, first, task };
  };
  const choose = async label => {
    const dialog = opened.at(-1);
    const choice = dialog.contentEl.choiceButtons.find(b => b.text === label);
    assert.ok(choice, `choice ${label}`); choice.run();
    await until(() => true); await tick(); await tick(); await tick();
  };
  const press = label => { const action = Notice.all.flatMap(n => n.actions).find(b => b.text === label); assert.ok(action, `notice button ${label}`); action.click(); };
  const bar = () => { const parent = element('div'); view.renderBackgroundBars(parent); return parent; };
  return { repo, app, view, plugin, ids, requests, opened, notices, cards, saved, parentOf, start, choose, mapPath, control, Notice, press, bar };
}
const fullReply = ids => ({ suggestions: [
  { kind: 'strengthen', targetId: ids.root, reason: 'Habits are missing.', title: 'Sleep hygiene', newParentId: '', mergeIntoId: '' },
  { kind: 'move', targetId: ids.c, reason: 'REM is about the mind.', title: '', newParentId: ids.b, mergeIntoId: '' },
  { kind: 'merge', targetId: ids.e, reason: 'Misc repeats Body.', title: '', newParentId: '', mergeIntoId: ids.a },
  { kind: 'reduce', targetId: ids.d, reason: 'Dreams are out of scope.', title: '', newParentId: '', mergeIntoId: '' },
  { kind: 'reduce', targetId: 'invented-id', reason: 'Not on the map.', title: '', newParentId: '', mergeIntoId: '' }
] });

integrationTest('structure review on the map: the AI gets titles, summaries and status only, unknown ids are dropped, cards are marked until the window closes', async () => {
  const h = await viewHarness(fullReply);
  const { modal, rows } = await h.start(null);
  const sent = h.requests[0];
  assert.equal(sent.rootQuestion, 'Sleep map');
  assert.deepEqual(Object.keys(sent.nodes[0]).sort(), ['depth', 'id', 'parentId', 'status', 'summary', 'title']);
  assert.ok(sent.nodes.some(n => n.title === 'Body' && n.summary === 'How the body sleeps.'));
  assert.equal(JSON.stringify(sent).includes('SECRET FULL NOTE BODY'), false, 'no note body is sent');
  assert.equal(rows().length, 4, 'the invented id is not offered');
  assert.ok(find(modal.contentEl, i => i.text === '1 suggestions could not be used (an unknown card, the root, a loop, a duplicate or no change) and were left out.'));
  const marked = [...h.cards].filter(([, card]) => hasCls(card, 'vam-structure-suggested')).map(([id]) => id).sort();
  assert.deepEqual(marked, [h.ids.root, h.ids.a, h.ids.b, h.ids.c, h.ids.d, h.ids.e].sort());
  modal.close();
  assert.equal([...h.cards.values()].filter(card => hasCls(card, 'vam-structure-suggested')).length, 0, 'closing clears every mark');
});

integrationTest('structure review: suggestions follow the map language while errors stay in the interface language', async () => {
  const { buildStructureReviewPrompt } = load('core/structure-review-service.ts');
  const h = await viewHarness({ suggestions: [] });
  h.view.map.title = '要如何在陽台養香草';
  h.view.openStructureReview(null);
  button(h.opened.at(-1).modalEl, 'Start review').click(); await until(() => h.requests.length);
  assert.equal(h.requests[0].language, 'en');
  assert.equal(h.requests[0].contentLanguage, 'zh-TW');
  assert.match(buildStructureReviewPrompt(h.requests[0]), /Traditional Chinese/);
  assert.doesNotMatch(buildStructureReviewPrompt({ ...h.requests[0], contentLanguage: undefined }), /Traditional Chinese/);
  const english = await viewHarness({ suggestions: [] });
  english.view.openStructureReview(null);
  button(english.opened.at(-1).modalEl, 'Start review').click(); await until(() => english.requests.length);
  assert.equal(english.requests[0].contentLanguage, 'en');
  assert.doesNotMatch(buildStructureReviewPrompt(english.requests[0]), /Traditional Chinese/);
});

integrationTest('structure review: a branch review sends only that branch with the branch topic as its root', async () => {
  const h = await viewHarness({ suggestions: [] });
  h.view.openStructureReview(h.ids.a);
  const branch = h.opened.at(-1);
  assert.equal(branch.titleEl.text, 'Review this branch');
  button(branch.modalEl, 'Start review').click(); await until(() => h.requests.length);
  assert.equal(h.requests[0].rootQuestion, 'Body');
  assert.equal(JSON.stringify(h.requests[0].nodes.map(n => [n.title, n.parentId === null])), JSON.stringify([['Body', true], ['REM', false]]));
  // The window is hidden; the (empty) result waits on the view and shows when it is reopened.
  await until(() => h.view.structureReviewTask?.state === 'done');
  assert.equal(branch.closeCount, 1);
  h.view.reopenStructureReview(h.view.structureReviewTask);
  assert.ok(find(h.opened.at(-1).contentEl, i => i.text === 'AI has no structure suggestions for this part of the map.'));
});

integrationTest('structure review: add, move, merge and remove each apply as one undo step', async () => {
  const h = await viewHarness(fullReply);
  const { rows, apply } = await h.start(null);
  const before = JSON.stringify((await h.saved()).map(n => [n.id, n.parentId]));
  // Add: a new child of the root.
  await apply(0);
  let nodes = await h.saved();
  const added = nodes.find(n => n.parentId === h.ids.root && !Object.values(h.ids).includes(n.id));
  assert.ok(added); assert.equal((await h.repo.readNote(added.path)).title, 'Sleep hygiene');
  await h.view.history.undo().undo();
  assert.equal(JSON.stringify((await h.saved()).map(n => [n.id, n.parentId])), before, 'one undo removes the added topic');
  // Move: REM goes under Mind.
  await apply(1);
  assert.equal(await h.parentOf('c'), h.ids.b);
  await h.view.history.undo().undo();
  assert.equal(await h.parentOf('c'), h.ids.a);
  // Merge: through the delete confirmation; Misc's subtopic moves to Body, Misc leaves the map.
  // The added topic's note was parked in Unassigned by its undo (D11a), so count only what the merge adds.
  const parkedBefore = (await h.repo.collectionFiles(h.mapPath, 'Unassigned')).length;
  assert.equal(parkedBefore, 1, 'the undone add parked its note');
  await apply(2, false); await tick();
  assert.equal(h.opened.at(-1).titleEl.text, 'Merge “Misc” into “Body”');
  await h.choose('Merge and remove “Misc”');
  nodes = await h.saved();
  assert.equal(nodes.some(n => n.id === h.ids.e), false);
  assert.equal(await h.parentOf('f'), h.ids.a);
  assert.equal((await h.repo.collectionFiles(h.mapPath, 'Unassigned')).length, parkedBefore + 1);
  await h.view.history.undo().undo();
  assert.equal(await h.parentOf('e'), h.ids.root); assert.equal(await h.parentOf('f'), h.ids.e);
  // Remove: the existing delete confirmation, entire branch.
  await apply(3, false); await tick();
  assert.equal(h.opened.at(-1).titleEl.text, 'Remove from map');
  await h.choose('Remove entire branch');
  assert.equal((await h.saved()).some(n => n.id === h.ids.d), false);
  await h.view.history.undo().undo();
  assert.equal(await h.parentOf('d'), h.ids.b);
  assert.equal(JSON.stringify((await h.saved()).map(n => [n.id, n.parentId])), before, 'every change undone');
  assert.equal(rows().length, 4);
});

integrationTest('structure review: a stale suggestion is blocked, a cancelled confirmation and closing the window write nothing', async () => {
  const h = await viewHarness(fullReply);
  const { modal, rows, apply } = await h.start(null);
  const before = JSON.stringify(await h.saved());
  // The map changes after the review: REM is renamed, so the move suggestion is out of date.
  h.view.notes.get(h.ids.c).title = 'REM sleep';
  await apply(1);
  assert.equal(JSON.stringify(await h.saved()), before, 'nothing written');
  assert.ok(hasCls(rows()[1], 'is-stale'));
  assert.equal(find(rows()[1], i => hasCls(i, 'vam-structure-note')).text, 'This suggestion is out of date: the card was renamed or moved after the review.');
  assert.equal(find(rows()[1], i => hasCls(i, 'vam-structure-apply')).disabled, true);
  // A card removed from the map makes its suggestion stale too.
  h.view.map.nodes = h.view.map.nodes.filter(n => n.id !== h.ids.d);
  await apply(3);
  assert.match(find(rows()[3], i => hasCls(i, 'vam-structure-note')).text, /no longer on the map/);
  h.view.map = await h.repo.readMap(h.mapPath);
  // Cancel the merge confirmation: nothing changes and the suggestion stays available.
  await apply(2, false); await tick();
  h.opened.at(-1).close(); await tick(); await tick();
  assert.equal(JSON.stringify(await h.saved()), before);
  assert.equal(find(rows()[2], i => hasCls(i, 'vam-structure-apply')).disabled, false);
  assert.equal(h.view.history.canUndo, false, 'no undo entry was recorded');
  modal.close();
  assert.equal(JSON.stringify(await h.saved()), before, 'closing the window writes nothing');
});

integrationTest('structure review: a card renamed or moved while the remove or merge confirmation is open is checked again inside the write', async () => {
  const h = await viewHarness(fullReply);
  const { rows, apply } = await h.start(null);
  const before = JSON.stringify(await h.saved());
  // Remove: the confirmation opens, then Dreams is renamed before the user picks.
  await apply(3, false); await tick();
  assert.equal(h.opened.at(-1).titleEl.text, 'Remove from map');
  h.view.notes.get(h.ids.d).title = 'Dream journal';
  await h.choose('Remove entire branch');
  assert.equal(JSON.stringify(await h.saved()), before, 'nothing written');
  assert.ok(hasCls(rows()[3], 'is-stale'));
  assert.equal(find(rows()[3], i => hasCls(i, 'vam-structure-note')).text, 'This suggestion is out of date: the card was renamed or moved after the review.');
  assert.equal(find(rows()[3], i => hasCls(i, 'vam-structure-apply')).disabled, true);
  // Merge: the confirmation opens, then Misc is moved under Mind before the user picks.
  await apply(2, false); await tick();
  assert.equal(h.opened.at(-1).titleEl.text, 'Merge “Misc” into “Body”');
  h.view.map.nodes.find(n => n.id === h.ids.e).parentId = h.ids.b;
  await h.choose('Merge and remove “Misc”');
  assert.equal(JSON.stringify(await h.saved()), before, 'nothing written');
  assert.ok(hasCls(rows()[2], 'is-stale'));
  assert.equal(find(rows()[2], i => hasCls(i, 'vam-structure-note')).text, 'This suggestion is out of date: the card was renamed or moved after the review.');
  assert.equal(h.view.history.canUndo, false, 'no undo entry was recorded');
});

// ---- Background structure review: the view owns the run once the window hides ---------------------------------------
const { deferred } = require('../support.cjs');
const pending = h => { h.view.openStructureReview(null); const first = h.opened.at(-1); return first; };
integrationTest('structure review in the background: the window hides only after usage is confirmed; a declined notice keeps it open and starts nothing (a)', async () => {
  const h = await viewHarness(fullReply, { fragments: true });
  h.control.decline = true;
  const first = pending(h);
  button(first.modalEl, 'Start review').click(); await tick(); await tick();
  assert.equal(first.closeCount, 0, 'declined: the window stays open'); assert.equal(h.requests.length, 0, 'no provider request');
  assert.ok(find(first.modalEl, i => i.text === 'The structure review did not start.'));
  assert.equal(h.view.structureReviewTask, null);
  h.control.decline = false;
  button(first.modalEl, 'Start review').click(); await until(() => h.view.structureReviewTask?.state === 'done');
  assert.equal(first.closeCount, 1, 'confirmed: the window hid itself'); assert.equal(h.requests.length, 1);
});
integrationTest('structure review in the background: the status bar shows running and Stop; Stop sends nothing more, clears marks and drops a late result (b, f)', async () => {
  const h = await viewHarness(fullReply, { fragments: true });
  h.control.gate = deferred();
  const first = pending(h);
  button(first.modalEl, 'Start review').click(); await until(() => h.view.structureReviewTask?.state === 'running');
  assert.ok(find(h.bar(), i => i.text === 'AI is reviewing the structure…'), 'the bar shows it running');
  assert.equal(h.opened.length, 1, 'no other window opened');
  dom.button(h.bar(), 'Stop research').click();
  assert.equal(h.view.structureReviewTask, null); assert.equal(h.bar().children.length, 0);
  h.control.gate.resolve(); await tick(); await tick(); await tick();
  assert.equal(h.view.structureReviewTask, null, 'a result that arrives after Stop is dropped');
  assert.equal(h.Notice.all.length, 0, 'no Notice for a stopped review');
  assert.equal([...h.cards.values()].some(card => hasCls(card, 'vam-structure-suggested')), false);
});
integrationTest('structure review in the background: completion is one Notice with a View button and a status-bar entry; no window opens by itself, closing the hidden window does not cancel (c, d)', async () => {
  const h = await viewHarness(fullReply, { fragments: true });
  h.control.gate = deferred();
  const first = pending(h);
  button(first.modalEl, 'Start review').click(); await until(() => h.view.structureReviewTask?.state === 'running');
  const controller = h.view.structureReviewTask.controller;
  first.close();
  assert.equal(controller.signal.aborted, false, 'closing the hidden window never cancels');
  h.control.gate.resolve(); await until(() => h.view.structureReviewTask.state === 'done');
  assert.equal(h.Notice.all.filter(n => n.actions.length).length, 1);
  assert.equal(h.Notice.all[0].actions[0].text, 'View 4 suggestions');
  assert.equal(h.opened.length, 1, 'no review window opened by itself');
  assert.equal(findAll(first.contentEl, i => hasCls(i, 'vam-proposal')).length, 0, 'nothing written into the hidden window');
  assert.ok(dom.button(h.bar(), 'View 4 suggestions'), 'the status bar keeps the entry');
  assert.ok(dom.button(h.bar(), '×'));
});
integrationTest('structure review in the background: View reopens the window with the results and card marks, no Start; closing clears the marks and the entry (e)', async () => {
  const h = await viewHarness(fullReply, { fragments: true });
  const first = pending(h);
  button(first.modalEl, 'Start review').click(); await until(() => h.view.structureReviewTask?.state === 'done');
  assert.equal([...h.cards.values()].some(card => hasCls(card, 'vam-structure-suggested')), false, 'no marks while the window is hidden');
  h.press('View 4 suggestions');
  const modal = h.opened.at(-1);
  assert.notEqual(modal, first);
  assert.equal(button(modal.modalEl, 'Start review'), undefined);
  assert.equal(findAll(modal.contentEl, i => hasCls(i, 'vam-proposal')).length, 4);
  assert.equal([...h.cards.values()].filter(card => hasCls(card, 'vam-structure-suggested')).length, 6, 'the suggested cards are marked again');
  modal.close();
  assert.equal([...h.cards.values()].some(card => hasCls(card, 'vam-structure-suggested')), false);
  assert.equal(h.view.structureReviewTask, null, 'closing the reopened window consumes the result');
  // A second request while one runs is refused with the existing message.
  h.control.gate = deferred();
  const again = pending(h);
  button(again.modalEl, 'Start review').click(); await until(() => h.view.structureReviewTask?.state === 'running');
  h.view.openStructureReview(null);
  assert.ok(h.notices.includes('AI running…'), 'pressing again while it runs says so');
  assert.equal(h.opened.length, 3, 'and opens no second window');
  h.control.gate.resolve(); await until(() => h.view.structureReviewTask.state === 'done');
});
integrationTest('structure review in the background: a failure is a Notice plus a failed bar entry; view close or another map aborts the run and clears the marks (g)', async () => {
  const failing = await viewHarness(() => { throw new Error('boom'); }, { fragments: true });
  const first = pending(failing);
  button(first.modalEl, 'Start review').click(); await until(() => failing.view.structureReviewTask?.state === 'failed');
  assert.ok(failing.Notice.all.some(n => /boom/.test(n.message)), 'the failure is a Notice');
  assert.ok(find(failing.bar(), i => /boom/.test(i.text ?? '')), 'and stays on the status bar');
  assert.equal(failing.opened.length, 1);
  const closing = await viewHarness(fullReply, { fragments: true });
  closing.control.gate = deferred();
  const second = pending(closing);
  button(second.modalEl, 'Start review').click(); await until(() => closing.view.structureReviewTask?.state === 'running');
  const controller = closing.view.structureReviewTask.controller;
  await closing.view.onClose();
  assert.equal(controller.signal.aborted, true); assert.equal(closing.view.structureReviewTask, null);
  closing.control.gate.resolve(); await tick(); await tick(); await tick();
  assert.equal(closing.Notice.all.length, 0, 'a result after the view closed is dropped');
  const switched = await viewHarness(fullReply, { fragments: true });
  switched.control.gate = deferred();
  const third = pending(switched);
  button(third.modalEl, 'Start review').click(); await until(() => switched.view.structureReviewTask?.state === 'running');
  const running = switched.view.structureReviewTask.controller;
  switched.view.dropMapBackground();
  assert.equal(running.signal.aborted, true); assert.equal(switched.view.structureReviewTask, null);
  switched.control.gate.resolve(); await tick(); await tick();
});

test('structure review entry copy in Traditional Chinese; the review window titles stay as they are', () => {
  const { translate } = load('i18n.ts');
  assert.equal(translate('zh-TW', 'ui.structure_review_entry_label'), 'AI 結構建議：');
  assert.equal(translate('zh-TW', 'ui.structure_review_entry_map'), '哪裡該加強或刪減？（整張圖）');
  assert.equal(translate('zh-TW', 'ui.structure_review_entry_branch'), '哪裡該加強或刪減？（這個分支）');
  assert.equal(translate('zh-TW', 'ui.structure_review_entry_hint'), 'AI 只讀標題、摘要與狀態，建議新增、刪減、移動或合併議題；每條可單獨套用、可復原。');
  assert.equal(translate('zh-TW', 'ui.structure_review_map'), '檢視整張圖');
  assert.equal(translate('zh-TW', 'ui.structure_review_branch'), '檢視這個分支');
});

integrationTest('structure review entry: the root topic offers the whole map, a subtopic with subtopics its branch, a leaf nothing', async () => {
  const h = await viewHarness({ suggestions: [] });
  const entry = id => h.view.structureReviewEntry(h.view.map.nodes.find(n => n.id === id));
  assert.equal(entry(h.ids.root).label, 'What to strengthen or cut? (whole map)');
  assert.equal(entry(h.ids.a).label, 'What to strengthen or cut? (this branch)');
  assert.equal(entry(h.ids.c), undefined);
  // The Next Step dialog shows it and opens the review in its place.
  const notices = [];
  const Modal = dom.makeModal();
  const { NextStepModal } = load('main.ts', { obsidian: { ...obsidian, Modal, setIcon: () => {}, Notice: class { constructor(m) { notices.push(m); } } } });
  const modelState = provider => ({ provider, status: 'ready', models: [] });
  const plugin = { settings: { codexUsageNoticeSeen: true, claudeUsageNoticeSeen: true, models: 'gpt-test', cliModel: 'gpt-test', cliReasoning: 'low', language: 'en' }, aiReadyForModel: async () => true, confirmAiUsage: async (_m, run) => { await run(); return true; }, saveSettings: async () => {}, activeTasks: new Map(), availableModels: () => ['gpt-test'], modelLabel: m => m, modelDiscoveryState: modelState, subscribeModelDiscovery: () => () => {}, refreshModelDiscovery: async p => modelState(p) };
  let opened = 0;
  const modal = new NextStepModal({}, 'Sleep', 'normal', 3, 0, plugin, async () => {}, async () => {}, async () => {}, { model: 'gpt-test', modelSource: 'workspace', reasoning: 'low', save: async () => {}, structureReview: { label: 'What to strengthen or cut? (whole map)', open: () => { opened++; } } });
  modal.open();
  assert.ok(find(modal.contentEl, i => hasCls(i, 'vam-next-structure-label') && i.text === 'AI structure suggestions:'));
  assert.ok(find(modal.contentEl, i => hasCls(i, 'vam-next-structure-hint') && i.text === 'AI reads only titles, summaries and status, then suggests topics to add, cut, move or merge; apply each one on its own, and undo any.'));
  button(modal.contentEl, 'What to strengthen or cut? (whole map)').click();
  assert.equal(opened, 1); assert.equal(modal.closeCount, 1);
});

// ---- Adversarial cases from the Phase C test pass: late results, cancelled confirms and entry points -------------
const diffWorld = (a0, b0) => { const strip = j => JSON.stringify(JSON.parse(j).map(([k, v]) => [k, v.replace(/^updated: .*\n/gm, '').replace(/^updated: .*$/gm, '').replace(/^agent-map-id: .*\n/gm, '')])); const a = strip(a0), b = strip(b0); return diffWorld0(a, b); };
const diffWorld0 = (a, b) => { const A = new Map(JSON.parse(a)), B = new Map(JSON.parse(b)); const out = []; for (const k of new Set([...A.keys(), ...B.keys()])) { if (!A.has(k)) out.push('ADDED ' + k); else if (!B.has(k)) out.push('MISSING ' + k); else if (A.get(k) !== B.get(k)) { const x = A.get(k).split('\n'), y = B.get(k).split('\n'); out.push('CHANGED ' + k + JSON.stringify([A.get(k).slice(0,400), B.get(k).slice(0,400)]) + ': ' + x.filter(l => !y.includes(l)).join(' | ') + ' => ' + y.filter(l => !x.includes(l)).join(' | ')); } } return out.join('\n'); };
const world = async h => { const files = h.app.vault.getMarkdownFiles().sort((a, b) => a.path.localeCompare(b.path)); const out = []; for (const f of files) out.push([f.path, await h.app.vault.read(f)]); return JSON.stringify(out); };
const noteText = (row) => find(row, i => hasCls(i, 'vam-structure-note')).text;
const applyBtn = (row) => find(row, i => hasCls(i, 'vam-structure-apply'));
integrationTest('structure review: cancelled confirm for reduce and merge: suggestion applicable, nothing written; Escape-like close path too', async () => {
  const h = await viewHarness(fullReply);
  const { rows, apply } = await h.start(null);
  const w0 = await world(h);
  for (const idx of [3, 2]) {
    await apply(idx, false); await tick();
    h.opened.at(-1).close(); await tick(); await tick();
    assert.equal(applyBtn(rows()[idx]).disabled, false, `row ${idx} still applicable`);
    assert.equal(await world(h), w0); assert.equal(h.view.history.canUndo, false);
  }
  // now actually apply after cancelling: still works
  await apply(3, false); await tick(); await h.choose('Remove entire branch');
  assert.equal((await h.saved()).some(n => n.id === h.ids.d), false);
});
integrationTest('structure review entries: leaf, AIM map, builtin sample, outside topics folder', async () => {
  const h = await viewHarness({ suggestions: [] });
  const entry = id => h.view.structureReviewEntry(h.view.map.nodes.find(n => n.id === id));
  assert.equal(entry(h.ids.c), undefined); assert.equal(entry(h.ids.f), undefined);
  assert.ok(entry(h.ids.root)); assert.ok(entry(h.ids.a));
  h.view.map.aim = { kind: 'aim' };
  assert.equal(entry(h.ids.root), undefined, 'aim: root'); assert.equal(entry(h.ids.a), undefined, 'aim: branch');
  delete h.view.map.aim;
  h.view.builtIn = true;
  assert.equal(entry(h.ids.root), undefined, 'sample root'); assert.equal(entry(h.ids.a), undefined);
  h.view.openStructureReview(null); assert.equal(h.opened.length, 0, 'direct open refused on sample');
  h.view.builtIn = false;
  h.view.openStructureReview(null); assert.equal(h.opened.length, 1);
  const p = h.view.path; h.view.path = 'Other/Map.md';
  assert.equal(entry(h.ids.root), undefined);
  h.view.path = p;
});

test('structure review window: a host that ignores abort and resolves late writes nothing into a closed or cancelled window', async () => {
  const result = { suggestions: [{ kind: 'strengthen', targetId: 'root', title: 'T', reason: 'r', basis: {} }], rejected: [] };
  for (const how of ['close', 'cancel']) {
    let release; const h = windowHarness({ review: () => new Promise(r => { release = () => r(result); }) });
    button(h.modal.modalEl, 'Start review').click(); await tick();
    if (how === 'close') h.modal.close(); else button(h.modal.modalEl, 'Cancel').click();
    await tick(); release(); await tick(); await tick();
    assert.equal(h.rows().length, 0, how + ': no rows');
    assert.deepEqual(h.calls.highlight.at(-1) ?? [], [], how + ': highlight clear');
    assert.equal(h.calls.highlight.some(ids => ids.length), false, how + ': never highlighted');
  }
});
test('outline modal: a generator that ignores abort and resolves late changes nothing after Stop or close; prose reply shows error and blocks add', async () => {
  for (const how of ['stop', 'close']) {
    let release; const h = importHarness({ generate: () => new Promise(r => { release = () => r('# Late\n## Result'); }) });
    h.textarea().value = '# Mine'; h.textarea().fire('input');
    button(h.ai, 'Generate outline').click(); await tick();
    if (how === 'stop') button(h.ai, 'Stop').click(); else h.modal.close();
    await tick(); release(); await tick(); await tick();
    assert.equal(h.textarea().value, '# Mine', how);
  }
  const outline = load('core/outline-generation-service.ts', { obsidian });
  const cases = { leadingProse: 'Here is your outline:\n# Sleep\n## Stages', trailingProse: '# Sleep\n## Stages\nHope this helps!', bullets: '# Sleep\n- item', proseFenceMix: 'Sure!\n```markdown\n# Sleep\n## A\n```', fenceThenProse: '```md\n# Sleep\n## A\n```\nDone.', frontMatter: '---\ntitle: x\n---\n# Sleep\n## A', html: '<!-- c -->\n# Sleep\n## A', empty: '', onlyProse: 'No headings here' };
  for (const [name, raw] of Object.entries(cases)) assert.throws(() => outline.parseOutlineReply(raw, 'en'), e => e.name === 'OutlineGenerateError', name);
  assert.doesNotThrow(() => outline.parseOutlineReply('```markdown\n# Sleep\n## A\n```', 'en'));
  assert.doesNotThrow(() => outline.parseOutlineReply('# Sleep\n## A\n', 'en'));
});
