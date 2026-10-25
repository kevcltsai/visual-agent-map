// Map AI dialogs (Phase B): tone presets library and pickers, the one-click Next Step dialog and the single-dialog
// synthesis flow. Dialogs run against the DOM stand-in in tests/support-dom.cjs; only the AI callbacks are doubles.
const assert = require('node:assert/strict');
const { test, integrationTest, load, plain, obsidian, node, map } = require('../support.cjs');
const dom = require('../support-dom.cjs');
const { hasCls, element, find, findAll, byLabel, button, buttons, tick } = dom;

// ---- tone presets library -------------------------------------------------------------------------------------
function presetsHarness(settings = {}) {
  const Modal = dom.makeModal();
  const mod = load('ui/modals/prompt-presets-modal.ts', { obsidian: { ...obsidian, Modal } });
  const plugin = { settings: { language: 'en', promptPresets: [], ...settings }, saves: 0, async saveSettings() { this.saves++; } };
  const modal = new mod.PromptPresetsModal({}, plugin, 'tone'); modal.open();
  const rows = () => findAll(modal.contentEl, i => i.cls === 'vam-template-row');
  const names = () => rows().map(r => find(r, i => i.tag === 'strong').text);
  const row = name => rows().find(r => find(r, i => i.tag === 'strong').text === name);
  const rowButtons = name => findAll(row(name), i => i.tag === 'button').map(b => b.text);
  const click = async (root, text) => { const b = button(root, text); assert.ok(b, `button ${text}`); b.click(); await tick(); };
  return { modal, plugin, rows, names, row, rowButtons, click };
}
test('tone library: built-ins offer View and Duplicate only; custom tones can be edited, renamed, duplicated and deleted', async () => {
  const h = presetsHarness({ promptPresets: [{ id: 'mine', kind: 'tone', name: 'Mine', text: 'Be brief.' }, { id: 'tree', kind: 'outline', name: 'Tree', text: 'x' }] });
  assert.deepEqual(h.names(), ['Plain explanation', 'Magazine column', 'Key-point summary', 'Practical guide', 'Academic rigor', 'AI choice', 'Mine'], 'outline presets are not listed');
  assert.deepEqual(plain(h.rowButtons('Academic rigor')), ['View', 'Duplicate']);
  assert.deepEqual(plain(h.rowButtons('Mine')), ['Edit', 'Duplicate', 'Delete']);
  assert.ok(find(h.row('Academic rigor'), i => i.cls === 'vam-template-tag' && i.text === 'Built-in'));
  // A built-in opens read-only.
  await h.click(h.row('Academic rigor'), 'View');
  assert.equal(byLabel(h.modal.contentEl, 'Tone name').disabled, true);
  assert.equal(byLabel(h.modal.contentEl, 'Describe the tone').disabled, true);
  assert.equal(button(h.modal.modalEl, 'Save'), undefined);
  await h.click(h.modal.modalEl, 'Close');
  // Duplicate a built-in: becomes an editable custom tone with the same text.
  await h.click(h.row('Magazine column'), 'Duplicate');
  assert.equal(h.plugin.promptPresets, undefined);
  const copy = h.plugin.settings.promptPresets.find(item => item.name === 'Magazine column copy');
  assert.ok(copy && copy.kind === 'tone' && copy.text.length > 10);
  assert.equal(h.plugin.saves, 1);
  // Edit and rename a custom one; Cancel discards, Save persists.
  await h.click(h.row('Mine'), 'Edit');
  byLabel(h.modal.contentEl, 'Tone name').value = 'Renamed'; byLabel(h.modal.contentEl, 'Tone name').fire('input');
  byLabel(h.modal.contentEl, 'Describe the tone').value = 'New voice.';
  await h.click(h.modal.modalEl, 'Cancel');
  assert.equal(h.plugin.settings.promptPresets.find(item => item.id === 'mine').name, 'Mine');
  await h.click(h.row('Mine'), 'Edit');
  byLabel(h.modal.contentEl, 'Tone name').value = 'Renamed'; byLabel(h.modal.contentEl, 'Tone name').fire('input');
  byLabel(h.modal.contentEl, 'Describe the tone').value = 'New voice.';
  await h.click(h.modal.modalEl, 'Save');
  assert.deepEqual(plain(h.plugin.settings.promptPresets.find(item => item.id === 'mine')), { id: 'mine', kind: 'tone', name: 'Renamed', text: 'New voice.' });
  assert.ok(h.names().includes('Renamed'));
  // A blank name cannot be saved and says why.
  await h.click(h.row('Renamed'), 'Edit');
  byLabel(h.modal.contentEl, 'Tone name').value = '  '; byLabel(h.modal.contentEl, 'Tone name').fire('input');
  assert.equal(button(h.modal.modalEl, 'Save').disabled, true);
  assert.ok(find(h.modal.modalEl, i => i.text === 'Enter a name before saving.'));
  await h.click(h.modal.modalEl, 'Cancel');
});
test('tone library: delete asks twice (armed for five seconds) and New tone opens an editor that saves a custom tone', async () => {
  const h = presetsHarness({ promptPresets: [{ id: 'mine', kind: 'tone', name: 'Mine', text: 'Be brief.' }] });
  const del = find(h.row('Mine'), i => i.tag === 'button' && i.text === 'Delete');
  del.click();
  assert.equal(h.plugin.settings.promptPresets.length, 1, 'the first press only arms');
  assert.equal(del.text, 'Delete tone?');
  assert.ok(find(h.modal.modalEl, i => /Press again within 5 seconds/.test(i.text)));
  del.click(); await tick();
  assert.deepEqual(plain(h.plugin.settings.promptPresets), []);
  assert.equal(h.plugin.saves, 1);
  await h.click(h.modal.modalEl, 'New tone');
  assert.equal(byLabel(h.modal.contentEl, 'Tone name').value, 'My tone');
  byLabel(h.modal.contentEl, 'Describe the tone').value = 'Warm and concrete.';
  await h.click(h.modal.modalEl, 'Save');
  assert.deepEqual(plain(h.plugin.settings.promptPresets.map(item => [item.kind, item.name, item.text])), [['tone', 'My tone', 'Warm and concrete.']]);
});

// ---- tone pickers -----------------------------------------------------------------------------------------------
integrationTest('map default tone picker: lists built-in and custom tones, marks the current one, sets and clears map.toneId', async () => {
  const opened = [];
  const { VisualAgentMapView } = load('main.ts', { obsidian: { ...obsidian, Modal: class { constructor() {} open() { opened.push(this); } close() {} }, Notice: class {} } });
  const plugin = { settings: { language: 'en', promptPresets: [{ id: 'mine', kind: 'tone', name: 'Mine', text: 'x' }] } };
  const view = new VisualAgentMapView({ app: {} }, plugin);
  view.map = map([node('a')]); view.enqueue = work => work();
  view.mapChange = async change => { change(view.map); };
  view.chooseMapTone();
  const choices = opened.at(-1).choices;
  assert.deepEqual(plain(choices.map(c => c.label)), ['Use the default (Academic rigor)', 'Plain explanation', 'Magazine column', 'Key-point summary', 'Practical guide', 'Academic rigor', 'AI choice', 'Mine']);
  assert.equal(choices[0].description, 'Current setting');
  await choices[2].action(); await tick();
  assert.equal(view.map.toneId, 'magazine');
  view.chooseMapTone();
  assert.equal(opened.at(-1).choices[2].description, 'Current setting');
  await choices[0].action(); await tick();
  assert.equal('toneId' in view.map, false);
});
integrationTest('multi-select research dialog: the tone picker defaults to keeping each topic and submits the chosen preset id', () => {
  const Modal = dom.makeModal();
  const { MultiResearchModal } = load('experiences/visual-map/multi-research-modal.ts', { obsidian: { ...obsidian, Modal } });
  const submitted = [];
  const models = { list: () => [], watch: () => () => {} };
  const modal = new MultiResearchModal({}, ['A', 'B'], models, [], request => submitted.push(request), [{ id: 'plain', name: 'Plain' }, { id: 'academic', name: 'Academic' }]);
  modal.open();
  const tone = byLabel(modal.contentEl, 'Writing tone');
  assert.deepEqual(plain(tone.children.map(o => o.text)), ["Each topic's current tone", 'Plain', 'Academic']);
  button(modal.modalEl, 'Start research (2)').click();
  assert.equal('toneId' in submitted[0], false, 'keeping each topic omits the field');
  const second = new MultiResearchModal({}, ['A', 'B'], models, [], request => submitted.push(request), [{ id: 'plain', name: 'Plain' }]);
  second.open(); byLabel(second.contentEl, 'Note style').value = 'custom'; byLabel(second.contentEl, 'Note style').fire('change'); byLabel(second.contentEl, 'Writing tone').value = 'plain'; button(second.modalEl, 'Start research (2)').click();
  assert.equal(submitted[1].toneId, 'plain');
});

integrationTest('tone picker: the edit link opens the tone library at the chosen tone and refreshes the list when it closes', () => {
  const Modal = dom.makeModal();
  const { MultiResearchModal } = load('experiences/visual-map/multi-research-modal.ts', { obsidian: { ...obsidian, Modal } });
  const models = { list: () => [], watch: () => () => {} };
  const tones = [{ id: 'plain', name: 'Plain' }, { id: 'custom-1', name: 'Mine' }];
  const opened = [];
  const modal = new MultiResearchModal({}, ['A', 'B'], models, [], () => {}, tones, (selected, refreshed) => opened.push({ selected, refreshed }));
  modal.open();
  const select = byLabel(modal.contentEl, 'Writing tone');
  select.value = 'custom-1';
  button(modal.contentEl, 'Edit tones…').click();
  assert.equal(opened.length, 1); assert.equal(opened[0].selected, 'custom-1', 'the library opens at the chosen tone');
  opened[0].refreshed([{ id: 'plain', name: 'Plain' }, { id: 'custom-1', name: 'Mine, edited' }, { id: 'custom-2', name: 'New one' }]);
  assert.deepEqual(plain(select.children.map(o => o.text)), ["Each topic's current tone", 'Plain', 'Mine, edited', 'New one'], 'edited and new tones show at once');
  assert.equal(select.value, 'custom-1', 'the choice survives the refresh');
  opened[0].refreshed([{ id: 'plain', name: 'Plain' }]);
  assert.equal(select.value, '', 'a deleted choice falls back to the default option');
  const presets = load('ui/modals/prompt-presets-modal.ts', { obsidian: { ...obsidian, Modal } });
  const host = { settings: { language: 'en', promptPresets: [{ id: 'custom-1', kind: 'tone', name: 'Mine', text: 'Short and warm.' }] }, saveSettings: async () => {} };
  const library = new presets.PromptPresetsModal({}, host, 'tone', () => {}, 'custom-1'); library.open();
  assert.equal(byLabel(library.contentEl, 'Tone text')?.value ?? findAll(library.contentEl, i => i.tag === 'textarea')[0].value, 'Short and warm.', 'opens straight into the editor');
});

integrationTest('template and model pickers: the edit link opens the template library at the chosen template, the fix link checks the chosen model', () => {
  const Modal = dom.makeModal();
  const { MultiResearchModal } = load('experiences/visual-map/multi-research-modal.ts', { obsidian: { ...obsidian, Modal } });
  const models = { list: () => [{ id: 'gpt-a', label: 'Codex · gpt-a' }], watch: () => () => {} };
  const templates = [{ id: 'standard', name: 'Standard' }, { id: 'mine', name: 'Mine' }];
  const opened = [], repaired = [];
  const modal = new MultiResearchModal({}, ['A', 'B'], models, templates, () => {}, [], undefined, {
    repair: model => repaired.push(model), manageTemplates: (selected, refreshed) => opened.push({ selected, refreshed }) });
  modal.open();
  const select = byLabel(modal.contentEl, 'Content template');
  select.value = 'mine';
  button(modal.contentEl, 'Edit templates…').click();
  assert.equal(opened.length, 1); assert.equal(opened[0].selected, 'mine', 'the library opens at the chosen template');
  opened[0].refreshed([{ id: 'standard', name: 'Standard' }, { id: 'mine', name: 'Mine, edited' }]);
  assert.deepEqual(plain(select.children.map(o => o.text)), ["Each topic's current template", 'Standard', 'Mine, edited'], 'edited templates show at once');
  assert.equal(select.value, 'mine', 'the choice survives the refresh');
  byLabel(modal.contentEl, 'Model').value = 'gpt-a';
  button(modal.contentEl, 'Fix connection…').click();
  assert.deepEqual(repaired, ['gpt-a'], 'the fix link checks the chosen model');
  const bare = new MultiResearchModal({}, ['A'], models, templates, () => {}); bare.open();
  assert.equal(button(bare.contentEl, 'Edit templates…'), undefined, 'no link without a handler');
  assert.equal(button(bare.contentEl, 'Fix connection…'), undefined);
  const library = load('ui/modals/detail-templates-modal.ts', { obsidian: { ...obsidian, Modal } });
  const host = { settings: { language: 'en', detailTemplates: [{ id: 'mine', name: 'Mine', sections: [] }] }, saveSettings: async () => {} };
  const editor = new library.DetailTemplatesModal({}, host, () => {}, 'mine'); editor.open();
  assert.ok(findAll(editor.contentEl, i => i.tag === 'input' && i.value === 'Mine').length, 'opens straight into the editor of the chosen template');
});
integrationTest('Next Step: the model field offers Fix connection and the template field offers Edit templates', () => {
  const repaired = [];
  const h = nextStepHarness({ plugin: { repairConnection: model => repaired.push(model) }, modelSettings: { templates: [{ id: 'standard', name: 'Standard' }], currentTemplate: 'Standard' } });
  assert.ok(button(h.modal.contentEl, 'Edit templates…'), 'the template picker offers an edit link');
  button(h.modal.contentEl, 'Fix connection…').click();
  assert.deepEqual(repaired, ['gpt-test'], 'the link checks the model shown in the dialog');
  assert.equal(button(h.modal.contentEl, 'Check again'), undefined, 'one way to recover, not two');
});

