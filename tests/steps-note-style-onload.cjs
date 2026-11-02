// P4: loading the plugin (onload and the layout-ready callbacks) never creates or modifies a vault file, including the style folder.
// The one exception (note-style-recipe T3, C3 / design §9): the first load with 0.28.0 custom templates or tones creates new
// files inside the note style folder (create / createFolder only) and tells once which maps carried a style that is not used.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const S = require('./support.cjs');
const dom = require('./support-dom.cjs');

const notices = [];
const { default: Plugin } = S.load('main.ts', { obsidian: { ...S.obsidian, Notice: dom.makeNotice(notices) } });

/** `options.layoutReady: false` keeps the layout-ready callbacks back; `options.saves` records every saveData; `options.failSave` makes it throw. */
async function onloadWrites(saved, options = {}) {
  const writes = [];
  const record = name => (...args) => { writes.push([name, args[0]]); return Promise.resolve(); };
  const listeners = [];
  const vault = {
    adapter: { exists: async () => false, list: async () => ({ files: [], folders: [] }), read: async () => '', write: record('adapter.write'), mkdir: record('adapter.mkdir') },
    getAbstractFileByPath: () => null, getMarkdownFiles: () => [], getFiles: () => [], getAllLoadedFiles: () => [], getRoot: () => ({ children: [] }),
    on: (name, handler) => { listeners.push(name); return { name, handler }; },
    create: record('create'), createFolder: record('createFolder'), modify: record('modify'), process: record('process'), rename: record('rename'), trash: record('trash'), delete: record('delete')
  };
  // Obsidian's registration helpers (registerEditorExtension, registerDomEvent, ...) do nothing here; they never touch the vault.
  const bare = new Plugin();
  const plugin = new Proxy(bare, { get: (target, key, receiver) => key in target || typeof key !== 'string' || !/^(register|add)/.test(key) ? Reflect.get(target, key, receiver) : () => ({ setAttribute() {}, addClass() {}, addEventListener() {} }) });
  plugin.manifest = { id: 'visual-agent-map', version: '0.0.0-test', dir: '' };
  plugin.app = { vault, fileManager: { trashFile: record('trashFile'), renameFile: record('renameFile') }, metadataCache: { on: () => ({}), getFileCache: () => null },
    workspace: { onLayoutReady: callback => { if (options.layoutReady === false) (options.callbacks ??= []).push(callback); else callback(); }, on: () => ({}), getLeavesOfType: () => [], getActiveFile: () => null, getActiveViewOfType: () => null, layoutReady: true }, loadLocalStorage: () => null, saveLocalStorage() {} };
  plugin.loadData = async () => saved;
  plugin.saveData = async data => { if (options.failSave?.()) throw new Error('disk full'); options.saves?.push(JSON.parse(JSON.stringify(data))); };
  plugin.addCommand = command => command;
  let error;
  try { await plugin.onload(); await plugin.ready; await new Promise(resolve => setImmediate(resolve)); } catch (caught) { error = caught; }
  assert.equal(error, undefined, String(error?.stack));
  return { plugin, writes, listeners };
}

test('onload and layout-ready write nothing to the vault: no create, modify, createFolder, rename, trash or adapter write', async () => {
  const { plugin, writes, listeners } = await onloadWrites({ migrated: true, structureVersion: 2, workspaceInitialized: true, noteStylesFolder: 'WS/Styles' });
  assert.deepEqual(writes, []);
  assert.ok(listeners.includes('rename'), 'the folder-rename listener is registered at load');
  // Control: the recorder sees a user action (opening the block folder), so the empty list above is not a blind spot.
  await plugin.noteStyles.ensureBlockFolder().catch(() => undefined);
  assert.ok(writes.some(([name]) => name === 'createFolder'), 'ensureBlockFolder writes through the same recorder');
  assert.ok(!writes.some(([name]) => name === 'create'), 'and writes no file: the five built-in style files are not written any more');
});

const CUSTOM = { id: 'u1', name: 'U', sections: [{ id: 's', name: 'S', description: 'd', role: 'none', aliases: [] }] };
const BASE = { migrated: true, structureVersion: 2, workspaceInitialized: true, noteStylesFolder: 'WS/Styles' };

