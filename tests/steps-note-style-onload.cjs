// P4: loading the plugin (onload and the layout-ready callbacks) never creates or modifies a vault file, including the style folder.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const S = require('./support.cjs');

const { default: Plugin } = S.load('main.ts', { obsidian: S.obsidian });

test('onload and layout-ready write nothing to the vault: no create, modify, createFolder, rename, trash or adapter write', async () => {
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
    workspace: { onLayoutReady: callback => callback(), on: () => ({}), getLeavesOfType: () => [], getActiveFile: () => null, getActiveViewOfType: () => null, layoutReady: true }, loadLocalStorage: () => null, saveLocalStorage() {} };
  plugin.loadData = async () => ({ migrated: true, structureVersion: 2, workspaceInitialized: true, noteStylesFolder: 'WS/Styles' });
  plugin.saveData = async () => {};
  plugin.addCommand = command => command;
  let error;
  try { await plugin.onload(); await plugin.ready; await new Promise(resolve => setImmediate(resolve)); } catch (caught) { error = caught; }
  assert.equal(error, undefined, String(error?.stack));
  assert.deepEqual(writes, []);
  assert.ok(listeners.includes('rename'), 'the folder-rename listener is registered at load');
  // Control: the recorder sees a user action (opening the style folder), so the empty list above is not a blind spot.
  await plugin.noteStyles.ensureStyleFolder().catch(() => undefined);
  assert.ok(writes.length > 0, 'ensureStyleFolder writes through the same recorder');
});