// ---- Next Step dialog harness -------------------------------------------------------------------------------
function nextStepHarness({ settings = {}, modelSettings = {}, topic = 'Parent', children = 1, pending = 0, research, expand, synthesize, language = 'en', plugin: pluginOverrides = {} } = {}) {
  const notices = [];
  const Modal = dom.makeModal();
  const { NextStepModal } = load('main.ts', { obsidian: { ...obsidian, Modal, setIcon: () => {}, Notice: class { constructor(message) { notices.push(message); } } } });
  const modelState = provider => ({ provider, status: 'ready', models: provider === 'codex' ? ['gpt-test'] : [] });
  const sources = { currentTopicId: 'current', currentLabel: 'Current topic included', synthesisLabel: 'Current topic and child topics included', synthesisTopics: ['Child A', 'Child B'], topics: async () => [], readTopic: async () => [] };
  const saved = [];
  const plugin = { settings: { codexUsageNoticeSeen: true, claudeUsageNoticeSeen: true, models: 'gpt-test', cliModel: 'gpt-test', cliReasoning: 'low', language, ...settings },
    aiReadyForModel: async () => true, confirmAiUsage: async (_model, run) => { await run(); return true; }, saveSettings: async () => {}, activeTasks: new Map(), availableModels: () => ['gpt-test', 'gpt-other'], modelLabel: model => model,
    modelDiscoveryState: modelState, subscribeModelDiscovery: () => () => {}, refreshModelDiscovery: async provider => modelState(provider), ...pluginOverrides };
  const settingsArg = { model: 'gpt-test', modelSource: 'workspace', reasoning: 'low', save: async patch => { saved.push(patch); }, sources, ...modelSettings };
  const calls = { research: [], expand: [], synthesize: [] };
  const modal = new NextStepModal({}, topic, children, pending, plugin,
    research ?? (async (options, _focus, _done, _failed, accepted) => { calls.research.push(options); accepted(); }),
    expand ?? (async (options, _direction, _found, _failed, accepted) => { calls.expand.push(options); accepted(); }),
    synthesize ?? (async (options, direction, _failed, accepted) => { calls.synthesize.push({ options, direction }); accepted(); }),
    settingsArg);
  modal.open();
  const actions = () => find(modal.modalEl, i => hasCls(i, 'vam-next-actions'));
  return { modal, plugin, notices, saved, calls, actions, settings: settingsArg, sources };
}
integrationTest('Next Step: the model select starts with Follow default; saves only modelSource and never pins a model', async () => {
  const pick = (h, value) => { const select = byLabel(h.modal.contentEl, 'Model'); select.value = value; select.fire('change'); };
  const run = async h => { button(h.actions(), 'Confirm research task').click(); await tick(); await tick(); };
  const untouched = nextStepHarness({ modelSettings: { topicStatus: 'idea' } });
  const select = byLabel(untouched.modal.contentEl, 'Model');
  const first = select.children.find(c => c.tag === 'option');
  assert.equal(first.value, '__follow_default__', 'the follow option is the first option');
  assert.equal(select.value, '__follow_default__', 'a non-manual topic shows it selected');
  assert.match(first.text, /Follow default \(now: gpt-test\)/);
  await run(untouched);
  assert.deepEqual(plain(untouched.saved), [], 'an untouched topic writes nothing');
  const manual = nextStepHarness({ modelSettings: { topicStatus: 'idea', model: 'gpt-other', modelSource: 'manual' } });
  assert.equal(byLabel(manual.modal.contentEl, 'Model').value, 'gpt-other');
  pick(manual, '__follow_default__'); await run(manual);
  assert.deepEqual(plain(manual.saved), [{ modelSource: 'workspace' }]);
  const child = nextStepHarness({ modelSettings: { topicStatus: 'idea', modelSource: 'manual', followDefault: { source: 'inherited', model: 'gpt-test' } } });
  pick(child, '__follow_default__'); await run(child);
  assert.deepEqual(plain(child.saved), [{ modelSource: 'inherited' }]);
  const back = nextStepHarness({ modelSettings: { topicStatus: 'idea' } });
  pick(back, 'gpt-other'); pick(back, '__follow_default__'); await run(back);
  assert.deepEqual(plain(back.saved), [{ modelSource: 'workspace' }], 'a specific model picked then dropped is not written');
});

integrationTest('Next Step: the tone select defaults to keeping the topic tone and its choice reaches the run options', async () => {
  const h = nextStepHarness({ modelSettings: { tones: [{ id: 'plain', name: 'Plain explanation' }, { id: 'academic', name: 'Academic rigor' }], currentTone: 'Academic rigor' } });
  const tone = byLabel(h.modal.contentEl, 'Writing tone');
  assert.deepEqual(plain(tone.children.map(o => o.text)), ['Keep current (Academic rigor)', 'Plain explanation', 'Academic rigor']);
  assert.ok(button(h.modal.contentEl, 'Edit tones…'), 'the tone picker offers an edit link to the tone library');
  const style = byLabel(h.modal.contentEl, 'Note style'); style.value = 'custom'; style.fire('change');
  tone.value = 'plain'; tone.fire('change');
  assert.ok(find(h.modal.contentEl, i => hasCls(i, 'vam-next-source-summary') && /Plain explanation/.test(i.text)), 'the output summary names the chosen tone');
  button(h.actions(), 'Confirm research task').click(); await tick(); await tick();
  assert.equal(h.calls.research[0].toneId, 'plain');
  const keep = nextStepHarness({ modelSettings: { tones: [{ id: 'plain', name: 'Plain explanation' }], currentTone: 'Academic rigor' } });
  button(keep.actions(), 'Confirm research task').click(); await tick(); await tick();
  assert.equal('toneId' in keep.calls.research[0], false, 'keeping the current tone writes nothing');
});

integrationTest('Next Step: the answer language follows the topic text, and a manual choice still wins', async () => {
  const selectOf = h => findAll(find(h.modal.contentEl, i => hasCls(i, 'vam-next-language')), i => i.tag === 'select')[0];
  const langOf = h => selectOf(h).value;
  const zhTopic = nextStepHarness({ topic: '要如何在陽台養香草', language: 'en' });
  assert.equal(langOf(zhTopic), 'zh-TW', 'English UI + Chinese topic answers in Chinese');
  button(zhTopic.actions(), 'Confirm research task').click(); await tick(); await tick();
  assert.equal(zhTopic.calls.research[0].outputLanguage, 'zh-TW');
  assert.equal(langOf(nextStepHarness({ topic: 'Balcony herbs', language: 'en' })), 'same-as-input');
  assert.equal(langOf(nextStepHarness({ topic: 'Balcony herbs', language: 'zh-TW' })), 'same-as-input', 'Chinese UI + English topic follows the language of the text');
  const manual = nextStepHarness({ topic: '要如何在陽台養香草', language: 'en' });
  const select = selectOf(manual); select.value = 'en'; select.fire('change');
  button(manual.actions(), 'Confirm research task').click(); await tick(); await tick();
  assert.equal(manual.calls.research[0].outputLanguage, 'en', 'the manual choice wins');
});

// ---- B2: one-click dialog --------------------------------------------------------------------------------------
const tones = [{ id: 'plain', name: 'Plain explanation' }, { id: 'magazine', name: 'Magazine column' }, { id: 'academic', name: 'Academic rigor' }];
const summaryOf = h => find(h.modal.contentEl, i => i.cls === 'vam-next-summary').text;
const adjustOf = h => find(h.modal.contentEl, i => i.tag === 'details' && i.cls.includes('vam-next-adjust'));
const cardsOf = h => find(h.modal.contentEl, i => i.cls === 'vam-next-cards');

