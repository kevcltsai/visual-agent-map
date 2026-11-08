// Map AI dialogs (Phase B): tone presets library and pickers, the one-click Next Step dialog and the single-dialog
// synthesis flow. Dialogs run against the DOM stand-in in tests/support-dom.cjs; only the AI callbacks are doubles.
const assert = require('node:assert/strict');
const { test, integrationTest, load, plain, obsidian, node, map } = require('../support.cjs');
const dom = require('../support-dom.cjs');
const { hasCls, element, find, findAll, byLabel, button, buttons, tick } = dom;

// ---- outline presets library (06 P4: the tone library is gone, tones are blocks; the modal lists the outline kind only) --------
function presetsHarness(settings = {}) {
  const Modal = dom.makeModal();
  const mod = load('ui/modals/prompt-presets-modal.ts', { obsidian: { ...obsidian, Modal } });
  const plugin = { settings: { language: 'en', promptPresets: [], ...settings }, saves: 0, async saveSettings() { this.saves++; } };
  const modal = new mod.PromptPresetsModal({}, plugin); modal.open();
  const rows = () => findAll(modal.contentEl, i => i.cls === 'vam-template-row');
  const names = () => rows().map(r => find(r, i => i.tag === 'strong').text);
  const row = name => rows().find(r => find(r, i => i.tag === 'strong').text === name);
  const rowButtons = name => findAll(row(name), i => i.tag === 'button').map(b => b.text);
  const click = async (root, text) => { const b = button(root, text); assert.ok(b, `button ${text}`); b.click(); await tick(); };
  return { modal, plugin, rows, names, row, rowButtons, click };
}
// Replaces 'tone library: built-ins offer View and Duplicate only...' (same flow, outline kind).
test('outline library: built-ins offer View and Duplicate only; custom presets can be edited, renamed, duplicated and deleted', async () => {
  const h = presetsHarness({ promptPresets: [{ id: 'mine', kind: 'outline', name: 'Mine', text: 'Be brief.' }, { id: 'warm', kind: 'tone', name: 'Warm', text: 'x' }] });
  assert.deepEqual(h.names(), ['Knowledge tree generator', 'Mine'], 'tone presets are not listed');
  assert.deepEqual(plain(h.rowButtons('Knowledge tree generator')), ['View', 'Duplicate']);
  assert.deepEqual(plain(h.rowButtons('Mine')), ['Edit', 'Duplicate', 'Delete']);
  assert.ok(find(h.row('Knowledge tree generator'), i => i.cls === 'vam-template-tag' && i.text === 'Built-in'));
  // A built-in opens read-only.
  await h.click(h.row('Knowledge tree generator'), 'View');
  assert.equal(byLabel(h.modal.contentEl, 'Preset name').disabled, true);
  assert.equal(byLabel(h.modal.contentEl, 'Preset instructions').disabled, true);
  assert.equal(button(h.modal.modalEl, 'Save'), undefined);
  await h.click(h.modal.modalEl, 'Close');
  // Duplicate a built-in: becomes an editable custom outline preset with the same text.
  await h.click(h.row('Knowledge tree generator'), 'Duplicate');
  assert.equal(h.plugin.promptPresets, undefined);
  const copy = h.plugin.settings.promptPresets.find(item => item.name === 'Knowledge tree generator copy');
  assert.ok(copy && copy.kind === 'outline' && copy.text.length > 10);
  assert.equal(h.plugin.saves, 1);
  // Edit and rename a custom one; Cancel discards, Save persists.
  await h.click(h.row('Mine'), 'Edit');
  byLabel(h.modal.contentEl, 'Preset name').value = 'Renamed'; byLabel(h.modal.contentEl, 'Preset name').fire('input');
  byLabel(h.modal.contentEl, 'Preset instructions').value = 'New voice.';
  await h.click(h.modal.modalEl, 'Cancel');
  assert.equal(h.plugin.settings.promptPresets.find(item => item.id === 'mine').name, 'Mine');
  await h.click(h.row('Mine'), 'Edit');
  byLabel(h.modal.contentEl, 'Preset name').value = 'Renamed'; byLabel(h.modal.contentEl, 'Preset name').fire('input');
  byLabel(h.modal.contentEl, 'Preset instructions').value = 'New voice.';
  await h.click(h.modal.modalEl, 'Save');
  assert.deepEqual(plain(h.plugin.settings.promptPresets.find(item => item.id === 'mine')), { id: 'mine', kind: 'outline', name: 'Renamed', text: 'New voice.' });
  assert.ok(h.names().includes('Renamed'));
  // A blank name cannot be saved and says why.
  await h.click(h.row('Renamed'), 'Edit');
  byLabel(h.modal.contentEl, 'Preset name').value = '  '; byLabel(h.modal.contentEl, 'Preset name').fire('input');
  assert.equal(button(h.modal.modalEl, 'Save').disabled, true);
  assert.ok(find(h.modal.modalEl, i => i.text === 'Enter a name before saving.'));
  await h.click(h.modal.modalEl, 'Cancel');
});
// Replaces 'tone library: delete asks twice ... New tone ...' (same flow, outline kind).
test('outline library: delete asks twice (armed for five seconds) and New preset opens an editor that saves a custom outline preset', async () => {
  const h = presetsHarness({ promptPresets: [{ id: 'mine', kind: 'outline', name: 'Mine', text: 'Be brief.' }] });
  const del = find(h.row('Mine'), i => i.tag === 'button' && i.text === 'Delete');
  del.click();
  assert.equal(h.plugin.settings.promptPresets.length, 1, 'the first press only arms');
  assert.equal(del.text, 'Delete preset?');
  assert.ok(find(h.modal.modalEl, i => /Press again within 5 seconds/.test(i.text)));
  del.click(); await tick();
  assert.deepEqual(plain(h.plugin.settings.promptPresets), []);
  assert.equal(h.plugin.saves, 1);
  await h.click(h.modal.modalEl, 'New preset');
  assert.equal(byLabel(h.modal.contentEl, 'Preset name').value, 'My outline preset');
  byLabel(h.modal.contentEl, 'Preset instructions').value = 'Warm and concrete.';
  await h.click(h.modal.modalEl, 'Save');
  assert.deepEqual(plain(h.plugin.settings.promptPresets.map(item => [item.kind, item.name, item.text])), [['outline', 'My outline preset', 'Warm and concrete.']]);
});