// was: 'onload with the old keys saved and no noteStyleUpgrade marker still writes nothing: the one-time upgrade no longer starts at layout-ready'
//   -> C3 / design §9 exception (the conversion of 0.28.0 custom content writes new files in the style folder) -> the three tests below
test('onload with only the unpublished workspace keys (no 0.28.0 custom template or tone) writes nothing to the vault', async () => {
  const saved = { ...BASE, noteTemplateBlock: 'builtin:textbook', noteToneBlock: 'builtin:plain', noteTemplateByKind: { hypothesis: 'builtin:action' } };
  const saves = [];
  const { writes } = await onloadWrites(saved, { saves });
  assert.deepEqual(writes, []);
  assert.equal(saves.at(-1).noteStyleRecipe.migrated, 1, 'only data.json gets the marker (D6)');
});

test('onload with only an outline preset writes nothing to the vault (D6: data.json marker only)', async () => {
  const { writes } = await onloadWrites({ ...BASE, promptPresets: [{ id: 'custom-outline-1', kind: 'outline', name: 'O', text: 'Two levels.' }] });
  assert.deepEqual(writes, []);
});

test('onload with 0.28.0 custom content writes only new files in the note style folder: create and createFolder, files under WS/Styles, nothing else', async () => {
  const saved = { ...BASE, defaultDetailTemplateId: 'u1', detailTemplates: [CUSTOM], promptPresets: [{ id: 'custom-tone-1', kind: 'tone', name: 'T', text: 'Voice.' }] };
  const saves = [];
  const { writes } = await onloadWrites(saved, { saves });
  assert.ok(writes.some(([name]) => name === 'create'), 'the conversion wrote files');
  for (const [name, target] of writes) {
    assert.ok(name === 'create' || name === 'createFolder', `${name} is not allowed on load`);
    // createFolder walks down from the root, so a missing parent (WS) of the style folder may be made too; a file is only ever inside it.
    if (name === 'create') assert.ok(String(target).startsWith('WS/Styles/'), `${target} is outside the note style folder`);
    else assert.ok(target === 'WS' || String(target).startsWith('WS/Styles'), `${target} is not the style folder or its parent`);
  }
  const last = saves.at(-1);
  assert.equal(last.noteStyleRecipe.legacy.templates.u1, 'file:U');
  assert.equal(last.noteStyleByKind.topic, 'file:U');
  assert.deepEqual(last.detailTemplates, [CUSTOM], 'the 0.28.0 keys are kept');
});

const FIELDS = { ...BASE, defaultDetailTemplateId: 'u1', detailTemplates: [CUSTOM], promptPresets: [] };
const mapOf = (path, title, extra = {}) => ({ file: { path, name: path.split('/').pop() }, map: { title, ...extra } });
async function lateLoad(saved, maps, options = {}) {
  const scans = { count: 0 };
  const run = await onloadWrites(saved, { layoutReady: false, ...options });
  run.plugin.repo.readableMaps = async () => { scans.count++; if (maps instanceof Error) throw maps; return maps; };
  notices.length = 0;
  return { ...run, scans, migrate: () => run.plugin.migrateNoteStyles() };
}

test('counter 10 (notice once): maps with a style of their own are listed once, in path order and by title; opening again scans nothing and says nothing', async () => {
  const saves = [];
  const maps = [mapOf('WS/Maps/B/Map.md', 'Zeta', { toneId: 'custom-tone-1' }), mapOf('WS/Maps/A/Map.md', 'Taiwan trip', { detailTemplateId: 'textbook' }), mapOf('WS/Maps/C/Map.md', 'Plain'), mapOf('WS/Maps/D/Map.md', '', { detailTemplateId: '' }), mapOf('WS/Maps/E/Map.md', '', { toneId: 'plain' })];
  const first = await lateLoad(FIELDS, maps, { saves });
  await first.migrate();
  assert.equal(notices.length, 1);
  assert.match(notices[0], /Taiwan trip/);
  assert.match(notices[0], /Zeta/);
  assert.match(notices[0], /Map\b/, 'a map with no title is listed by its file name');
  assert.doesNotMatch(notices[0], /Plain/, 'a map with no style of its own is not listed');
  assert.ok(notices[0].indexOf('Taiwan trip') < notices[0].indexOf('Zeta'), 'path order');
  assert.match(notices[0], /Weekly|U\b/, 'D5: the converted default is named in the same notice');
  assert.equal(first.scans.count, 1);
  assert.equal(saves.at(-1).noteStyleRecipe.mapsNotified, true);
  // the same plugin again, and a new session over what was saved
  notices.length = 0;
  await first.migrate();
  assert.equal(notices.length, 0);
  assert.equal(first.scans.count, 1, 'nothing is scanned once the maps have been looked at');
  const second = await lateLoad(saves.at(-1), maps, {});
  await second.migrate();
  assert.equal(notices.length, 0);
  assert.equal(second.scans.count, 0);
  assert.deepEqual(second.writes.filter(([name]) => name !== 'create' && name !== 'createFolder'), []);
});