integrationTest('one-click dialog: research is open then one confirm; the summary line states the mode, language and tone, and every option sits under Adjust', async () => {
  const h = nextStepHarness({ modelSettings: { tones, currentTone: 'Magazine column', topicStatus: 'idea' } });
  assert.equal(summaryOf(h), 'Quick · Same language as my text · Magazine column');
  // Everything adjustable is inside the one disclosure, which starts closed.
  const adjust = adjustOf(h);
  assert.equal(adjust.open, false); assert.equal(adjust.children[0].text, 'Adjust');
  const expandNumbers = find(h.modal.contentEl, i => hasCls(i, 'vam-quick-limits'));
  const outside = findAll(h.modal.contentEl, i => i.tag === 'select' || i.tag === 'textarea' || (i.tag === 'input' && i.type !== undefined)).filter(i => !findAll(adjust, x => x === i).length && !findAll(expandNumbers, x => x === i).length);
  assert.deepEqual(outside.map(i => i.tag), [], 'no input, select or textarea outside Adjust (the expansion\'s levels and size sit on its own panel)');
  assert.equal(findAll(h.modal.contentEl, i => i.tag === 'details' && hasCls(i, 'vam-next-adjust')).length, 1, 'a single Adjust');
  // The AI mode switch sits outside Adjust, at the top of the dialog; changing a field updates the summary line.
  const modeGroup = byLabel(h.modal.contentEl, 'AI mode');
  assert.ok(modeGroup && modeGroup.attrs.role === 'radiogroup' && !findAll(adjust, x => x === modeGroup).length, 'the switch is a radiogroup outside Adjust');
  button(modeGroup, 'Standard').click();
  assert.equal(summaryOf(h), 'Standard · Same language as my text · Magazine column');
  byLabel(h.modal.contentEl, 'Note style').value = 'preset:plain'; byLabel(h.modal.contentEl, 'Note style').fire('change');
  assert.equal(summaryOf(h), 'Standard · Same language as my text · Plain language');
  byLabel(h.modal.contentEl, 'Answer language for this task').value = 'zh-TW'; byLabel(h.modal.contentEl, 'Answer language for this task').fire('change');
  assert.match(summaryOf(h), /繁體中文/);
  // One click on the primary action runs it and closes: with the opening click that is two clicks in all.
  button(h.actions(), 'Confirm research task').click(); await tick(); await tick();
  assert.equal(h.calls.research.length, 1); assert.equal(h.modal.closeCount, 1);
  const sent = h.calls.research[0];
  assert.deepEqual([sent.researchMode, sent.researchDepth, sent.visualMode, sent.mapAiMode], ['research', 'normal', 'auto', 'standard'], 'Standard research: web, standard depth, images');
});
integrationTest('one-click dialog: each step shows only its own section under Adjust and its own summary', () => {
  const h = nextStepHarness({ modelSettings: { tones, currentTone: 'Academic rigor', topicStatus: 'completed' }, children: 0 });
  const sections = findAll(adjustOf(h), i => i.cls === 'vam-next-adjust-section');
  assert.equal(sections.length, 3);
  assert.deepEqual(sections.map(s => s.hidden), [true, false, true], 'a researched leaf opens on Expand');
  assert.equal(summaryOf(h), '2 levels · up to 15 · Same language as my text · Academic rigor');
  cardsOf(h).children[2].click();
  assert.deepEqual(sections.map(s => s.hidden), [true, true, false]);
  assert.equal(summaryOf(h), 'Full content · Same language as my text · Academic rigor', 'a synthesis has no mode or web choice');
  cardsOf(h).children[0].click();
  assert.deepEqual(sections.map(s => s.hidden), [false, true, true]);
  assert.equal(summaryOf(h), 'Quick · Same language as my text · Academic rigor');
});
const outlineStub = (calls = []) => ({ presets: [{ id: 'knowledge-tree', name: 'Knowledge tree' }], generate: async request => { calls.push(request); return []; }, create: async () => {} });
integrationTest('one-click dialog: levels and size sit on the Expand panel (2 and 15); there is no guided or quick-explore control and the button is Expand', () => {
  const h = nextStepHarness({ modelSettings: { topicStatus: 'completed', quickOutline: outlineStub() }, children: 0 });
  const limits = find(h.modal.contentEl, i => hasCls(i, 'vam-quick-limits'));
  assert.ok(limits && !findAll(adjustOf(h), x => x === limits).length, 'the numbers are on the panel, not under Adjust');
  assert.deepEqual(findAll(limits, i => i.tag === 'input').map(i => i.value), ['2', '15']);
  assert.equal(button(h.actions(), 'Expand').hidden, false);
  for (const gone of ['Choose directions together', 'Quickly explore a map', 'Get expansion directions', 'Generate outline'])
    assert.equal(button(h.modal.modalEl, gone), undefined, `${gone} is gone`);
  assert.ok(find(adjustOf(h), i => i.tag === 'select' && i.attrs['aria-label'] === 'Outline preset'), 'the outline preset stays under Adjust');
  assert.equal(summaryOf(h), '2 levels · up to 15 · Same language as my text', 'the summary names the chosen levels and size; no web part');
  const shallow = findAll(adjustOf(h), i => i.tag === 'input' && i.type === 'checkbox')[0];
  shallow.checked = true; shallow.change();
  assert.equal(summaryOf(h), '2 levels · up to 15 · Quick · Same language as my text', 'subtopic research adds the mode');
  button(byLabel(h.modal.contentEl, 'AI mode'), 'Standard').click();
  assert.equal(summaryOf(h), '2 levels · up to 15 · Standard · Same language as my text');
  const withoutOutline = nextStepHarness({ modelSettings: { topicStatus: 'completed' }, children: 0 });
  assert.equal(button(withoutOutline.actions(), 'Expand').disabled, true, 'no outline generator, nothing to run');
});
integrationTest('one-click dialog: the AI mode switch is a radiogroup with arrow keys; it shows for research and expansion and hides for synthesis', () => {
  const h = nextStepHarness({ modelSettings: { topicStatus: 'idea' } });
  const group = byLabel(h.modal.contentEl, 'AI mode');
  const [quick, standard] = [button(group, 'Quick'), button(group, 'Standard')];
  assert.deepEqual([quick.attrs['aria-checked'], standard.attrs['aria-checked']], ['true', 'false'], 'Quick is the default');
  assert.deepEqual([quick.tabIndex, standard.tabIndex], [0, -1]);
  quick.keydown({ key: 'ArrowRight' });
  assert.deepEqual([quick.attrs['aria-checked'], standard.attrs['aria-checked']], ['false', 'true']);
  assert.equal(standard.focused, true, 'the arrow moves focus with the choice');
  standard.keydown({ key: 'ArrowLeft' });
  assert.equal(quick.attrs['aria-checked'], 'true');
  const wrapper = group.parent;
  assert.ok(findAll(wrapper, i => hasCls(i, 'vam-hint') && /Use Standard once the structure is settled/.test(i.text)).length, 'the one-line hint about when to use Standard');
  for (const [index, hidden] of [[0, false], [1, false], [2, true]]) { cardsOf(h).children[index].click(); assert.equal(wrapper.hidden, hidden, `step ${index}`); }
  const multi = nextStepHarness({ modelSettings: { topicStatus: 'completed' }, children: 1 });
  assert.equal(byLabel(multi.modal.contentEl, 'AI mode').parent.hidden, false);
});
integrationTest('one-click dialog: the map\'s remembered mode is the default (Quick when absent) and is written only when a research or expansion starts, never on cancel', async () => {
  const remembered = [];
  const fresh = nextStepHarness({ modelSettings: { topicStatus: 'idea', rememberAiMode: async mode => { remembered.push(mode); } } });
  assert.equal(button(byLabel(fresh.modal.contentEl, 'AI mode'), 'Quick').attrs['aria-checked'], 'true');
  button(byLabel(fresh.modal.contentEl, 'AI mode'), 'Standard').click();
  button(fresh.actions(), 'Close').click(); fresh.modal.close(); await tick();
  assert.deepEqual(remembered, [], 'cancelling the dialog stores nothing');
  const standard = nextStepHarness({ modelSettings: { topicStatus: 'idea', aiMode: 'standard', rememberAiMode: async mode => { remembered.push(mode); } } });
  assert.equal(button(byLabel(standard.modal.contentEl, 'AI mode'), 'Standard').attrs['aria-checked'], 'true', 'the map\'s mode is preselected');
  button(byLabel(standard.modal.contentEl, 'AI mode'), 'Quick').click();
  button(standard.actions(), 'Confirm research task').click(); await tick(); await tick();
  assert.deepEqual(remembered, ['quick'], 'the mode of the run is stored before AI starts');
  assert.equal(standard.calls.research[0].mapAiMode, 'quick');
  const expanding = nextStepHarness({ modelSettings: { topicStatus: 'completed', quickOutline: outlineStub(), rememberAiMode: async mode => { remembered.push(mode); } }, children: 0 });
  button(byLabel(expanding.modal.contentEl, 'AI mode'), 'Standard').click();
  button(expanding.actions(), 'Expand').click(); await tick(); await tick(); await tick();
  assert.deepEqual(remembered, ['quick', 'standard'], 'an expansion stores the mode too');
});
integrationTest('one-click dialog: the research request carries the mode\'s options (Quick: local, standard depth, no images; Standard: web, images)', async () => {
  const quick = nextStepHarness({ modelSettings: { topicStatus: 'idea' } });
  button(quick.actions(), 'Confirm research task').click(); await tick(); await tick();
  const q = quick.calls.research[0];
  assert.deepEqual([q.researchMode, q.researchDepth, q.visualMode, q.mapAiMode], ['local', 'normal', 'off', 'quick']);
  assert.equal('shallowWebSearch' in q, false);
});
integrationTest('synthesis from the dialog stays on the original local policy at standard depth with no images, whatever the AI mode, and stores no mode (D-2026-10-229, 243)', async () => {
  const remembered = [];
  const h = nextStepHarness({ modelSettings: { topicStatus: 'completed', rememberAiMode: async mode => { remembered.push(mode); } }, children: 2 });
  button(byLabel(h.modal.contentEl, 'AI mode'), 'Standard').click();
  cardsOf(h).children[2].click();
  assert.match(summaryOf(h), /^Full content/); assert.ok(find(h.modal.contentEl, i => /run a Standard research on the topic first/.test(i.text ?? '')), 'the hint points at a Standard research first');
  button(h.actions(), 'Get synthesis suggestions first').click(); await tick(); await tick();
  const options = h.calls.synthesize[0].options;
  assert.deepEqual(plain([options.researchMode, options.researchDepth, options.visualMode]), ['local', 'normal', 'off']);
  assert.equal('mapAiMode' in options, false, 'a synthesis never takes the Quick prompt text: it keeps research.local word for word');
  assert.deepEqual(remembered, [], 'a synthesis does not store the AI mode');
});
integrationTest('one-click dialog: waiting proposals are reviewed in place by a secondary button (no AI starts) and the dialog closes itself once the subtopics are created', async () => {
  // Owner decision 2026-10-19: a press that starts AI hides the dialog; reviewing proposals that already wait starts none.
  let created; const generated = [];
  const h = nextStepHarness({ modelSettings: { topicStatus: 'completed', quickOutline: outlineStub(generated) }, children: 0, pending: 2, expand: async (_options, _direction, found) => found([{ title: 'Transport', task: 'Compare', contribution: '', parentTitle: '' }], async items => { created = items; }) });
  assert.equal(button(h.actions(), 'Expand').hidden, false, 'Expand stays the primary action');
  button(h.actions(), 'Review AI subtopic suggestions (2)').click(); await tick();
  assert.equal(h.modal.closeCount, 0, 'proposals are reviewed in the dialog first');
  assert.equal(generated.length, 0, 'reviewing saved suggestions calls no AI');
  button(h.modal.contentEl, 'Create subtopics (1)').click(); await tick(); await tick();
  assert.equal(created[0].title, 'Transport'); assert.equal(h.modal.closeCount, 1);
  assert.ok(h.notices.includes('Subtopics created.'));
  const none = nextStepHarness({ modelSettings: { topicStatus: 'completed', quickOutline: outlineStub() }, children: 0, pending: 0 });
  assert.equal(button(none.actions(), 'Review AI subtopic suggestions (0)').hidden, true, 'no saved suggestions, no review button');
});
// ---- background runs: the dialog hides once AI starts (owner decision 2026-10-19) --------------------------------
const hookSpy = () => { const spy = { begins: [], ends: 0, completed: [], results: [], outlines: [] }; spy.hooks = { begin: controller => spy.begins.push(controller), end: () => { spy.ends++; }, completed: (kind, result) => { spy.completed.push(kind); spy.results.push(result); }, outlineReady: outline => spy.outlines.push(outline) }; return spy; };
const pressOf = {
  research: h => button(h.actions(), 'Confirm research task'),
  expand: h => { dom.findAll(h.modal.contentEl, i => hasCls(i, 'vam-next-cards'))[0].children[1].click(); return button(h.actions(), 'Expand'); },
  synthesis: h => { dom.findAll(h.modal.contentEl, i => hasCls(i, 'vam-next-cards'))[0].children[2].click(); return button(h.actions(), 'Get synthesis suggestions first'); }
};
for (const kind of ['research', 'expand', 'synthesis']) {
  integrationTest(`background ${kind}: the dialog hides only once the usage notice is confirmed; declining starts nothing and keeps it open`, async () => {
    const gate = deferred();
    // An expansion's first AI call is the outline generator, so it counts as the started call.
    const make = plugin => { const outline = []; const h = nextStepHarness({ modelSettings: { topicStatus: kind === 'research' ? 'idea' : 'completed', ...(kind === 'expand' ? { quickOutline: outlineStub(outline) } : {}) }, children: kind === 'expand' ? 0 : 1, plugin }); h.started = () => h.calls.research.length + h.calls.expand.length + h.calls.synthesize.length + outline.length; return h; };
    const h = make({ confirmAiUsage: async (_m, run) => { await gate.promise; if (gate.decline) return false; await run(); return true; } });
    pressOf[kind](h).click(); await tick(); await tick();
    assert.equal(h.modal.closeCount, 0, 'still open while the usage notice is unanswered');
    assert.equal(h.started(), 0);
    gate.resolve(); await until(() => h.modal.closeCount === 1);
    assert.equal(h.started(), 1);
    const declined = deferred(); declined.decline = true;
    const d = make({ confirmAiUsage: async (_m, run) => { await declined.promise; if (declined.decline) return false; await run(); return true; } });
    const press = pressOf[kind](d); press.click(); declined.resolve(); await tick(); await tick();
    assert.equal(d.modal.closeCount, 0, 'declining keeps the dialog open'); assert.equal(press.disabled, false);
    assert.equal(d.started(), 0, 'nothing started');
  });
}
integrationTest('background research: the view gets the controller at hide-time, Stop before acceptance sends no request, and the hidden dialog is never written', async () => {
  const spy = hookSpy(), gate = deferred(); let seen, accepted = 0;
  const h = nextStepHarness({ modelSettings: { topicStatus: 'idea', background: spy.hooks }, research: async (options, _focus, _done, failed) => { seen = options; await gate.promise; if (options.signal.aborted) { failed('Research stopped.'); return; } accepted++; } });
  const status = find(h.modal.contentEl, i => hasCls(i, 'vam-next-status'));
  button(h.actions(), 'Confirm research task').click(); await until(() => seen);
  assert.equal(h.modal.closeCount, 1); assert.equal(spy.begins.length, 1, 'card Stop is bound to the dialog controller');
  h.modal.close();
  assert.equal(seen.signal.aborted, false, 'closing the hidden dialog never aborts the run');
  spy.begins[0].abort();
  assert.equal(seen.signal.aborted, true, 'the card Stop reaches the run before the provider accepted it');
  gate.resolve(); await until(() => spy.ends === 1);
  assert.equal(accepted, 0, 'no request is sent after Stop'); assert.ok(h.notices.includes('Research stopped.'));
  assert.notEqual(status.text, 'Research stopped.', 'nothing is written into the hidden dialog');
});
integrationTest('background research: acceptance hands the card to the view, and a finished result is reported once through the view hook', async () => {
  const spy = hookSpy(); let finish;
  const h = nextStepHarness({ modelSettings: { topicStatus: 'idea', background: spy.hooks }, research: async (_options, _focus, done, _failed, accepted) => { accepted(); finish = done; } });
  button(h.actions(), 'Confirm research task').click(); await until(() => finish);
  assert.equal(spy.begins.length, 1); assert.equal(spy.ends, 1, 'accepted ends the starting hand-over'); assert.deepEqual(spy.completed, []);
  assert.equal(h.notices.some(m => /background/.test(m)), false, 'no started-in-background Notice: the dialog already hid');
  finish({ summary: 'S', detail: 'D', suggestions: [], visualReferences: [] });
  assert.deepEqual(spy.completed, ['research']); assert.equal(h.modal.closeCount, 1, 'closed once, not again');
});
integrationTest('background expand: an outline that arrives after the dialog hid goes to the view hook, never into the dialog', async () => {
  const spy = hookSpy(), gate = deferred();
  const quickOutline = { presets: [{ id: 'knowledge-tree', name: 'Knowledge tree' }], generate: async () => { await gate.promise; return [{ index: 0, title: 'Parent', level: 1, parent: null, line: 1 }, { index: 1, title: 'T', level: 2, parent: 0, line: 2 }]; }, create: async () => {} };
  const h = nextStepHarness({ modelSettings: { topicStatus: 'completed', background: spy.hooks, quickOutline }, children: 0 });
  pressOf.expand(h).click(); await until(() => spy.begins.length === 1);
  assert.equal(h.modal.closeCount, 1); gate.resolve(); await until(() => spy.outlines.length === 1);
  assert.equal(spy.outlines[0].options.mapAiMode, 'quick', 'the outline keeps the mode it was generated with');
  assert.equal(find(h.modal.contentEl, i => i.text === 'AI outline'), undefined, 'nothing is written into the hidden dialog');
});
integrationTest('background research: a Quick result is handed to the view hook (so a knowledge-gap marker can offer the Standard run); a Standard result is not', async () => {
  const gap = { summary: 'S', detail: 'Model knowledge is insufficient.', suggestions: [], visualReferences: [] };
  const run = async mode => {
    const spy = hookSpy(); let finish;
    const h = nextStepHarness({ modelSettings: { topicStatus: 'idea', aiMode: mode, background: spy.hooks }, research: async (_options, _focus, done, _failed, accepted) => { accepted(); finish = done; } });
    button(h.actions(), 'Confirm research task').click(); await until(() => finish);
    finish(gap);
    return spy.results;
  };
  const [fromQuick] = await run('quick'); assert.deepEqual(plain(fromQuick), gap);
  const [fromStandard] = await run('standard'); assert.equal(fromStandard, undefined);
});
integrationTest('one-click dialog: model and effort are saved once when a run starts, never when the dialog is cancelled', async () => {
  const cancelled = nextStepHarness({ modelSettings: { topicStatus: 'idea' } });
  byLabel(cancelled.modal.contentEl, 'Model').value = 'gpt-other'; byLabel(cancelled.modal.contentEl, 'Model').fire('change');
  byLabel(cancelled.modal.contentEl, 'Reasoning level').value = 'high'; byLabel(cancelled.modal.contentEl, 'Reasoning level').fire('change');
  button(cancelled.actions(), 'Close').click(); cancelled.modal.close(); await tick();
  assert.deepEqual(plain(cancelled.saved), [], 'closing without running writes nothing');
  const started = nextStepHarness({ modelSettings: { topicStatus: 'idea' } });
  byLabel(started.modal.contentEl, 'Model').value = 'gpt-other'; byLabel(started.modal.contentEl, 'Model').fire('change');
  byLabel(started.modal.contentEl, 'Reasoning level').value = 'high'; byLabel(started.modal.contentEl, 'Reasoning level').fire('change');
  assert.deepEqual(plain(started.saved), []);
  button(started.actions(), 'Confirm research task').click(); await tick(); await tick();
  assert.deepEqual(plain(started.saved), [{ model: 'gpt-other', modelSource: 'manual', reasoning: 'high' }]);
  // A start that fails to save reports the reason and does not run.
  const failing = nextStepHarness({ modelSettings: { topicStatus: 'idea', save: async () => { throw new Error('disk full'); } } });
  byLabel(failing.modal.contentEl, 'Reasoning level').value = 'high'; byLabel(failing.modal.contentEl, 'Reasoning level').fire('change');
  button(failing.actions(), 'Confirm research task').click(); await tick(); await tick();
  assert.equal(failing.calls.research.length, 0);
  assert.ok(findAll(failing.modal.contentEl, i => hasCls(i, 'vam-next-status')).some(i => /disk full/.test(i.text)));
});
integrationTest('one-click dialog: the data sources have no web or image choice, and the AI mode choice survives switching steps', () => {
  const h = nextStepHarness({ modelSettings: { topicStatus: 'completed' } });
  const sources = find(h.modal.contentEl, i => hasCls(i, 'vam-next-source-details'));
  assert.deepEqual(findAll(sources, i => i.tag === 'input' && i.type === 'checkbox').map(i => i.text), [], 'no checkbox for web search or images');
  assert.equal(findAll(sources, i => /web search|image references/i.test(i.text)).length, 0, 'no web or image wording in the sources');
  assert.match(sources.children[0].text + findAll(sources, i => hasCls(i, 'vam-next-source-summary')).map(i => i.text).join(''), /0 Markdown files$/);
  const group = byLabel(h.modal.contentEl, 'AI mode');
  button(group, 'Standard').click();
  for (const index of [2, 1, 0]) { cardsOf(h).children[index].click(); assert.equal(button(group, 'Standard').attrs['aria-checked'], 'true', 'the choice is kept'); }
});
integrationTest('one AI-mode widget with one default: the Next Step dialog and the outline import window share it', () => {
  const Modal = dom.makeModal();
  const fields = load('experiences/visual-map/research-fields.ts', { obsidian });
  assert.equal('researchDepthField' in fields, false); assert.equal('DEFAULT_RESEARCH_DEPTH' in fields, false);
  const parent = element('div'); const seen = [];
  const widget = fields.aiModeField(parent, { onChange: mode => seen.push(mode) });
  const radios = findAll(parent, i => i.tag === 'button' && i.attrs.role === 'radio');
  assert.deepEqual(radios.map(r => [r.text, r.attrs['aria-checked']]), [['Quick', 'true'], ['Standard', 'false']]);
  assert.equal(widget.value(), 'quick');
  radios[1].click(); assert.equal(widget.value(), 'standard'); assert.deepEqual(seen, ['standard']);
  radios[1].click(); assert.deepEqual(seen, ['standard'], 'choosing the same mode again is no change');
  assert.ok(hasCls(radios[1], 'is-active') && !hasCls(radios[0], 'is-active'), 'the checked state is a JS-toggled class');
  widget.set('quick'); assert.equal(radios[0].attrs['aria-checked'], 'true'); assert.deepEqual(seen, ['standard'], 'set() is silent');
  const outline = load('experiences/visual-map/outline-import-modal.ts', { obsidian: { ...obsidian, Modal } });
  const modal = new outline.OutlineImportModal({}, async () => {}); modal.open();
  assert.deepEqual(findAll(modal.contentEl, i => i.tag === 'button' && i.attrs.role === 'radio').map(r => [r.text, r.attrs['aria-checked']]), [['Quick', 'true'], ['Standard', 'false']], 'the outline window starts on Quick');
  const multi = load('experiences/visual-map/multi-research-modal.ts', { obsidian: { ...obsidian, Modal } });
  const dialog = new multi.MultiResearchModal({}, ['A'], { list: () => [], watch: () => () => {} }, [], () => {}, []); dialog.open();
  assert.equal(findAll(dialog.contentEl, i => i.type === 'radio' || i.attrs?.role === 'radio').length, 0, 'multi-research has no mode choice of its own');
});
integrationTest('map stylesheet: the AI-mode choice uses JS-toggled classes, so no :has() is left on the map or the AI dialog', () => {
  const css = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', '..', 'styles.css'), 'utf8');
  const withHas = css.split('\n').filter(rule => rule.includes(':has('));
  assert.deepEqual(withHas.filter(rule => /\.vam-next|\.vam-depth|\.vam-workspace|\.vam-node|\.vam-canvas/.test(rule)), []);
  assert.match(css, /\.vam-ai-mode > button\.is-active \{/); assert.match(css, /\.vam-ai-mode > button:focus-visible/);
  assert.doesNotMatch(css, /vam-next-depth|vam-reference-network|vam-next-segmented/, 'the styles of the removed depth, network and guided-expansion controls are gone');
});
integrationTest('localized labels: reasoning levels and model names are never shown as raw ids', () => {
  const modals = load('experiences/visual-map/modals.ts', { obsidian });
  assert.deepEqual(['auto', 'low', 'medium', 'high', 'weird'].map(modals.reasoningLabel), ['Auto', 'Low', 'Medium', 'High', 'Low']);
  const h = nextStepHarness({ plugin: { modelLabel: id => `Label of ${id}` }, modelSettings: { model: 'gpt-test' } });
  const summaryText = findAll(adjustOf(h), i => i.tag === 'summary').flatMap(s => findAll(s, x => x.text)).map(x => x.text).join('|');
  assert.ok(summaryText.includes('Label of gpt-test'), summaryText);
  assert.ok(findAll(adjustOf(h), i => i.tag === 'p').some(p => p.text.includes('Label of gpt-test')), 'the model line uses the label');
  assert.equal(findAll(adjustOf(h), i => /gpt-test/.test(i.text ?? '') && !/Label of gpt-test/.test(i.text ?? '') && i.tag !== 'option').length, 0, 'no raw id outside the model list');
});
integrationTest('map UI in zh-TW says 整合 for synthesis, never 收斂', () => {
  const source = require('../support.cjs').i18nSource('zh-TW');
  const zh = source;
  const entries = [...zh.matchAll(/^  "(ui\.[^"]+)": "((?:[^"\\]|\\.)*)"/gm)];
  // AIM and the Markdown selection tools have their own vocabulary; the map's synthesis dialogs must say 整合.
  const drift = entries.filter(([, key, text]) => /收斂/.test(text) && /synthes|integrat|merge|direction/.test(key)).map(([, key]) => key);
  assert.deepEqual(drift, []);
  assert.match(entries.find(([, key]) => key === 'ui.choose_synthesis_direction')[2], /整合/);
});

// ---- B3: single-dialog synthesis (real view, fake provider) -----------------------------------------------------
const { fixture, topicNote, withExpansionCoordinator, DEFAULT_SETTINGS, core, deferred, until } = require('../support.cjs');
const { synthesisDirectionsTask } = load('experiences/visual-map/steps/fragments.ts');
const DIRECTIONS = { summary: '', detail: '', visualReferences: [], suggestions: [{ title: 'Common ground', task: 'Find shared constraints', contribution: 'A shared view', parentTitle: '' }, { title: 'Differences', task: 'List differences', contribution: '', parentTitle: '' }] };
const DRAFT = { summary: 'Draft summary', detail: '### Core conclusions\n\nDraft detail', visualReferences: [], suggestions: [] };
const abortError = () => Object.assign(new Error('aborted'), { name: 'AbortError' });

async function synthesisHarness({ language = 'en' } = {}) {
  const { repo, app } = fixture(language);
  const parent = await topicNote(repo, 'Parent', 'model-a');
  const mapPath = 'Agent Workspace/Topics/map-a/Map.md';
  const doc = { id: 'map-a', title: 'map-a', version: 1, nodes: [parent], viewport: { x: 0, y: 0, zoom: 1 } };
  await app.vault.create(mapPath, core.serializeMap(doc));
  const kids = [];
  for (const title of ['Child A', 'Child B']) { const child = await repo.createNote(title, 'model-a', doc, mapPath, 'workspace'); child.parentId = parent.id; doc.nodes.push(child); kids.push(child); }
  await repo.saveMap(mapPath, doc);
  await repo.updateNote(parent.path, { status: 'completed', summary: 'Existing conclusion', detail: 'Existing knowledge' });
  for (const kid of kids) await repo.updateNote(kid.path, { status: 'completed', summary: `${kid.title} summary`, detail: `${kid.title} detail` });
  const calls = [], notices = [], modals = [], gates = [];
  // knobs: `ignoreAbort` makes the provider return its result even after Stop; `readGate` holds the view's note reads (the gap before the provider accepts).
  const knobs = { ignoreAbort: false, readGate: null };
  const readNote = repo.readNote.bind(repo);
  repo.readNote = async (...args) => { if (knobs.readGate) await knobs.readGate.promise; return readNote(...args); };
  const Base = dom.makeModal();
  class Modal extends Base { open() { modals.push(this); super.open(); } }
  class Component { load() {} unload() {} addChild(child) { return child; } removeChild() {} }
  const MarkdownRenderer = { render: async (_app, markdown, el) => { el.rendered = markdown; } };
  const modelState = provider => ({ provider, status: 'ready', models: [] });
  let view;
  const plugin = withExpansionCoordinator({ repo, settings: { ...DEFAULT_SETTINGS, language, cliModel: 'model-a' }, running: new Set(), abortChartJobs: () => {}, addChartsAfterWrite: () => {}, activeTasks: new Map(), pendingSuggestions: new Map(), pendingResearchOptions: new Map(), quickExpandFailures: new Map(),
    rebuildDerivedData: async () => {}, mutate: async work => work(), releaseOutline() {}, views: () => [view], recordFailure: (_label, error) => error.message,
    aiReadyForModel: async () => true, confirmAiUsage: async (_model, run) => { await run(); return true; }, saveSettings: async () => {}, availableModels: () => ['model-a'], modelLabel: model => model,
    modelDiscoveryState: modelState, subscribeModelDiscovery: () => () => {}, refreshModelDiscovery: async provider => modelState(provider),
    askModel: async (context, _model, _reasoning, signal, _exchange, onAccepted) => {
      if (signal?.aborted) throw abortError();
      const entry = { context, signal, directions: context.task.includes(synthesisDirectionsTask(language)) };
      calls.push(entry);
      onAccepted?.();
      const gate = gates.shift();
      if (gate) await new Promise((resolve, reject) => { gate.promise.then(resolve); signal?.addEventListener('abort', () => { if (!knobs.ignoreAbort) reject(abortError()); }, { once: true }); });
      if (signal?.aborted && !knobs.ignoreAbort) throw abortError();
      return entry.directions ? DIRECTIONS : DRAFT;
    } });
  const Notice = dom.makeNotice(notices);
  const { VisualAgentMapView } = load('main.ts', { obsidian: { ...obsidian, Modal, Component, MarkdownRenderer, setIcon: () => {}, Notice } }, { createFragment: dom.createFragment });
  view = new VisualAgentMapView({ app }, plugin);
  view.path = mapPath; view.map = doc; view.contentEl = { querySelector: () => null }; view.render = () => {}; view.ancestorContext = async () => ''; view.focusNode = () => {};
  view.enqueue = work => work();
  view.hydrate = async () => { view.notes = new Map(await Promise.all(view.map.nodes.map(async n => [n.id, await repo.readNote(n.path)]))); };
  await view.hydrate();
  const hold = () => { const gate = deferred(); gates.push(gate); return gate; };
  const openSingle = async () => { const before = modals.length; view.openNextStep(parent); await until(() => modals.length === before + 1); const modal = modals.at(-1); dom.findAll(modal.contentEl, i => hasCls(i, 'vam-next-cards'))[0].children[2].click(); return modal; };
  const note = async () => repo.readNote(parent.path);
  const openSelection = async () => { const before = modals.length; view.multiSelected = new Set(kids.map(k => k.id)); view.integrationMode = true; view.integrateSelected(); await until(() => modals.length === before + 1); return modals.at(-1); };
  return { openSelection, repo, app, view, plugin, doc, parent, kids, calls, notices, Notice, knobs, modals, hold, openSingle, note, mapPath };
}
const untilAsync = async predicate => { for (let i = 0; i < 200; i++) { if (await predicate()) return; await new Promise(r => setImmediate(r)); } throw new Error('condition not reached'); };
const panelOf = (modal, index = 2) => findAll(modal.contentEl, i => hasCls(i, 'vam-next-research'))[index];
const barButton = (modal, text) => findAll(modal.modalEl, i => i.tag === 'button' && i.text === text && !hasCls(i, 'is-hidden'))[0];
const visibleBar = (modal, text) => { const b = button(modal.modalEl, text); return b && !b.hidden ? b : undefined; };
const statusOf = modal => panelOf(modal).querySelector('.vam-next-status').text;
// The Notices that carry a button (a finished background run), and pressing the one labelled `label`.
const actionNotices = h => h.Notice.all.filter(n => n.actions.length);
const pressNotice = (h, label) => { const action = h.Notice.all.flatMap(n => n.actions).find(b => b.text === label); assert.ok(action, `notice button ${label}`); action.click(); };

// Owner decision 2026-10-19: pressing a synthesis step hides the dialog once AI starts. The result returns as one Notice with
// a button plus the card badge; the same dialog reopens at its next stage and the review opens only on request.
integrationTest('synthesis: pressing hides the dialog; directions return by one Notice, the dialog reopens at stage 2, and the draft is reviewed from its own Notice', async () => {
  const h = await synthesisHarness();
  const modal = await h.openSingle();
  assert.equal(h.modals.length, 1);
  const setupOutput = find(modal.contentEl, i => hasCls(i, 'vam-next-output'));
  const setupSources = find(modal.contentEl, i => hasCls(i, 'vam-next-source-details'));
  assert.equal(setupOutput.hidden, false); assert.equal(setupSources.hidden, false);
  visibleBar(modal, 'Get synthesis suggestions first').click();
  await until(() => h.view.synthesisTasks.get(h.parent.path)?.state === 'directions');
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0].directions, true);
  assert.equal(modal.closeCount, 1, 'the dialog hid itself once AI started'); assert.equal(h.modals.length, 1, 'no dialog opens by itself');
  assert.equal(findAll(modal.contentEl, i => hasCls(i, 'vam-next-angle')).length, 0, 'nothing was written into the hidden dialog');
  assert.equal(actionNotices(h).length, 1, 'exactly one result Notice'); assert.equal(actionNotices(h)[0].actions[0].text, 'Choose synthesis direction');
  assert.equal((await h.note()).summary, 'Existing conclusion');
  pressNotice(h, 'Choose synthesis direction');
  assert.equal(actionNotices(h)[0].hidden, true, 'pressing the button hides the Notice');
  await until(() => h.modals.length === 2);
  const again = h.modals[1];
  // Stage 2 in the reopened dialog: the directions are listed; inputs the draft step ignores are hidden.
  assert.deepEqual(findAll(again.contentEl, i => hasCls(i, 'vam-next-angle')).map(a => find(a, x => x.tag === 'strong').text), ['Common ground', 'Differences']);
  assert.equal(find(again.contentEl, i => hasCls(i, 'vam-next-output')).hidden, true); assert.equal(find(again.contentEl, i => hasCls(i, 'vam-next-source-details')).hidden, true);
  assert.equal(visibleBar(again, 'Get synthesis suggestions first'), undefined); assert.equal(visibleBar(again, 'Skip suggestions and synthesize now'), undefined);
  assert.ok(find(again.contentEl, i => hasCls(i, 'vam-next-synth-fixed') && !i.hidden), 'the dialog says what is fixed now');
  assert.ok(find(again.contentEl, i => hasCls(i, 'vam-next-requirements')), 'requirements remain');
  const box = byLabel(again.contentEl, 'Synthesis direction');
  assert.equal(box.value, 'Find shared constraints');
  button(panelOf(again), 'Choose this direction').click();
  box.value = 'Edited direction';
  visibleBar(again, 'Start synthesis').click();
  await until(() => !h.view.synthesisTasks.has(h.parent.path) && h.calls.length === 2);
  await untilAsync(async () => (await h.note()).summary === 'Draft summary');
  assert.equal(h.calls[1].directions, false); assert.equal(h.calls[1].context.task, 'Edited direction');
  assert.equal(again.closeCount, 1); assert.equal(h.modals.length, 2, 'no draft review opens: the result is written directly');
  const saved = await h.note();
  assert.match(saved.detail, /Draft detail/); assert.equal(saved.status, 'completed');
  assert.equal(actionNotices(h).filter(n => n.actions[0].text === 'Review synthesis draft').length, 0, 'there is no review Notice');
  assert.equal(actionNotices(h).filter(n => n.actions[0].text === 'Undo').length, 1, 'one done Notice with Undo');
  pressNotice(h, 'Undo'); await tick(); await tick(); await tick();
  assert.equal((await h.note()).summary, 'Existing conclusion', 'Undo restores the parent');
});
integrationTest('synthesis: skipping the suggestions writes the parent directly and hides the dialog; there is no review', async () => {
  const h = await synthesisHarness();
  const modal = await h.openSingle();
  visibleBar(modal, 'Skip suggestions and synthesize now').click();
  await untilAsync(async () => (await h.note()).summary === 'Draft summary');
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0].directions, false);
  assert.equal(modal.closeCount, 1); assert.equal(h.modals.length, 1, 'no review opens');
  assert.equal(h.view.synthesisTasks.size, 0);
  assert.equal(actionNotices(h).length, 1); assert.equal(actionNotices(h)[0].actions[0].text, 'Undo');
});
integrationTest('synthesis: the hidden dialog is never aborted or written into; the draft is written directly, with no review', async () => {
  const h = await synthesisHarness();
  const modal = await h.openSingle();
  const gate = h.hold();
  visibleBar(modal, 'Get synthesis suggestions first').click(); await until(() => h.calls.length === 1);
  assert.equal(modal.closeCount, 1, 'hidden by the press, not by a manual close');
  modal.close();
  assert.equal(h.calls[0].signal.aborted, false, 'closing the hidden dialog again does not abort the run');
  gate.resolve(); await until(() => h.view.synthesisTasks.get(h.parent.path)?.state === 'directions');
  assert.equal(findAll(modal.contentEl, i => hasCls(i, 'vam-next-angle')).length, 0, 'nothing was written into the hidden dialog');
  assert.equal(actionNotices(h).length, 1, 'the Notice and badge carry the result');
  const again = await h.openSingle();
  assert.equal(findAll(again.contentEl, i => hasCls(i, 'vam-next-angle')).length, 2);
  const second = h.hold();
  visibleBar(again, 'Start synthesis').click(); await until(() => h.calls.length === 2);
  assert.equal(again.closeCount, 1);
  assert.equal((await h.note()).summary, 'Existing conclusion', 'nothing is written before the result arrives');
  second.resolve(); await untilAsync(async () => (await h.note()).summary === 'Draft summary');
  assert.equal(find(again.contentEl, i => hasCls(i, 'vam-next-review')), undefined, 'nothing was rendered into the hidden dialog');
  assert.equal(h.modals.length, 2); assert.equal(h.view.synthesisTasks.size, 0);
  assert.ok(actionNotices(h).some(n => n.actions[0].text === 'Undo'));
});
integrationTest('synthesis: Stop on the card stops the accepted run, writes nothing and leaves the cancelled badge to retry or discard', async () => {
  const h = await synthesisHarness();
  const modal = await h.openSingle();
  const gate = h.hold();
  visibleBar(modal, 'Get synthesis suggestions first').click(); await until(() => h.calls.length === 1); await tick();
  const task = h.view.synthesisTasks.get(h.parent.path);
  assert.equal(task.state, 'running'); assert.equal(modal.closeCount, 1);
  task.controller.abort(); await until(() => h.calls[0].signal.aborted); await tick(); await tick();
  assert.equal(h.view.synthesisTasks.get(h.parent.path).state, 'cancelled', 'a stopped run shows the cancelled badge with Try again / Discard');
  assert.equal(actionNotices(h).length, 0, 'a stop is not a result');
  const saved = await h.note();
  assert.equal(saved.summary, 'Existing conclusion'); assert.equal(saved.detail, 'Existing knowledge'); assert.equal(saved.status, 'completed');
  assert.equal(h.plugin.running.size, 0); assert.equal(h.plugin.activeTasks.size, 0); assert.equal(h.view.startingTasks.size, 0);
  gate.resolve();
  // Discard leaves nothing behind; a fresh press runs again.
  h.view.discardSynthesis(h.parent); assert.equal(h.view.synthesisTasks.size, 0);
  const next = await h.openSingle();
  visibleBar(next, 'Get synthesis suggestions first').click(); await until(() => h.view.synthesisTasks.get(h.parent.path)?.state === 'directions');
  assert.equal(h.calls.length, 2);
});
integrationTest('synthesis: Stop before the provider accepts sends no request and writes nothing', async () => {
  const h = await synthesisHarness();
  const modal = await h.openSingle();
  h.knobs.readGate = deferred();
  visibleBar(modal, 'Get synthesis suggestions first').click();
  await until(() => h.view.startingTasks.has(h.parent.path));
  assert.equal(modal.closeCount, 1, 'hidden as soon as AI starts'); assert.equal(h.calls.length, 0);
  h.view.startingTasks.get(h.parent.path).abort();
  h.knobs.readGate.resolve(); h.knobs.readGate = null;
  await until(() => !h.view.startingTasks.has(h.parent.path)); await tick(); await tick();
  assert.equal(h.calls.length, 0, 'no provider request was sent');
  assert.equal((await h.note()).summary, 'Existing conclusion'); assert.equal(h.plugin.running.size, 0); assert.equal(h.plugin.activeTasks.size, 0);
  assert.equal(actionNotices(h).length, 0);
});
integrationTest('synthesis: a result that arrives after Stop is dropped, never becoming directions or a Notice', async () => {
  const h = await synthesisHarness();
  const modal = await h.openSingle();
  h.knobs.ignoreAbort = true;
  const gate = h.hold();
  visibleBar(modal, 'Get synthesis suggestions first').click(); await until(() => h.calls.length === 1);
  h.view.synthesisTasks.get(h.parent.path).controller.abort();
  gate.resolve(); await tick(); await tick(); await tick();
  const task = h.view.synthesisTasks.get(h.parent.path);
  assert.notEqual(task?.state, 'directions'); assert.equal((task?.directions ?? []).length, 0);
  assert.equal(actionNotices(h).length, 0, 'no result Notice for a stopped run');
});
integrationTest('synthesis: view close aborts a dialog run that is still starting', async () => {
  const h = await synthesisHarness();
  const modal = await h.openSingle();
  h.knobs.readGate = deferred();
  visibleBar(modal, 'Get synthesis suggestions first').click();
  await until(() => h.view.startingTasks.has(h.parent.path));
  const controller = h.view.startingTasks.get(h.parent.path);
  await h.view.onClose();
  assert.equal(controller.signal.aborted, true); assert.equal(h.view.startingTasks.size, 0);
  h.knobs.readGate.resolve(); h.knobs.readGate = null; await tick(); await tick();
  assert.equal(h.calls.length, 0);
});
integrationTest('synthesis: a research or expansion result reported by the view hook is one Notice whose button opens the right panel', async () => {
  const h = await synthesisHarness();
  const opened = [];
  h.view.openDetails = node => opened.push(['details', node.id]);
  h.view.openNodePanel = (node, mode) => opened.push([mode, node.id]);
  const hooks = h.view.backgroundHooks(h.parent.path, h.parent);
  hooks.completed('research');
  assert.equal(actionNotices(h).length, 1); assert.match(h.notices.at(-1), /Research finished: Parent/);
  assert.equal(actionNotices(h)[0].actions[0].text, 'View'); pressNotice(h, 'View');
  h.plugin.pendingSuggestions.set(h.parent.path, [{ title: 'A', task: '', contribution: '' }, { title: 'B', task: '', contribution: '' }]);
  hooks.completed('expand');
  assert.equal(actionNotices(h).length, 2); pressNotice(h, 'View 2 expansion suggestions');
  assert.deepEqual(opened, [['details', h.parent.id], ['proposals', h.parent.id]]);
});
integrationTest('research Notice: a Quick answer with the knowledge-gap marker offers View and Re-run with Standard; any other result keeps the single View button', async () => {
  const h = await synthesisHarness();
  const opened = [], reruns = [];
  h.view.openDetails = node => opened.push(node.id); h.view.rerunStandard = node => reruns.push(node.id);
  const hooks = h.view.backgroundHooks(h.parent.path, h.parent);
  hooks.completed('research', { summary: 'S', detail: 'A complete answer.', suggestions: [], visualReferences: [] });
  hooks.completed('research');
  assert.deepEqual(plain(actionNotices(h).map(n => n.actions.map(b => b.text))), [['View'], ['View']], 'no marker, or no result handed over: one button');
  hooks.completed('research', { summary: 'S', detail: 'Model knowledge is insufficient.', suggestions: [], visualReferences: [] });
  const notice = actionNotices(h).at(-1);
  assert.deepEqual(plain(notice.actions.map(b => b.text)), ['View', 'Re-run with Standard']);
  assert.match(h.notices.at(-1), /Research finished, but the model's knowledge was not enough: Parent/);
  notice.actions[1].click();
  assert.deepEqual(reruns, [h.parent.id]); assert.equal(notice.hidden, true, 'pressing a button closes the Notice');
  assert.deepEqual(opened, [], 'only the pressed action ran');
  const second = h.Notice.all.at(-1); second.actions[0].click(); assert.deepEqual(opened, [h.parent.id], 'View opens the details');
});
test('background notice: a single action, several actions, or none', () => {
  const dom = require('../support-dom.cjs');
  const log = []; const Notice = dom.makeNotice(log);
  const { backgroundResultNotice } = load('ui/background-run.ts', { obsidian: { ...obsidian, Notice } }, { createFragment: dom.createFragment, window: { createFragment: dom.createFragment } });
  const pressed = [];
  const one = backgroundResultNotice('One', { label: 'Open', open: () => pressed.push('open') });
  assert.deepEqual(plain(one.actions.map(b => b.text)), ['Open']); one.actions[0].click(); assert.deepEqual(pressed, ['open']); assert.equal(one.hidden, true);
  const many = backgroundResultNotice('Many', [{ label: 'View', open: () => pressed.push('view') }, { label: 'Again', open: () => pressed.push('again') }]);
  assert.deepEqual(plain(many.actions.map(b => b.text)), ['View', 'Again']); many.actions[1].click(); assert.deepEqual(pressed, ['open', 'again']); assert.equal(many.hidden, true);
  assert.equal(backgroundResultNotice('Plain').actions.length, 0); assert.equal(backgroundResultNotice('Empty list', []).actions.length, 0);
  assert.equal(log.at(-1), 'Empty list');
});
integrationTest('quick outline: Generate hides the dialog, the card runs with Stop, completion is one Notice plus a badge entry, and reopening goes straight to the review (a, d, e)', async () => {
  const h = await synthesisHarness();
  const outline = load('experiences/visual-map/outline-import.ts', { obsidian }).parseOutline('# Parent\n## Food\n### Breakfast').nodes;
  const gate = deferred(); let providerSignal;
  h.plugin.outlineGeneration = { generate: async (_request, signal) => { providerSignal = signal; await gate.promise; return { markdown: '', nodes: plain(outline) }; } };
  const before = h.modals.length;
  h.view.openNextStep(h.parent); await until(() => h.modals.length === before + 1);
  const modal = h.modals.at(-1);
  findAll(modal.contentEl, i => hasCls(i, 'vam-next-cards'))[0].children[1].click();
  button(modal.modalEl, 'Expand').click();
  await until(() => h.view.startingTasks.has(h.parent.path));
  assert.equal(modal.closeCount, 1, 'the dialog hid itself once the outline started');
  assert.equal(providerSignal === undefined || providerSignal.aborted === false, true);
  assert.equal(actionNotices(h).length, 0, 'no result Notice yet');
  gate.resolve(); await until(() => h.view.quickOutlines.has(h.parent.path));
  const storedOutline = h.view.quickOutlines.get(h.parent.path);
  assert.equal(storedOutline.options.signal, undefined, 'the closed dialog signal is not stored'); assert.equal(storedOutline.options.onProgress, undefined, 'the closed dialog progress callback is not stored');
  assert.equal(h.view.startingTasks.size, 0, 'the card is released once the outline arrived');
  assert.equal(actionNotices(h).length, 1, 'exactly one result Notice'); assert.equal(actionNotices(h)[0].actions[0].text, 'Review outline (2)');
  assert.equal(h.modals.length, before + 1, 'no review window opens by itself');
  assert.equal(findAll(modal.contentEl, i => hasCls(i, 'vam-proposal')).length, 0, 'nothing was written into the hidden dialog');
  pressNotice(h, 'Review outline (2)');
  await until(() => h.modals.length === before + 2);
  const review = h.modals.at(-1);
  assert.deepEqual(findAll(review.contentEl, i => hasCls(i, 'vam-proposal-title')).map(i => i.value), ['Food', 'Breakfast'], 'the reopened dialog is at the outline review');
  assert.ok(button(review.contentEl, 'Create subtopics (2)'));
  review.close();
  assert.ok(h.view.quickOutlines.has(h.parent.path), 'closing the review keeps the badge entry until the outline is created');
});
integrationTest('quick outline: Stop on the card before the provider answers drops the outline; view close aborts it too (b, f, g)', async () => {
  const h = await synthesisHarness();
  const outline = load('experiences/visual-map/outline-import.ts', { obsidian }).parseOutline('# Parent\n## Food').nodes;
  const gate = deferred(); let providerSignal;
  h.plugin.outlineGeneration = { generate: async (_request, signal) => { providerSignal = signal; await gate.promise; return { markdown: '', nodes: plain(outline) }; } };
  const run = async () => {
    const before = h.modals.length;
    h.view.openNextStep(h.parent); await until(() => h.modals.length === before + 1);
    const modal = h.modals.at(-1);
    findAll(modal.contentEl, i => hasCls(i, 'vam-next-cards'))[0].children[1].click();
      button(modal.modalEl, 'Expand').click();
    await until(() => h.view.startingTasks.has(h.parent.path));
    return modal;
  };
  await run();
  h.view.startingTasks.get(h.parent.path).abort(); gate.resolve(); await tick(); await tick(); await tick();
  assert.equal(h.view.quickOutlines.size, 0, 'a stopped outline is never kept'); assert.equal(actionNotices(h).length, 0);
  const second = await synthesisHarness();
  second.plugin.outlineGeneration = { generate: async (_request, signal) => { providerSignal = signal; await new Promise(() => {}); } };
  const before = second.modals.length;
  second.view.openNextStep(second.parent); await until(() => second.modals.length === before + 1);
  const dialog = second.modals.at(-1);
  findAll(dialog.contentEl, i => hasCls(i, 'vam-next-cards'))[0].children[1].click();
  button(dialog.modalEl, 'Expand').click();
  await until(() => providerSignal && second.view.startingTasks.has(second.parent.path));
  await second.view.onClose();
  assert.equal(providerSignal.aborted, true, 'closing the view stops the hidden outline');
});
integrationTest('synthesis: two requests for the same topic start one run', async () => {
  const h = await synthesisHarness();
  const gate = h.hold();
  const options = { researchMode: 'local', researchDepth: 'normal', visualMode: 'off', referenceGroups: [] };
  const failures = [];
  const first = h.view.startSynthesis(h.parent, options, null, m => failures.push(m), () => {});
  await until(() => h.calls.length === 1);
  await h.view.startSynthesis(h.parent, options, null, m => failures.push(m), () => {});
  assert.equal(h.calls.length, 1, 'the second request never reached the provider'); assert.equal(failures.length, 1); assert.match(failures[0], /running/i);
  gate.resolve(); await first;
  assert.equal(h.view.synthesisTasks.get(h.parent.path).state, 'directions');
});
integrationTest('synthesis: nothing is written when the topic changed while the result was being made', async () => {
  const h = await synthesisHarness();
  const modal = await h.openSingle();
  const gate = h.hold();
  visibleBar(modal, 'Skip suggestions and synthesize now').click(); await until(() => h.calls.length === 1);
  await h.repo.updateNote(h.parent.path, { summary: 'Edited elsewhere' });
  gate.resolve(); await until(() => h.view.synthesisTasks.get(h.parent.path)?.state === 'failed');
  assert.equal((await h.note()).summary, 'Edited elsewhere', 'the stale result did not overwrite it');
  assert.equal(h.view.history.undoEntry, undefined, 'no history step');
  assert.equal(actionNotices(h).filter(n => n.actions[0].text === 'Undo').length, 0);
});

// Fields that belong to the run itself: both dialogs must show exactly these (the name is the selection's own extra).
const fieldLabels = modal => findAll(modal.contentEl, i => ['select', 'textarea', 'input'].includes(i.tag) && i.type !== 'file' && i.type !== 'radio').map(i => i['aria-label'] ?? i.type ?? i.tag).filter(label => label !== 'New topic name' && label !== 'Model' && label !== 'Reasoning level');
integrationTest('single-topic and multi-select synthesis share one flow and one field set', async () => {
  const h = await synthesisHarness();
  const single = await h.openSingle();
  const multi = await h.openSelection();
  assert.deepEqual(fieldLabels(multi), fieldLabels(single), 'the same controls in the same order');
  for (const modal of [single, multi]) {
    const panel = panelOf(modal);
    assert.ok(visibleBar(modal, 'Get synthesis suggestions first') && visibleBar(modal, 'Skip suggestions and synthesize now'), 'the same two first steps');
    assert.ok(findAll(modal.contentEl, i => i.tag === 'select' && i['aria-label'] === 'Topic synthesis content').length === 1, 'the same content choice');
    assert.ok(panel);
  }
  assert.equal(byLabel(multi.contentEl, 'New topic name').value, 'Synthesis: Child A, Child B');
  assert.equal(find(multi.contentEl, i => hasCls(i, 'vam-next-cards')).cls.includes('is-hidden'), true);
  assert.equal(multi.titleEl.text, 'Confirm topic synthesis');
});
integrationTest('multi-select synthesis: pressing hides the dialog; directions, draft and review return by Notice, then the new topic is created', async () => {
  const h = await synthesisHarness();
  const modal = await h.openSelection();
  const name = byLabel(modal.contentEl, 'New topic name'); name.value = 'Cooking water'; name.input();
  visibleBar(modal, 'Get synthesis suggestions first').click();
  await until(() => h.view.integrationTask?.state === 'directions');
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0].directions, true);
  assert.equal(h.calls[0].context.title, 'Cooking water');
  assert.equal(modal.closeCount, 1, 'the dialog hid itself once AI started'); assert.equal(h.modals.length, 1, 'nothing opens by itself');
  assert.equal(actionNotices(h).length, 1); pressNotice(h, 'Choose synthesis direction');
  await until(() => h.modals.length === 2);
  const again = h.modals[1];
  assert.equal(findAll(again.contentEl, i => hasCls(i, 'vam-next-angle')).length, 2);
  assert.equal(find(again.contentEl, i => hasCls(i, 'vam-next-output')).hidden, true, 'ignored inputs are hidden in stage 2');
  assert.equal(find(again.contentEl, i => hasCls(i, 'vam-next-synth-setup')).cls.includes('is-hidden'), true, 'the name is fixed once the directions are requested');
  const before = (await h.repo.readMap(h.mapPath)).nodes.length;
  button(panelOf(again), 'Choose this direction').click();
  visibleBar(again, 'Start synthesis').click();
  await untilAsync(async () => (await h.repo.readMap(h.mapPath)).nodes.length === before + 1);
  assert.equal(h.calls[1].context.task, 'Find shared constraints'); assert.equal(h.calls[1].directions, false);
  assert.equal(h.modals.length, 2, 'no review opens: the topic is created directly'); assert.equal(again.closeCount, 1);
  assert.equal(actionNotices(h).filter(n => n.actions[0].text === 'Review synthesis draft').length, 0);
  const saved = await h.repo.readMap(h.mapPath);
  const created = await h.repo.readNote(saved.nodes.at(-1).path);
  assert.equal(created.title, 'Cooking water'); assert.equal(created.summary, 'Draft summary'); assert.equal(created.status, 'completed');
  assert.equal(h.view.integrationTask, null);
  assert.equal(actionNotices(h).filter(n => n.actions[0].text === 'Undo').length, 1);
  const createdPath = saved.nodes.at(-1).path;
  pressNotice(h, 'Undo'); await tick(); await tick(); await tick();
  assert.equal((await h.repo.readMap(h.mapPath)).nodes.length, before, 'Undo removes the new topic from the map');
  assert.ok(!h.app.vault.getAbstractFileByPath(createdPath), 'and its note leaves the topic folder (parked in Unassigned)');
  await h.view.history.redo().redo();
  assert.equal((await h.repo.readMap(h.mapPath)).nodes.length, before + 1, 'Redo brings it back');
  assert.equal((await h.repo.readNote(createdPath)).title, 'Cooking water');
});
integrationTest('multi-select synthesis: the chosen content template reaches the draft and the saved topic', async () => {
  const h = await synthesisHarness();
  const section = (id, name) => ({ id, name, description: '', role: 'none', aliases: [] });
  h.plugin.settings.detailTemplates = [{ id: 't1', name: 'Brief', sections: [section('key', 'Key points'), section('more', 'Further')] }];
  const modal = await h.openSelection();
  const name = byLabel(modal.contentEl, 'New topic name'); name.value = 'Cooking water'; name.input();
  const style = byLabel(modal.contentEl, 'Note style'); style.value = 'custom'; style.fire('change');
  const select = byLabel(modal.contentEl, 'Content template'); select.value = 't1'; select.change?.();
  visibleBar(modal, 'Skip suggestions and synthesize now').click();
  await untilAsync(async () => (await h.repo.readMap(h.mapPath)).nodes.length === 3 + 1);
  assert.equal(h.calls.at(-1).context.detailTemplate?.id, 't1', 'the draft is written for the chosen template');
  const saved = await h.repo.readMap(h.mapPath);
  assert.match((await h.repo.readNote(saved.nodes.at(-1).path)).detail, /Key points/, 'the saved topic uses the chosen template');
});
integrationTest('multi-select synthesis: Stop on the bar writes nothing and shows cancelled; the hidden dialog is never touched; a pending draft waits on the bar and its Notice', async () => {
  const h = await synthesisHarness();
  const modal = await h.openSelection();
  const notesBefore = (await h.repo.readMap(h.mapPath)).nodes.length;
  const gate = h.hold();
  visibleBar(modal, 'Get synthesis suggestions first').click(); await until(() => h.calls.length === 1); await tick();
  assert.equal(modal.closeCount, 1);
  h.view.integrationTask.controller.abort(); await until(() => h.calls[0].signal.aborted); await tick(); await tick();
  assert.equal(h.view.integrationTask.state, 'cancelled', 'a stopped request shows the cancelled bar with Try again / Discard');
  assert.equal((await h.repo.readMap(h.mapPath)).nodes.length, notesBefore);
  assert.equal(actionNotices(h).length, 0); assert.equal(h.view.startingTasks.size, 0);
  gate.resolve();
  h.view.discardSelectionSynthesis();
  // The draft arriving while the dialog is hidden waits on the selection bar and its Notice, never in the dialog.
  const second = await h.openSelection();
  const draftGate = h.hold();
  visibleBar(second, 'Skip suggestions and synthesize now').click(); await until(() => h.calls.length === 2);
  assert.equal(second.closeCount, 1); assert.equal(h.calls[1].signal.aborted, false);
  second.close(); assert.equal(h.calls[1].signal.aborted, false, 'closing the hidden dialog again does not abort');
  assert.equal((await h.repo.readMap(h.mapPath)).nodes.length, notesBefore, 'nothing is created before the result arrives');
  draftGate.resolve(); await untilAsync(async () => (await h.repo.readMap(h.mapPath)).nodes.length === notesBefore + 1);
  assert.equal(find(second.contentEl, i => hasCls(i, 'vam-next-review')), undefined);
  assert.equal(actionNotices(h).length, 1); assert.equal(actionNotices(h)[0].actions[0].text, 'Undo');
  assert.equal(h.modals.length, 2, 'no review dialog opens'); assert.equal(h.view.integrationTask, null);
});
integrationTest('multi-select synthesis: nothing is created when a source changed while the result was being made', async () => {
  const h = await synthesisHarness();
  const modal = await h.openSelection();
  const before = (await h.repo.readMap(h.mapPath)).nodes.length;
  const gate = h.hold();
  visibleBar(modal, 'Skip suggestions and synthesize now').click(); await until(() => h.calls.length === 1);
  await h.repo.updateNote(h.kids[0].path, { summary: 'Edited elsewhere' });
  gate.resolve(); await until(() => h.view.integrationTask?.state === 'failed');
  assert.equal((await h.repo.readMap(h.mapPath)).nodes.length, before);
  assert.equal(h.view.history.undoEntry, undefined);
  assert.equal(actionNotices(h).filter(n => n.actions[0].text === 'Undo').length, 0);
});
integrationTest('multi-select synthesis: Stop before the provider accepts sends no request; a late result after Stop is dropped', async () => {
  const h = await synthesisHarness();
  const modal = await h.openSelection();
  h.knobs.readGate = deferred();
  visibleBar(modal, 'Get synthesis suggestions first').click();
  await until(() => h.view.startingTasks.has(h.view.selectionTaskKey()));
  assert.equal(modal.closeCount, 1);
  h.view.startingTasks.get(h.view.selectionTaskKey()).abort();
  h.knobs.readGate.resolve(); h.knobs.readGate = null;
  await until(() => !h.view.startingTasks.has(h.view.selectionTaskKey())); await tick(); await tick();
  assert.equal(h.calls.length, 0, 'no provider request was sent'); assert.equal(actionNotices(h).length, 0);
  h.view.discardSelectionSynthesis();
  const second = await h.openSelection();
  h.knobs.ignoreAbort = true;
  const gate = h.hold();
  visibleBar(second, 'Get synthesis suggestions first').click(); await until(() => h.calls.length === 1);
  h.view.integrationTask.controller.abort(); gate.resolve(); await tick(); await tick(); await tick();
  assert.notEqual(h.view.integrationTask?.state, 'directions'); assert.equal(actionNotices(h).length, 0, 'a late result after Stop makes no Notice');
});
integrationTest('multi-select synthesis: a request needs a name and two requests do not both start', async () => {
  const h = await synthesisHarness();
  const modal = await h.openSelection();
  const name = byLabel(modal.contentEl, 'New topic name'); name.value = ' '; name.input();
  assert.equal(visibleBar(modal, 'Get synthesis suggestions first').disabled, true);
  assert.equal(h.calls.length, 0);
  const options = { researchMode: 'local', researchDepth: 'normal', visualMode: 'off', referenceGroups: [], synthesisTitle: 'T' };
  const failures = []; const gate = h.hold();
  const nodes = h.kids;
  const first = h.view.startSelectionSynthesis(nodes, options, null, m => failures.push(m), () => {});
  const second = h.view.startSelectionSynthesis(nodes, options, null, m => failures.push(m), () => {});
  await second; assert.equal(failures.length, 1); assert.match(failures[0], /running/i);
  await until(() => h.calls.length === 1); gate.resolve(); await first;
  assert.equal(h.calls.length, 1); assert.equal(h.view.integrationTask.state, 'directions');
});
integrationTest('multi-select synthesis: Stop during the draft then Try again runs a fresh request instead of aborting at once (D2)', async () => {
  const h = await synthesisHarness();
  const modal = await h.openSelection();
  const gate = h.hold();
  visibleBar(modal, 'Skip suggestions and synthesize now').click(); await until(() => h.calls.length === 1); await tick();
  h.view.integrationTask.controller.abort(); await until(() => h.calls[0].signal.aborted); await tick(); await tick();
  assert.equal(h.view.integrationTask.state, 'cancelled'); gate.resolve();
  h.view.retrySelectionSynthesis(h.view.integrationTask);
  await until(() => h.calls.length === 2); await tick();
  assert.equal(h.calls[1].signal.aborted, false, 'the retry does not inherit the stopped run signal');
  assert.notEqual(h.view.integrationTask?.state, 'cancelled');
});
integrationTest('synthesis: a result for a map that is no longer open raises no Notice and stores nothing under the new map (Low 1)', async () => {
  const h = await synthesisHarness();
  const hooks = h.view.backgroundHooks(h.parent.path, h.parent);
  h.view.path = 'Other map.md';
  hooks.completed('research'); hooks.outlineReady({ nodes: [], dropped: 0, options: { researchMode: 'local', researchDepth: 'normal', visualMode: 'off' } });
  assert.equal(h.notices.length, 0, 'no cross-map Notice'); assert.equal(h.view.quickOutlines.size, 0);
});