// ---- tone pickers -----------------------------------------------------------------------------------------------
integrationTest('map actions (counterexample 9, Q15/Q17, C5; was: the map default note style and map default tone pickers): a regular map and an AIM map list neither "Note style for this map" nor "Voice for this map", and the old map values stay byte for byte', async () => {
  const menus = [];
  const { VisualAgentMapView } = load('main.ts', { obsidian: { ...obsidian, Menu: class Menu { constructor() { this.items = []; this.separators = []; menus.push(this); } addItem(cb) { const item = { setTitle(v) { this.title = v; return this; }, setIcon() { return this; }, setWarning(v) { this.warning = v; return this; }, onClick(fn) { this.click = fn; return this; } }; cb(item); this.items.push(item); return this; } addSeparator() { this.separators.push(this.items.length); return this; } showAtPosition(at) { this.at = at; return this; } showAtMouseEvent() { this.mouse = true; return this; } }, Notice: class {} } });
  const plugin = { settings: { language: 'en', detailTemplates: [], promptPresets: [] } };
  for (const aim of [false, true]) {
    const view = new VisualAgentMapView({ app: {} }, plugin);
    view.map = { ...map([node('a')]), detailTemplateId: 'textbook', toneId: 'plain', ...(aim ? { aim: { branches: [] } } : {}) };
    const before = JSON.stringify(view.map);
    view.openMapActions();
    const labels = plain(menus.at(-1).items.map(item => item.title));
    assert.ok(labels.length >= 2 && labels.includes('Rename current mind map'), labels.join('|'));
    for (const label of labels) assert.ok(!/note style|voice|tone/i.test(label), `${aim ? 'AIM' : 'regular'} map: ${label}`);
    assert.equal(JSON.stringify(view.map), before, 'opening the actions leaves the old map values alone');
  }
  assert.equal(typeof load('main.ts', { obsidian }).VisualAgentMapView.prototype.chooseMapStyle, 'undefined');
  assert.equal(typeof load('main.ts', { obsidian }).VisualAgentMapView.prototype.chooseMapTone, 'undefined');
});
// The one-line note-style choice (T6 P2): "Note style: X", a button "Use another style this time", and a select that exists once opened.
const styleLine = root => findAll(find(root, i => hasCls(i, 'vam-style-choice-text')), i => i.text).map(i => i.text).join('');
const styleSelect = root => byLabel(root, 'Note style for this run');
const openStyle = root => { const toggle = button(root, 'Use another style this time'); assert.ok(toggle, 'the button that opens the choice'); toggle.click(); return styleSelect(root); };
const pick = (select, value) => { select.value = value; select.fire('change'); };
const noStyleKeys = request => { for (const key of ['noteStyle', 'detailTemplateId', 'toneId']) assert.equal(key in request, false, `${key} is not sent`); };
integrationTest('multi-select research dialog: the line says each topic keeps its own setting and sends no style until one is chosen for this batch; the choice goes out as noteStyle (was: the tone picker sent toneId; Q18, D2)', () => {
  const Modal = dom.makeModal();
  const { MultiResearchModal } = load('experiences/visual-map/multi-research-modal.ts', { obsidian: { ...obsidian, Modal } });
  const submitted = [];
  const models = { list: () => [], watch: () => () => {} };
  const modal = new MultiResearchModal({}, ['A', 'B'], models, request => submitted.push(request));
  modal.open();
  // The separate "Writing tone" select is gone: the tone comes with the chosen note style.
  assert.equal(byLabel(modal.contentEl, 'Writing tone'), undefined);
  assert.equal(styleLine(modal.contentEl), "Note style: Each topic's own setting");
  button(modal.modalEl, 'Start research (2)').click();
  noStyleKeys(submitted[0]);
  const second = new MultiResearchModal({}, ['A', 'B'], models, request => submitted.push(request));
  second.open(); pick(openStyle(second.contentEl), 'builtin:textbook'); button(second.modalEl, 'Start research (2)').click();
  assert.equal(submitted[1].noteStyle, 'builtin:textbook');
  assert.equal('toneId' in submitted[1], false); assert.equal('detailTemplateId' in submitted[1], false);
});
integrationTest('tone picker: the research dialog has no tone library link any more; the preset library (outline kind) still opens straight into the editor', () => {
  const Modal = dom.makeModal();
  const { MultiResearchModal } = load('experiences/visual-map/multi-research-modal.ts', { obsidian: { ...obsidian, Modal } });
  const models = { list: () => [], watch: () => () => {} };
  const modal = new MultiResearchModal({}, ['A', 'B'], models, () => {});
  modal.open();
  assert.equal(byLabel(modal.contentEl, 'Writing tone'), undefined, 'no tone select: the tone comes with the note style');
  assert.equal(button(modal.contentEl, 'Edit tones…'), undefined);
  const presets = load('ui/modals/prompt-presets-modal.ts', { obsidian: { ...obsidian, Modal } });
  const host = { settings: { language: 'en', promptPresets: [{ id: 'custom-1', kind: 'outline', name: 'Mine', text: 'Short and warm.' }] }, saveSettings: async () => {} };
  const library = new presets.PromptPresetsModal({}, host, () => {}, 'custom-1'); library.open();
  assert.equal(byLabel(library.contentEl, 'Preset instructions')?.value ?? findAll(library.contentEl, i => i.tag === 'textarea')[0].value, 'Short and warm.', 'opens straight into the editor');
});