test('counter 10 (no affected map): nothing is said, the maps are looked at once, the next load scans nothing', async () => {
  const saves = [];
  const first = await lateLoad(FIELDS, [mapOf('WS/Maps/A/Map.md', 'Plain')], { saves });
  await first.migrate();
  assert.equal(notices.length, 0);
  assert.equal(first.scans.count, 1);
  const second = await lateLoad(saves.at(-1), [mapOf('WS/Maps/A/Map.md', 'Taiwan', { detailTemplateId: 'textbook' })], {});
  await second.migrate();
  assert.equal(notices.length, 0, 'a style set on a map after the conversion is not announced later');
  assert.equal(second.scans.count, 0);
});

test('counter 10 (a map that cannot be scanned): the scan failing does not throw, converts nothing, says nothing and logs a warning; the next load tries again', async () => {
  const saves = [];
  const first = await lateLoad(FIELDS, new Error('scan failed'), { saves });
  await assert.doesNotReject(first.migrate());
  assert.equal(notices.length, 0);
  assert.equal(saves.some(data => data.noteStyleRecipe), false);
  assert.equal(first.writes.length, 0);
  assert.ok(first.plugin.logs.getLogs().some(entry => entry.level === 'warn' && /scan failed/.test(entry.message)));
});

test('counter 4 (main): a failed conversion shows the failure notice and logs a warning with the cause; the maps notice is not shown; the next load converts and tells', async () => {
  const saves = [];
  let failing = true;
  const maps = [mapOf('WS/Maps/A/Map.md', 'Taiwan trip', { detailTemplateId: 'textbook' })];
  const first = await lateLoad(FIELDS, maps, { saves, failSave: () => failing });
  const logBefore = first.plugin.logs.getLogs().length;
  await first.migrate();
  assert.equal(notices.length, 1);
  assert.match(notices[0], /did not finish/);
  assert.doesNotMatch(notices[0], /Taiwan trip/);
  assert.ok(first.plugin.logs.getLogs().slice(logBefore).some(entry => entry.level === 'warn' && /disk full/.test(entry.message)));
  assert.equal(saves.some(data => data.noteStyleRecipe), false, 'no marker');
  // next load: the files written before are reused
  failing = false;
  const second = await lateLoad(FIELDS, maps, { saves });
  await second.migrate();
  assert.equal(notices.length, 1);
  assert.match(notices[0], /Taiwan trip/);
  assert.equal(saves.at(-1).noteStyleRecipe.migrated, 1);
});

const MARKED = { ...BASE, noteStyleRecipe: { migrated: 1 } };
test('counter 4b (main): when only the maps record cannot be saved (the marker exists), the failure notice is not shown; a warning is logged and the next load tells the maps', async () => {
  const saves = [];
  let failing = true;
  const maps = [mapOf('WS/Maps/A/Map.md', 'Taiwan trip', { detailTemplateId: 'textbook' })];
  const first = await lateLoad(MARKED, maps, { saves, failSave: () => failing });
  const logBefore = first.plugin.logs.getLogs().length;
  await first.migrate();
  assert.equal(notices.length, 0);
  assert.ok(first.plugin.logs.getLogs().slice(logBefore).some(entry => entry.level === 'warn' && /disk full/.test(entry.message)));
  failing = false;
  const second = await lateLoad(MARKED, maps, { saves });
  await second.migrate();
  assert.equal(notices.length, 1);
  assert.match(notices[0], /Taiwan trip/);
});