// ---- Note style picker ------------------------------------------------------------------------------------------------
const styleSelect = root => byLabel(root, 'Note style');
const pick = (select, value) => { select.value = value; select.fire('change'); };
integrationTest('Next Step: the Note style select lists the presets, hints what each gives and starts on "Keep current" with Custom… collapsed', async () => {
  const h = nextStepHarness({ modelSettings: { tones, currentTone: 'Academic rigor', currentStyle: 'Standard', templates: [{ id: 'standard', name: 'Standard' }, { id: 'textbook', name: 'Textbook' }], currentTemplate: 'Standard' } });
  const select = styleSelect(h.modal.contentEl);
  assert.deepEqual(plain(select.children.map(o => [o.value, o.text])), [['', 'Keep current (Standard)'], ['preset:standard', 'Standard (academic)'], ['preset:textbook', 'Textbook (intro, then sections)'], ['preset:summary', 'Key points'], ['preset:plain', 'Plain language'], ['preset:guide', 'Practical guide'], ['custom', 'Custom…']]);
  const custom = find(h.modal.contentEl, i => hasCls(i, 'vam-note-style-custom'));
  assert.equal(custom.hidden, true, 'the custom selects start collapsed');
  pick(select, 'preset:textbook');
  assert.equal(custom.hidden, true);
  assert.ok(find(h.modal.contentEl, i => i.text === 'Opens with 2–4 intro paragraphs, then the six sections; empty sections are left out.'), 'the hint line describes the choice');
  pick(select, 'custom'); assert.equal(custom.hidden, false);
  assert.ok(find(h.modal.contentEl, i => i.text === 'Pick a content template and a writing tone yourself, including your own.'));
  pick(select, 'preset:plain'); assert.equal(custom.hidden, true);
  pick(select, ''); assert.equal(find(h.modal.contentEl, i => i.text === 'Six sections in everyday words; jargon is explained the first time it appears.'), undefined, 'the first option has no hint');
});
integrationTest('Next Step: a preset sends both the template and the tone (even Standard + academic); keeping sends neither', async () => {
  const sent = async value => {
    const h = nextStepHarness({ modelSettings: { tones, currentTone: 'Academic rigor', currentStyle: 'Standard' } });
    if (value !== undefined) pick(styleSelect(h.modal.contentEl), value);
    button(h.actions(), 'Confirm research task').click(); await tick(); await tick();
    return h.calls.research[0];
  };
  const keep = await sent(undefined);
  assert.equal('detailTemplateId' in keep, false); assert.equal('toneId' in keep, false);
  const standard = await sent('preset:standard');
  assert.equal(standard.detailTemplateId, 'standard'); assert.equal(standard.toneId, 'academic');
  const textbook = await sent('preset:textbook');
  assert.equal(textbook.detailTemplateId, 'textbook'); assert.equal(textbook.toneId, 'academic');
  const summary = await sent('preset:summary');
  assert.equal(summary.detailTemplateId, 'standard'); assert.equal(summary.toneId, 'summary');
  assert.equal((await sent('preset:plain')).toneId, 'plain'); assert.equal((await sent('preset:guide')).toneId, 'guide');
});
integrationTest('Next Step: Custom… sends its two selects; collapsing it again sends only the preset, never the hidden custom values', async () => {
  const h = nextStepHarness({ modelSettings: { tones, templates: [{ id: 'standard', name: 'Standard' }, { id: 'mine', name: 'Mine' }], currentTone: 'Academic rigor', currentTemplate: 'Standard', currentStyle: 'Standard' } });
  const select = styleSelect(h.modal.contentEl);
  pick(select, 'custom');
  byLabel(h.modal.contentEl, 'Content template').value = 'mine'; byLabel(h.modal.contentEl, 'Content template').fire('change');
  byLabel(h.modal.contentEl, 'Writing tone').value = 'magazine'; byLabel(h.modal.contentEl, 'Writing tone').fire('change');
  assert.ok(find(h.modal.contentEl, i => hasCls(i, 'vam-next-source-summary') && /Custom: Mine · Magazine column/.test(i.text)), 'the output summary names the custom pair');
  pick(select, 'preset:summary');
  button(h.actions(), 'Confirm research task').click(); await tick(); await tick();
  assert.equal(h.calls.research[0].detailTemplateId, 'standard'); assert.equal(h.calls.research[0].toneId, 'summary');
  const second = nextStepHarness({ modelSettings: { tones, templates: [{ id: 'standard', name: 'Standard' }, { id: 'mine', name: 'Mine' }], currentTone: 'Academic rigor', currentTemplate: 'Standard', currentStyle: 'Standard' } });
  pick(styleSelect(second.modal.contentEl), 'custom');
  byLabel(second.modal.contentEl, 'Content template').value = 'mine'; byLabel(second.modal.contentEl, 'Writing tone').value = 'magazine';
  button(second.actions(), 'Confirm research task').click(); await tick(); await tick();
  assert.equal(second.calls.research[0].detailTemplateId, 'mine'); assert.equal(second.calls.research[0].toneId, 'magazine');
  const back = nextStepHarness({ modelSettings: { tones, templates: [{ id: 'standard', name: 'Standard' }, { id: 'mine', name: 'Mine' }], currentTone: 'Academic rigor', currentTemplate: 'Standard', currentStyle: 'Standard' } });
  pick(styleSelect(back.modal.contentEl), 'custom'); byLabel(back.modal.contentEl, 'Content template').value = 'mine';
  pick(styleSelect(back.modal.contentEl), '');
  button(back.actions(), 'Confirm research task').click(); await tick(); await tick();
  assert.equal('detailTemplateId' in back.calls.research[0], false, 'a collapsed custom choice is not sent'); assert.equal('toneId' in back.calls.research[0], false);
});
integrationTest('Next Step: when the current style is custom the first option names it and Custom… does not open by itself', () => {
  const h = nextStepHarness({ modelSettings: { tones, currentTone: 'Magazine column', currentTemplate: 'Mine', currentStyle: 'Custom: Mine · Magazine column' } });
  const select = styleSelect(h.modal.contentEl);
  assert.equal(select.children[0].text, 'Keep current (Custom: Mine · Magazine column)'); assert.equal(select.value, '');
  assert.equal(find(h.modal.contentEl, i => hasCls(i, 'vam-note-style-custom')).hidden, true);
  assert.equal(summaryOf(h).endsWith('Custom: Mine · Magazine column'), true, 'the summary names the style, not only the tone');
});
integrationTest('multi-select research dialog: one Note style field with "Each topic\'s current style" first; presets send both values', () => {
  const Modal = dom.makeModal();
  const { MultiResearchModal } = load('experiences/visual-map/multi-research-modal.ts', { obsidian: { ...obsidian, Modal } });
  const submitted = []; const models = { list: () => [], watch: () => () => {} };
  const modal = new MultiResearchModal({}, ['A', 'B'], models, [{ id: 'standard', name: 'Standard' }], request => submitted.push(request), [{ id: 'plain', name: 'Plain' }]);
  modal.open();
  const select = styleSelect(modal.contentEl);
  assert.equal(select.children[0].text, "Each topic's current style");
  assert.equal(findAll(modal.contentEl, i => i.tag === 'select' && i['aria-label'] === 'Note style').length, 1);
  pick(select, 'preset:textbook'); button(modal.modalEl, 'Start research (2)').click();
  assert.equal(submitted[0].detailTemplateId, 'textbook'); assert.equal(submitted[0].toneId, 'academic');
});
integrationTest('outline import dialog: first option is "Use the default (Standard)"; the style is sent only with quick research and restored on reopen', async () => {
  const Modal = dom.makeModal();
  const { OutlineImportModal } = load('experiences/visual-map/outline-import-modal.ts', { obsidian: { ...obsidian, Modal } });
  const requests = [];
  const open = (shallowOn, value, prefill) => {
    const modal = new OutlineImportModal({ vault: { getMarkdownFiles: () => [] } }, async request => { requests.push(request); }, undefined, [{ id: 'standard', name: 'Standard' }], { map: 'none' }, 'tree', undefined, {}, [{ id: 'plain', name: 'Plain' }], 'Standard');
    modal.open();
    const select = styleSelect(modal.contentEl);
    if (value) pick(select, value);
    const textarea = find(modal.contentEl, i => i.tag === 'textarea'); textarea.value = '# R\n## A'; textarea.fire('input');
    const shallow = find(modal.contentEl, i => i.tag === 'input' && i.type === 'checkbox'); shallow.checked = shallowOn; shallow.fire('change');
    button(modal.modalEl, 'Add to mind map').click();
    return { modal, select };
  };
  const first = open(false, 'preset:textbook'); await tick();
  assert.equal(first.select.children[0].text, 'Use the default (Standard)');
  assert.equal('detailTemplateId' in requests[0], false); assert.equal('toneId' in requests[0], false, 'ignored while quick research is off');
  open(true, 'preset:textbook'); await tick();
  assert.equal(requests[1].detailTemplateId, 'textbook'); assert.equal(requests[1].toneId, 'academic');
  open(true, 'preset:plain'); await tick();
  assert.equal(requests[2].detailTemplateId, 'standard'); assert.equal(requests[2].toneId, 'plain');
  open(true, undefined); await tick();
  assert.equal('toneId' in requests[3], false); assert.equal('detailTemplateId' in requests[3], false);
});