integrationTest('style and model pickers: a style file with a problem offers Open this file, the chosen style has no edit link any more, the fix link checks the chosen model (was: the edit link opened the template; D3)', () => {
  const Modal = dom.makeModal();
  const { MultiResearchModal } = load('experiences/visual-map/multi-research-modal.ts', { obsidian: { ...obsidian, Modal } });
  const models = { list: () => [{ id: 'gpt-a', label: 'Codex · gpt-a' }], watch: () => () => {} };
  const opened = [], repaired = [];
  const part = name => ({ name });
  const recipes = [{ ref: 'file:Mine', kind: 'file', name: 'Mine', fileName: 'Mine.md', structure: part('Standard'), voice: part('Academic rigor'), format: part('Standard'), update: 'merge', issues: [] },
    { ref: 'file:Broken', kind: 'file', name: 'Broken', fileName: 'Broken.md', structure: part('Standard'), voice: part('Academic rigor'), format: part('Standard'), update: 'merge', issues: [{ line: 3, code: 'ui.detail_template_error_section_name_taken', values: [2], message: 'x' }] }];
  const styles = { refresh: async () => {}, recipes: () => recipes, openRecipe: async ref => { opened.push(ref); } };
  const modal = new MultiResearchModal({}, ['A', 'B'], models, () => {}, { repair: model => repaired.push(model), styles });
  modal.open();
  // The template and tone selects are gone, and so is "Edit this style": a problem row opens its file instead.
  assert.equal(byLabel(modal.contentEl, 'Content template'), undefined);
  assert.equal(button(modal.contentEl, 'Edit templates…'), undefined);
  assert.equal(button(modal.contentEl, 'Edit this style'), undefined);
  assert.equal(openStyle(modal.contentEl).children.length > 0, true);
  button(modal.contentEl, 'Open this file').click();
  assert.deepEqual(plain(opened), ['file:Broken'], 'the style file with the problem opens');
  byLabel(modal.contentEl, 'Model').value = 'gpt-a';
  button(modal.contentEl, 'Fix connection…').click();
  assert.deepEqual(repaired, ['gpt-a'], 'the fix link checks the chosen model');
  const bare = new MultiResearchModal({}, ['A'], models, () => {}); bare.open();
  assert.equal(button(bare.contentEl, 'Open this file'), undefined, 'no file link without a style folder');
  assert.equal(button(bare.contentEl, 'Fix connection…'), undefined);
});
// ---- Selection synthesis dialog harness (the only dialog left: NextStepModal(app, plugin, synthesize, selectionFlow)) ----
function nextStepHarness({ settings = {}, flow = {}, fields = {}, names = ['Child A', 'Child B'], language = 'en', synthesize, plugin: pluginOverrides = {} } = {}) {
  const notices = [];
  const Modal = dom.makeModal();
  const { NextStepModal, NoteStyleFileError } = load('tests/support-main-entry.ts', { obsidian: { ...obsidian, Modal, setIcon: () => {}, Notice: class { constructor(message) { notices.push(message); } hide() {} } } }, { createFragment: dom.createFragment });
  const sources = { mapSources: async () => [], synthesisTopics: names };
  const plugin = { settings: { codexUsageNoticeSeen: true, claudeUsageNoticeSeen: true, models: 'gpt-test', cliModel: 'gpt-test', cliReasoning: 'low', language, ...settings },
    aiReadyForModel: async () => true, confirmAiUsage: async (_model, run) => { await run(); return true; }, saveSettings: async () => {}, activeTasks: new Map(), availableModels: () => ['gpt-test'], modelLabel: model => model, ...pluginOverrides };
  const calls = { synthesize: [] };
  const selectionFlow = { names, initialTitle: 'Merged topic', defaultDirection: 'Find shared conclusions', fields: { sources, ...fields }, ...flow };
  const modal = new NextStepModal({}, plugin,
    synthesize ?? (async (options, direction, _failed, accepted) => { calls.synthesize.push({ options, direction }); accepted(); }), selectionFlow);
  modal.open();
  return { modal, plugin, notices, calls, flow: selectionFlow, sources, NoteStyleFileError };
}
// The run buttons sit in the dialog's action bar.
const skip = h => button(h.modal.modalEl, 'Skip suggestions and synthesize now');
const suggest = h => button(h.modal.modalEl, 'Get synthesis suggestions first');
const summaryOf = h => find(h.modal.contentEl, i => i.cls === 'vam-next-summary').text;

