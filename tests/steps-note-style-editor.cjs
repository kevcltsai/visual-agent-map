// Note style recipe T5 P4 and settings-redesign P4: the style editor window (NoteStyleEditorModal) over a real store on an in-memory vault, with the prompt preview it opens.
// Unit level (a DOM stand-in, fake timers, a fake Markdown renderer); the real window is checked by the UI harness.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const S = require('./support.cjs');
const dom = require('./support-dom.cjs');
const { loadSource } = require('./support-replay.cjs');

const M = loadSource(`
export * from "./ai/note-style-recipe";
export { NoteStyleStore } from "./ai/note-style-store";
export { translate } from "./i18n";
export * from "./ai/note-style-structure-edit";
export { parseTemplateBlock } from "./core/blocks/template-block";
`);
const LANGUAGES = ['zh-TW', 'zh-CN', 'en'];
const plain = value => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
const ROOT = 'WS/S';
const dirOf = (language, role) => `${ROOT}/${M.translate(language, `ui.style_folder_${role}`)}`;

/** An in-memory vault that records every write; `create` never overwrites, `modify` needs an existing file. */
function vault(files = {}) {
  const state = { files: { ...files }, folders: new Set(), creates: [], modifies: [], folderCalls: 0, trashes: 0 };
  const under = folder => Object.keys(state.files).filter(file => file.startsWith(`${folder}/`) && !file.slice(folder.length + 1).includes('/'));
  state.port = {
    list: async folder => under(folder).map(file => file.slice(folder.length + 1)).filter(name => name.endsWith('.md')),
    read: async file => { if (!(file in state.files)) throw new Error(file); return state.files[file]; },
    folderExists: folder => state.folders.has(folder) || Object.keys(state.files).some(file => file.startsWith(`${folder}/`)),
    createFolder: async folder => { state.folderCalls++; state.folders.add(folder); },
    create: async (file, content) => {
      if (Object.keys(state.files).some(existing => existing.toLowerCase() === file.toLowerCase())) throw new Error(`exists: ${file}`);
      state.files[file] = content; state.creates.push(file);
    },
    modify: async (file, content) => { if (!(file in state.files)) throw new Error(file); state.files[file] = content; state.modifies.push(file); },
    trash: async file => { state.trashes++; delete state.files[file]; }
  };
  return state;
}
const writes = v => v.creates.length + v.modifies.length + v.folderCalls + v.trashes;

// ---- the stand-ins ----
const notices = [];
const windows = [];
const events = [];
const renders = [];
const renderOwners = [];
const timers = [];
let timerId = 0;
const fakeSetTimeout = (fn, ms) => { const id = ++timerId; timers.push({ id, fn, ms }); return id; };
const fakeClearTimeout = id => { const at = timers.findIndex(timer => timer.id === id); if (at >= 0) timers.splice(at, 1); };
const counts = { loads: 0, unloads: 0, added: 0, removed: 0 };
/** A component with children: addChild / removeChild are counted apart from the window's own load / unload. */
class FakeComponent {
  constructor() { this.children = new Set(); }
  load() { counts.loads++; }
  unload() { counts.unloads++; }
  addChild(child) { this.children.add(child); counts.added++; return child; }
  removeChild(child) { if (this.children.delete(child)) counts.removed++; return child; }
}
const BaseModal = dom.makeModal();
class RecordingModal extends BaseModal { open() { windows.push(this); events.push(`open:${this.constructor.name}`); super.open(); } }
class FakeSetting {
  constructor(container) {
    this.settingEl = container.createDiv('setting-item');
    this.nameEl = this.settingEl.createDiv('setting-item-name');
    this.descEl = this.settingEl.createDiv('setting-item-description');
    this.controlEl = this.settingEl.createDiv('setting-item-control');
  }
  setName(name) { this.nameEl.setText(name); return this; }
  setDesc(text) { this.descEl.setText(text); return this; }
  addButton(build) {
    const el = this.controlEl.createEl('button');
    const component = { buttonEl: el, setButtonText(text) { el.setText(text); return component; }, onClick(fn) { el.addEventListener('click', fn); return component; }, setCta() { return component; }, setDestructive() { return component; }, setDisabled(value) { el.disabled = value; return component; } };
    build(component);
    return this;
  }
  addDropdown(build) {
    const el = this.controlEl.createEl('select');
    const component = { selectEl: el, onChange(fn) { el.addEventListener('change', () => fn(el.value)); return component; } };
    build(component);
    return this;
  }
  addText(build) {
    const el = this.controlEl.createEl('input', { type: 'text' });
    const component = { inputEl: el, onChange(fn) { el.addEventListener('input', () => fn(el.value)); return component; } };
    build(component);
    return this;
  }
}
const obsidian = {
  ...S.obsidian, Modal: RecordingModal, Setting: FakeSetting, Notice: dom.makeNotice(notices), Component: FakeComponent,
  MarkdownRenderer: { render: async (app, markdown, host, path, component) => { renders.push(markdown); renderOwners.push(component); host.createDiv({ text: markdown }); } }
};
const windowValues = { setTimeout: fakeSetTimeout, clearTimeout: fakeClearTimeout };
const { NoteStyleEditorModal } = S.load('ui/modals/note-style-editor-modal.ts', { obsidian }, windowValues);
const { PromptPreviewModal } = S.load('ui/modals/prompt-preview-modal.ts', { obsidian }, windowValues);
const { default: Plugin } = S.load('main.ts', { obsidian }, { createFragment: dom.createFragment });

const flush = () => new Promise(resolve => setImmediate(resolve));
const settle = async () => { for (let n = 0; n < 8; n++) await flush(); };
/** Runs the timers that are waiting (the 200ms redraw), then lets the redraw finish. */
const runTimers = async () => { for (const timer of timers.splice(0)) timer.fn(); await settle(); };

/** A plugin over a real store. `touched` lists every other member of the plugin the editor reached for (AI, for one). */
async function editorSetup(files = {}, settingsPatch = {}) {
  const v = vault(files);
  const settings = { detailTemplates: [], workspaceFolder: 'WS', noteStylesFolder: ROOT, language: 'en', ...settingsPatch };
  const made = { settingSaves: 0 };
  const store = new M.NoteStyleStore({ settings: () => settings, port: v.port, save: async () => { made.settingSaves++; } });
  const realRefresh = store.refresh.bind(store);
  store.refresh = async () => { events.push('refresh'); await realRefresh(); events.push('refreshed'); };
  await realRefresh();
  notices.length = 0; windows.length = 0; events.length = 0; renders.length = 0; renderOwners.length = 0; timers.length = 0; counts.loads = 0; counts.unloads = 0; counts.added = 0; counts.removed = 0;
  const opened = [];
  const app = {
    vault: { getAbstractFileByPath: path => (path in v.files ? new S.TFile(path) : null) },
    workspace: { getLeaf: () => ({ openFile: async file => { opened.push(file.path); } }) }
  };
  const base = { app, settings, noteStyles: store, saveSettings: async () => { made.settingSaves++; } };
  base.editNotePart = (...args) => Plugin.prototype.editNotePart.apply(base, args);
  base.saveNoteRecipe = (...args) => Plugin.prototype.saveNoteRecipe.apply(base, args);
  base.setKindStyle = (...args) => Plugin.prototype.setKindStyle.apply(base, args);
  base.setGlobalPart = (...args) => Plugin.prototype.setGlobalPart.apply(base, args);
  base.openPromptPreview = (trigger, styleOf) => new PromptPreviewModal(app, store, 'en', 'codex', trigger, styleOf).open();
  const touched = [];
  const members = new Set(Object.keys(base));
  const plugin = new Proxy(base, { get: (target, key) => { if (typeof key === 'string' && !members.has(key)) touched.push(key); return target[key]; } });
  return { v, store, settings, plugin, app, opened, touched, made };
}
const RECIPE_DIR = dirOf('en', 'recipe');
const STRUCTURE_DIR = dirOf('en', 'template');
const VOICE_DIR = dirOf('en', 'tone');
const FORMAT_DIR = dirOf('en', 'format');
const WEEKLY = `${RECIPE_DIR}/Weekly.md`;
const WEEKLY_TEXT = '---\nstructure: Mine\nvoice: plain\nformat: Standard format\nupdate: top\ntags: [a]\n---\nWeekly notes\n';
const SEED = { [`${STRUCTURE_DIR}/Mine.md`]: '## A\nx\n', [WEEKLY]: WEEKLY_TEXT };

