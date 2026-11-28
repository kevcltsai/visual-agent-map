// Shared helpers, fixtures and module loads for the unit/integration suites in tests/suites.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const vm = require('node:vm');
const path = require('node:path');
const { test: nodeTest } = require('node:test');
const directSuite = process.argv[1] && path.dirname(path.resolve(process.argv[1])) === path.join(__dirname, 'suites');
const layer = process.argv.find(value => value.startsWith('--layer='))?.split('=')[1] || (directSuite ? process.env.VAM_ISOLATED_TEST_LAYER : undefined);
if (layer && !['unit', 'integration'].includes(layer)) throw new Error('Unknown test layer');
// A test that never settles fails after this long instead of hanging the run; VAM_TEST_TIMEOUT_MS overrides it (the timeout test uses a tiny value), and options a test passes itself win.
const testTimeout = Number(process.env.VAM_TEST_TIMEOUT_MS) || 60000;
const register = (name, optionsOrFn, maybeFn) => {
  if (typeof optionsOrFn === 'function') nodeTest(name, { timeout: testTimeout }, optionsOrFn);
  else nodeTest(name, { timeout: testTimeout, ...optionsOrFn }, maybeFn);
};
const test = (name, optionsOrFn, maybeFn) => { if (!layer || layer === 'unit') register(name, optionsOrFn, maybeFn); };
const integrationTest = (name, optionsOrFn, maybeFn) => { if (!layer || layer === 'integration') register(name, optionsOrFn, maybeFn); };
const { buildSync, recordCachedEntry } = require('./build.cjs');
// Obsidian's own YAML options, so frontmatter in tests round-trips like the real app (not a one-line-per-key stub).
const YAML = require('yaml');
const root = path.resolve(__dirname, '..');
function load(entry, overrides = {}, windowValues = {}, buildOptions = {}) {
  if (overrides.obsidian && !overrides.obsidian.Component) overrides = { ...overrides, obsidian: { ...overrides.obsidian, Component: class {} } };
  if (overrides.obsidian && !overrides.obsidian.addIcon) overrides = { ...overrides, obsidian: { ...overrides.obsidian, addIcon() {} } };
  if (overrides.obsidian && !overrides.obsidian.MarkdownRenderChild) overrides = { ...overrides, obsidian: { ...overrides.obsidian, MarkdownRenderChild: class {} } };
  const code = buildSync({ entryPoints: [path.join(root, entry)], external: ['obsidian', 'node:*'], ...buildOptions }).outputFiles[0].text;
  const module = { exports: {} };
  vm.runInNewContext(code, { get activeWindow() { return windowValues.activeWindow; }, get activeDocument() { return windowValues.activeDocument; }, module, exports: module.exports, require: name => overrides[name] || require(name), console, TextDecoder, TextEncoder, btoa, Blob, URL, Event, crypto: require('node:crypto').webcrypto, process, AbortController, navigator: windowValues.navigator, CSS: windowValues.CSS, document: windowValues.document, createSvg: windowValues.createSvg, createEl: windowValues.createEl, createSpan: windowValues.createSpan, Option: class { constructor(text, value) { this.tag = 'option'; this.text = text; this.value = value; this.cls = ''; this.children = []; this.attrs = {}; } }, HTMLInputElement: class {}, HTMLTextAreaElement: class {}, HTMLSelectElement: class {}, window: { setTimeout, clearTimeout, ...windowValues } });
  // The view reaches the running set, stop registry and pending suggestions only through plugin.topicRuns (04c): a plugin double gets a TopicRuns over its own fields.
  if (typeof module.exports.VisualAgentMapView === 'function') {
    const View = module.exports.VisualAgentMapView;
    return { ...module.exports, VisualAgentMapView: class extends View { constructor(leaf, plugin) { super(leaf, plugin && !('topicRuns' in plugin) ? attachTopicRuns(plugin) : plugin); } } };
  }
  return module.exports;
}
/** The shipped build: AIM was removed, so this is `load` (tests/suites/legacy-aim-map.cjs keeps its name for what it loads). */
const loadHidden = (entry, overrides = {}, windowValues = {}) => load(entry, overrides, windowValues);
// Cache evaluated modules without attributing their entire dependency graph to
// every test that imports this helper. Credit the actual consumer on each hit.
function loadCached(entry, cached, overrides = {}) {
  if (cached) { recordCachedEntry(entry); return cached; }
  return load(entry, overrides);
}
let core, layout, logging;
const node = (id, parentId = null, collapsed = false) => ({ id, parentId, path: `${id}.md`, x: 0, y: 0, collapsed });
const map = nodes => ({ id: 'map', title: '測試心智圖', version: 1, nodes, viewport: { x: 0, y: 0, zoom: 1 } });
const plain = obj => JSON.parse(JSON.stringify(obj));
const tree = () => [node('a'), node('b', 'a'), node('c', 'b'), node('d')];
let topicRunsModule;
/** The run module over a view-level plugin double: every port reads the double on use, like the real composition root. */
let noteStyleModule;
/** Starts a research run straight on the plugin's run module, with no view: the callbacks a view would give are test stand-ins. */
function startResearch(plugin, node, { map, request, runOnce, done, failed, accepted, ...rest } = {}) {
  return plugin.topicRuns.start(node.path, 'research', { map, request, runOnce, done, failed, accepted, notify: () => {}, ancestors: async () => '', userTexts: () => '', ...rest });
}
function attachTopicRuns(plugin) {
  if (plugin.topicRuns) return plugin;
  noteStyleModule = loadCached('ai/note-style-store.ts', noteStyleModule, { obsidian: module.exports.obsidian ?? {} });
  topicRunsModule = loadCached('experiences/visual-map/topic-run.ts', topicRunsModule, { obsidian: module.exports.obsidian ?? {} });
  const { NoteStyleStore: NoteStyleStoreClass } = noteStyleModule;
  const { TopicRuns: TopicRunsClass } = topicRunsModule;
  plugin.topicRuns = new TopicRunsClass({
    aiTasks: () => plugin.aiTasks ?? { chartEligible: () => false }, mutate: () => work => plugin.mutate ? plugin.mutate(work) : work(), progress: () => plugin.researchProgress,
    repository: () => plugin.repo, running: () => plugin.running ??= new Set(), pendingSuggestions: () => plugin.pendingSuggestions ??= new Map(), activeTasks: () => plugin.activeTasks ??= new Map(),
    askModel: (...args) => plugin.askModel(...args), settings: () => plugin.settings, exchanges: () => plugin.exchanges, recordFailure: (...args) => plugin.recordFailure(...args),
    runStyle: ({ note, outputLanguage, rewrite }) => (plugin.noteStyles ??= new NoteStyleStoreClass({ settings: () => plugin.settings, port: {}, save: async () => {} })).runStyle({ topic: { style: note.noteStyle, template: note.detailTemplateId, tone: note.toneId }, kind: note.topicKind ?? 'topic', outputLanguage, detail: note.detail, ...(rewrite ? { rewrite } : {}) }), resolveModel: (path, map, runOnce) => plugin.repo.resolveTopicModel(path, map, runOnce),
    clearOtherHistory: origin => { for (const view of plugin.views?.() ?? []) if (view !== origin) view.clearUndoHistory?.(); },
    refreshViews: () => { for (const view of plugin.views?.() ?? []) view.reloadAfterAiRun?.(); }
  });
  // The chart queue of the double stays the double's: the view-level tests spy on these two calls.
  return plugin;
}
/** Replaces the research run at the module seam (TopicRuns.start); the stub gets what view.runAgent used to get: node, done, failed, request, accepted, runOnce. */
function researchSeam(view) {
  return { set run(stub) { const runs = view.plugin.topicRuns, original = runs.start.bind(runs); runs.start = (path, kind, options) => kind !== 'research' ? original(path, kind, options) : stub(view.map?.nodes.find(node => node.path === path) ?? { path }, options.done, options.failed, options.request, options.accepted, options.runOnce); } };
}
function withExpansionCoordinator(plugin) {
  const { ShallowExpansionCoordinator } = load('experiences/visual-map/expansion-batch.ts');
  plugin.activeTasks ??= new Map(); plugin.expansionBatches = new Map(); plugin.quickExpandPending ??= new Set();
  // Background chart jobs belong to the real plugin; the view-level doubles only need the two calls to exist.
  plugin.abortChartJobs ??= () => {}; plugin.addChartsAfterWrite ??= () => {};
  plugin.expansionCoordinator = new ShallowExpansionCoordinator(plugin.activeTasks, plugin.expansionBatches);
  attachTopicRuns(plugin);
  // The real plugin resolves the current model one way (ADR-021); a double over settings answers the same.
  plugin.currentModelChoice ??= () => ({ model: plugin.settings.cliModel, reasoning: repositoryModule().normalizeReasoningLevel(plugin.settings.cliReasoning) });
  return plugin;
}
class TFolder { constructor(path) { this.path = path; this.name = path.split('/').at(-1); this.children = []; this.parent = null; } }
class TFile { constructor(path) { this.path = path; this.name = path.split('/').at(-1); this.basename = this.name.replace(/\.md$/, ''); this.extension = this.name.includes('.') ? this.name.split('.').at(-1) : ''; this.parent = null; this.stat = { mtime: Date.now() }; } }
// Obsidian caches what it parses from a note's frontmatter, and the fixture's getFileCache asks for it once per note per read; memoising by the text gives the same answers (the key is the content, so a changed note never hits). Callers get a copy, and a text that throws is not cached.
const yamlMemo = new Map();
function cachedParseYaml(text) {
  if (yamlMemo.has(text)) return structuredClone(yamlMemo.get(text));
  const parsed = YAML.parse(text, null, {});
  if (yamlMemo.size >= 20000) yamlMemo.clear();
  yamlMemo.set(text, structuredClone(parsed));
  return parsed;
}
const obsidian = { Platform: { isMacOS: false }, setIcon: (parent, name) => { parent.iconName = name; }, setTooltip() {}, displayTooltip() {}, Menu: class { addItem(callback) { callback({ setTitle() { return this; }, setIcon() { return this; }, setWarning() { return this; }, onClick() { return this; } }); return this; } addSeparator() { return this; } showAtMouseEvent() { return this; } },
  Scope: class { constructor(parent) { this.parent = parent; this.keys = []; } register(modifiers, key, func) { const handler = { modifiers, key, func }; this.keys.push(handler); return handler; } unregister(handler) { this.keys = this.keys.filter(item => item !== handler); } },
  TFile, TFolder, App: class {}, Plugin: class {}, ItemView: class { constructor(leaf) { this.app = leaf.app; } async setState() {} }, PluginSettingTab: class {}, Modal: class {}, FuzzySuggestModal: class {}, Notice: class {}, FileSystemAdapter: class { getBasePath() { return '/vault'; } },
  normalizePath: value => value.replace(/\/+/g, '/').replace(/^\//, ''),
  parseYaml: cachedParseYaml,
  stringifyYaml: obj => YAML.stringify(obj, null, { nullStr: '', lineWidth: 0, aliasDuplicateObjects: false })
};
// Preserve shared module identity without evaluating unused product modules for basic helpers.
let repository;
const repositoryModule = () => (repository = loadCached('repository.ts', repository, { obsidian }));
function fixture(language = 'zh-TW', options = {}) {
  const { Repository, DEFAULT_SETTINGS } = repositoryModule();
  const files = new Map(), contents = new Map(), trashed = [];
  const attach = item => { const folderPath = item.path.split('/').slice(0, -1).join('/'); item.parent = files.get(folderPath) || null; // Obsidian's vault tree hides dot-files and dot-folders; the adapter (disk) listing below still reports them.
    if (item.parent instanceof TFolder && !item.name.startsWith('.') && !item.parent.children.includes(item)) item.parent.children.push(item); };
  const renameTree = (from, to) => { const entries = Array.from(files.entries()).filter(([p]) => p === from || p.startsWith(`${from}/`)).sort((a, b) => a[0].length - b[0].length); for (const [old, item] of entries) { files.delete(old); if (item.parent?.children) item.parent.children = item.parent.children.filter(child => child !== item); const next = `${to}${old.slice(from.length)}`; item.path = next; item.name = next.split('/').at(-1); if (item instanceof TFile) { item.basename = item.name.replace(/\.md$/, ''); item.stat.mtime = Date.now(); const content = contents.get(old); contents.delete(old); contents.set(next, content); } files.set(next, item); } for (const [, item] of entries) attach(item); };
  const app = { vault: {
    configDir: '.obsidian',
    getAbstractFileByPath: p => files.get(p),
    getMarkdownFiles: () => Array.from(files.values()).filter(file => file instanceof TFile && file.extension === 'md'),
    read: async file => contents.get(file.path), cachedRead: async file => contents.get(file.path),
    createFolder: async p => { if (files.has(p)) throw new Error(`Folder already exists: ${p}`); const folder = new TFolder(p); files.set(p, folder); attach(folder); return folder; },
    create: async (p, content) => { assert.equal(files.has(p), false); const file = new TFile(p); files.set(p, file); contents.set(p, content); attach(file); return file; },
    createBinary: async (p, content) => { assert.equal(files.has(p), false); const file = new TFile(p); files.set(p, file); contents.set(p, content); attach(file); return file; },
    process: async (file, change) => { contents.set(file.path, change(contents.get(file.path))); },
    // Like Vault.append: it does not throw for a handle whose file is gone (trashed), it writes the path again as a new file holding only `data`.
    append: async (file, data) => { if (!files.has(file.path)) { files.set(file.path, file); contents.set(file.path, ''); attach(file); } contents.set(file.path, (contents.get(file.path) ?? '') + data); },
    // Moves without touching any link, like Obsidian's Vault.rename.
    rename: async (item, target) => renameTree(item.path, target),
    adapter: {
      exists: async p => files.has(p),
      mkdir: async p => { if (files.has(p)) throw new Error(`Folder already exists: ${p}`); const folder = new TFolder(p); files.set(p, folder); attach(folder); },
      append: async (p, data) => { if (!files.has(p)) throw new Error(`Missing file: ${p}`); contents.set(p, (contents.get(p) ?? '') + data); },
      rename: async (from, to) => renameTree(from, to),
      list: async p => ({ files: [...files.values()].filter(file => file instanceof TFile && file.parent?.path === p).map(file => file.path), folders: [...files.values()].filter(file => file instanceof TFolder && file.parent?.path === p).map(file => file.path) }),
      read: async p => { if (!contents.has(p)) throw new Error(`Missing file: ${p}`); return contents.get(p); },
      write: async (p, value) => { if (!files.has(p)) { const file = new TFile(p); files.set(p, file); attach(file); } contents.set(p, value); },
      process: async (p, change) => { if (!contents.has(p)) throw new Error(`Missing file: ${p}`); const next = change(contents.get(p)); contents.set(p, next); return next; }
    }
  }, metadataCache: { getFileCache: file => { const text = contents.get(file.path) || ''; const block = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1]; return { frontmatter: block ? obsidian.parseYaml(block) : {} }; }, getFirstLinkpathDest: link => { const key = link.replace(/\.md$/, ''); return Array.from(files.values()).find(file => file instanceof TFile && (file.basename === key || file.path.replace(/\.md$/, '') === key)) || null; } }, fileManager: { renameFile: async (item, target) => renameTree(item.path, target), trashFile: async item => { trashed.push(item.path); } } };
  // Opt-in link index: resolvedLinks is computed from the current text (frontmatter and body wikilinks), like Obsidian's.
  if (options.linkIndex) Object.defineProperty(app.metadataCache, 'resolvedLinks', { configurable: true, get: () => { const index = {}; for (const [path, text] of contents) { if (!(files.get(path) instanceof TFile) || !path.endsWith('.md')) continue; for (const match of String(text).matchAll(/!?\[\[([^\]|#\n]+)/g)) { const dest = app.metadataCache.getFirstLinkpathDest(match[1].trim()); if (!dest) continue; index[path] ||= {}; index[path][dest.path] = (index[path][dest.path] || 0) + 1; } } return index; } });
  return { app, contents, files, trashed, repo: new (options.Repository ?? Repository)(app, { ...DEFAULT_SETTINGS, language }) };
}
async function topicNote(repo, title = '題目', model = 'model-a', id = 'map-a') {
  const mapDoc = { id, title: id, version: 1, nodes: [], viewport: { x: 0, y: 0, zoom: 1 } };
  const mapPath = `Agent Workspace/Topics/${id}/Map.md`; await repo.ensureTopicFolders(`Agent Workspace/Topics/${id}`);
  return repo.createNote(title, model, mapDoc, mapPath, 'workspace');
}
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const until = async predicate => { for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise(r => setImmediate(r)); } throw new Error('condition not reached'); };
/** Ids of every registered language, read from the registry so a new language needs no test edit. */
const languageIds = () => load('i18n/languages.ts').LANGUAGES.map(item => item.id);
/** Dictionary text of the i18n facade plus every registered language file, for tests that scan translation keys and values. */
// A headless Chrome a test starts in its own process group outlives this process if it is killed before its `finally` runs (a SIGKILL, a runner killing a stuck file).
// This watchdog shell checks both every second: once this process is gone it ends the Chrome group and removes its profile; once Chrome is gone it just exits.
const reapIfOrphaned = (child, profile) => {
  const script = 'while kill -0 "$1" 2>/dev/null && kill -0 "$2" 2>/dev/null; do sleep 1; done; kill -0 "$1" 2>/dev/null || { kill -9 -"$2" 2>/dev/null; kill -9 "$2" 2>/dev/null; rm -rf "$3"; }';
  require('node:child_process').spawn('/bin/sh', ['-c', script, 'vam-chrome-reaper', String(process.pid), String(child.pid), profile], { stdio: 'ignore', detached: true }).unref();
};
const i18nSource = (language) => [language ? [] : ['i18n.ts', ...languageIds().map(id => `i18n/${id}.ts`)], language ? [`i18n/${language}.ts`] : []].flat().map(file => require('node:fs').readFileSync(path.join(root, file), 'utf8')).join('\n');
module.exports = { loadHidden, startResearch, researchSeam, attachTopicRuns, i18nSource, languageIds, test, integrationTest, root, load, get core() { return core = loadCached('map-model.ts', core); }, get layout() { return layout = loadCached('map-layout.ts', layout); }, get logging() { return logging = loadCached('log-manager.ts', logging); }, node, map, plain, tree, withExpansionCoordinator, TFolder, TFile, obsidian, get Repository() { return repositoryModule().Repository; }, get DEFAULT_SETTINGS() { return repositoryModule().DEFAULT_SETTINGS; }, get normalizeReasoningLevel() { return repositoryModule().normalizeReasoningLevel; }, fixture, topicNote, deferred, until, reapIfOrphaned };