// ---- S6: the research dialog pre-starts the CLI and releases it when it is not used ----
const warmSpies = () => { const spy = { prewarms: [], releases: 0 }; spy.plugin = { prewarmClaude: (model, reasoning) => spy.prewarms.push([model, reasoning]), releaseWarmClaude: () => { spy.releases++; } }; return spy; };
integrationTest('S6 dialog: opening the research step pre-starts the CLI with the dialog\'s model and reasoning; closing it unused releases the process', () => {
  const spy = warmSpies();
  const h = nextStepHarness({ plugin: spy.plugin, modelSettings: { topicStatus: 'idea' } });
  assert.deepEqual(spy.prewarms, [['gpt-test', 'low']], 'one pre-start on open');
  assert.equal(spy.releases, 0);
  h.modal.close();
  assert.equal(spy.releases, 1, 'closed without starting AI: the waiting process is killed');
});
integrationTest('S6 dialog: confirm hands the process to the run (closing the hidden dialog does not kill it); only Stop or an abort does', async () => {
  const spy = warmSpies();
  const controllers = [];
  const h = nextStepHarness({ plugin: spy.plugin, modelSettings: { topicStatus: 'idea', background: { begin: controller => controllers.push(controller), end: () => {}, completed: () => {} } } });
  button(h.actions(), 'Confirm research task').click(); await tick(); await tick();
  assert.equal(h.calls.research.length, 1);
  assert.equal(spy.releases, 0, 'the run owns the process now');
  h.modal.close();
  assert.equal(spy.releases, 0, 'the dialog hid itself on confirm; closing it must not kill the process the run is about to take');
  assert.equal(controllers.length, 1);
  controllers[0].abort();
  assert.equal(spy.releases, 1, 'Stop before the provider took the process kills it');
});
integrationTest('S6 dialog: switching to another step releases the process, and a model change pre-starts the new command', () => {
  const spy = warmSpies();
  const h = nextStepHarness({ plugin: spy.plugin, modelSettings: { topicStatus: 'idea' } });
  const n = spy.prewarms.length;
  const model = byLabel(h.modal.contentEl, 'Model');
  model.value = 'gpt-other'; model.fire('change');
  assert.equal(spy.prewarms.length, n + 1, 'a changed model pre-starts again (the pool kills the old command)');
  const cards = findAll(cardsOf(h), i => i.tag === 'button' && i.attrs && i.attrs.role === 'radio');
  assert.equal(cards.length, 3, cards.map(c => c.text).join('|'));
  const before = spy.releases;
  cards[1].click();
  assert.equal(spy.releases, before + 1, 'leaving the research step releases the process');
});
integrationTest('S6 dialog: the pre-start follows the AI mode (Quick pre-starts without web tools, Standard with them); an expansion pre-starts only when its subtopics are researched', () => {
  const spy = { prewarms: [], releases: 0 };
  spy.plugin = { prewarmClaude: (model, reasoning, webSearch) => spy.prewarms.push(webSearch), releaseWarmClaude: () => { spy.releases++; } };
  const h = nextStepHarness({ plugin: spy.plugin, modelSettings: { topicStatus: 'idea' } });
  assert.deepEqual(spy.prewarms, [false], 'Quick is the default: pre-started without web tools');
  const group = byLabel(h.modal.contentEl, 'AI mode');
  button(group, 'Standard').click();
  assert.deepEqual(spy.prewarms, [false, true], 'switching to Standard pre-starts again with web tools');
  button(group, 'Quick').click();
  assert.deepEqual(spy.prewarms, [false, true, false]);
  // expansion: nothing unless the new subtopics are researched afterwards
  const checkbox = text => find(find(h.modal.contentEl, i => i.tag === 'label' && findAll(i, c => c.text === text).length > 0), i => i.tag === 'input');
  const cards = findAll(cardsOf(h), i => i.tag === 'button' && i.attrs && i.attrs.role === 'radio');
  const releases = spy.releases;
  cards[1].click();
  assert.equal(spy.releases, releases + 1, 'plain expansion pre-starts nothing');
  const shallow = checkbox('Run a short research on each created subtopic');
  shallow.checked = true; shallow.change();
  assert.deepEqual(spy.prewarms.at(-1), false, 'Quick subtopic research pre-starts without web tools');
  button(group, 'Standard').click();
  assert.deepEqual(spy.prewarms.at(-1), true, 'Standard subtopic research pre-starts with web tools');
  shallow.checked = false; shallow.change();
  assert.equal(spy.releases, releases + 2, 'unticking the subtopic research releases it again');
});
integrationTest('W2c dialog: the synthesis step pre-starts a web-less synthesis command whatever the AI mode, and releases it when leaving the step', () => {
  const spy = { prewarms: [], releases: 0 };
  spy.plugin = { prewarmClaude: (model, reasoning, webSearch, mode) => spy.prewarms.push([webSearch, mode]), releaseWarmClaude: () => { spy.releases++; } };
  const h = nextStepHarness({ plugin: spy.plugin, modelSettings: { topicStatus: 'idea' } });
  const cards = findAll(cardsOf(h), i => i.tag === 'button' && i.attrs && i.attrs.role === 'radio');
  button(byLabel(h.modal.contentEl, 'AI mode'), 'Standard').click();
  cards[2].click();
  assert.deepEqual(spy.prewarms.at(-1), [false, 'synthesize'], 'synthesis never uses the web and uses the synthesis effort');
  const releases = spy.releases;
  cards[0].click();
  assert.equal(spy.prewarms.at(-1)[1], undefined, 'the research step pre-starts a plain research command'); assert.equal(spy.prewarms.at(-1)[0], true, 'in the chosen mode');
  assert.equal(spy.releases, releases);
  cards[1].click();
  assert.equal(spy.releases, releases + 1, 'plain expansion releases it');
});
integrationTest('S6 dialog: a plugin without the pre-start methods (older test doubles) still opens and closes', () => {
  const h = nextStepHarness({});
  assert.doesNotThrow(() => h.modal.close());
});

