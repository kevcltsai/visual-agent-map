const assert = require('node:assert/strict');
const vm = require('node:vm');
const path = require('node:path');
const { test } = require('node:test');
const { buildSync } = require('esbuild');

const root = path.resolve(__dirname, '..');
class TFolder {
  constructor(filePath) { this.path = filePath; this.name = filePath.split('/').at(-1); this.children = []; this.parent = null; }
}
class TFile {
  constructor(filePath) { this.path = filePath; this.name = filePath.split('/').at(-1); this.basename = this.name.replace(/\.md$/, ''); this.extension = this.name.split('.').at(-1); this.parent = null; this.stat = { mtime: Date.now() }; }
}
const obsidian = {
  TFile,
  TFolder,
  normalizePath: value => value.replace(/\\/g, '/').replace(/\/+/g, '/'),
};
function load(entry) {
  const code = buildSync({ entryPoints: [path.join(root, entry)], bundle: true, write: false, platform: 'node', format: 'cjs', external: ['obsidian', 'node:*'] }).outputFiles[0].text;
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports, require: name => name === 'obsidian' ? obsidian : require(name), console, crypto: require('node:crypto').webcrypto, AbortController, window: { setTimeout, clearTimeout } });
  return module.exports;
}
function fixture() {
  const files = new Map(), contents = new Map();
  const attach = item => {
    const parentPath = item.path.split('/').slice(0, -1).join('/');
    item.parent = files.get(parentPath) ?? null;
    if (item.parent instanceof TFolder && !item.parent.children.includes(item)) item.parent.children.push(item);
  };
  const createFolder = async filePath => {
    if (files.has(filePath)) throw new Error(`Folder already exists: ${filePath}`);
    const folder = new TFolder(filePath); files.set(filePath, folder); attach(folder); return folder;
  };
  const createFile = async (filePath, text) => {
    if (files.has(filePath)) throw new Error(`File already exists: ${filePath}`);
    const file = new TFile(filePath); files.set(filePath, file); contents.set(filePath, text); attach(file); return file;
  };
  const app = { vault: {
    getAbstractFileByPath: filePath => files.get(filePath) ?? null,
    getFiles: () => [...files.values()].filter(file => file instanceof TFile),
    read: async file => contents.get(file.path),
    createFolder,
    create: createFile,
    process: async (file, change) => { contents.set(file.path, change(contents.get(file.path))); },
    adapter: {
      exists: async filePath => files.has(filePath),
      mkdir: createFolder,
      list: async folderPath => ({
        files: [...files.values()].filter(file => file instanceof TFile && file.parent?.path === folderPath).map(file => file.path),
        folders: [...files.values()].filter(file => file instanceof TFolder && file.parent?.path === folderPath).map(file => file.path),
      }),
      read: async filePath => { if (!contents.has(filePath)) throw new Error(`Missing file: ${filePath}`); return contents.get(filePath); },
      write: async (filePath, value) => { if (!files.has(filePath)) { const file = new TFile(filePath); files.set(filePath, file); attach(file); } contents.set(filePath, value); },
      process: async (filePath, change) => { if (!contents.has(filePath)) throw new Error(`Missing file: ${filePath}`); const next = change(contents.get(filePath)); contents.set(filePath, next); return next; },
    },
  } };
  return { app, contents };
}

test('Coffee customization and convergence metadata round trip; undo survives saved History', async () => {
  const { CoffeeStorage } = load('experiences/coffee-tables/storage.ts');
  const { CoffeeEngine } = load('experiences/coffee-tables/engine.ts');
  const types = load('experiences/coffee-tables/types.ts');
  const insights = load('experiences/coffee-tables/insights.ts');
  const { app, contents } = fixture();
  const store = new CoffeeStorage(app.vault, 'Workspace');
  const session = types.createSession('Storage round trip', 'model', 'low', 'en');
  const longPrompt = 'Keep this preference. '.repeat(900);
  const customization = { observerPrompt: longPrompt, convergencePrompt: longPrompt, mergeLevel: 'balanced', detailLevel: 'standard', preserve: ['disagreements', 'sources'] };
  const currentNotes = insights.serializeInsightNotes(insights.baselineFromVersions(['# Observer’s notes\n\n## Unexpected connections\n- Accepted new insight. <!-- coffee-insight:v1:id=insight-current -->'], 'en'), 'en');
  const priorNotes = insights.serializeInsightNotes(insights.baselineFromVersions(['# Observer’s notes\n\n## Core disagreements\n- Original insight. <!-- coffee-insight:v1:id=insight-original -->'], 'en'), 'en');
  const raw = `${'x'.repeat(18_000)}\n\n## Observer notes\nThis stays in the sidecar.`;
  session.status = 'completed';
  session.guests.customization = customization;
  session.observerNotes = [currentNotes];
  session.pinnedInsightIds = ['insight-current'];
  session.convergenceRawDraft = raw;
  session.convergenceDraft = {
    baseFingerprint: 'coffee-notes-fixture',
    proposals: [{ sourceIds: ['insight-current'], summary: 'Accepted new insight.', detail: 'Retain its context.', category: 'connections' }],
    raw,
    createdAt: session.createdAt,
    customization,
  };
  await store.save(session);

  const path = store.sessionPath(session.id);
  const initialMarkdown = contents.get(path);
  assert.equal(initialMarkdown.includes(raw), false);
  const sidecarPath = store.sidecarPath(session.id);
  const sidecar = JSON.parse(contents.get(sidecarPath));
  sidecar.convergenceUndo = { notes: [priorNotes], expectedNotes: [currentNotes] };
  contents.set(sidecarPath, JSON.stringify(sidecar, null, 2));
  contents.set(path, `${initialMarkdown}\n\n### History\n\n#### Version 1\n\n# Observer’s notes\n\n## Core disagreements\n- Stale historical insight. <!-- coffee-insight:v1:id=insight-stale -->`);

  const reopened = new CoffeeStorage(app.vault, 'Workspace');
  const restored = await reopened.load(session.id);
  assert.deepEqual(JSON.parse(JSON.stringify(restored.guests.customization)), customization);
  assert.deepEqual([...restored.pinnedInsightIds], ['insight-current']);
  assert.equal(restored.convergenceRawDraft, raw);
  assert.equal(restored.convergenceDraft.raw, raw);
  assert.equal(restored.observerNotes.length, 1);
  assert.match(restored.observerNotes[0], /Accepted new insight/);
  assert.doesNotMatch(restored.observerNotes[0], /Stale historical insight/);
  assert.doesNotMatch(restored.observerNotes[0], /This stays in the sidecar/);
  assert.deepEqual(JSON.parse(JSON.stringify(restored.convergenceUndo.expectedNotes)), JSON.parse(JSON.stringify(restored.observerNotes)));

  const engine = new CoffeeEngine(restored, async () => { throw new Error('provider must not be called'); }, value => reopened.save(value));
  await engine.undoConvergence();
  assert.deepEqual([...engine.session.observerNotes], [priorNotes]);
  const afterUndo = await new CoffeeStorage(app.vault, 'Workspace').load(session.id);
  assert.match(afterUndo.observerNotes[0], /Original insight/);
  assert.doesNotMatch(afterUndo.observerNotes[0], /Stale historical insight|Accepted new insight/);
});