// ---- helpers for the section list, the voice chips and the apply-to-all box ----
function openEditor(setup, options = {}) {
  const trigger = dom.element('button');
  const saved = [];
  const editor = new NoteStyleEditorModal(setup.app, setup.plugin, { source: null, trigger, onSaved: ref => saved.push(ref), ...options });
  editor.open();
  return { editor, trigger, saved, root: editor.modalEl, content: editor.contentEl };
}
const byLabel = (root, label) => dom.byLabel(root, label);
const nameOf = ed => byLabel(ed.content, 'Name');
const saveOf = ed => dom.button(ed.root, 'Save');
const errorOf = ed => dom.find(ed.content, node => node.attrs.id === 'vam-editor-error');
const typeName = (ed, value) => { const input = nameOf(ed); input.value = value; input.fire('input'); };
const radio = (ed, mode) => dom.find(ed.content, node => node.attrs.id === `vam-editor-update-${mode}`);
const pickUpdate = (ed, mode) => { for (const m of ['merge', 'top', 'fresh']) radio(ed, m).checked = m === mode; radio(ed, mode).fire('change'); };
const previewTexts = () => { const modal = windows.find(w => w.titleEl.text === 'AI instructions preview'); return modal ? dom.texts(modal.contentEl).join('\n') : ''; };
const nameInputs = ed => dom.findAll(ed.content, node => dom.hasCls(node, 'vam-editor-section-name'));
const sectionNames = ed => nameInputs(ed).map(node => node.value);
const renameSection = (ed, index, value) => { const input = nameInputs(ed)[index]; input.value = value; input.fire('input'); };
const rowButton = (ed, index, kind) => dom.findAll(ed.content, node => dom.hasCls(node, `vam-editor-section-${kind}`))[index];
const addSection = ed => dom.button(ed.content, `＋ ${M.translate('en', 'ui.editor_section_add')}`).click();
const VOICE_NAME = { academic: M.translate('en', 'ui.preset_name_academic'), plain: M.translate('en', 'ui.preset_name_plain'), magazine: M.translate('en', 'ui.preset_name_magazine'), 'picture-book': M.translate('en', 'ui.preset_name_picture_book') };
const chip = (ed, id) => dom.find(ed.content, node => node.attrs.role === 'radio' && node.text === VOICE_NAME[id]);
const pickVoice = (ed, id) => chip(ed, id).click();
const checkedVoice = ed => dom.findAll(ed.content, node => node.attrs.role === 'radio' && node.attrs['aria-checked'] === 'true').map(node => node.text);
const sampleOf = ed => dom.find(ed.content, node => dom.hasCls(node, 'vam-style-sample'));
const applyAllOf = ed => dom.find(ed.root, node => node.attrs.id === 'vam-editor-apply-all');
const setApplyAll = (ed, on) => { applyAllOf(ed).checked = on; applyAllOf(ed).fire('change'); };
const sampleText = id => M.translate('en', `ui.note_style_sample_${id.replace('-', '_')}`);
const recipeText = parts => M.recipeFileText({ structure: 'builtin:standard', voice: null, format: null, update: 'merge', ...parts }, 'en');
const STRUCT_SRC = '%% about this part %%\n## Alpha\nDescribe alpha.\n\n## Beta\nCount: 2\nDescribe beta\n%% hidden note %%\n\n## Gamma\nGamma words\n';
const OWN_STRUCT = `${STRUCTURE_DIR}/Own.md`;
const OWN = `${RECIPE_DIR}/Own.md`;
const OWN_SEED = { [OWN_STRUCT]: STRUCT_SRC, [OWN]: recipeText({ structure: 'file:Own', update: 'top' }) };