integrationTest('selection dialog: the tone comes with the chosen note style (no separate tone select) and reaches the run options as noteStyle, for this run only (was: toneId; Q18, D2)', async () => {
  const h = nextStepHarness({ fields: { currentStyle: 'Academic rigor' } });
  assert.equal(byLabel(h.modal.contentEl, 'Writing tone'), undefined, 'no separate tone select');
  assert.equal(button(h.modal.contentEl, 'Edit tones…'), undefined, 'no tone library link');
  pick(openStyle(h.modal.contentEl), 'builtin:textbook');
  assert.ok(find(h.modal.contentEl, i => hasCls(i, 'vam-next-source-summary') && /Textbook/.test(i.text)), 'the output summary names the chosen style');
  skip(h).click(); await tick(); await tick();
  assert.equal(h.calls.synthesize[0].options.noteStyle, 'builtin:textbook');
  assert.equal('toneId' in h.calls.synthesize[0].options, false); assert.equal('detailTemplateId' in h.calls.synthesize[0].options, false, 'the old keys are never sent');
  const keep = nextStepHarness({ fields: { currentStyle: 'Academic rigor' } });
  skip(keep).click(); await tick(); await tick();
  noStyleKeys(keep.calls.synthesize[0].options);
});
integrationTest('selection dialog: the answer language follows the map title and remembered choice, and a manual choice still wins and is remembered once', async () => {
  const selectOf = h => findAll(find(h.modal.contentEl, i => hasCls(i, 'vam-next-language')), i => i.tag === 'select')[0];
  const langOf = h => selectOf(h).value;
  assert.equal(langOf(nextStepHarness({ fields: { mapTitle: '要如何在陽台養香草' }, language: 'en' })), 'zh-TW', 'English UI + Chinese map title answers in Chinese');
  assert.equal(langOf(nextStepHarness({ fields: { mapTitle: 'Balcony herbs' }, language: 'zh-TW' })), 'zh-TW', 'an English map title decides nothing: the interface language is kept');
  assert.equal(langOf(nextStepHarness({ fields: { outputLanguage: 'ja', mapTitle: '要如何在陽台養香草' }, language: 'en' })), 'ja', 'the map\'s remembered choice comes first');
  const remembered = [];
  const manual = nextStepHarness({ fields: { mapTitle: '要如何在陽台養香草', rememberOutputLanguage: async value => { remembered.push(value); } }, language: 'en' });
  const select = selectOf(manual); select.value = 'en'; select.fire('change');
  assert.deepEqual(remembered, [], 'nothing is remembered before a run starts');
  skip(manual).click(); await tick(); await tick();
  assert.equal(manual.calls.synthesize[0].options.outputLanguage, 'en', 'the manual choice wins');
  assert.deepEqual(remembered, ['en']);
});
integrationTest('selection dialog: synthesis stays on the original local policy at standard depth with no images and stores no AI mode (D-2026-10-229, 243); there is no model, AI-mode or reasoning field', async () => {
  const h = nextStepHarness();
  for (const label of ['AI mode', 'Model', 'Reasoning level', 'Apply to']) assert.equal(byLabel(h.modal.contentEl, label), undefined, `${label} is not offered`);
  assert.match(summaryOf(h), /^Full content/);
  suggest(h).click(); await tick(); await tick();
  const options = h.calls.synthesize[0].options;
  assert.deepEqual(plain([options.researchMode, options.researchDepth, options.visualMode]), ['local', 'normal', 'off']);
  assert.equal('mapAiMode' in options, false, 'a synthesis never takes the Quick prompt text: it keeps research.local word for word');
  assert.equal('runOnce' in options, false, 'no run-once model is carried');
});
// ---- background runs: the dialog hides once AI starts (owner decision 2026-10-19) --------------------------------
const hookSpy = () => { const spy = { begins: [], ends: 0, completed: [], results: [], outlines: [] }; spy.hooks = { begin: controller => spy.begins.push(controller), end: () => { spy.ends++; }, completed: (kind, result) => { spy.completed.push(kind); spy.results.push(result); }, outlineReady: outline => spy.outlines.push(outline) }; return spy; };
integrationTest('background synthesis: the dialog hides only once the usage notice is confirmed; declining starts nothing and keeps it open', async () => {
  const gate = deferred();
  const h = nextStepHarness({ plugin: { confirmAiUsage: async (_m, run) => { await gate.promise; if (gate.decline) return false; await run(); return true; } } });
  suggest(h).click(); await tick(); await tick();
  assert.equal(h.modal.closeCount, 0, 'still open while the usage notice is unanswered');
  assert.equal(h.calls.synthesize.length, 0);
  gate.resolve(); await until(() => h.modal.closeCount === 1);
  assert.equal(h.calls.synthesize.length, 1);
  const declined = deferred(); declined.decline = true;
  const d = nextStepHarness({ plugin: { confirmAiUsage: async (_m, run) => { await declined.promise; if (declined.decline) return false; await run(); return true; } } });
  const press = suggest(d); press.click(); declined.resolve(); await tick(); await tick();
  assert.equal(d.modal.closeCount, 0, 'declining keeps the dialog open'); assert.equal(press.disabled, false);
  assert.equal(d.calls.synthesize.length, 0, 'nothing started');
});
// The sources belong to the map (toolbar panel); the task dialog has no data-source section, hint or text in any step.
const NO_SOURCE_SECTION = /vam-next-source-(?:details)|vam-reference-/;
const assertNoSourceSection = (root, where) => {
  assert.equal(findAll(root, i => NO_SOURCE_SECTION.test(i.cls ?? '')).length, 0, `${where}: no source section`);
  assert.equal(findAll(root, i => /Data sources|資料來源/.test(i.text ?? '')).length, 0, `${where}: no data-source text`);
  assert.equal(findAll(root, i => /選擇其他筆記|choose other notes|其他筆記來源|note source/i.test(i.text ?? '')).length, 0, `${where}: no hint to pick other notes or a note source`);
};
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
  const dialog = new multi.MultiResearchModal({}, ['A'], { list: () => [], watch: () => () => {} }, () => {}); dialog.open();
  assert.deepEqual(findAll(dialog.contentEl, i => i.tag === 'button' && i.attrs.role === 'radio').map(r => [r.text, r.attrs['aria-checked']]), [['Quick', 'true'], ['Standard', 'false']], 'multi-research shares the same widget (was: no mode choice of its own) and starts on Quick');
});
integrationTest('map stylesheet: the AI-mode choice uses JS-toggled classes, so no :has() is left on the map or the AI dialog', () => {
  const css = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', '..', 'styles.css'), 'utf8');
  const withHas = css.split('\n').filter(rule => rule.includes(':has('));
  assert.deepEqual(withHas.filter(rule => /\.vam-next|\.vam-depth|\.vam-workspace|\.vam-node|\.vam-canvas/.test(rule)), []);
  assert.match(css, /\.vam-ai-mode > button\.is-active \{/); assert.match(css, /\.vam-ai-mode > button:focus-visible/);
  assert.doesNotMatch(css, /vam-next-depth|vam-reference-network|vam-next-segmented/, 'the styles of the removed depth, network and guided-expansion controls are gone');
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
  const note = async () => repo.readNote(parent.path);
  const openSelection = async () => { const before = modals.length; view.selection.chatSelect(kids.map(k => k.id)); view.integrateSelected(); await until(() => modals.length === before + 1); return modals.at(-1); };
  return { openSelection, repo, app, view, plugin, doc, parent, kids, calls, notices, Notice, knobs, modals, hold, note, mapPath };
}
const untilAsync = async predicate => { for (let i = 0; i < 200; i++) { if (await predicate()) return; await new Promise(r => setImmediate(r)); } throw new Error('condition not reached'); };
const panelOf = (modal, index = 0) => findAll(modal.contentEl, i => hasCls(i, 'vam-next-research'))[index];
const barButton = (modal, text) => findAll(modal.modalEl, i => i.tag === 'button' && i.text === text && !hasCls(i, 'is-hidden'))[0];
const visibleBar = (modal, text) => { const b = button(modal.modalEl, text); return b && !b.hidden ? b : undefined; };
const statusOf = modal => panelOf(modal).querySelector('.vam-next-status').text;
// The Notices that carry a button (a finished background run), and pressing the one labelled `label`.
const actionNotices = h => h.Notice.all.filter(n => n.actions.length);
const pressNotice = (h, label) => { const action = h.Notice.all.flatMap(n => n.actions).find(b => b.text === label); assert.ok(action, `notice button ${label}`); action.click(); };

// Owner decision 2026-10-19: pressing a synthesis step hides the dialog once AI starts. The result returns as one Notice with
// a button plus the card badge; the same dialog reopens at its next stage and the review opens only on request.
integrationTest('selection synthesis: view close aborts a dialog run that is still starting', async () => {
  const h = await synthesisHarness();
  const modal = await h.openSelection();
  h.knobs.readGate = deferred();
  visibleBar(modal, 'Get synthesis suggestions first').click();
  await until(() => h.view.startingTasks.size === 1);
  const controller = [...h.view.startingTasks.values()][0];
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
integrationTest('research Notice: Re-run with Standard pressed after the view moved to another map does not run and asks to go back', async () => {
  const h = await synthesisHarness();
  const reruns = [];
  h.view.openDetails = () => {}; h.view.rerunStandard = node => reruns.push(node.id);
  const hooks = h.view.backgroundHooks(h.parent.path, h.parent);
  hooks.completed('research', { summary: 'S', detail: 'Model knowledge is insufficient.', suggestions: [], visualReferences: [] });
  const notice = actionNotices(h).at(-1);
  const before = h.notices.length, original = h.view.path;
  h.view.path = 'Maps/Other/Other.vam.json';
  notice.actions[1].click();
  assert.deepEqual(reruns, [], 'no run on the other map');
  assert.equal(h.notices.length, before + 1); assert.match(h.notices.at(-1), /Go back to the map this research ran on/);
  h.view.path = original;
  hooks.completed('research', { summary: 'S', detail: 'Model knowledge is insufficient.', suggestions: [], visualReferences: [] });
  actionNotices(h).at(-1).actions[1].click();
  assert.deepEqual(reruns, [h.parent.id], 'back on the original map the button runs');
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

// Fields that belong to the run itself: both dialogs must show exactly these (the name is the selection's own extra).
const fieldLabels = modal => findAll(modal.contentEl, i => ['select', 'textarea', 'input'].includes(i.tag) && i.type !== 'file' && i.type !== 'radio').map(i => i['aria-label'] ?? i.type ?? i.tag).filter(label => label !== 'New topic name' && label !== 'Model' && label !== 'Reasoning level' && label !== 'Apply to');
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
integrationTest('multi-select synthesis: the chosen style reaches the draft and the saved topic (was: the chosen content template; Q18, D2)', async () => {
  const h = await synthesisHarness();
  const section = (id, name) => ({ id, name, description: '', role: 'none', aliases: [] });
  // 06 P3: the user's own template is a template block (file:Brief), read from the Templates block folder.
  const { NoteStyleStore } = load('ai/note-style-store.ts');
  Object.assign(h.plugin.settings, { workspaceFolder: 'WS', noteStylesFolder: 'WS/S' });
  const dir = 'WS/S/Structures';
  // The style file Brief (structure: Brief) is chosen in the one-line choice; the template block Brief gives its sections.
  const port = { list: async folder => (folder === dir || folder === 'WS/S/Styles' ? ['Brief.md'] : []), read: async path => (path.includes('/Styles/') ? '---\nstructure: Brief\n---\n' : '## Key points\nThe main idea.\n\n## Further\nMore detail.\n'), folderExists: () => false, createFolder: async () => {}, create: async () => {}, trash: async () => {} };
  h.plugin.noteStyles = new NoteStyleStore({ settings: () => h.plugin.settings, port, save: async () => {} });
  await h.plugin.noteStyles.refresh();
  const modal = await h.openSelection();
  const name = byLabel(modal.contentEl, 'New topic name'); name.value = 'Cooking water'; name.input();
  // A style file is chosen in the one-line choice itself (was: a template block in the Note style select).
  pick(openStyle(modal.contentEl), 'file:Brief');
  visibleBar(modal, 'Skip suggestions and synthesize now').click();
  await untilAsync(async () => (await h.repo.readMap(h.mapPath)).nodes.length === 3 + 1);
  assert.equal(h.calls.at(-1).context.detailTemplate?.id, 'file:Brief', 'the draft is written for the chosen template');
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
integrationTest('05c: a selection synthesis refused by the run registry frees this view and its modal abort listener', async () => {
  const h = await synthesisHarness();
  const options = { researchMode: 'local', researchDepth: 'normal', visualMode: 'off', referenceGroups: [], synthesisTitle: 'T' };
  const real = h.view.plugin.topicRuns.start.bind(h.view.plugin.topicRuns);
  let refuseNext = true;
  h.view.plugin.topicRuns.start = (path, kind, o) => { if (refuseNext) { refuseNext = false; o.refused(); return Promise.resolve(); } return real(path, kind, o); };
  const listeners = new Set(); const modalSignal = { aborted: false, addEventListener: (_n, f) => listeners.add(f), removeEventListener: (_n, f) => listeners.delete(f) };
  const failures = [];
  await h.view.startSelectionSynthesis(h.kids, { ...options, signal: modalSignal }, null, m => failures.push(m), () => {});
  assert.equal(failures.length, 1); assert.equal(h.view.selectionStarting, false, 'a refused start does not keep the view blocked');
  assert.equal(listeners.size, 0, 'the modal abort listener is removed');
  const gate = h.hold();
  const again = h.view.startSelectionSynthesis(h.kids, options, null, m => failures.push(m), () => {});
  await until(() => h.calls.length === 1); gate.resolve(); await again;
  assert.equal(failures.length, 1, 'the same view starts again after the refusal'); assert.equal(h.view.integrationTask.state, 'directions');
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
  hooks.completed('research');
  assert.equal(h.notices.length, 0, 'no cross-map Notice');
});

// ---- Note style picker ------------------------------------------------------------------------------------------------
integrationTest('Next Step: the style line starts on "Note style: X" with the choice closed; opening lists Keep (X), then the built-ins and Mine; closing again sends nothing (was: the Note style select with five presets, hints and a Custom… entry; Q18, D3)', async () => {
  const part = name => ({ name });
  const recipe = (ref, name) => ({ ref, kind: ref.startsWith('file:') ? 'file' : 'builtin', name, ...(ref.startsWith('file:') ? { fileName: `${name}.md` } : {}), structure: part('Standard'), voice: part('Academic rigor'), format: part('Standard'), update: 'merge', issues: [] });
  const listed = [recipe('builtin:general', 'General research'), recipe('builtin:textbook', 'Textbook'), { ...recipe('builtin:aim', 'AIM report'), aimOnly: true }, recipe('file:Mine', 'Mine')];
  const plugin = { noteStyles: { refresh: async () => {}, listBlocks: () => [], listRecipes: () => listed, ensureBlockFile: async () => ({ path: 'x', base: 'Mine' }) } };
  const h = nextStepHarness({ fields: { currentStyle: 'General research' }, plugin });
  assert.equal(styleLine(h.modal.contentEl), 'Note style: General research');
  assert.equal(button(h.modal.contentEl, 'Use another style this time').attrs['aria-expanded'], 'false');
  const select = openStyle(h.modal.contentEl);
  assert.deepEqual(plain(findAll(select, o => o.tag === 'option').map(o => [o.value, o.text])), [['', 'Keep (General research)'], ['builtin:general', 'General research'], ['builtin:textbook', 'Textbook'], ['file:Mine', 'Mine']], 'the AIM report is never offered');
  pick(select, 'file:Mine');
  assert.equal(styleLine(h.modal.contentEl), 'Note style: Mine');
  assert.ok(find(h.modal.contentEl, i => hasCls(i, 'vam-next-source-summary') && /Mine/.test(i.text)), 'the output summary names the style');
  button(h.modal.contentEl, 'Go back to the original style').click();
  skip(h).click(); await tick(); await tick();
  noStyleKeys(h.calls.synthesize[0].options);
  const second = nextStepHarness({ fields: { currentStyle: 'General research' }, plugin });
  pick(openStyle(second.modal.contentEl), 'file:Mine');
  skip(second).click(); await tick(); await tick();
  assert.equal(second.calls.synthesize[0].options.noteStyle, 'file:Mine'); assert.equal('toneId' in second.calls.synthesize[0].options, false, 'no tone or template key is sent');
});
integrationTest('Next Step: an older topic setting shows as the X of the line, and the summary names it (was: the first option "Keep as is (Custom: …)")', () => {
  const h = nextStepHarness({ fields: { currentStyle: 'Old setting (Mine · Magazine column)' } });
  assert.equal(styleLine(h.modal.contentEl), 'Note style: Old setting (Mine · Magazine column)');
  assert.equal(styleSelect(h.modal.contentEl).children[0].text, 'Keep (Old setting (Mine · Magazine column))'); assert.equal(styleSelect(h.modal.contentEl).value, '');
  assert.equal(summaryOf(h).endsWith('Old setting (Mine · Magazine column)'), true, 'the summary names the style, not only the tone');
});
integrationTest('multi-select research dialog: one style line "Each topic\'s own setting"; a built-in sends noteStyle only (was: presets sent both values)', () => {
  const Modal = dom.makeModal();
  const { MultiResearchModal } = load('experiences/visual-map/multi-research-modal.ts', { obsidian: { ...obsidian, Modal } });
  const submitted = []; const models = { list: () => [], watch: () => () => {} };
  const modal = new MultiResearchModal({}, ['A', 'B'], models, request => submitted.push(request));
  modal.open();
  assert.equal(findAll(modal.contentEl, i => i.tag === 'select' && i['aria-label'] === 'Note style for this run').length, 1);
  assert.equal(styleSelect(modal.contentEl).children[0].text, "Keep (Each topic's own setting)");
  pick(openStyle(modal.contentEl), 'builtin:textbook'); button(modal.modalEl, 'Start research (2)').click();
  assert.equal(submitted[0].noteStyle, 'builtin:textbook'); assert.equal('detailTemplateId' in submitted[0], false); assert.equal('toneId' in submitted[0], false);
});
integrationTest('outline import dialog: the line says "Follow the topic type"; the style is sent only with quick research and is restored on reopen (was: "Follow default (Standard)" and detailTemplateId/toneId; Q18, #44)', async () => {
  const Modal = dom.makeModal();
  const { OutlineImportModal } = load('experiences/visual-map/outline-import-modal.ts', { obsidian: { ...obsidian, Modal } });
  const requests = [];
  const open = (shallowOn, value, prefill) => {
    const modal = new OutlineImportModal({ vault: { getMarkdownFiles: () => [] } }, async request => { requests.push(request); }, undefined, { map: 'none' }, 'tree');
    modal.open();
    if (value) pick(openStyle(modal.contentEl), value);
    const textarea = find(modal.contentEl, i => i.tag === 'textarea'); textarea.value = '# R\n## A'; textarea.fire('input');
    const shallow = find(modal.contentEl, i => i.tag === 'input' && i.type === 'checkbox'); shallow.checked = shallowOn; shallow.fire('change');
    button(modal.modalEl, 'Add to mind map').click();
    return { modal };
  };
  const first = open(false, 'builtin:textbook'); await tick();
  assert.equal(styleLine(first.modal.contentEl), 'Note style: Textbook');
  noStyleKeys(requests[0]);
  assert.equal(styleSelect(open(false).modal.contentEl).children[0].text, 'Keep (Follow the topic type)');
  open(true, 'builtin:textbook'); await tick();
  assert.equal(requests.at(-1).noteStyle, 'builtin:textbook'); assert.equal('toneId' in requests.at(-1), false); assert.equal('detailTemplateId' in requests.at(-1), false);
  open(true, 'builtin:evidence'); await tick();
  assert.equal(requests.at(-1).noteStyle, 'builtin:evidence');
  open(true, undefined); await tick();
  noStyleKeys(requests.at(-1));
});


// ---- B2-feat: integration from the chat (no dialog, the user's message is the direction) ---------------------------------
const NOT_UNDOABLE_TEXT = 'Undo takes back this reply’s changes, but not the AI work it started (research, expand, integrate, rating, merge, picture search); that work records its own undo step when it finishes. Once it writes to these cards, this reply can no longer be undone.';
const chatApply = async (h, actions, message, baseline = {}) => (await h.view.applyMapChatActions({ actions, rejected: [], message }, { mdHashes: {}, topicHashes: baseline })).filter(l => l.text !== NOT_UNDOABLE_TEXT);
const synth = (nodeIds, extra = {}) => ({ kind: 'run_map_action', action: 'synthesize', nodeIds, title: '', goal: '', direction: 'model words', mode: '', images: false, ...extra });
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
  h.view.selection.setSelected(h.parent.id);
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
  const ro = await synthesisHarness(); ro.view.map.aim = { kind: 'aim' };
  const skippedRo = await chatApply(ro, [synth([ro.parent.id])], 'x'); assert.deepEqual(plain(skippedRo.map(l => l.status)), ['skipped']); assert.equal(ro.calls.length, 0);
});
integrationTest('B2 synthesize (chat): the options equal what the integration dialog hands over when its fields are left alone (selection)', async () => {
  const selDialog = await synthesisHarness(); const selDialogSeen = spyOptions(selDialog);
  const selModal = await selDialog.openSelection(); visibleBar(selModal, 'Skip suggestions and synthesize now').click();
  await until(() => selDialogSeen.length === 1);
  const selChat = await synthesisHarness(); const selChatSeen = spyOptions(selChat);
  await chatApply(selChat, [synth(selChat.kids.map(k => k.id))], 'x'); await until(() => selChatSeen.length === 1);
  assert.deepEqual(selChatSeen[0].options, selDialogSeen[0].options, 'selection: same TaskOptions, including the new topic\'s default name');
  console.log('B2 integration default options (selection):', JSON.stringify(selChatSeen[0].options));
});

integrationTest('Next Step: a bad style file found after the dialog hid shows Open this file and never reaches the provider', async () => {
  const spy = hookSpy(); let opened = 0, askModel = 0;
  const h = nextStepHarness({ flow: { background: spy.hooks }, plugin: { askModel: () => { askModel++; } },
    synthesize: async function () { throw new h.NoteStyleFileError('The note style file "A.md" cannot be used (line 2): x', () => { opened++; }); } });
  suggest(h).click(); await until(() => h.notices.length);
  assert.equal(h.modal.closeCount, 1, 'the dialog had hidden');
  const shown = h.notices[h.notices.length - 1];
  assert.equal(typeof shown, 'object', 'a fragment with an action, not plain text');
  const open = findAll(shown, i => i.tag === 'button')[0];
  assert.equal(open.text, 'Open this file'); open.click(); assert.equal(opened, 1);
  assert.equal(askModel, 0, 'no provider call');
});

// ---- map-level data sources: AI provenance (C1-C6). The sources live in Map.md; every run reads them at its start. ----
const refs = load('ai/reference-materials.ts', { obsidian });
const SRC = { 'Solo/x.md': '# X\nunique-fact-file', 'Src/one.md': '# One\nunique-fact-one', 'Src/two.md': '# Two\nunique-fact-two',
  'Src/Archive/old.md': '---\nagent-map-node: true\n---\nunique-fact-archived', 'Other/a.md': '# A\nunique-fact-map-a', 'Other/b.md': '# B\nunique-fact-map-b' };
async function seedSources(h, list) {
  for (const folder of ['Solo', 'Src', 'Src/Archive', 'Other']) await h.app.vault.createFolder(folder);
  for (const [path, text] of Object.entries(SRC)) await h.app.vault.create(path, text);
  const nodes = ['Other/a.md', 'Other/b.md'].map((path, i) => ({ id: `o${i}`, parentId: null, path, x: 0, y: 0, collapsed: false }));
  await h.app.vault.create('Other/Map.md', core.serializeMap({ id: 'other-id', title: 'Other', version: 1, nodes, viewport: { x: 0, y: 0, zoom: 1 } }));
  await h.repo.writeMapSources(h.mapPath, list);
}
const ALL = [{ kind: 'file', path: 'Solo/x.md' }, { kind: 'folder', path: 'Src' }, { kind: 'map', path: 'Other/Map.md' }];
const doc = path => ({ path, content: SRC[path], external: false, key: path });
// What the old picker produced for the same picks: group ids, vault-relative documents, external false.
const OLD_PICKER = () => [
  { id: 'files:Solo/x.md', name: 'x.md', location: 'Solo/x.md', documents: [doc('Solo/x.md')] },
  { id: 'folder:Src', name: 'Src', location: 'Src', documents: [doc('Src/one.md'), doc('Src/two.md')] },
  { id: 'map:other-id', name: 'Other', location: 'Other/Map.md', documents: [doc('Other/a.md'), doc('Other/b.md')] }];
const sentText = call => JSON.stringify(call.context);
const startStage1 = async (h, modal) => { visibleBar(modal, 'Get synthesis suggestions first').click(); await until(() => h.calls.length === 1); return h.calls[0]; };
const MARKERS = ['unique-fact-file', 'unique-fact-one', 'unique-fact-two', 'unique-fact-map-a', 'unique-fact-map-b'];

integrationTest('C1/C5: a selection synthesis on a map with a file, a folder (with an archived managed note) and a map sends those 5 documents, as the old picker did', async () => {
  const h = await synthesisHarness();
  await seedSources(h, ALL);
  const modal = await h.openSelection();
  const groups = await h.view.taskSourceSettings().mapSources(new AbortController().signal);
  assert.equal(groups.flatMap(g => g.documents).length, 5);
  assert.ok(groups.flatMap(g => g.documents).every(d => d.external === false && !d.path.startsWith('/')));
  assert.deepEqual(plain(refs.referenceBatches(groups)), plain(refs.referenceBatches(OLD_PICKER())), 'referenceBatches equal the old picker baseline');
  assert.equal(refs.referenceCatalog(groups), refs.referenceCatalog(OLD_PICKER()));
  const call = await startStage1(h, modal);
  for (const marker of MARKERS) assert.ok(sentText(call).includes(marker), `${marker} reaches the request`);
  assert.equal(sentText(call).includes('unique-fact-archived'), false, 'the archived managed note is left out');
});

integrationTest('C5: a selection synthesis (merge) on the same map gets the same sources', async () => {
  const h = await synthesisHarness();
  await seedSources(h, ALL);
  const modal = await h.openSelection();
  const call = await startStage1(h, modal);
  for (const marker of MARKERS) assert.ok(sentText(call).includes(marker), `${marker} reaches the merge request`);
});

integrationTest('C2: a deleted source is skipped and the task still runs on the rest, with no dialog text about it', async () => {
  const h = await synthesisHarness();
  await seedSources(h, [...ALL, { kind: 'file', path: 'Gone/missing.md' }]);
  const modal = await h.openSelection();
  const call = await startStage1(h, modal);
  for (const marker of MARKERS) assert.ok(sentText(call).includes(marker));
  assert.equal(findAll(modal.contentEl, i => /read|unreadable|missing|skipped|讀不到/i.test(i.text ?? '') && hasCls(i, 'vam-next-status')).length, 0);
  assertNoSourceSection(modal.contentEl, 'unreadable source');
});

integrationTest('C2/C6: all sources unreadable, or no map-sources key, behaves like no sources: the run still starts with no source text', async () => {
  for (const list of [[{ kind: 'file', path: 'Gone/a.md' }, { kind: 'folder', path: 'Gone' }, { kind: 'map', path: 'Gone/Map.md' }], []]) {
    const h = await synthesisHarness();
    await h.repo.writeMapSources(h.mapPath, list);
    const groups = await h.view.taskSourceSettings().mapSources(new AbortController().signal);
    assert.deepEqual(plain(groups), []);
    const modal = await h.openSelection();
    const call = await startStage1(h, modal);
    assert.equal(MARKERS.some(m => sentText(call).includes(m)), false);
  }
});

integrationTest('C3: a map source equal to the current map is not sent', async () => {
  const h = await synthesisHarness();
  await seedSources(h, [{ kind: 'map', path: h.mapPath }, { kind: 'file', path: 'Solo/x.md' }]);
  const groups = await h.view.taskSourceSettings().mapSources(new AbortController().signal);
  assert.deepEqual(plain(groups.map(g => g.id)), ['files:Solo/x.md']);
});

integrationTest('C4: the sources are read once per press and the same groups reach the synthesis run', async () => {
  let reads = 0; const snapshot = [{ id: 'files:a.md', name: 'a.md', location: 'a.md', documents: [doc('Solo/x.md')] }];
  const h = nextStepHarness({ fields: { sources: { mapSources: async () => { reads++; return snapshot; }, synthesisTopics: [] } } });
  suggest(h).click(); await tick(); await tick(); await tick();
  assert.equal(reads, 1, 'read once, at the press');
  assert.equal(h.calls.synthesize[0].options.referenceGroups, snapshot, 'the synthesis gets the snapshot');
});

integrationTest('aborting while the sources are being read sends no request', async () => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const h = nextStepHarness({ fields: { sources: { mapSources: async () => { await gate; return []; }, synthesisTopics: [] } } });
  suggest(h).click(); await tick();
  assert.ok(h.modal.taskController, 'a run is waiting for its sources'); h.modal.taskController.abort(); // what the Cancel button does
  release(); await tick(); await tick(); await tick();
  assert.equal(h.calls.synthesize.length, 0, 'no request was sent after Cancel');
});