// ---- B2-feat: integration from the chat (no dialog, the user's message is the direction) ---------------------------------
const NOT_UNDOABLE_TEXT = 'These changes cannot be undone; the undo history was cleared.';
const chatApply = async (h, actions, message, baseline = {}) => (await h.view.applyMapChatActions({ actions, rejected: [], message }, { mdHashes: {}, topicHashes: baseline })).filter(l => l.text !== NOT_UNDOABLE_TEXT);
const synth = (nodeIds, extra = {}) => ({ kind: 'run_map_action', action: 'synthesize', nodeIds, title: '', goal: '', direction: 'model words', depth: '', images: false, ...extra });
const spyOptions = h => { const seen = []; for (const name of ['startSynthesis', 'startSelectionSynthesis']) { const original = h.view[name].bind(h.view); h.view[name] = (target, options, ...rest) => { const { signal, onProgress, ...kept } = options; seen.push({ name, options: JSON.parse(JSON.stringify(kept)), direction: rest[0], hadSignal: !!signal }); return original(target, options, ...rest); }; } return seen; };

integrationTest('B2 synthesize (chat): one card with subtopics is integrated into itself with no dialog; the message is the direction; the parent note is written', async () => {
  const h = await synthesisHarness();
  const lines = await chatApply(h, [synth([h.parent.id])], 'Integrate around sleep debt');
  assert.deepEqual(plain(lines.map(l => l.status)), ['done'], JSON.stringify(lines));
  await untilAsync(async () => (await h.note()).summary === 'Draft summary');
  assert.equal(h.modals.length, 0, 'no dialog of any kind opened');
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0].directions, false, 'the directions step is skipped');
  assert.equal(h.calls[0].context.task, 'Integrate around sleep debt', 'the request task is the message, not the model\'s direction');
  assert.match((await h.note()).detail, /Draft detail/); assert.equal(h.view.synthesisTasks.size, 0);
  assert.equal(actionNotices(h).filter(n => n.actions[0].text === 'Undo').length, 1, 'the usual done Notice with Undo');
});
integrationTest('B2 synthesize (chat): the selection is the target when the reply names none', async () => {
  const h = await synthesisHarness();
  h.view.selected = h.parent.id;
  const lines = await chatApply(h, [synth([])], 'Go');
  assert.deepEqual(plain(lines.map(l => l.status)), ['done']); await untilAsync(async () => (await h.note()).summary === 'Draft summary');
  assert.equal(h.modals.length, 0);
});
integrationTest('B2 synthesize (chat) counterexample: a card without subtopics is skipped with the reason, no dialog, no request', async () => {
  const h = await synthesisHarness();
  const lines = await chatApply(h, [synth([h.kids[0].id])], 'Integrate');
  assert.deepEqual(plain(lines.map(l => l.status)), ['skipped']); assert.match(lines[0].text, /no subtopics/);
  assert.equal(h.modals.length, 0); assert.equal(h.calls.length, 0);
});
integrationTest('B2 synthesize (chat) counterexample: an integration already running on the card is skipped; the first one still finishes', async () => {
  const h = await synthesisHarness();
  const gate = h.hold();
  const first = chatApply(h, [synth([h.parent.id])], 'First');
  await until(() => h.calls.length === 1);
  const second = await chatApply(h, [synth([h.parent.id])], 'Second');
  assert.deepEqual(plain(second.map(l => l.status)), ['skipped']); assert.match(second[0].text, /already running or waiting/); assert.equal(h.calls.length, 1);
  gate.resolve(); assert.deepEqual(plain((await first).map(l => l.status)), ['done']);
  await untilAsync(async () => (await h.note()).summary === 'Draft summary'); assert.equal(h.modals.length, 0);
});
integrationTest('B2 synthesize (chat): several cards go to the selection integration with no dialog and make one new integrated topic', async () => {
  const h = await synthesisHarness();
  const before = h.view.map.nodes.length;
  const lines = await chatApply(h, [synth(h.kids.map(k => k.id))], 'Compare the two');
  assert.deepEqual(plain(lines.map(l => l.status)), ['done'], JSON.stringify(lines));
  await untilAsync(async () => h.view.map.nodes.length === before + 1 || (await h.repo.readMap(h.mapPath)).nodes.length === before + 1);
  assert.equal(h.modals.length, 0); assert.equal(h.calls.length, 1); assert.equal(h.calls[0].directions, false);
  assert.match(h.calls[0].context.task, /Compare the two/);
});
integrationTest('B2 synthesize (chat): a declined usage notice starts nothing and says so', async () => {
  const h = await synthesisHarness(); h.plugin.confirmAiUsage = async () => false;
  const lines = await chatApply(h, [synth([h.parent.id])], 'x');
  assert.deepEqual(plain(lines.map(l => l.status)), ['skipped']); assert.match(lines[0].text, /did not start/); assert.equal(h.calls.length, 0);
});
integrationTest('B2 synthesize (chat): a start that fails before the provider accepts is a failed line; a map that is read-only or switched is skipped', async () => {
  const h = await synthesisHarness();
  h.plugin.askModel = async () => { throw new Error('provider down'); };
  const failed = await chatApply(h, [synth([h.parent.id])], 'x');
  assert.deepEqual(plain(failed.map(l => l.status)), ['failed']); assert.match(failed[0].text, /provider down/); assert.equal(h.modals.length, 0);
  const ro = await synthesisHarness(); ro.view.builtIn = true;
  const skippedRo = await chatApply(ro, [synth([ro.parent.id])], 'x'); assert.deepEqual(plain(skippedRo.map(l => l.status)), ['skipped']); assert.equal(ro.calls.length, 0);
});
integrationTest('B2 synthesize (chat): the options equal what the integration dialog hands over when its fields are left alone (single card and selection)', async () => {
  const dialog = await synthesisHarness(); const dialogSeen = spyOptions(dialog);
  const modal = await dialog.openSingle(); visibleBar(modal, 'Skip suggestions and synthesize now').click();
  await untilAsync(async () => (await dialog.note()).summary === 'Draft summary');
  const chat = await synthesisHarness(); const chatSeen = spyOptions(chat);
  await chatApply(chat, [synth([chat.parent.id])], 'x'); await untilAsync(async () => (await chat.note()).summary === 'Draft summary');
  assert.equal(dialogSeen.length, 1); assert.equal(chatSeen.length, 1);
  assert.deepEqual(chatSeen[0].options, dialogSeen[0].options, 'single card: same TaskOptions');
  console.log('B2 integration default options (single):', JSON.stringify(chatSeen[0].options));
  const selDialog = await synthesisHarness(); const selDialogSeen = spyOptions(selDialog);
  const selModal = await selDialog.openSelection(); visibleBar(selModal, 'Skip suggestions and synthesize now').click();
  await until(() => selDialogSeen.length === 1);
  const selChat = await synthesisHarness(); const selChatSeen = spyOptions(selChat);
  await chatApply(selChat, [synth(selChat.kids.map(k => k.id))], 'x'); await until(() => selChatSeen.length === 1);
  assert.deepEqual(selChatSeen[0].options, selDialogSeen[0].options, 'selection: same TaskOptions, including the new topic\'s default name');
  console.log('B2 integration default options (selection):', JSON.stringify(selChatSeen[0].options));
});