test('F1 R1 (security, was failing first): a part file\'s section names and descriptions, and the names of the voice and format, reach the renderer with every ASCII punctuation character escaped - no link, tag, wiki link, HTML or highlight can be made', async () => {
  const hostile = ['https://x.test/a', 'a@b.co', '[[x]]', '<b>y</b>', '==z==', '+ plus', '![i](u)', '1. n', '~~s~~', '$m$', '|p|', '> q'];
  const part = words => words.map((word, n) => `## S${n} ${word}\n${word} desc\n`).join('\n');
  const setup = await editorSetup({
    ...SEED,
    [`${STRUCTURE_DIR}/Hostile.md`]: part(hostile.slice(0, 6)), [`${STRUCTURE_DIR}/Hostile2.md`]: part(hostile.slice(6)),
    [`${VOICE_DIR}/Odd _v_ @a.md`]: 'x\n', [`${FORMAT_DIR}/Odd _f_ @g.md`]: 'x\n',
    [`${RECIPE_DIR}/Hostile.md`]: recipeText({ structure: 'file:Hostile', voice: 'file:Odd _v_ @a', format: 'file:Odd _f_ @g' }),
    [`${RECIPE_DIR}/Hostile2.md`]: recipeText({ structure: 'file:Hostile2', voice: 'file:Odd _v_ @a', format: 'file:Odd _f_ @g' })
  });
  const escape = value => value.replace(/\s+/g, ' ').trim().replace(/[!-\/:-@[-`{-~]/g, '\\$&');
  for (const [source, words] of [['file:Hostile', hostile.slice(0, 6)], ['file:Hostile2', hostile.slice(6)]]) {
    const ed = openEditor(setup, { source });
    await settle();
    await runTimers();
    const markdown = renders.at(-1);
    const headings = markdown.split('\n').filter(line => line.startsWith('## '));
    assert.equal(headings.length, words.length);
    words.forEach((word, n) => assert.equal(headings[n], `## ${escape(`S${n} ${word}`)}`, word));
    // no ASCII punctuation survives unescaped in the text a part file supplied
    for (const line of markdown.split('\n')) {
      if (/^(> \[!note\]|>|\| )/.test(line) && !/S\d/.test(line)) continue;
      if (line === '' || line === '| --- | --- |' || line.startsWith('- ') || line.startsWith('*')) continue;
      assert.equal(/[!-\/:-@[-`{-~]/.test(line.replace(/\\[!-\/:-@[-`{-~]/g, '').replace(/^(## |> \[!note\] |> |\*|\| )/, '')), false, line);
    }
    assert.ok(markdown.includes('Odd \\_v\\_ \\@a'), 'the voice name is escaped too');
    assert.ok(markdown.includes('Odd \\_f\\_ \\@g'), 'the format name is escaped too');
    // a section name typed in the editor is plain text too
    renameSection(ed, 0, '[[typed]] <i>x</i>');
    await runTimers();
    assert.ok(renders.at(-1).split('\n').includes('## ' + escape('[[typed]] <i>x</i>')));
  }
});

test('F1 R4: every redraw of the sample uses its own child component and the one it replaces is removed, so the children do not pile up; closing unloads the window\'s component', async () => {
  const setup = await editorSetup(SEED);
  const ed = openEditor(setup, { source: null, name: 'Sample' });
  await settle();
  const live = () => counts.added - counts.removed;
  assert.equal(live(), 1);
  for (let n = 0; n < 6; n++) {
    pickVoice(ed, n % 2 ? 'plain' : 'magazine');
    await runTimers();
  }
  assert.equal(renders.length, 7);
  assert.equal(live(), 1, 'one child holds the sample on screen');
  assert.equal(new Set(renderOwners).size, 7, 'each picture had its own child');
  assert.ok(renderOwners.every(owner => owner.load !== undefined));
});

test('counter 1: opening the editor (new, on a built-in style, on a file), changing every control (rename, add, move and delete a section, the voice, the update mode, "also use it"), opening the preview and cancelling write nothing and change no setting; the editor reaches for nothing but the store, the save, the global voice and the preview', async () => {
  for (const source of [null, 'builtin:hypothesis', 'file:Weekly', 'file:Own']) {
    const setup = await editorSetup({ ...SEED, ...OWN_SEED });
    const before = JSON.stringify(setup.settings);
    const ed = openEditor(setup, { source });
    await settle();
    renameSection(ed, 0, 'Renamed first');
    addSection(ed);
    rowButton(ed, 0, 'down').click();
    rowButton(ed, 1, 'remove').click();
    pickVoice(ed, 'magazine');
    pickUpdate(ed, 'fresh');
    setApplyAll(ed, true);
    dom.button(ed.root, 'Preview AI instructions').click();
    await settle();
    await runTimers();
    dom.button(ed.root, 'Cancel').click();
    const discard = dom.button(windows.at(-1).modalEl, 'Discard changes');
    discard.click();
    await settle();
    assert.equal(ed.editor.closeCount >= 1, true);
    assert.equal(writes(setup.v), 0, String(source));
    assert.equal(setup.made.settingSaves, 0);
    assert.equal(JSON.stringify(setup.settings), before);
    assert.deepEqual(setup.touched, [], 'no AI, no run: only the members the plugin double lists');
    assert.equal(setup.opened.length, 0);
  }
});

test('P4 acceptance (was failing first): editing a built-in style - sections, voice, "also use it" - and pressing Cancel leaves no file and no setting behind, and the editor never opens a file', async () => {
  const setup = await editorSetup(SEED);
  const before = JSON.stringify(setup.settings);
  const ed = openEditor(setup, { source: 'builtin:general', name: 'My General' });
  await settle();
  assert.equal(dom.findAll(ed.content, node => node.tag === 'button' && node.text === 'Edit').length, 0, 'no per-part Edit button is left');
  renameSection(ed, 0, 'Mine first');
  addSection(ed);
  pickVoice(ed, 'plain');
  setApplyAll(ed, true);
  dom.button(ed.root, 'Cancel').click();
  dom.button(windows.filter(w => w.titleEl.text === 'Discard changes?').at(-1).modalEl, 'Discard changes').click();
  await settle();
  assert.deepEqual(setup.v.creates, []);
  assert.equal(writes(setup.v), 0);
  assert.equal(JSON.stringify(setup.settings), before);
  assert.equal(setup.made.settingSaves, 0);
  assert.deepEqual(setup.opened, []);
  assert.equal(ed.editor.closeCount, 1);
});

test('counter 2 (data, was failing first): another program changed the style file after the editor opened it - Save writes nothing, the file keeps the other program\'s bytes, the window stays open and says so', async () => {
  const setup = await editorSetup(SEED);
  const ed = openEditor(setup, { source: 'file:Weekly' });
  await settle();
  const external = `${WEEKLY_TEXT}changed outside\n`;
  setup.v.files[WEEKLY] = external;
  pickUpdate(ed, 'fresh');
  saveOf(ed).click();
  await settle();
  assert.equal(setup.v.files[WEEKLY], external);
  assert.deepEqual(setup.v.modifies, []);
  assert.equal(ed.editor.closeCount, 0, 'the window stays open');
  assert.deepEqual(ed.saved, []);
  assert.deepEqual(notices, [M.translate('en', 'ui.recipe_notice_changed')]);
  // an unchanged file is changed in place: only the changed value, every other line keeps its bytes (the voice and format keys it had stay)
  const ok = await editorSetup(SEED);
  const edOk = openEditor(ok, { source: 'file:Weekly' });
  await settle();
  pickUpdate(edOk, 'fresh');
  saveOf(edOk).click();
  await settle();
  assert.deepEqual(ok.v.modifies, [WEEKLY]);
  assert.equal(ok.v.files[WEEKLY], WEEKLY_TEXT.replace('update: top', 'update: fresh'));
  const read = M.parseRecipeFile(ok.v.files[WEEKLY]);
  assert.deepEqual(plain({ update: read.update, voice: read.voice, voiceSet: read.voiceSet, format: read.format, formatSet: read.formatSet }), { update: 'fresh', voice: 'builtin:plain', voiceSet: true, format: 'builtin:standard', formatSet: true });
  assert.deepEqual(ed.saved.length + edOk.saved.length, 1);
  assert.equal(edOk.saved[0], 'file:Weekly');
  assert.equal(edOk.editor.closeCount, 1);
});

test('P4 (D5): Save of a new style from a built-in one writes the style file once - no structure file when the sections are as they were - with the update mode, the format the source fixes (Evidence is lean) and no voice key; it changes no topic type; a name taken meanwhile writes nothing', async () => {
  const setup = await editorSetup(SEED, { noteStyleByKind: { hypothesis: 'builtin:evidence' } });
  const ed = openEditor(setup, { source: null, from: 'builtin:evidence', name: 'Lab log' });
  await settle();
  assert.equal(writes(setup.v), 0);
  assert.equal(M.translate('en', 'ui.editor_title_new'), ed.editor.titleEl.text);
  pickUpdate(ed, 'top');
  saveOf(ed).click();
  await settle();
  const path = `${RECIPE_DIR}/Lab log.md`;
  assert.deepEqual(setup.v.creates, [path]);
  const read = M.parseRecipeFile(setup.v.files[path]);
  assert.deepEqual(plain({ structure: read.structure, voiceSet: read.voiceSet, format: read.format, formatSet: read.formatSet, update: read.update }), { structure: 'builtin:evidence', voiceSet: false, format: 'builtin:lean', formatSet: true, update: 'top' });
  assert.deepEqual(ed.saved, ['file:Lab log']);
  assert.equal(ed.editor.closeCount, 1);
  assert.equal(ed.trigger.focused, true, 'the focus goes back to the button that opened it');
  assert.equal(setup.made.settingSaves, 0);
  assert.deepEqual(plain(setup.settings.noteStyleByKind), { hypothesis: 'builtin:evidence' });
  // taken by another program after the editor opened: no overwrite
  const late = openEditor(setup, { source: null, name: 'Late' });
  await settle();
  setup.v.files[`${RECIPE_DIR}/Late.md`] = 'mine\n';
  saveOf(late).click();
  await settle();
  assert.equal(setup.v.files[`${RECIPE_DIR}/Late.md`], 'mine\n');
  assert.equal(late.editor.closeCount, 0);
  assert.notEqual(errorOf(late).text, '');
});

test('A4: section names as they were - also after a rename that is renamed back, or two moves that cancel out - point the style back at the original structure and create no structure file', async () => {
  const setup = await editorSetup({ ...SEED, ...OWN_SEED });
  const ed = openEditor(setup, { source: 'builtin:general', name: 'My G' });
  await settle();
  const first = sectionNames(ed)[0];
  renameSection(ed, 0, 'Temporary');
  renameSection(ed, 0, first);
  rowButton(ed, 0, 'down').click();
  rowButton(ed, 1, 'up').click();
  saveOf(ed).click();
  await settle();
  assert.deepEqual(setup.v.creates, [`${RECIPE_DIR}/My G.md`]);
  assert.equal(M.parseRecipeFile(setup.v.files[`${RECIPE_DIR}/My G.md`]).structure, 'builtin:standard');
  // a file style whose structure is a file: nothing is written for the structure either
  const own = openEditor(setup, { source: 'file:Own' });
  await settle();
  pickUpdate(own, 'merge');
  saveOf(own).click();
  await settle();
  assert.equal(setup.v.files[OWN_STRUCT], STRUCT_SRC);
  assert.equal(setup.v.modifies.includes(OWN_STRUCT), false);
});

test('M1 (was failing first): a structure file only this style uses, but that the 0.29.0 legacy table still points at (detail-template t1), is not rewritten; the edit goes to a new file named like the style', async () => {
  const setup = await editorSetup(OWN_SEED, { noteStyleRecipe: { migrated: 1, legacy: { templates: { t1: 'file:Own' }, tones: {} } } });
  const ed = openEditor(setup, { source: 'file:Own' });
  await settle();
  renameSection(ed, 0, 'Alpha 2');
  saveOf(ed).click();
  await settle();
  assert.equal(setup.v.files[OWN_STRUCT], OWN_SEED[OWN_STRUCT], 'the old structure file keeps its bytes');
  assert.deepEqual(setup.v.modifies.filter(file => file === OWN_STRUCT), []);
  assert.equal(setup.v.creates.length, 1);
  assert.notEqual(M.parseRecipeFile(setup.v.files[OWN]).structure, 'file:Own');
  assert.equal(setup.settings.noteStyleRecipe.legacy.templates.t1, 'file:Own');
});

test('A4: changed sections of a built-in or shared structure become a new structure file named like the style; the original lines (descriptions, the Count line, comments) travel with their sections, a new section has an empty description, a deleted one is gone, and nothing else is written', async () => {
  const shared = { ...OWN_SEED, [`${RECIPE_DIR}/Other.md`]: recipeText({ structure: 'file:Own' }) };
  // a shared structure file is not changed: the style that edits it gets a copy named like itself
  const setup = await editorSetup(shared);
  const ed = openEditor(setup, { source: 'file:Own' });
  await settle();
  assert.deepEqual(sectionNames(ed), ['Alpha', 'Beta', 'Gamma']);
  renameSection(ed, 0, 'Alpha 2');
  rowButton(ed, 2, 'remove').click();
  addSection(ed);
  rowButton(ed, 2, 'up').click();
  assert.deepEqual(sectionNames(ed), ['Alpha 2', 'New section 1', 'Beta']);
  assert.equal(writes(setup.v), 0, 'nothing is written before Save');
  saveOf(ed).click();
  await settle();
  assert.deepEqual(setup.v.creates, [`${STRUCTURE_DIR}/Own (2).md`], 'the name "Own" is taken by the shared file, so " (2)"');
  assert.equal(setup.v.files[OWN_STRUCT], STRUCT_SRC, 'the shared structure keeps its bytes');
  assert.equal(setup.v.files[`${STRUCTURE_DIR}/Own (2).md`], '%% about this part %%\n\n## Alpha 2\nDescribe alpha.\n\n## New section 1\n\n## Beta\nCount: 2\nDescribe beta\n%% hidden note %%\n');
  assert.equal(M.parseRecipeFile(setup.v.files[OWN]).structure, 'file:Own (2)');
  assert.equal(M.parseRecipeFile(setup.v.files[`${RECIPE_DIR}/Other.md`]).structure, 'file:Own');
  const parsed = M.parseTemplateBlock(setup.v.files[`${STRUCTURE_DIR}/Own (2).md`], { id: 'x', name: 'x' });
  assert.equal(parsed.ok, true);
  assert.deepEqual(plain(parsed.template.sections.map(section => [section.name, section.description, section.count?.n ?? null])), [['Alpha 2', 'Describe alpha.', null], ['New section 1', '', null], ['Beta', 'Describe beta', 2]]);
  // a new style from a built-in one: the new structure file is named like the new style, written before the style file
  const fresh = await editorSetup(SEED);
  const edNew = openEditor(fresh, { source: null, from: 'builtin:general', name: 'Lab log' });
  await settle();
  const original = sectionNames(edNew);
  renameSection(edNew, 1, 'Mechanism');
  saveOf(edNew).click();
  await settle();
  assert.deepEqual(fresh.v.creates, [`${STRUCTURE_DIR}/Lab log.md`, `${RECIPE_DIR}/Lab log.md`]);
  assert.equal(M.parseRecipeFile(fresh.v.files[`${RECIPE_DIR}/Lab log.md`]).structure, 'file:Lab log');
  const copy = M.parseTemplateBlock(fresh.v.files[`${STRUCTURE_DIR}/Lab log.md`], { id: 'x', name: 'x' });
  assert.equal(copy.ok, true);
  assert.deepEqual(plain(copy.template.sections.map(section => section.name)), original.map((name, n) => (n === 1 ? 'Mechanism' : name)));
  assert.equal(copy.template.sections.every(section => section.description), true, 'the original descriptions stay');
  assert.equal(fresh.v.modifies.length, 0);
  assert.deepEqual(fresh.opened, []);
});

test('A4: a structure file only this style uses is changed in place - lines, Count and comments kept - after the file is re-read and found as it was; if another program changed it meanwhile nothing is written', async () => {
  const setup = await editorSetup(OWN_SEED);
  const ed = openEditor(setup, { source: 'file:Own' });
  await settle();
  renameSection(ed, 0, 'Alpha 2');
  rowButton(ed, 2, 'remove').click();
  addSection(ed);
  saveOf(ed).click();
  await settle();
  assert.deepEqual(setup.v.creates, []);
  assert.deepEqual(setup.v.modifies, [OWN_STRUCT]);
  assert.equal(setup.v.files[OWN_STRUCT], '%% about this part %%\n\n## Alpha 2\nDescribe alpha.\n\n## Beta\nCount: 2\nDescribe beta\n%% hidden note %%\n\n## New section 1\n');
  assert.equal(M.parseRecipeFile(setup.v.files[OWN]).structure, 'file:Own', 'the style still points at the same file');
  assert.equal(ed.editor.closeCount, 1);
  assert.deepEqual(setup.opened, []);
  // the file was changed outside after the editor read it
  const late = await editorSetup(OWN_SEED);
  const edLate = openEditor(late, { source: 'file:Own' });
  await settle();
  renameSection(edLate, 0, 'Mine');
  const outside = `${STRUCT_SRC}## Added elsewhere\n`;
  late.v.files[OWN_STRUCT] = outside;
  saveOf(edLate).click();
  await settle();
  assert.equal(late.v.files[OWN_STRUCT], outside);
  assert.equal(late.v.files[OWN], OWN_SEED[OWN]);
  assert.deepEqual(late.v.modifies, []);
  assert.equal(edLate.editor.closeCount, 0);
  assert.deepEqual(notices, [M.translate('en', 'ui.recipe_notice_changed')]);
});

test('A4: the structure of a style is gone (a file that was removed) - the Standard sections are shown, opening rewrites nothing, Save without a section change keeps the reference, and changing a section writes a new structure file', async () => {
  const gone = recipeText({ structure: 'file:Vanished' });
  const setup = await editorSetup({ ...SEED, [`${RECIPE_DIR}/Gone.md`]: gone });
  const ed = openEditor(setup, { source: 'file:Gone' });
  await settle();
  assert.ok(sectionNames(ed).length >= 5);
  assert.equal(setup.v.files[`${RECIPE_DIR}/Gone.md`], gone, 'nothing is rewritten by showing it');
  pickUpdate(ed, 'top');
  saveOf(ed).click();
  await settle();
  assert.equal(M.parseRecipeFile(setup.v.files[`${RECIPE_DIR}/Gone.md`]).structure, 'file:Vanished');
  const edit = openEditor(setup, { source: 'file:Gone' });
  await settle();
  addSection(edit);
  saveOf(edit).click();
  await settle();
  assert.deepEqual(setup.v.creates, [`${STRUCTURE_DIR}/Gone.md`]);
  assert.equal(M.parseRecipeFile(setup.v.files[`${RECIPE_DIR}/Gone.md`]).structure, 'file:Gone');
});

test('A2: the voice key is written only when the chosen voice differs from the global one; an untouched voice stays as the source had it (its own key, or none)', async () => {
  const save = async (settingsPatch, options, act) => {
    const setup = await editorSetup({ ...SEED, [`${RECIPE_DIR}/Keyed.md`]: recipeText({ voice: 'builtin:magazine' }), [`${RECIPE_DIR}/Plain.md`]: recipeText({}) }, settingsPatch);
    const ed = openEditor(setup, { name: 'Fresh', ...options });
    await settle();
    act?.(ed);
    pickUpdate(ed, 'top');
    saveOf(ed).click();
    await settle();
    const path = options.source ? `${RECIPE_DIR}/${options.source.slice('file:'.length)}.md` : `${RECIPE_DIR}/Fresh.md`;
    return plain(M.parseRecipeFile(setup.v.files[path]));
  };
  const own = parsed => (parsed.voiceSet ? parsed.voice : null);
  // global voice is academic (not set)
  assert.equal(own(await save({}, { source: null }, null)), null, 'untouched, the source followed the global voice');
  assert.equal(own(await save({}, { source: null }, ed => pickVoice(ed, 'plain'))), 'builtin:plain', 'differs from the global one: written (set apart)');
  assert.equal(own(await save({}, { source: null }, ed => { pickVoice(ed, 'plain'); pickVoice(ed, 'academic'); })), null, 'back to the global one: no key');
  // the global voice is plain
  const plainGlobal = { noteStyleDefaults: { voice: 'builtin:plain' } };
  assert.equal(own(await save(plainGlobal, { source: null }, ed => pickVoice(ed, 'plain'))), null, 'the same as the global voice: no key');
  assert.equal(own(await save(plainGlobal, { source: null }, ed => pickVoice(ed, 'magazine'))), 'builtin:magazine');
  assert.equal(own(await save(plainGlobal, { source: null }, ed => pickVoice(ed, 'academic'))), 'builtin:academic', 'academic is not the global voice here, so it is written');
  // an existing file: an own voice that is not touched keeps its key; one that is changed to the global voice loses it; no key stays none
  assert.equal(own(await save({}, { source: 'file:Keyed' }, null)), 'builtin:magazine');
  assert.equal(own(await save({}, { source: 'file:Keyed' }, ed => pickVoice(ed, 'academic'))), null);
  assert.equal(own(await save({}, { source: 'file:Plain' }, null)), null);
  assert.equal(own(await save({}, { source: 'file:Plain' }, ed => pickVoice(ed, 'magazine'))), 'builtin:magazine');
});

test('A2: the editor has no format control - the format key stays as the source had it: a file with the key keeps it, a file without stays without, a built-in that fixes its format (Atomic knowledge is lean) writes it, one that follows the global format writes none', async () => {
  const setup = await editorSetup({ ...SEED, [`${RECIPE_DIR}/NoFmt.md`]: '---\nstructure: Standard six\nupdate: top\n---\n' });
  assert.equal(dom.findAll(openEditor(setup, { source: null, name: 'Probe' }).content, node => node.attrs['aria-label'] === 'Format rules').length, 0);
  const saveFrom = async (options, file) => {
    const ed = openEditor(setup, options);
    await settle();
    pickUpdate(ed, options.update ?? 'fresh');
    saveOf(ed).click();
    await settle();
    return plain(M.parseRecipeFile(setup.v.files[file]));
  };
  const noFmt = await saveFrom({ source: 'file:NoFmt', update: 'merge' }, `${RECIPE_DIR}/NoFmt.md`);
  assert.equal(noFmt.formatSet, false);
  assert.equal(/format/i.test(setup.v.files[`${RECIPE_DIR}/NoFmt.md`]), false);
  const atomic = await saveFrom({ source: null, from: 'builtin:atomic', name: 'Atom copy' }, `${RECIPE_DIR}/Atom copy.md`);
  assert.deepEqual([atomic.formatSet, atomic.format], [true, 'builtin:lean']);
  const general = await saveFrom({ source: null, from: 'builtin:general', name: 'General copy' }, `${RECIPE_DIR}/General copy.md`);
  assert.equal(general.formatSet, false);
  const weekly = await saveFrom({ source: 'file:Weekly' }, WEEKLY);
  assert.deepEqual([weekly.formatSet, weekly.format], [true, 'builtin:standard']);
});

test('A3: "also use it for the other 5 types" makes the chosen voice the global voice - the style gets no voice key - and a Notice lists the types that set their own voice and so were not changed; unchecked, the global voice is not touched; a save that fails sets nothing', async () => {
  const files = { ...SEED, [`${RECIPE_DIR}/Voiced.md`]: recipeText({ voice: 'builtin:magazine' }) };
  const setup = await editorSetup(files, { noteStyleByKind: { hypothesis: 'file:Voiced' } });
  const ed = openEditor(setup, { source: null, from: 'builtin:general', name: 'Mine' });
  await settle();
  pickVoice(ed, 'plain');
  setApplyAll(ed, true);
  saveOf(ed).click();
  await settle();
  assert.deepEqual(plain(setup.settings.noteStyleDefaults), { voice: 'builtin:plain' });
  assert.equal(M.parseRecipeFile(setup.v.files[`${RECIPE_DIR}/Mine.md`]).voiceSet, false);
  assert.ok(notices.includes(M.translate('en', 'ui.editor_apply_notice_0', VOICE_NAME.plain)), notices.join('|'));
  const kept = notices.find(text => text.startsWith('These types keep'));
  assert.ok(kept && kept.includes('Hypothesis') && !kept.includes('Atomic') && !kept.includes('AIM'), kept);
  assert.deepEqual(plain(setup.settings.noteStyleByKind), { hypothesis: 'file:Voiced' });
  // unchecked: the global voice stays
  const off = await editorSetup(files);
  const edOff = openEditor(off, { source: null, from: 'builtin:general', name: 'Mine' });
  await settle();
  pickVoice(edOff, 'plain');
  saveOf(edOff).click();
  await settle();
  assert.equal(off.settings.noteStyleDefaults, undefined);
  assert.equal(M.parseRecipeFile(off.v.files[`${RECIPE_DIR}/Mine.md`]).voice, 'builtin:plain');
  // the style could not be saved (the file changed): the global voice is not set
  const bad = await editorSetup(OWN_SEED);
  const edBad = openEditor(bad, { source: 'file:Own' });
  await settle();
  pickVoice(edBad, 'plain');
  setApplyAll(edBad, true);
  bad.v.files[OWN] = `${OWN_SEED[OWN]}x\n`;
  saveOf(edBad).click();
  await settle();
  assert.equal(bad.settings.noteStyleDefaults, undefined);
  assert.equal(edBad.editor.closeCount, 0);
  // choosing the default voice and applying it removes nothing that is not there and sets no key
  const same = await editorSetup(SEED);
  const edSame = openEditor(same, { source: null, from: 'builtin:general', name: 'Mine' });
  await settle();
  setApplyAll(edSame, true);
  saveOf(edSame).click();
  await settle();
  assert.equal(same.settings.noteStyleDefaults, undefined);
});

test('section list: a list that is empty, a name used twice, an empty name or a name the parser reads differently shows an error in the live region and disables Save; Save then writes nothing; a valid list enables it again', async () => {
  const setup = await editorSetup(SEED);
  const ed = openEditor(setup, { source: null, from: 'builtin:general', name: 'Lists' });
  await settle();
  const count = sectionNames(ed).length;
  assert.equal(errorOf(ed).text, '');
  renameSection(ed, 1, sectionNames(ed)[0]);
  assert.notEqual(errorOf(ed).text, '', 'a name used twice');
  assert.equal(saveOf(ed).disabled, true);
  saveOf(ed).click();
  await settle();
  assert.equal(writes(setup.v), 0);
  renameSection(ed, 1, '');
  assert.notEqual(errorOf(ed).text, '', 'an empty name');
  renameSection(ed, 1, 'has %% mark');
  assert.notEqual(errorOf(ed).text, '', 'a comment mark would hide the name');
  assert.equal(saveOf(ed).disabled, true);
  renameSection(ed, 1, 'A fine name');
  assert.equal(errorOf(ed).text, '');
  assert.equal(saveOf(ed).disabled, false);
  for (let n = 0; n < count; n++) rowButton(ed, 0, 'remove').click();
  assert.equal(nameInputs(ed).length, 0);
  assert.notEqual(errorOf(ed).text, '', 'no section at all');
  assert.equal(saveOf(ed).disabled, true);
  addSection(ed);
  assert.deepEqual(sectionNames(ed), ['New section 1']);
  addSection(ed);
  assert.deepEqual(sectionNames(ed), ['New section 1', 'New section 2'], 'a new name never repeats one that is there');
  assert.equal(errorOf(ed).text, '');
  assert.equal(saveOf(ed).disabled, false);
  // 13 sections are too many
  for (let n = 0; n < 11; n++) addSection(ed);
  assert.equal(nameInputs(ed).length, 13);
  assert.notEqual(errorOf(ed).text, '');
  assert.equal(saveOf(ed).disabled, true);
});

test('voice chips: the four built-in voices are chips in a radio group that change the sample sentence; a voice that is a file or retired has no chip checked and no sample sentence (A9); the arrow keys pick and keep the focus on the chip', async () => {
  const setup = await editorSetup({ ...SEED, [`${VOICE_DIR}/Dry.md`]: 'x\n', [`${RECIPE_DIR}/Filed.md`]: recipeText({ voice: 'file:Dry' }), [`${RECIPE_DIR}/Old.md`]: '---\nvoice: Key-point summary\n---\n' });
  const ed = openEditor(setup, { source: null, name: 'Chips' });
  await settle();
  const group = dom.find(ed.content, node => node.attrs.role === 'radiogroup');
  assert.equal(dom.findAll(group, node => node.attrs.role === 'radio').length, 4);
  assert.deepEqual(checkedVoice(ed), [VOICE_NAME.academic]);
  assert.ok(sampleOf(ed).children.some(node => node.text === sampleText('academic')));
  for (const id of ['plain', 'magazine', 'picture-book', 'academic']) {
    pickVoice(ed, id);
    assert.deepEqual(checkedVoice(ed), [VOICE_NAME[id]]);
    assert.ok(sampleOf(ed).children.some(node => node.text === sampleText(id)), id);
    assert.equal(chip(ed, id).focused, true, 'the focus stays on the chip just picked');
  }
  chip(ed, 'academic').keydown({ key: 'ArrowRight' });
  assert.deepEqual(checkedVoice(ed), [VOICE_NAME.plain]);
  assert.equal(chip(ed, 'plain').focused, true);
  chip(ed, 'plain').keydown({ key: 'ArrowLeft' });
  assert.deepEqual(checkedVoice(ed), [VOICE_NAME.academic]);
  assert.equal(chip(ed, 'academic').attrs.tabindex, '0');
  assert.equal(chip(ed, 'plain').attrs.tabindex, '-1');
  // the sample note follows the voice
  await runTimers();
  const last = () => renders.at(-1);
  pickVoice(ed, 'magazine');
  await runTimers();
  assert.ok(last().includes(`Voice\\: ${VOICE_NAME.magazine.replace(/[!-\/:-@[-`{-~]/g, '\\$&')}`), last());
  // a voice that is a file: no chip checked, no sample sentence, the file's name is said
  const filed = openEditor(setup, { source: 'file:Filed' });
  await settle();
  assert.deepEqual(checkedVoice(filed), []);
  assert.equal(sampleOf(filed).children.some(node => node.text === sampleText('academic')), false);
  assert.ok(sampleOf(filed).children.some(node => node.text === M.translate('en', 'ui.note_style_voice_other_0', 'Dry')));
  assert.equal(chip(filed, 'academic').attrs.tabindex, '0', 'Tab still reaches the group');
  pickUpdate(filed, 'top');
  saveOf(filed).click();
  await settle();
  assert.equal(M.parseRecipeFile(setup.v.files[`${RECIPE_DIR}/Filed.md`]).voice, 'file:Dry');
});

test('counter 11 (OQ16): the sample is drawn once on open and, after a burst of changes, once 200ms after the last one; no AI is reached; closing clears the timer, unloads the component and draws nothing more', async () => {
  const setup = await editorSetup(SEED);
  const ed = openEditor(setup, { source: null, name: 'Sample' });
  await settle();
  assert.equal(counts.loads, 1);
  assert.equal(renders.length, 1, 'drawn on open');
  renameSection(ed, 0, 'Typed A');
  addSection(ed);
  pickUpdate(ed, 'top');
  assert.equal(timers.length, 1, 'one timer waits, the earlier ones were cleared');
  assert.equal(timers[0].ms, 200);
  assert.equal(renders.length, 1, 'nothing is drawn before the delay');
  await runTimers();
  assert.equal(renders.length, 2);
  assert.match(renders[1], /## Typed A/);
  assert.match(renders[1], /## New section 1/);
  // a change followed by a close: the pending redraw is gone
  pickVoice(ed, 'plain');
  assert.equal(timers.length, 1);
  ed.editor.close();
  dom.button(windows.at(-1).modalEl, 'Discard changes').click();
  assert.equal(timers.filter(timer => timer.ms === 200).length, 0, 'the timer was cleared');
  assert.equal(counts.unloads, 1);
  await runTimers();
  assert.equal(renders.length, 2);
  assert.deepEqual(setup.touched, []);
});

test('P4 (D6): the sample lists the section names of the style (as edited); Standard has one callout on the first section, a lean style bullets and no callout, a rich style a callout or table on every section; text from the part file is plain text, never markup', async () => {
  const withFormat = format => recipeText({ format });
  const setup = await editorSetup({
    ...SEED, [`${STRUCTURE_DIR}/Odd.md`]: '## <b>Bold</b> *x*\n[[link]] and **bold**\n\n## Second\ny\n',
    [`${RECIPE_DIR}/Lean.md`]: withFormat('builtin:lean'), [`${RECIPE_DIR}/Rich.md`]: withFormat('builtin:rich'), [`${RECIPE_DIR}/OddStyle.md`]: recipeText({ structure: 'file:Odd' })
  });
  const headings = markdown => markdown.split('\n').filter(line => line.startsWith('## '));
  const callouts = markdown => markdown.split('\n').filter(line => line.startsWith('> [!note]')).length;
  const tables = markdown => markdown.split('\n').filter(line => line.startsWith('| --- ')).length;
  const bullets = markdown => markdown.split('\n').filter(line => line.startsWith('- ')).length;
  const plainMd = value => value.replace(/\s+/g, ' ').trim().replace(/[!-\/:-@[-`{-~]/g, '\\$&');
  const std = openEditor(setup, { source: null, from: 'builtin:general', name: 'Sample' });
  await settle();
  const sections = setup.store.draftStyle({ name: 'x', structure: 'builtin:standard', voice: 'builtin:academic', update: 'merge' }, 'topic', 'en').template.sections;
  let markdown = renders.at(-1);
  assert.equal(headings(markdown).length, sections.length);
  for (const section of sections) assert.ok(markdown.split('\n').includes(`## ${plainMd(section.name)}`), section.name);
  assert.equal(callouts(markdown), 1);
  // the sections as edited: a renamed one, a new one (no description line), a deleted one
  renameSection(std, 0, 'Typed first');
  addSection(std);
  rowButton(std, 1, 'remove').click();
  await runTimers();
  markdown = renders.at(-1);
  assert.equal(headings(markdown).length, sections.length);
  assert.ok(markdown.split('\n').includes('## Typed first'));
  assert.ok(markdown.split('\n').includes('## New section 1'));
  assert.equal(markdown.split('\n').includes(`## ${plainMd(sections[1].name)}`), false);
  assert.equal(writes(setup.v), 0);
  const lean = openEditor(setup, { source: 'file:Lean' });
  await settle();
  markdown = renders.at(-1);
  assert.equal(callouts(markdown), 0);
  assert.equal(tables(markdown), 0);
  assert.ok(bullets(markdown) >= 2 * sections.length);
  const rich = openEditor(setup, { source: 'file:Rich' });
  await settle();
  markdown = renders.at(-1);
  assert.equal(callouts(markdown) + tables(markdown), sections.length);
  const odd = openEditor(setup, { source: 'file:OddStyle' });
  await settle();
  markdown = renders.at(-1);
  assert.equal(headings(markdown).length, 2);
  assert.equal(/<b>|\*\*bold\*\*|\[\[link\]\]/.test(markdown), false, 'a part file\'s words carry no markup into the sample');
  assert.match(markdown, /Bold/);
  assert.match(markdown, /Voice\\: /);
});

test('counter 12 (#38, was failing first): Preview AI instructions reads the files again before it opens, so a structure edited in a tab shows in the preview while the sections are untouched; once the sections are edited, the preview shows the draft\'s sections; the default preview of the settings page is unchanged', async () => {
  const setup = await editorSetup({ ...SEED, [`${RECIPE_DIR}/OnMine.md`]: recipeText({ structure: 'file:Mine' }) });
  const ed = openEditor(setup, { source: 'file:OnMine' });
  await settle();
  setup.v.files[`${STRUCTURE_DIR}/Mine.md`] = '## A\nx\n\n## Brandnew\ny\n';
  events.length = 0;
  dom.button(ed.root, 'Preview AI instructions').click();
  await settle();
  const firstRefresh = events.indexOf('refresh');
  const opening = events.indexOf('open:PromptPreviewModal');
  assert.ok(firstRefresh >= 0 && events.indexOf('refreshed') < opening, events.join());
  assert.match(previewTexts(), /Brandnew/);
  assert.equal(writes(setup.v), 0);
  // edited sections are what the preview shows
  const edited = openEditor(setup, { source: 'file:OnMine' });
  await settle();
  renameSection(edited, 0, 'Draft section');
  windows.length = 0;
  dom.button(edited.root, 'Preview AI instructions').click();
  await settle();
  assert.match(previewTexts(), /Draft section/);
  assert.equal(writes(setup.v), 0);
  // without a draft the same window shows the workspace default style
  windows.length = 0;
  new PromptPreviewModal(setup.app, setup.store, 'en', 'codex').open();
  await settle();
  assert.equal(/Brandnew|Draft section/.test(previewTexts()), false);
});

test('P4: coming back to the window (focus) re-reads the files: untouched sections follow the structure file, edited sections stay and Save then checks the file against what was read', async () => {
  const setup = await editorSetup(OWN_SEED);
  const ed = openEditor(setup, { source: 'file:Own' });
  await settle();
  setup.v.files[OWN_STRUCT] = '## Alpha\na\n\n## Delta\nd\n';
  await ed.editor.onFocus();
  await settle();
  assert.deepEqual(sectionNames(ed), ['Alpha', 'Delta']);
  assert.equal(ed.editor.closeCount, 0);
  renameSection(ed, 0, 'Edited');
  setup.v.files[OWN_STRUCT] = '## Alpha\na\n\n## Epsilon\ne\n';
  await ed.editor.onFocus();
  await settle();
  assert.deepEqual(sectionNames(ed), ['Edited', 'Delta'], 'edits are not replaced');
  saveOf(ed).click();
  await settle();
  assert.equal(setup.v.files[OWN_STRUCT], '## Alpha\na\n\n## Epsilon\ne\n', 'the file changed after it was read: nothing is written');
  assert.deepEqual(setup.v.modifies, []);
});

test('P4: the section list has real keyboard controls - every row has a named name field and up, down and delete buttons that Tab reaches; the first row\'s up and the last row\'s down are unavailable; the focus follows a moved row and a deleted one', async () => {
  const setup = await editorSetup(OWN_SEED);
  const ed = openEditor(setup, { source: 'file:Own' });
  await settle();
  assert.equal(nameInputs(ed)[0].focused, true, 'an existing style starts in its first section');
  const labels = [];
  for (const kind of ['up', 'down', 'remove']) {
    const buttons = dom.findAll(ed.content, node => dom.hasCls(node, `vam-editor-section-${kind}`));
    assert.equal(buttons.length, 3);
    for (const button of buttons) { assert.ok(button.attrs['aria-label'], kind); assert.equal(button.tag, 'button'); labels.push(button.attrs['aria-label']); }
  }
  for (const input of nameInputs(ed)) assert.ok(input.attrs['aria-label']);
  assert.equal(new Set(labels).size, labels.length, 'every button says which section it acts on');
  assert.equal(rowButton(ed, 0, 'up').disabled, true);
  assert.equal(rowButton(ed, 2, 'down').disabled, true);
  assert.equal(rowButton(ed, 1, 'up').disabled, false);
  rowButton(ed, 0, 'down').click();
  assert.deepEqual(sectionNames(ed), ['Beta', 'Alpha', 'Gamma']);
  assert.equal(rowButton(ed, 1, 'down').focused, true, 'the focus stays on the moved row');
  rowButton(ed, 1, 'down').click();
  assert.deepEqual(sectionNames(ed), ['Beta', 'Gamma', 'Alpha']);
  assert.equal(rowButton(ed, 2, 'up').focused, true, 'the row is last now: its down is off, so the focus goes to its up');
  rowButton(ed, 1, 'remove').click();
  assert.deepEqual(sectionNames(ed), ['Beta', 'Alpha']);
  assert.equal(rowButton(ed, 1, 'remove').focused, true, 'the focus goes to the next row\'s delete');
  addSection(ed);
  assert.equal(nameInputs(ed)[2].focused, true, 'a new section starts in its name');
  assert.equal(nameInputs(ed)[2].value, 'New section 1');
  // renaming updates what the buttons say
  renameSection(ed, 0, 'Beta two');
  assert.match(rowButton(ed, 0, 'remove').attrs['aria-label'], /Beta two/);
});

test('counter 15 (runtime-ui): every control has a readable name, the update mode is a fieldset with a legend and three labelled radios with a line each, the sample is a named region that is not live, the error line and the voice sample are the only live regions, and the focus goes back to the trigger on close', async () => {
  const setup = await editorSetup(SEED);
  const ed = openEditor(setup, { source: null, name: 'Keys' });
  await settle();
  const controls = dom.findAll(ed.root, node => ['button', 'select', 'input'].includes(node.tag));
  assert.ok(controls.length >= 17);
  for (const control of controls) {
    const named = control.text || control.attrs['aria-label'] || control.parent?.tag === 'label' || dom.find(ed.root, node => node.tag === 'label' && node.attrs.for === control.attrs.id);
    assert.ok(named, `${control.tag} ${control.attrs.id ?? ''}`);
  }
  assert.equal(dom.findAll(ed.root, node => node.tag === 'select').length, 0, 'no dropdown is left');
  const fieldset = dom.find(ed.content, node => node.tag === 'fieldset');
  assert.ok(dom.find(fieldset, node => node.tag === 'legend').text);
  const radios = dom.findAll(fieldset, node => node.type === 'radio');
  assert.equal(radios.length, 3);
  assert.equal(new Set(radios.map(item => item.attrs.name)).size, 1);
  assert.deepEqual(radios.map(item => item.checked), [true, false, false]);
  for (const item of radios) assert.ok(dom.find(fieldset, node => node.attrs.id === item.attrs['aria-describedby']).text.length > 10);
  const region = dom.find(ed.content, node => node.attrs.role === 'region');
  assert.equal(region.attrs['aria-label'], 'Sample note');
  assert.equal(region.attrs['aria-live'], undefined);
  assert.deepEqual(dom.findAll(ed.content, node => node.attrs['aria-live']).map(node => node.attrs.id ?? 'sample'), ['vam-editor-error', 'sample']);
  assert.equal(nameOf(ed).attrs['aria-describedby'], 'vam-editor-error');
  assert.equal(nameOf(ed).focused, true, 'a new style starts in the name');
  assert.equal(dom.find(ed.content, node => node.attrs.role === 'radiogroup').attrs['aria-labelledby'] !== undefined, true);
  ed.editor.close();
  assert.equal(ed.editor.closeCount, 1);
  assert.equal(ed.trigger.focused, true);
  assert.equal(ed.editor.contentEl.children.length, 0);
});

test('P4: closing (Escape and the close button call close) asks before it drops changes - a changed section, voice or "also use it" counts - and not when nothing changed; Cancel of the question keeps the window, Discard closes it; a change that is changed back is no change', async () => {
  const setup = await editorSetup(SEED);
  const clean = openEditor(setup, { source: null, name: 'Clean' });
  await settle();
  clean.editor.close();
  assert.equal(clean.editor.closeCount, 1);
  assert.equal(windows.filter(w => w.titleEl.text === 'Discard changes?').length, 0);
  const ed = openEditor(setup, { source: null, name: 'Dirty' });
  await settle();
  renameSection(ed, 0, 'Typed');
  ed.editor.close();
  assert.equal(ed.editor.closeCount, 0);
  const question = windows.filter(w => w.titleEl.text === 'Discard changes?');
  assert.equal(question.length, 1);
  ed.editor.close();
  assert.equal(windows.filter(w => w.titleEl.text === 'Discard changes?').length, 1, 'one question at a time');
  dom.button(question[0].modalEl, 'Cancel').click();
  assert.equal(ed.editor.closeCount, 0, 'keep editing');
  ed.editor.close();
  const again = windows.filter(w => w.titleEl.text === 'Discard changes?');
  assert.equal(again.length, 2);
  dom.button(again[1].modalEl, 'Discard changes').click();
  assert.equal(ed.editor.closeCount, 1);
  assert.equal(writes(setup.v), 0);
  for (const change of [ed2 => pickVoice(ed2, 'plain'), ed2 => setApplyAll(ed2, true), ed2 => rowButton(ed2, 0, 'down').click(), ed2 => addSection(ed2), ed2 => rowButton(ed2, 0, 'remove').click()]) {
    const dirty = openEditor(setup, { source: null, name: 'Other' });
    await settle();
    change(dirty);
    dirty.editor.close();
    assert.equal(dirty.editor.closeCount, 0, String(change));
  }
  // a change that is changed back is no change
  const back = openEditor(setup, { source: null, name: 'Back' });
  await settle();
  const first = sectionNames(back)[0];
  pickUpdate(back, 'top');
  pickUpdate(back, 'merge');
  renameSection(back, 0, 'Else');
  renameSection(back, 0, first);
  pickVoice(back, 'plain');
  pickVoice(back, 'academic');
  setApplyAll(back, true);
  setApplyAll(back, false);
  back.editor.close();
  assert.equal(back.editor.closeCount, 1);
});

test('K3 (P4): the voice chips offer no retired voice; a style that uses one has no chip checked, and Save keeps its ref', async () => {
  const setup = await editorSetup({ ...SEED, [`${RECIPE_DIR}/Old.md`]: '---\nvoice: Key-point summary\n---\n' });
  const fresh = openEditor(setup, { source: null, name: 'Fresh' });
  await settle();
  const labels = dom.findAll(fresh.content, node => node.attrs.role === 'radio').map(node => node.text);
  assert.deepEqual(labels, [VOICE_NAME.academic, VOICE_NAME.plain, VOICE_NAME.magazine, VOICE_NAME['picture-book']]);
  const ed = openEditor(setup, { source: 'file:Old' });
  await settle();
  assert.deepEqual(checkedVoice(ed), []);
  assert.ok(sampleOf(ed).children.some(node => node.text === M.translate('en', 'ui.note_style_voice_other_0', 'Key-point summary')));
  pickUpdate(ed, 'top');
  saveOf(ed).click();
  await settle();
  assert.equal(M.parseRecipeFile(setup.v.files[`${RECIPE_DIR}/Old.md`]).voice, 'builtin:summary');
});

test('structure edit helpers (pure): the text is cut at the headings outside code and comments; unchanged rows give the text back; a renamed heading keeps its comment; CRLF is kept; moving a section moves all its lines', () => {
  const text = '%% head %%\nIntro line\n\n## One\nd1\n```\n## not a heading\n```\n\n## Two %% keep me %%\nCount: 3\n%% multi\n## inside a comment\n%%\nd2\n';
  const chunks = M.splitStructure(text);
  assert.deepEqual(plain(chunks.sections.map(section => section.name)), ['One', 'Two']);
  assert.deepEqual(plain(chunks.head), ['%% head %%', 'Intro line', '']);
  assert.equal(M.sameRows(chunks, M.rowsOf(chunks)), true);
  assert.equal(M.composeStructure(chunks, M.rowsOf(chunks)), text);
  assert.equal(M.sameRows(chunks, [{ origin: 1, name: 'Two' }, { origin: 0, name: 'One' }]), false);
  const moved = M.composeStructure(chunks, [{ origin: 1, name: 'Two' }, { origin: 0, name: 'One' }]);
  assert.ok(moved.indexOf('## Two') < moved.indexOf('## One') && moved.includes('Count: 3\n%% multi\n## inside a comment\n%%\nd2'));
  assert.ok(M.composeStructure(chunks, [{ origin: 0, name: 'One' }, { origin: 1, name: 'Deux' }]).includes('## Deux %% keep me %%\nCount: 3'));
  assert.equal(M.composeStructure(chunks, [{ origin: null, name: 'Only' }]), '%% head %%\nIntro line\n\n## Only\n');
  const crlf = M.splitStructure('## A\r\nx\r\n\r\n## B\r\ny\r\n');
  assert.equal(crlf.eol, '\r\n');
  assert.equal(M.composeStructure(crlf, [{ origin: 1, name: 'B' }, { origin: 0, name: 'A' }]), '## B\r\ny\r\n\r\n## A\r\nx\r\n');
  assert.equal(M.splitStructure('no headings\n').sections.length, 0);
});

test('store.saveRecipe (null keys): a null voice or format leaves the key out of a new file and removes it from an existing one without touching any other byte; strings are written as before', async () => {
  const keyed = M.recipeFileText({ structure: 'file:Mine', voice: 'builtin:plain', format: 'builtin:lean', update: 'top' }, 'en').replace('\n---\n', '\ntags: [a]\n---\nBody\n');
  const v = vault({ [`${RECIPE_DIR}/Keys.md`]: keyed, [`${STRUCTURE_DIR}/Mine.md`]: '## A\nx\n' });
  const settings = { detailTemplates: [], workspaceFolder: 'WS', noteStylesFolder: ROOT, language: 'en' };
  const store = new M.NoteStyleStore({ settings: () => settings, port: v.port, save: async () => undefined });
  await store.refresh();
  const original = { ref: 'file:Keys', text: keyed };
  assert.deepEqual(plain(await store.saveRecipe({ name: 'Keys', structure: 'file:Mine', voice: null, format: 'builtin:lean', update: 'top', original })), { ok: true, ref: 'file:Keys' });
  assert.equal(v.files[`${RECIPE_DIR}/Keys.md`], keyed.split('\n').filter(line => !/^voice:/i.test(line)).join('\n'));
  const created = await store.saveRecipe({ name: 'Fresh', structure: 'builtin:standard', voice: null, format: null, update: 'merge' });
  assert.deepEqual(plain(created), { ok: true, ref: 'file:Fresh' });
  assert.equal(M.parseRecipeFile(v.files[`${RECIPE_DIR}/Fresh.md`]).voiceSet, false);
  assert.equal(M.parseRecipeFile(v.files[`${RECIPE_DIR}/Fresh.md`]).formatSet, false);
  assert.equal(/voice|format/i.test(v.files[`${RECIPE_DIR}/Fresh.md`]), false);
  const again = await store.saveRecipe({ name: 'Keys2', structure: 'builtin:standard', voice: 'builtin:plain', format: 'builtin:rich', update: 'merge' });
  assert.equal(again.ok, true);
  const read = M.parseRecipeFile(v.files[`${RECIPE_DIR}/Keys2.md`]);
  assert.deepEqual(plain([read.voiceSet, read.voice, read.formatSet, read.format]), [true, 'builtin:plain', true, 'builtin:rich']);
});

test('counter 4: a name that is empty, padded, has / or \\ or .., is a built-in\'s name (any language, any case), has an unsafe character or is taken shows an error in the live region, disables Save, and writes nothing', async () => {
  const setup = await editorSetup(SEED);
  const ed = openEditor(setup, { source: null, name: 'Fine' });
  await settle();
  assert.equal(errorOf(ed).attrs['aria-live'], 'polite');
  assert.equal(errorOf(ed).text, '');
  assert.equal(saveOf(ed).disabled, false);
  const builtinNames = LANGUAGES.map(language => M.translate(language, 'ui.recipe_name_general'));
  const bad = ['', ' padded', 'padded ', 'a/b', 'a\\b', '..', 'a..b', 'a:b', 'Weekly', 'weekly', ...builtinNames, ...builtinNames.map(name => name.toUpperCase())];
  for (const name of bad) {
    typeName(ed, name);
    assert.notEqual(errorOf(ed).text, '', JSON.stringify(name));
    assert.equal(saveOf(ed).disabled, true, JSON.stringify(name));
    saveOf(ed).click();
    await settle();
  }
  assert.equal(writes(setup.v), 0);
  assert.equal(ed.editor.closeCount, 0);
  typeName(ed, 'Fine again');
  assert.equal(errorOf(ed).text, '');
  assert.equal(saveOf(ed).disabled, false);
  // an existing style keeps its name: the field is read-only and the name is not checked
  const existing = openEditor(setup, { source: 'file:Weekly' });
  await settle();
  assert.equal(nameOf(existing).value, 'Weekly');
  assert.equal(nameOf(existing).attrs.readonly, 'readonly');
  assert.equal(saveOf(existing).disabled, false);
});

test('counter 10 (decision #41 D3): saving a style made from a built-in one switches the topic types that use that built-in (stored or by default) to the new file and says which; other types and an edit of a file change nothing', async () => {
  const setup = await editorSetup(SEED, { noteStyleByKind: { atomic: 'builtin:general', hypothesis: 'builtin:evidence' } });
  const ed = openEditor(setup, { source: 'builtin:general', name: 'Mine G' });
  await settle();
  pickUpdate(ed, 'fresh');
  saveOf(ed).click();
  await settle();
  assert.deepEqual(plain(setup.settings.noteStyleByKind), { atomic: 'file:Mine G', hypothesis: 'builtin:evidence', topic: 'file:Mine G' });
  const note = notices.find(text => text.includes('Mine G') && text.includes('Topic'));
  assert.ok(note && note.includes('Atomic knowledge') && !note.includes('Hypothesis'), notices.join('|'));
  assert.deepEqual(ed.saved, ['file:Mine G']);
  assert.equal(setup.made.settingSaves, 2, 'one save per row that changed');
  // a file edited in place: nothing is switched
  const before = JSON.stringify(setup.settings);
  const second = openEditor(setup, { source: 'file:Mine G' });
  await settle();
  pickUpdate(second, 'top');
  saveOf(second).click();
  await settle();
  assert.equal(JSON.stringify(setup.settings), before);
  assert.equal(setup.made.settingSaves, 2);
  // a built-in no topic type uses switches nothing
  const none = await editorSetup(SEED);
  const edNone = openEditor(none, { source: 'builtin:textbook', name: 'My textbook' });
  await settle();
  saveOf(edNone).click();
  await settle();
  assert.equal(none.made.settingSaves, 0);
  assert.equal(none.settings.noteStyleByKind, undefined);
});

test('F1 R7: the sample has no scroll of its own, so the window is the only scroll axis and the button row never covers the end of the sample; the rule sits above the map-search marker', () => {
  const css = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'styles.css'), 'utf8');
  const rule = css.split('\n').find(line => line.startsWith('.vam-editor-example {'));
  assert.ok(rule && !/max-height|overflow-y/.test(rule), rule);
  assert.ok(css.indexOf('.vam-editor-example {') < css.indexOf('/* Map search'));
  assert.match(css, /^\.vam-editor-modal \.modal-content \{ padding-bottom: var\(--size-4-3\); \}/m);
});