test('external observer-note headings invalidate convergence undo without dropping their text', async () => {
  const { CoffeeStorage } = load('experiences/coffee-tables/storage.ts');
  const { CoffeeEngine } = load('experiences/coffee-tables/engine.ts');
  const types = load('experiences/coffee-tables/types.ts');
  const insights = load('experiences/coffee-tables/insights.ts');
  const { app, contents } = fixture();
  const store = new CoffeeStorage(app.vault, 'Workspace');
  const session = types.createSession('Edited observer notes', 'model', 'low', 'en');
  const currentNotes = insights.serializeInsightNotes(insights.baselineFromVersions(['# Observer’s notes\n\n## Unexpected connections\n- Converged insight. <!-- coffee-insight:v1:id=insight-converged -->'], 'en'), 'en');
  const priorNotes = insights.serializeInsightNotes(insights.baselineFromVersions(['# Observer’s notes\n\n## Core disagreements\n- Original insight. <!-- coffee-insight:v1:id=insight-original -->'], 'en'), 'en');
  session.status = 'completed';
  session.observerNotes = [currentNotes];
  session.convergenceUndo = { notes: [priorNotes], expectedNotes: [currentNotes] };
  await store.save(session);

  const path = store.sessionPath(session.id);
  const original = contents.get(path);
  const edited = original.replace('## Assumptions to verify', '## User annotation\n\nKeep this note.\n\n## Assumptions to verify');
  contents.set(path, edited);
  const reopened = new CoffeeStorage(app.vault, 'Workspace');
  const restored = await reopened.load(session.id);
  assert.match(restored.observerNotes[0], /Keep this note\./);
  const engine = new CoffeeEngine(restored, async () => { throw new Error('provider must not be called'); }, value => reopened.save(value));
  await assert.rejects(engine.undoConvergence(), /Observer notes changed after convergence/);
  assert.match(engine.session.observerNotes[0], /Keep this note\./);
  assert.equal(contents.get(path), edited);
});

test('a stored convergence preview remains applicable after reopening the table', async () => {
  const { CoffeeStorage } = load('experiences/coffee-tables/storage.ts');
  const { CoffeeEngine } = load('experiences/coffee-tables/engine.ts');
  const types = load('experiences/coffee-tables/types.ts');
  const insights = load('experiences/coffee-tables/insights.ts');
  const convergence = load('experiences/coffee-tables/convergence.ts');
  const { app } = fixture();
  const firstStore = new CoffeeStorage(app.vault, 'Workspace');
  const session = types.createSession('Preview persists', 'model', 'low', 'en');
  const notes = insights.serializeInsightNotes(insights.baselineFromVersions(['# Observer’s notes\n\n## Unexpected connections\n- Original insight. <!-- coffee-insight:v1:id=insight-source -->'], 'en'), 'en');
  session.status = 'completed';
  session.observerNotes = [notes];
  await firstStore.save(session);

  const source = await new CoffeeStorage(app.vault, 'Workspace').load(session.id);
  const firstEngine = new CoffeeEngine(source, async () => JSON.stringify({ proposals: [{ sourceIds: ['insight-source'], summary: 'A converged insight.', detail: 'The original context remains visible.', category: 'connections' }] }), value => firstStore.save(value));
  await firstEngine.previewConvergence();

  const secondStore = new CoffeeStorage(app.vault, 'Workspace');
  const reopened = await secondStore.load(session.id);
  assert.ok(reopened.convergenceDraft);
  assert.equal(reopened.convergenceDraft.baseFingerprint, convergence.convergenceFingerprint(reopened));
  const secondEngine = new CoffeeEngine(reopened, async () => { throw new Error('provider must not be called'); }, value => secondStore.save(value));
  await secondEngine.applyConvergence([0]);
  assert.match(secondEngine.session.observerNotes[0], /A converged insight/);
  assert.equal(secondEngine.session.convergenceDraft, undefined);
});
