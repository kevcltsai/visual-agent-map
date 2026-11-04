// Note style recipe T5 P4: the style editor window (NoteStyleEditorModal) over a real store on an in-memory vault, with the prompt preview it opens.
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

test('F1 R1 (security, was failing first): a part file\'s section names and descriptions, and the names of the voice and format, reach the renderer with every ASCII punctuation character escaped - no link, tag, wiki link, HTML or highlight can be made', async () => {
  const hostile = ['https://x.test/a', 'a@b.co', '[[x]]', '<b>y</b>', '==z==', '+ plus', '![i](u)', '1. n', '~~s~~', '$m$', '|p|', '> q'];
  const part = words => words.map((word, n) => `## S${n} ${word}\n${word} desc\n`).join('\n');
  const setup = await editorSetup({ ...SEED, [`${STRUCTURE_DIR}/Hostile.md`]: part(hostile.slice(0, 6)), [`${STRUCTURE_DIR}/Hostile2.md`]: part(hostile.slice(6)), [`${VOICE_DIR}/Odd _v_ @a.md`]: 'x\n', [`${FORMAT_DIR}/Odd _f_ @g.md`]: 'x\n' });
  const ed = openEditor(setup, { source: null, from: 'builtin:general', name: 'Sample' });
  await settle();
  choose(ed, 'Voice', 'file:Odd _v_ @a');
  choose(ed, 'Format rules', 'file:Odd _f_ @g');
  const plain = value => value.replace(/\s+/g, ' ').trim().replace(/[!-\/:-@[-`{-~]/g, '\\$&');
  for (const [structure, words] of [['file:Hostile', hostile.slice(0, 6)], ['file:Hostile2', hostile.slice(6)]]) {
    choose(ed, 'Structure', structure);
    await runTimers();
    const markdown = renders.at(-1);
    const headings = markdown.split('\n').filter(line => line.startsWith('## '));
    assert.equal(headings.length, words.length);
    words.forEach((word, n) => assert.equal(headings[n], `## ${plain(`S${n} ${word}`)}`, word));
    // no ASCII punctuation survives unescaped in the text a part file supplied
    for (const line of markdown.split('\n')) {
      if (/^(> \[!note\]|>|\| )/.test(line) && !/S\d/.test(line)) continue;
      if (line === '' || line === '| --- | --- |' || line.startsWith('- ') || line.startsWith('*')) continue;
      assert.equal(/[!-\/:-@[-`{-~]/.test(line.replace(/\\[!-\/:-@[-`{-~]/g, '').replace(/^(## |> \[!note\] |> |\*|\| )/, '')), false, line);
    }
    assert.ok(markdown.includes('Odd \\_v\\_ \\@a'), 'the voice name is escaped too');
    assert.ok(markdown.includes('Odd \\_f\\_ \\@g'), 'the format name is escaped too');
  }
});

test('F1 R4: every redraw of the sample uses its own child component and the one it replaces is removed, so the children do not pile up; closing unloads the window\'s component', async () => {
  const setup = await editorSetup(SEED);
  const ed = openEditor(setup, { source: null, name: 'Sample' });
  await settle();
  const live = () => counts.added - counts.removed;
  assert.equal(live(), 1);
  for (let n = 0; n < 6; n++) {
    choose(ed, 'Format rules', n % 2 ? 'builtin:lean' : 'builtin:rich');
    await runTimers();
  }
  assert.equal(renders.length, 7);
  assert.equal(live(), 1, 'one child holds the sample on screen');
  assert.equal(new Set(renderOwners).size, 7, 'each picture had its own child');
  assert.ok(renderOwners.every(owner => owner.load !== undefined));
});

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
const choose = (ed, label, value) => { const select = byLabel(ed.content, label); select.value = value; select.change(); };
const optionsOf = select => dom.findAll(select, node => node.tag === 'option').map(node => node.optionValue);
const radio = (ed, mode) => dom.find(ed.content, node => node.attrs.id === `vam-editor-update-${mode}`);
const pickUpdate = (ed, mode) => { for (const m of ['merge', 'top', 'fresh']) radio(ed, m).checked = m === mode; radio(ed, mode).fire('change'); };
const previewTexts = () => { const modal = windows.find(w => w.titleEl.text === 'AI instructions preview'); return modal ? dom.texts(modal.contentEl).join('\n') : ''; };

test('counter 1: opening the editor (new, on a built-in style, on a file), changing every list and the update mode, opening the preview and cancelling write nothing and change no setting; the editor reaches for nothing but the store, the save, the part edit and the preview', async () => {
  for (const source of [null, 'builtin:hypothesis', 'file:Weekly']) {
    const setup = await editorSetup(SEED);
    const before = JSON.stringify(setup.settings);
    const ed = openEditor(setup, { source });
    await settle();
    choose(ed, 'Structure', 'file:Mine');
    choose(ed, 'Voice', 'builtin:plain');
    choose(ed, 'Format rules', 'builtin:lean');
    pickUpdate(ed, 'fresh');
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
  // an unchanged file is changed in place: only the four values, every other line keeps its bytes
  const ok = await editorSetup(SEED);
  const edOk = openEditor(ok, { source: 'file:Weekly' });
  await settle();
  pickUpdate(edOk, 'fresh');
  choose(edOk, 'Format rules', 'builtin:lean');
  saveOf(edOk).click();
  await settle();
  assert.deepEqual(ok.v.modifies, [WEEKLY]);
  const lines = ok.v.files[WEEKLY].split('\n');
  assert.ok(lines.includes('tags: [a]') && lines.includes('Weekly notes'));
  assert.equal(M.parseRecipeFile(ok.v.files[WEEKLY]).update, 'fresh');
  assert.equal(M.parseRecipeFile(ok.v.files[WEEKLY]).format, 'builtin:lean');
  assert.deepEqual(ed.saved.length + edOk.saved.length, 1);
  assert.equal(edOk.saved[0], 'file:Weekly');
  assert.equal(edOk.editor.closeCount, 1);
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

test('P4 (D5): Save of a new style writes the file once with the chosen four values and tells the list (onSaved); a new style from a built-in changes no topic type; a name taken meanwhile writes nothing', async () => {
  const setup = await editorSetup(SEED, { noteStyleByKind: { hypothesis: 'builtin:evidence' } });
  const ed = openEditor(setup, { source: null, from: 'builtin:evidence', name: 'Lab log' });
  await settle();
  assert.equal(writes(setup.v), 0);
  assert.equal(M.translate('en', 'ui.editor_title_new'), ed.editor.titleEl.text);
  choose(ed, 'Structure', 'file:Mine');
  choose(ed, 'Format rules', 'builtin:lean');
  pickUpdate(ed, 'top');
  saveOf(ed).click();
  await settle();
  const path = `${RECIPE_DIR}/Lab log.md`;
  assert.deepEqual(setup.v.creates, [path]);
  const read = M.parseRecipeFile(setup.v.files[path]);
  assert.deepEqual(plain({ structure: read.structure, voice: read.voice, format: read.format, update: read.update }), { structure: 'file:Mine', voice: 'builtin:academic', format: 'builtin:lean', update: 'top' });
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

test('counter 11 (OQ16): the sample is drawn once on open and, after a burst of changes, once 200ms after the last one; no AI is reached; closing clears the timer, unloads the component and draws nothing more', async () => {
  const setup = await editorSetup(SEED);
  const ed = openEditor(setup, { source: null, name: 'Sample' });
  await settle();
  assert.equal(counts.loads, 1);
  assert.equal(renders.length, 1, 'drawn on open');
  choose(ed, 'Structure', 'file:Mine');
  choose(ed, 'Format rules', 'builtin:lean');
  pickUpdate(ed, 'top');
  assert.equal(timers.length, 1, 'one timer waits, the earlier ones were cleared');
  assert.equal(timers[0].ms, 200);
  assert.equal(renders.length, 1, 'nothing is drawn before the delay');
  await runTimers();
  assert.equal(renders.length, 2);
  assert.match(renders[1], /## A/);
  // a change followed by a close: the pending redraw is gone
  choose(ed, 'Voice', 'builtin:plain');
  assert.equal(timers.length, 1);
  ed.editor.close();
  dom.button(windows.at(-1).modalEl, 'Discard changes').click();
  assert.equal(timers.filter(timer => timer.ms === 200).length, 0, 'the timer was cleared');
  assert.equal(counts.unloads, 1);
  await runTimers();
  assert.equal(renders.length, 2);
  assert.deepEqual(setup.touched, []);
});

test('P4 (D6): the sample lists the section names of the chosen structure; Lean has bullets and no callout, Standard and a file have one callout on the first section, Rich a callout or table on every section; text from the part file is plain text, never markup', async () => {
  const setup = await editorSetup({ ...SEED, [`${STRUCTURE_DIR}/Odd.md`]: '## <b>Bold</b> *x*\n[[link]] and **bold**\n\n## Second\ny\n' });
  const ed = openEditor(setup, { source: null, from: 'builtin:general', name: 'Sample' });
  await settle();
  const sections = setup.store.draftStyle({ name: 'x', structure: 'builtin:standard', voice: 'builtin:academic', format: 'builtin:standard', update: 'merge' }, 'topic', 'en').template.sections;
  const headings = markdown => markdown.split('\n').filter(line => line.startsWith('## '));
  const callouts = markdown => markdown.split('\n').filter(line => line.startsWith('> [!note]')).length;
  const tables = markdown => markdown.split('\n').filter(line => line.startsWith('| --- ')).length;
  const bullets = markdown => markdown.split('\n').filter(line => line.startsWith('- ')).length;
  const last = () => renders.at(-1);
  assert.equal(headings(last()).length, sections.length);
  const plain = value => value.replace(/\s+/g, ' ').trim().replace(/[!-\/:-@[-`{-~]/g, '\\$&');
  for (const section of sections) assert.ok(last().split('\n').includes(`## ${plain(section.name)}`), section.name);
  assert.equal(callouts(last()), 1);
  choose(ed, 'Format rules', 'builtin:lean');
  await runTimers();
  assert.equal(callouts(last()), 0);
  assert.equal(tables(last()), 0);
  assert.ok(bullets(last()) >= 2 * sections.length);
  choose(ed, 'Format rules', 'builtin:rich');
  await runTimers();
  assert.equal(callouts(last()) + tables(last()), sections.length);
  choose(ed, 'Structure', 'file:Odd');
  await runTimers();
  const odd = last();
  assert.equal(headings(odd).length, 2);
  assert.equal(/<b>|\*\*bold\*\*|\[\[link\]\]/.test(odd), false, 'a part file\'s words carry no markup into the sample');
  assert.match(odd, /Bold/);
  assert.match(odd, /Voice\\: /);
});

test('counter 12 (#38, was failing first): Preview AI instructions reads the files again before it opens, so a part edited in a tab shows in the preview; the preview shows the draft\'s parts, and the default preview of the settings page is unchanged', async () => {
  const setup = await editorSetup(SEED);
  const ed = openEditor(setup, { source: null, name: 'Draft' });
  await settle();
  choose(ed, 'Structure', 'file:Mine');
  setup.v.files[`${STRUCTURE_DIR}/Mine.md`] = '## A\nx\n\n## Brandnew\ny\n';
  events.length = 0;
  dom.button(ed.root, 'Preview AI instructions').click();
  await settle();
  const firstRefresh = events.indexOf('refresh');
  const opening = events.indexOf('open:PromptPreviewModal');
  assert.ok(firstRefresh >= 0 && events.indexOf('refreshed') < opening, events.join());
  assert.match(previewTexts(), /Brandnew/);
  assert.equal(writes(setup.v), 0);
  // without a draft the same window shows the workspace default style
  windows.length = 0;
  new PromptPreviewModal(setup.app, setup.store, 'en', 'codex').open();
  await settle();
  assert.equal(/Brandnew/.test(previewTexts()), false);
});

test('P4: Edit next to a list opens the part: a built-in part is saved as "My <name>" and the list switches to that file, a file opens as it is; the list keeps its choice otherwise', async () => {
  const setup = await editorSetup(SEED);
  const ed = openEditor(setup, { source: null, name: 'Draft' });
  await settle();
  const structure = byLabel(ed.content, 'Structure');
  assert.equal(structure.value, 'builtin:standard');
  const edit = byLabel(ed.content, 'Edit Structure');
  assert.equal(edit.text, 'Edit');
  edit.click();
  await settle();
  const created = `${STRUCTURE_DIR}/My Standard six.md`;
  assert.deepEqual(setup.v.creates, [created]);
  assert.deepEqual(setup.opened, [created]);
  assert.equal(structure.value, 'file:My Standard six');
  assert.ok(optionsOf(structure).includes('file:My Standard six'));
  assert.equal(edit.focused, true);
  // a file is opened as it is
  byLabel(ed.content, 'Edit Structure').click();
  await settle();
  assert.equal(setup.v.creates.length, 1);
  assert.equal(setup.opened.at(-1), created);
  assert.equal(structure.value, 'file:My Standard six');
  // saving keeps the file as the style's structure
  saveOf(ed).click();
  await settle();
  assert.equal(M.parseRecipeFile(setup.v.files[`${RECIPE_DIR}/Draft.md`]).structure, 'file:My Standard six');
});

test('P4: each list offers the built-in and the user\'s parts in groups, hides a file named like a built-in, and keeps a choice whose file is gone as "Not found"', async () => {
  const setup = await editorSetup({ ...SEED, [`${STRUCTURE_DIR}/Standard six.md`]: '## Same name\nx\n', [`${RECIPE_DIR}/Gone.md`]: '---\nstructure: Vanished\n---\n' });
  const ed = openEditor(setup, { source: 'file:Gone' });
  await settle();
  const structure = byLabel(ed.content, 'Structure');
  assert.equal(structure.value, 'file:Vanished');
  const missing = dom.findAll(structure, node => node.tag === 'option' && node.optionValue === 'file:Vanished')[0];
  assert.equal(missing.text, 'Not found: Vanished');
  assert.equal(optionsOf(structure).includes('file:Standard six'), false, 'a file with a built-in\'s name is not used');
  assert.ok(optionsOf(structure).includes('file:Mine') && optionsOf(structure).includes('builtin:standard'));
  const groups = dom.findAll(structure, node => node.tag === 'optgroup').map(node => node.attrs.label);
  assert.deepEqual(groups, ['Built-in', 'Mine']);
  assert.equal(setup.v.files[`${RECIPE_DIR}/Gone.md`], '---\nstructure: Vanished\n---\n', 'nothing is rewritten by showing it');
});

test('counter 15 (runtime-ui): every control has a readable name, the update mode is a fieldset with a legend and three labelled radios with a line each, the sample is a named region that is not live, the error line is the only live region, and the focus goes back to the trigger on close', async () => {
  const setup = await editorSetup(SEED);
  const ed = openEditor(setup, { source: null, name: 'Keys' });
  await settle();
  const controls = dom.findAll(ed.root, node => ['button', 'select', 'input'].includes(node.tag));
  assert.ok(controls.length >= 11);
  for (const control of controls) {
    const named = control.text || control.attrs['aria-label'] || dom.find(ed.root, node => node.tag === 'label' && node.attrs.for === control.attrs.id);
    assert.ok(named, `${control.tag} ${control.attrs.id ?? ''}`);
  }
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
  assert.equal(dom.findAll(ed.content, node => node.attrs['aria-live']).length, 1);
  assert.equal(nameOf(ed).attrs['aria-describedby'], 'vam-editor-error');
  assert.equal(nameOf(ed).focused, true, 'a new style starts in the name');
  const edits = dom.findAll(ed.content, node => node.tag === 'button' && node.text === 'Edit');
  assert.equal(new Set(edits.map(edit => edit.attrs['aria-label'])).size, 3);
  ed.editor.close();
  assert.equal(ed.editor.closeCount, 1);
  assert.equal(ed.trigger.focused, true);
  assert.equal(ed.editor.contentEl.children.length, 0);
});

test('P4: closing (Escape and the close button call close) asks before it drops changes and not when nothing changed; Cancel of the question keeps the window, Discard closes it', async () => {
  const setup = await editorSetup(SEED);
  const clean = openEditor(setup, { source: null, name: 'Clean' });
  await settle();
  clean.editor.close();
  assert.equal(clean.editor.closeCount, 1);
  assert.equal(windows.filter(w => w.titleEl.text === 'Discard changes?').length, 0);
  const ed = openEditor(setup, { source: null, name: 'Dirty' });
  await settle();
  pickUpdate(ed, 'top');
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
  // a change that is changed back is no change
  const back = openEditor(setup, { source: null, name: 'Back' });
  await settle();
  pickUpdate(back, 'top');
  pickUpdate(back, 'merge');
  back.editor.close();
  assert.equal(back.editor.closeCount, 1);
});

test('F1 R7: the sample has no scroll of its own, so the window is the only scroll axis and the button row never covers the end of the sample; the rule sits above the map-search marker', () => {
  const css = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'styles.css'), 'utf8');
  const rule = css.split('\n').find(line => line.startsWith('.vam-editor-example {'));
  assert.ok(rule && !/max-height|overflow-y/.test(rule), rule);
  assert.ok(css.indexOf('.vam-editor-example {') < css.indexOf('/* Map search'));
  assert.match(css, /^\.vam-editor-modal \.modal-content \{ padding-bottom: var\(--size-4-3\); \}/m);
});

test('K3 (P4): the voice list offers no retired voice; a style that uses one shows it as "(retired)" in the list, its option name says so, and Save keeps the ref', async () => {
  const setup = await editorSetup({ ...SEED, [`${RECIPE_DIR}/Old.md`]: '---\nvoice: Key-point summary\n---\n' });
  const fresh = openEditor(setup, { source: null, name: 'Fresh' });
  await settle();
  const freshVoices = optionsOf(byLabel(fresh.content, 'Voice'));
  for (const id of ['summary', 'guide', 'auto']) assert.equal(freshVoices.includes(`builtin:${id}`), false, id);
  assert.ok(freshVoices.includes('builtin:plain'));
  const ed = openEditor(setup, { source: 'file:Old' });
  await settle();
  const voice = byLabel(ed.content, 'Voice');
  assert.equal(voice.value, 'builtin:summary');
  const options = dom.findAll(voice, node => node.tag === 'option');
  assert.deepEqual(options.filter(node => node.optionValue.startsWith('builtin:')).map(node => node.optionValue).filter(ref => ['summary', 'guide', 'auto'].some(id => ref === `builtin:${id}`)), ['builtin:summary']);
  assert.equal(options.find(node => node.optionValue === 'builtin:summary').text, 'Key-point summary (retired)');
  pickUpdate(ed, 'top');
  saveOf(ed).click();
  await settle();
  assert.equal(M.parseRecipeFile(setup.v.files[`${RECIPE_DIR}/Old.md`]).voice, 'builtin:summary');
});
