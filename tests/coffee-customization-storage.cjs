const assert = require('node:assert/strict');
const vm = require('node:vm');
const path = require('node:path');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
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

test('CoffeeStorage preserves same-claim insight IDs, reasons, and source groups after fresh-session load', async () => {
  const { CoffeeStorage } = load('experiences/coffee-tables/storage.ts');
  const types = load('experiences/coffee-tables/types.ts');
  const insights = load('experiences/coffee-tables/insights.ts');
  const { app } = fixture();
  const session = types.createSession('Insight source groups', 'offline-fixture', 'low', 'en');
  session.observerNotes = ['# Observer’s notes\n\n## Unexpected connections\n\n- An evening schedule changes access and service capacity. <!-- coffee-insight:v1:id=access-insight --> <!-- source: Evening hours give working families another chance to visit. -->\n  - Context: The schedule can remove a timing barrier for working families.\n\n- An evening schedule changes access and service capacity. <!-- coffee-insight:v1:id=capacity-insight --> <!-- source: Evening hours make one-on-one support harder to staff. -->\n  - Context: Staffing the evening shift can reduce one-on-one support.'];
  const store = new CoffeeStorage(app.vault, 'Workspace');
  await store.save(session);
  const path = store.sessionPath(session.id);
  const reopened = await new CoffeeStorage(app.vault, 'Workspace').load(path);
  const items = insights.baselineFromVersions(reopened.observerNotes, 'en');
  assert.deepEqual(Array.from(items, item => item.id), ['access-insight', 'capacity-insight']);
  assert.deepEqual(Array.from(items, item => item.detail), [
    'The schedule can remove a timing barrier for working families.',
    'Staffing the evening shift can reduce one-on-one support.',
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(Array.from(items, item => item.sources))), [
    ['Evening hours give working families another chance to visit.'],
    ['Evening hours make one-on-one support harder to staff.'],
  ]);
});

test('editing reusable template content leaves an already-saved room roster unchanged after fresh Storage load', async () => {
  const { CoffeeStorage } = load('experiences/coffee-tables/storage.ts');
  const types = load('experiences/coffee-tables/types.ts');
  const rosterModule = load('experiences/coffee-tables/roster.ts');
  const { app } = fixture();
  const template = { id: 'template-isolation', identity: 'Fictional evening librarian', category: 'experts', role: 'Evening service librarian', description: 'Helps families after work.', prompt: 'Ask which hours are hard to reach.' };
  const session = types.createSession('Saved room roster snapshot', 'offline-fixture', 'low', 'en');
  const roomRoster = rosterModule.rosterFromLegacySettings(session.guests);
  roomRoster.cards[0] = { ...roomRoster.cards[0], roleName: template.identity, personaRole: template.role, description: template.description, prompt: template.prompt, templateId: template.id, source: 'library', edited: true };
  session.guests = rosterModule.guestSettingsFromRoster(session.guests, roomRoster);
  const savedRoomRoster = structuredClone(session.guests.roster);
  const storage = new CoffeeStorage(app.vault, 'Workspace');
  await storage.save(session);
  const roomPath = storage.sessionPath(session.id);

  // Reusable templates live in plugin settings. Editing T must not mutate the copied roster in R.
  template.role = 'Updated fictional night dispatcher';
  template.description = 'Updated care and late-shift perspective.';
  template.prompt = 'Ask who covers an emergency after closing.';
  const secondStorage = new CoffeeStorage(app.vault, 'Workspace');
  const reopened = await secondStorage.load(roomPath);

  assert.deepEqual(JSON.parse(JSON.stringify(reopened.guests.roster)), JSON.parse(JSON.stringify(savedRoomRoster)));
  assert.equal(reopened.guests.roster.cards[0].templateId, template.id, 'the room retains its template provenance');
  assert.equal(reopened.guests.roster.cards[0].personaRole, 'Evening service librarian');
  assert.equal(reopened.guests.roster.cards[0].description, 'Helps families after work.');
  assert.equal(reopened.guests.roster.cards[0].prompt, 'Ask which hours are hard to reach.');
  assert.notEqual(reopened.guests.roster.cards[0].personaRole, template.role, 'editing T does not back-write into the saved R snapshot');
});

test('Coffee customization and convergence metadata round trip; undo survives saved History', async () => {
  const { CoffeeStorage } = load('experiences/coffee-tables/storage.ts');
  const { CoffeeEngine } = load('experiences/coffee-tables/engine.ts');
  const types = load('experiences/coffee-tables/types.ts');
  const insights = load('experiences/coffee-tables/insights.ts');
  const { app, contents } = fixture();
  const store = new CoffeeStorage(app.vault, 'Workspace');
  const session = types.createSession('Storage round trip', 'model', 'low', 'en');
  const longPrompt = 'Keep this preference. '.repeat(900).trimEnd();
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

test('accepted role recommendations save to filesystem and reopen through a fresh CoffeeStorage instance', async () => {
  const { CoffeeStorage } = load('experiences/coffee-tables/storage.ts');
  const types = load('experiences/coffee-tables/types.ts');
  const roster = load('experiences/coffee-tables/roster.ts');
  const allowedRoot = '/tmp/vam-e2e-current_coffee-library-live';
  await fs.mkdir(allowedRoot, { recursive: true });
  const diskRoot = await fs.mkdtemp(path.join(allowedRoot, 'coffee-storage-filesystem-'));
  const diskPath = virtualPath => path.join(diskRoot, ...virtualPath.split('/').filter(Boolean));
  const abstract = virtualPath => {
    const physical = diskPath(virtualPath); if (!fsSync.existsSync(physical)) return null;
    const stat = fsSync.statSync(physical), name = path.basename(virtualPath);
    if (stat.isDirectory()) { const folder = new TFolder(virtualPath); folder.parent = virtualPath.includes('/') ? abstract(virtualPath.slice(0, virtualPath.lastIndexOf('/'))) : null; return folder; }
    const file = new TFile(virtualPath); file.parent = virtualPath.includes('/') ? abstract(virtualPath.slice(0, virtualPath.lastIndexOf('/'))) : null; file.name = name; file.basename = name.replace(/\.md$/, ''); file.extension = path.extname(name).slice(1); file.stat = { mtime: stat.mtimeMs }; return file;
  };
  const walkMarkdown = async directory => {
    let entries; try { entries = await fs.readdir(diskPath(directory), { withFileTypes: true }); } catch { return []; }
    const found = [];
    for (const entry of entries) { const child = `${directory}/${entry.name}`; if (entry.isDirectory()) found.push(...await walkMarkdown(child)); else if (entry.name.endsWith('.md')) found.push(abstract(child)); }
    return found;
  };
  const adapter = {
    exists: async virtualPath => fsSync.existsSync(diskPath(virtualPath)),
    mkdir: async virtualPath => fs.mkdir(diskPath(virtualPath), { recursive: true }),
    list: async virtualPath => { const entries = await fs.readdir(diskPath(virtualPath), { withFileTypes: true }); return { files: entries.filter(item => item.isFile()).map(item => `${virtualPath}/${item.name}`), folders: entries.filter(item => item.isDirectory()).map(item => `${virtualPath}/${item.name}`) }; },
    read: async virtualPath => fs.readFile(diskPath(virtualPath), 'utf8'),
    write: async (virtualPath, value) => { await fs.mkdir(path.dirname(diskPath(virtualPath)), { recursive: true }); await fs.writeFile(diskPath(virtualPath), value, 'utf8'); },
    process: async (virtualPath, change) => { const current = await fs.readFile(diskPath(virtualPath), 'utf8'); const next = change(current); await fs.writeFile(diskPath(virtualPath), next, 'utf8'); return next; },
  };
  const vault = {
    adapter,
    getAbstractFileByPath: abstract,
    getFiles: () => [],
    createFolder: async virtualPath => { await fs.mkdir(diskPath(virtualPath), { recursive: true }); return abstract(virtualPath); },
    create: async (virtualPath, value) => { await fs.mkdir(path.dirname(diskPath(virtualPath)), { recursive: true }); await fs.writeFile(diskPath(virtualPath), value, 'utf8'); return abstract(virtualPath); },
    read: async file => fs.readFile(diskPath(file.path), 'utf8'),
    process: async (file, change) => adapter.process(file.path, change),
  };
  vault.getFiles = () => [];
  try {
    const store = new CoffeeStorage(vault, 'Isolated Workspace');
    const settings = { counts: { experts: 1, 'cross-domain': 1, generalist: 0, affected: 1 }, guests: [
      { id: 'fictional-expert', category: 'experts', identity: 'Fictional night-shift librarian', role: 'Community librarian', description: 'A fictional worker closing a neighborhood library.', prompt: 'Ask who covers late hours.' },
      { id: 'fictional-cross-domain', category: 'cross-domain', identity: 'Fictional transit planner', role: 'Evening transit planner', description: 'A fictional planner studying late schedules.', prompt: 'Ask which trips run after work.' },
      { id: 'fictional-affected', category: 'affected', identity: 'Fictional evening visitor', role: 'Neighborhood visitor', description: 'A fictional visitor with evening access needs.', prompt: 'Ask what blocks a later visit.' },
    ], background: '', customPrompt: '', hostCount: 1 };
    const session = types.createSession('Fictional library staffing', 'offline-fixture', 'low', 'en', settings);
    const initialRoster = roster.rosterFromLegacySettings(session.guests);
    initialRoster.cards = initialRoster.cards.map(card => ({ ...card, source: 'builtin', edited: false }));
    session.guests = roster.guestSettingsFromRoster(session.guests, initialRoster);
    await store.save(session);
    const markdownPath = store.sessionPath(session.id), sidecarPath = store.sidecarPath(session.id);
    assert.ok((await fs.stat(diskPath(markdownPath))).isFile(), 'CoffeeStorage created the Markdown file on disk');
    assert.ok((await fs.stat(diskPath(sidecarPath))).isFile(), 'CoffeeStorage created the hidden session snapshot on disk');
    const reopenedStore = new CoffeeStorage(vault, 'Isolated Workspace');
    const reopened = await reopenedStore.load(markdownPath);
    assert.equal(reopened.guests.roster.cards[0].roleName, 'Fictional night-shift librarian');
    assert.equal(reopened.guests.roster.cards[0].personaRole, 'Community librarian');
    reopened.guests.roster.cards[0].prompt = 'Ask who can reach the library after work.';
    reopened.guests = roster.guestSettingsFromRoster(reopened.guests, reopened.guests.roster);
    await reopenedStore.save(reopened);
    const finalStore = new CoffeeStorage(vault, 'Isolated Workspace');
    const { CoffeeEngine } = load('experiences/coffee-tables/engine.ts');
    const beforeRecommendation = await finalStore.load(markdownPath);
    assert.equal(beforeRecommendation.guests.roster.totalParticipants, 4);
    assert.equal(beforeRecommendation.guests.roster.cards.length, 3);
    const savedSeatIds = JSON.parse(JSON.stringify(beforeRecommendation.guests.roster.cards.map(card => card.id)));
    const recommendationEngine = new CoffeeEngine(beforeRecommendation, async request => JSON.stringify({ cards: request.session.guests.roster.cards.map((card, index) => ({
      category: card.category,
      roleName: `Fictional recommended persona ${index + 1}`,
      personaRole: `Fictional library perspective ${index + 1}`,
      description: 'A fictional perspective on library access.',
      style: 'Ask for a practical example.',
      prompt: 'Do not claim personal testimony.',
      suggestions: ['Compare weekday and evening access.'],
    })) }), value => finalStore.save(value));
    const preview = await recommendationEngine.recommendRoster();
    const beforeAccept = await new CoffeeStorage(vault, 'Isolated Workspace').load(markdownPath);
    assert.deepEqual(JSON.parse(JSON.stringify(beforeAccept.guests.roster)), JSON.parse(JSON.stringify(beforeRecommendation.guests.roster)), 'preview alone does not persist the recommended roster');
    await recommendationEngine.setRoster(preview);
    const finalSession = await new CoffeeStorage(vault, 'Isolated Workspace').load(markdownPath);
    assert.equal(finalSession.guests.roster.totalParticipants, 4);
    assert.equal(finalSession.guests.roster.cards.length, 3);
    assert.deepEqual(JSON.parse(JSON.stringify(finalSession.guests.roster.cards.map(card => card.id))), savedSeatIds, 'fresh Storage preserves the original seat identities');
    assert.deepEqual(JSON.parse(JSON.stringify(finalSession.guests.roster.cards.map(card => card.category))), ['experts', 'cross-domain', 'affected'], 'fresh Storage preserves the fixed role labels');
    assert.deepEqual(JSON.parse(JSON.stringify(finalSession.guests.roster.cards.map(card => card.roleName))), ['Fictional recommended persona 1', 'Fictional recommended persona 2', 'Fictional recommended persona 3']);
    assert.equal(finalSession.guests.roster.cards[0].prompt, 'Do not claim personal testimony.');

    const insights = load('experiences/coffee-tables/insights.ts');
    const rawSourceNotes = '# Observer’s notes\n\n## Unexpected connections\n\n- P source claim. <!-- coffee-insight:v1:id=insight-p --> <!-- source: P exact dialogue source -->\n  - Reason: P-specific reasoning.\n\n- Q source claim. <!-- coffee-insight:v1:id=insight-q --> <!-- source: Q exact dialogue source -->\n  - Reason: Q-specific reasoning.\n\n- R source claim. <!-- coffee-insight:v1:id=insight-r --> <!-- source: R exact dialogue source -->\n  - Reason: R-specific dissent and conditions.\n';
    const originalNotes = insights.serializeInsightNotes(insights.baselineFromVersions([rawSourceNotes], 'en'), 'en');
    const convergenceResponse = JSON.stringify({ proposals: [
      { sourceIds: ['insight-p'], summary: 'Accepted P claim.', detail: 'P reasoning remains attached.', category: 'connections' },
      { sourceIds: ['insight-q'], summary: 'Q candidate claim.', detail: 'Q reasoning remains attached.', category: 'connections' },
      { sourceIds: ['insight-r'], summary: 'R candidate claim.', detail: 'R dissent and conditions remain attached.', category: 'connections' },
    ] });
    finalSession.status = 'completed';
    finalSession.observerNotes = [originalNotes];
    await finalStore.save(finalSession);
    const previewEngine = new CoffeeEngine(finalSession, async () => convergenceResponse, value => finalStore.save(value));
    await previewEngine.previewConvergence();
    const previewStore = new CoffeeStorage(vault, 'Isolated Workspace');
    const afterPreview = await previewStore.load(markdownPath);
    assert.ok(afterPreview.convergenceDraft, 'the actual CoffeeStorage sidecar persists the reviewable preview');
    assert.match(afterPreview.observerNotes[0], /R source claim[\s\S]*R-specific dissent and conditions/, 'the stored observer baseline retains R and its detail before review');
    assert.equal(afterPreview.transcriptMarkdown, finalSession.transcriptMarkdown, 'filesystem preview save must not change the transcript');
    assert.deepEqual(afterPreview.rounds, finalSession.rounds, 'filesystem preview save must not change frozen round inputs');
    const originalPersistedNotes = [...afterPreview.observerNotes];
    const skippedBlock = afterPreview.observerNotes[0].match(/- R source claim[\s\S]*?(?=\n## |$)/)?.[0];
    assert.ok(skippedBlock, 'the persisted R block can be isolated from the saved Markdown');

    const reopenedEngine = new CoffeeEngine(afterPreview, async () => { throw new Error('applying saved proposals must not call a provider'); }, value => previewStore.save(value));
    await reopenedEngine.applyConvergence([0, 1], { 1: { summary: 'Edited Q claim.', detail: 'Edited Q detail preserves its source context.' } });
    const acceptedStore = new CoffeeStorage(vault, 'Isolated Workspace');
    const accepted = await acceptedStore.load(markdownPath);
    const acceptedInsights = insights.baselineFromVersions(accepted.observerNotes, 'en');
    assert.deepEqual(Array.from(acceptedInsights, item => item.id), ['insight-p', 'insight-q', 'insight-r']);
    assert.match(accepted.observerNotes[0], /Accepted P claim\./);
    assert.match(accepted.observerNotes[0], /Edited Q claim\./);
    assert.ok(accepted.observerNotes[0].includes(skippedBlock), 'skipped R retains its persisted Markdown, source and order on disk');
    assert.deepEqual(JSON.parse(JSON.stringify(acceptedInsights.find(item => item.id === 'insight-r').sources)), ['R exact dialogue source']);

    const undoEngine = new CoffeeEngine(accepted, async () => { throw new Error('Undo must not call a provider'); }, value => acceptedStore.save(value));
    await undoEngine.undoConvergence();
    const afterUndoStore = new CoffeeStorage(vault, 'Isolated Workspace');
    const afterUndo = await afterUndoStore.load(markdownPath);
    assert.deepEqual(JSON.parse(JSON.stringify(afterUndo.observerNotes)), originalPersistedNotes, 'Undo after a fresh storage readback restores exact pre-accept persisted note text and sources');

    const retryPreview = new CoffeeEngine(afterUndo, async () => convergenceResponse, value => afterUndoStore.save(value));
    await retryPreview.previewConvergence();
    const retryStore = new CoffeeStorage(vault, 'Isolated Workspace');
    const retryReopened = await retryStore.load(markdownPath);
    const retryApply = new CoffeeEngine(retryReopened, async () => { throw new Error('reopened preview must not call a provider'); }, value => retryStore.save(value));
    await retryApply.applyConvergence([0, 1], { 1: { summary: 'Edited Q claim.', detail: 'Edited Q detail preserves its source context.' } });
    const afterRepeatedAcceptance = await new CoffeeStorage(vault, 'Isolated Workspace').load(markdownPath);
    const repeatedInsights = insights.baselineFromVersions(afterRepeatedAcceptance.observerNotes, 'en');
    assert.deepEqual(Array.from(repeatedInsights, item => item.id), ['insight-p', 'insight-q', 'insight-r']);
    assert.equal(repeatedInsights.filter(item => item.summary === 'Accepted P claim.').length, 1);
    assert.equal(repeatedInsights.filter(item => item.summary === 'Edited Q claim.').length, 1);
  } finally { await fs.rm(diskRoot, { recursive: true, force: true }); }
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

test('Coffee roster and each round’s effective roster survive sidecar save and reopen', async () => {
  const { CoffeeStorage } = load('experiences/coffee-tables/storage.ts');
  const types = load('experiences/coffee-tables/types.ts');
  const rosterModule = load('experiences/coffee-tables/roster.ts');
  const { app, contents } = fixture();
  const store = new CoffeeStorage(app.vault, 'Workspace');
  const roster = {
    totalParticipants: 3,
    hostCount: 1,
    cards: [
      { id: 'seat-expert', category: 'experts', roleName: 'After-hours service planner', source: 'recommended', description: 'Focuses on who can actually use evening services.', style: 'Ask about access after work.', prompt: 'Do not assume every family has a car.', suggestions: ['Compare weekdays and weekends.'], locked: false, edited: false },
      { id: 'seat-affected', category: 'affected', roleName: 'Weekend-only library visitor', source: 'custom', description: 'Can visit only on weekends.', style: 'Prioritize practical constraints.', prompt: '', suggestions: [], locked: true, edited: true },
    ],
  };
  const guests = rosterModule.guestSettingsFromRoster({ counts: { experts: 1, 'cross-domain': 0, generalist: 0, affected: 1 }, guests: [], background: '', customPrompt: '', hostCount: 1 }, roster);
  const session = types.createSession('Roster sidecar round trip', 'model', 'low', 'en', guests);
  session.status = 'completed';
  session.rounds = [{ id: 'roster-history', markdown: '### A|Topic expert\nA fictional exchange.', notes: '', status: 'completed', kind: 'initial', createdAt: session.createdAt, rosterSnapshot: structuredClone(roster) }];
  session.transcriptMarkdown = session.rounds[0].markdown;
  await store.save(session);

  const saved = JSON.parse(contents.get(store.sidecarPath(session.id)));
  assert.deepEqual(JSON.parse(JSON.stringify(saved.guests.roster)), roster);
  assert.deepEqual(JSON.parse(JSON.stringify(saved.rounds[0].rosterSnapshot)), roster);
  const reopened = await new CoffeeStorage(app.vault, 'Workspace').load(session.id);
  assert.deepEqual(JSON.parse(JSON.stringify(reopened.guests.roster)), roster);
  assert.deepEqual(JSON.parse(JSON.stringify(reopened.rounds[0].rosterSnapshot)), roster);
  assert.equal(reopened.transcriptMarkdown, session.transcriptMarkdown);
  assert.equal(reopened.guests.counts.experts, 1);
  assert.equal(reopened.guests.counts.affected, 1);
});

test('role recommendation failure preserves every seat; a valid preview changes storage only after explicit save', async () => {
  const { CoffeeStorage } = load('experiences/coffee-tables/storage.ts');
  const { CoffeeEngine } = load('experiences/coffee-tables/engine.ts');
  const types = load('experiences/coffee-tables/types.ts');
  const rosterModule = load('experiences/coffee-tables/roster.ts');
  const { app } = fixture();
  const store = new CoffeeStorage(app.vault, 'Workspace');
  const source = types.createSession('Fictional library access scenario', 'model', 'low', 'en');
  const roster = rosterModule.rosterFromLegacySettings(source.guests);
  roster.cards = roster.cards.map(card => ({ ...card, source: 'builtin', roleName: card.category === 'experts' ? 'Topic expert' : 'Affected perspective', edited: false }));
  source.guests = rosterModule.guestSettingsFromRoster(source.guests, roster);
  await store.save(source);
  let call = 0;
  const engine = new CoffeeEngine(source, async () => {
    call++;
    if (call === 1) throw new Error('temporary provider outage');
    return JSON.stringify({ cards: roster.cards.map(card => ({
      category: card.category,
      roleName: card.category === 'experts' ? 'Fictional library access researcher' : 'Fictional weekend visitor',
      description: 'A fictional perspective on access hours.', style: 'Ask for practical examples.',
      prompt: 'Do not claim personal testimony.', suggestions: ['Compare weekday and weekend access.'],
    })) });
  }, value => store.save(value));
  const before = JSON.parse(JSON.stringify(engine.session.guests.roster));
  await assert.rejects(engine.recommendRoster(), /temporary provider outage/);
  assert.deepEqual(JSON.parse(JSON.stringify(engine.session.guests.roster)), before);
  assert.match(engine.recommendationError, /temporary provider outage/);
  assert.equal(engine.session.status, 'ready');
  const suggestion = await engine.recommendRoster(before);
  assert.equal(call, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(engine.session.guests.roster)), before, 'preview never mutates the active session');
  assert.deepEqual(suggestion.cards.map(card => card.roleName), ['Fictional library access researcher', 'Fictional weekend visitor']);
  const whilePending = await new CoffeeStorage(app.vault, 'Workspace').load(source.id);
  assert.deepEqual(JSON.parse(JSON.stringify(whilePending.guests.roster)), before, 'preview is not persisted before acceptance');
  await engine.setRoster(suggestion);
  const reopened = await new CoffeeStorage(app.vault, 'Workspace').load(source.id);
  assert.deepEqual(JSON.parse(JSON.stringify(reopened.guests.roster)), JSON.parse(JSON.stringify(suggestion)));
});

test('cancelling role recommendations keeps the saved roster unchanged', async () => {
  const { CoffeeEngine } = load('experiences/coffee-tables/engine.ts');
  const types = load('experiences/coffee-tables/types.ts');
  const rosterModule = load('experiences/coffee-tables/roster.ts');
  const source = types.createSession('Cancel recommendation', 'model', 'low', 'en');
  const roster = rosterModule.rosterFromLegacySettings(source.guests);
  roster.cards = roster.cards.map(card => ({ ...card, source: 'builtin', roleName: card.category === 'experts' ? 'Topic expert' : 'Affected perspective', edited: false }));
  source.guests = rosterModule.guestSettingsFromRoster(source.guests, roster);
  const before = JSON.parse(JSON.stringify(roster));
  let signal;
  const engine = new CoffeeEngine(source, request => new Promise((resolve, reject) => {
    signal = request.signal;
    request.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  }), async () => {});
  const pending = engine.recommendRoster(roster);
  await new Promise(resolve => setImmediate(resolve));
  engine.cancelRecommendations();
  await assert.rejects(pending);
  assert.equal(signal.aborted, true);
  assert.deepEqual(JSON.parse(JSON.stringify(engine.session.guests.roster)), before);
  assert.match(engine.recommendationError, /cancelled/);
});

test('opening seat error keeps the received draft and retry completes from the same exact roster snapshot', async () => {
  const { CoffeeEngine } = load('experiences/coffee-tables/engine.ts');
  const types = load('experiences/coffee-tables/types.ts');
  const rosterModule = load('experiences/coffee-tables/roster.ts');
  const notes = `# Observer’s notes\n\n## Unexpected connections\nThese fictional views connect access and planning decisions.\n\n## Questions worth pursuing\nWhich hours do people need most often?\n\n## Core disagreements\nThe table differs on which constraint matters first.\n\n## Directions to explore\nCompare a small weekday pilot with weekends.\n\n## Assumptions to verify\nCheck whether travel time changes who can attend.`;
  const labels = { experts: 'Topic expert', 'cross-domain': 'Cross-domain expert', generalist: 'Generalist', affected: 'Affected perspective' };
  const opening = (roster, extraAffected = 0) => {
    const listed = [
      { name: 'Host A', role: 'Host' }, { name: 'Observer A', role: 'Observer' },
      ...roster.cards.map(card => ({ name: card.roleName, role: labels[card.category] })),
      ...Array.from({ length: extraAffected }, (_, index) => ({ name: `Unexpected affected ${index + 1}`, role: 'Affected perspective' })),
    ];
    return `${listed.map(person => `- **${person.name} | ${person.role}**: Fictional introduction.`).join('\n')}\n\n${listed.map(person => `### ${person.name} | ${person.role}\nA fictional participant asks who can use the service and when.`).join('\n\n')}\n\n${notes}`;
  };
  const source = types.createSession('After-hours library access', 'model', 'low', 'en');
  let roster = rosterModule.rosterFromLegacySettings(source.guests);
  roster.cards = roster.cards.map(card => ({ ...card, source: 'builtin', roleName: card.category === 'experts' ? 'Fictional access researcher' : 'Fictional weekend visitor', personaRole: card.category === 'experts' ? 'library-service researcher' : 'occasional library visitor', edited: false }));
  source.guests = rosterModule.guestSettingsFromRoster(source.guests, roster);
  let attempt = 0, firstPrompt = '';
  const engine = new CoffeeEngine(source, async request => {
    attempt++; firstPrompt = request.prompt;
    return attempt === 1 ? opening(roster, 1) : opening(request.session.guests.roster);
  }, async () => {});
  await engine.start();
  assert.equal(engine.session.status, 'error');
  assert.match(engine.error, /Opening role counts do not match settings/);
  assert.match(engine.session.draftMarkdown, /Unexpected affected 1/);
  assert.equal(engine.session.rounds[0].status, 'error');
  assert.equal(engine.session.transcriptMarkdown, '');
  assert.match(firstPrompt, /participant total is 3, including 1 host/);
  assert.match(firstPrompt, /observer is exactly one and is excluded/);
  await engine.start();
  assert.equal(engine.session.status, 'completed');
  assert.equal(engine.session.draftMarkdown, undefined);
  assert.equal(engine.session.rounds[0].status, 'completed');
  assert.deepEqual(JSON.parse(JSON.stringify(engine.session.rounds[0].rosterSnapshot)), JSON.parse(JSON.stringify(roster)));
  assert.match(engine.session.transcriptMarkdown, /Fictional weekend visitor/);
});

test('an in-progress room edit changes the next segment only and preserves the active segment snapshot', async () => {
  const { CoffeeEngine } = load('experiences/coffee-tables/engine.ts');
  const types = load('experiences/coffee-tables/types.ts');
  const rosterModule = load('experiences/coffee-tables/roster.ts');
  const source = types.createSession('Next-segment roster update', 'model', 'low', 'en');
  const original = rosterModule.rosterFromLegacySettings(source.guests);
  original.cards = original.cards.map(card => ({ ...card, source: 'builtin', roleName: card.category === 'experts' ? 'Fictional expert' : 'Fictional affected visitor', edited: false }));
  source.guests = rosterModule.guestSettingsFromRoster(source.guests, original);
  source.status = 'completed';
  source.transcriptMarkdown = '### Host A | Host\nThe existing table has begun.';
  source.rounds = [{ id: 'prior-round', kind: 'initial', markdown: source.transcriptMarkdown, notes: '', status: 'completed', createdAt: source.createdAt, rosterSnapshot: structuredClone(original) }];
  let resolveRuntime;
  const runtimeRequests = [];
  const engine = new CoffeeEngine(source, request => { runtimeRequests.push(request); return new Promise(resolve => { resolveRuntime = resolve; }); }, async () => {});
  const pending = engine.continueTable();
  await new Promise(resolve => setImmediate(resolve));
  const active = engine.session.rounds.find(round => round.status === 'generating');
  assert.deepEqual(JSON.parse(JSON.stringify(active.rosterSnapshot)), JSON.parse(JSON.stringify(original)));
  assert.deepEqual(JSON.parse(JSON.stringify(runtimeRequests[0].session.guests.roster)), JSON.parse(JSON.stringify(original)), 'the runtime receives the run-start roster snapshot');
  assert.match(runtimeRequests[0].prompt, /Fictional expert/, 'the run-start roster is present in the generated prompt');
  const changed = structuredClone(original);
  changed.cards[0].roleName = 'Fictional public-service researcher';
  changed.cards[0].edited = true;
  await engine.setRoster(changed);
  assert.equal(engine.session.guests.roster.cards[0].roleName, 'Fictional public-service researcher');
  assert.deepEqual(JSON.parse(JSON.stringify(engine.session.rounds.find(round => round.status === 'generating').rosterSnapshot)), JSON.parse(JSON.stringify(original)));
  resolveRuntime(`### Host A | Host\nA new segment considers who gets access.\n\n# Observer’s notes\n\n## Unexpected connections\nThe schedule connects transportation and public services.\n\n## Questions worth pursuing\nWhich people cannot reach the service?\n\n## Core disagreements\nConvenience and cost still pull in different directions.\n\n## Directions to explore\nA weekend pilot may reveal a different pattern.\n\n## Assumptions to verify\nCheck whether demand changes after regular work hours.`);
  await pending;
  const continuation = engine.session.rounds.find(round => round.kind === 'continuation');
  assert.equal(continuation.status, 'completed');
  assert.deepEqual(JSON.parse(JSON.stringify(continuation.rosterSnapshot)), JSON.parse(JSON.stringify(original)));
  assert.equal(engine.session.guests.roster.cards[0].roleName, 'Fictional public-service researcher');
});

test('the next run after a roster edit uses the changed roster while prior runs keep their frozen snapshots', async () => {
  const { CoffeeStorage } = load('experiences/coffee-tables/storage.ts');
  const { CoffeeEngine } = load('experiences/coffee-tables/engine.ts');
  const types = load('experiences/coffee-tables/types.ts');
  const rosterModule = load('experiences/coffee-tables/roster.ts');
  const { app } = fixture();
  const firstStorage = new CoffeeStorage(app.vault, 'Workspace');
  const session = types.createSession('Roster snapshot across runs', 'offline-fixture', 'low', 'en');
  const original = rosterModule.rosterFromLegacySettings(session.guests);
  original.cards = original.cards.map(card => ({ ...card, source: 'builtin', roleName: card.category === 'experts' ? 'Fictional expert' : 'Fictional affected visitor', edited: false }));
  session.guests = rosterModule.guestSettingsFromRoster(session.guests, original);
  session.status = 'completed';
  session.transcriptMarkdown = '### Host A | Host\nThe existing table has begun.';
  session.rounds = [{ id: 'prior-round', kind: 'initial', markdown: session.transcriptMarkdown, notes: '', status: 'completed', createdAt: session.createdAt, rosterSnapshot: structuredClone(original) }];
  await firstStorage.save(session);
  const roomPath = firstStorage.sessionPath(session.id);

  let resolveFirstRun;
  const firstRequests = [];
  const firstEngine = new CoffeeEngine(session, request => { firstRequests.push(request); return new Promise(resolve => { resolveFirstRun = resolve; }); }, value => firstStorage.save(value));
  const firstRun = firstEngine.continueTable();
  await new Promise(resolve => setImmediate(resolve));
  const active = firstEngine.session.rounds.find(round => round.status === 'generating');
  assert.deepEqual(JSON.parse(JSON.stringify(active.rosterSnapshot)), JSON.parse(JSON.stringify(original)), 'the first new run freezes the old roster before the edit');
  assert.deepEqual(JSON.parse(JSON.stringify(firstRequests[0].session.guests.roster)), JSON.parse(JSON.stringify(original)), 'the runtime receives the run-start roster snapshot');
  assert.match(firstRequests[0].prompt, /Fictional expert/, 'the run-start roster is present in the generated prompt');

  const edited = structuredClone(original);
  edited.cards[0].roleName = 'Fictional public-service researcher';
  edited.cards[0].personaRole = 'Fictional access specialist';
  edited.cards[0].edited = true;
  await firstEngine.setRoster(edited);
  resolveFirstRun(`### Host A | Host\nThe first new segment considers who gets access.\n\n# Observer’s notes\n\n## Unexpected connections\nThe schedule connects transportation and public services.\n\n## Questions worth pursuing\nWhich people cannot reach the service?\n\n## Core disagreements\nConvenience and cost still pull in different directions.\n\n## Directions to explore\nA weekend pilot may reveal a different pattern.\n\n## Assumptions to verify\nCheck whether demand changes after regular work hours.`);
  await firstRun;

  const secondStorage = new CoffeeStorage(app.vault, 'Workspace');
  const reopened = await secondStorage.load(roomPath);
  assert.deepEqual(JSON.parse(JSON.stringify(reopened.guests.roster)), JSON.parse(JSON.stringify(edited)), 'a new Storage instance reloads the edited room roster');
  assert.deepEqual(JSON.parse(JSON.stringify(reopened.rounds.find(round => round.id !== 'prior-round').rosterSnapshot)), JSON.parse(JSON.stringify(original)), 'the completed first run still has its frozen original roster');

  const secondRequests = [];
  const secondEngine = new CoffeeEngine(reopened, async request => { secondRequests.push(request); return `### Host A | Host\nThe later segment considers the updated expert’s perspective.\n\n# Observer’s notes\n\n## Unexpected connections\nAccess planning connects the expert perspective and visitor needs.\n\n## Questions worth pursuing\nWhich access barriers remain?\n\n## Core disagreements\nThe best hours remain unsettled.\n\n## Directions to explore\nCompare evening and weekend access.\n\n## Assumptions to verify\nCheck whether a later schedule changes participation.`; }, value => secondStorage.save(value));
  await secondEngine.continueTable();
  assert.deepEqual(JSON.parse(JSON.stringify(secondRequests[0].session.guests.roster)), JSON.parse(JSON.stringify(edited)), 'the subsequent runtime request receives the updated roster');
  assert.match(secondRequests[0].prompt, /Fictional public-service researcher/, 'the updated roster is present in the subsequent prompt');
  const laterRun = secondEngine.session.rounds.at(-1);
  assert.equal(laterRun.status, 'completed', secondEngine.error);
  assert.deepEqual(JSON.parse(JSON.stringify(laterRun.rosterSnapshot)), JSON.parse(JSON.stringify(edited)), 'the subsequent run freezes the updated roster');
  assert.deepEqual(JSON.parse(JSON.stringify(secondEngine.session.rounds.find(round => round.id !== 'prior-round').rosterSnapshot)), JSON.parse(JSON.stringify(original)), 'the prior in-progress run remains frozen to its original roster');

  const finalReload = await new CoffeeStorage(app.vault, 'Workspace').load(roomPath);
  assert.deepEqual(JSON.parse(JSON.stringify(finalReload.rounds.at(-1).rosterSnapshot)), JSON.parse(JSON.stringify(edited)), 'the later run snapshot survives a fresh Storage reload');
  assert.deepEqual(JSON.parse(JSON.stringify(finalReload.rounds.find(round => round.id !== 'prior-round').rosterSnapshot)), JSON.parse(JSON.stringify(original)));
});

test('a failed roster save rolls back only the roster and preserves a newer streamed draft', async () => {
  const { CoffeeEngine } = load('experiences/coffee-tables/engine.ts');
  const types = load('experiences/coffee-tables/types.ts');
  const rosterModule = load('experiences/coffee-tables/roster.ts');
  const source = types.createSession('Concurrent roster rollback', 'model', 'low', 'en');
  const original = rosterModule.rosterFromLegacySettings(source.guests);
  source.guests = rosterModule.guestSettingsFromRoster(source.guests, original);
  let rejectSave;
  const engine = new CoffeeEngine(source, async () => '', () => new Promise((_, reject) => { rejectSave = reject; }));
  const changed = { ...original, cards: original.cards.map((card, index) => index ? card : { ...card, roleName: 'Temporary edit', edited: true }) };
  const saving = engine.setRoster(changed);
  await new Promise(resolve => setImmediate(resolve));
  engine.updateDraft('new streamed text', undefined);
  rejectSave(new Error('disk write failed'));
  await assert.rejects(saving, /disk write failed/);
  assert.deepEqual(JSON.parse(JSON.stringify(engine.session.guests.roster)), JSON.parse(JSON.stringify(original)));
  assert.equal(engine.session.draftMarkdown, 'new streamed text');
});

test('Coffee accepted insight survives save, fresh reopen, and VAM handoff with reasons, dissent, limits, and source', async () => {
  const { CoffeeStorage } = load('experiences/coffee-tables/storage.ts');
  const { createSession } = load('experiences/coffee-tables/types.ts');
  const { buildCoffeeSource, coffeeHandoffIdentity } = load('experiences/coffee-tables/handoff-source.ts');
  const { receiveVisualMapHandoff } = load('experiences/visual-map/handoff.ts');
  const { app, contents } = fixture();
  const store = new CoffeeStorage(app.vault, 'Workspace');
  const session = createSession('Fictional access proposal', 'fixture-model', 'low', 'en');
  session.status = 'completed';
  session.rounds = [{ id: 'accepted-dialogue', createdAt: session.createdAt, status: 'completed', markdown: '### Host|Host\nA local service may help if people can reach it after work.', notes: '' }];
  session.observerNotes = ['# Observer’s notes\n\n## Core disagreements\n- Keep a local service because it may help people after work. <!-- coffee-insight:v1:id=accepted-provenance --> <!-- source: A local service may help if people can reach it after work. -->\n  - Reason: evening access could address the travel barrier.\n  - Dissent: a remote option may reach more people.\n  - Limitation: no local usage data supports the estimate.'];
  await store.save(session);
  const path = store.sessionPath(session.id);
  const freshStore = new CoffeeStorage(app.vault, 'Workspace');
  const reopened = await freshStore.load(path);
  const source = buildCoffeeSource(reopened, 'accepted-provenance');
  for (const expected of ['Reason: evening access', 'Dissent: a remote option', 'Limitation: no local usage data', 'A local service may help if people can reach it after work.']) {
    assert.ok(reopened.observerNotes[0].includes(expected), `CoffeeStorage reread retains ${expected}`);
    assert.ok(source.content.includes(expected), `handoff includes ${expected}`);
    assert.ok(source.sourceSnapshot.includes(expected), `provenance snapshot includes ${expected}`);
  }
  const confirmedContent = `${source.sourceSnapshot}\n\nUser-confirmed context`;
  assert.equal(buildCoffeeSource(await new CoffeeStorage(app.vault, 'Workspace').load(path), 'accepted-provenance').artifactId, source.artifactId, 'persisted source identity survives a fresh storage reopen');
  const identityInput = { sessionId: reopened.id, sourcePath: path, sourceContent: source.content, sourceSnapshot: source.sourceSnapshot, question: source.question, content: confirmedContent, model: reopened.model, reasoning: reopened.reasoning, language: reopened.language, reframingMethod: 'manual', sourceIdentityKind: source.identityKind, sourceArtifactId: source.artifactId };
  const id = coffeeHandoffIdentity(identityInput);
  assert.equal(coffeeHandoffIdentity(identityInput), id, 'the same frozen payload has the same retry identity');
  assert.notEqual(coffeeHandoffIdentity({ ...identityInput, content: 'Edited context' }), id, 'a changed confirmed payload receives a new identity');
  const artifact = { version: 1, id, kind: 'question', title: source.question, content: confirmedContent, sourceSnapshot: source.sourceSnapshot, origin: { experience: 'coffee-tables', sessionId: reopened.id, path }, sources: [{ label: reopened.topic, path, experience: 'coffee-tables', sessionId: reopened.id, artifactId: source.artifactId }], metadata: { model: reopened.model, reasoning: reopened.reasoning, reframingMethod: 'manual', sourceIdentityKind: source.identityKind } };
  const repository = handoffRepository();
  const options = handoffOptions(repository);
  const first = await receiveVisualMapHandoff(artifact, options);
  const savedNote = repository.notes.get(first.paths.find(item => item.endsWith('.md') && item !== `${first.targetPath}`));
  assert.ok(savedNote);
  for (const expected of ['Reason: evening access', 'Dissent: a remote option', 'Limitation: no local usage data', 'A local service may help if people can reach it after work.']) {
    assert.ok(savedNote.detail.includes(expected), `VAM Detail reread retains ${expected}`);
    assert.ok(savedNote.thinkingOrigin.includes(expected), `VAM Thinking Origin reread retains ${expected}`);
  }
});

test('VAM handoff reuses an exact saved map after a lost response and rejects payload mismatch', async () => {
  const { receiveVisualMapHandoff } = load('experiences/visual-map/handoff.ts');
  const repository = handoffRepository(), options = handoffOptions(repository);
  const artifact = handoffArtifact();
  const first = await receiveVisualMapHandoff(artifact, options);
  const retried = await receiveVisualMapHandoff(artifact, options);
  assert.equal(repository.createdMaps, 1);
  assert.equal(repository.createdNotes, 1);
  assert.equal(retried.targetPath, first.targetPath);
  assert.equal(repository.readMapCalls > 0, true, 'reuse rereads the target map');
  assert.equal(repository.readNoteCalls > 1, true, 'reuse rereads the saved note content and provenance');
  await assert.rejects(receiveVisualMapHandoff({ ...artifact, content: 'Changed payload' }, options), /saved content differs/);
  assert.equal(repository.createdMaps, 1);
});

test('VAM handoff retry reattaches a saved orphan note after map persistence fails', async () => {
  const { receiveVisualMapHandoff } = load('experiences/visual-map/handoff.ts');
  const repository = handoffRepository(), artifact = handoffArtifact(), options = handoffOptions(repository);
  const saveMap = repository.saveMap.bind(repository);
  let failFirstSave = true;
  repository.saveMap = async (path, map) => {
    if (failFirstSave) { failFirstSave = false; throw new Error('simulated interruption after note write'); }
    return saveMap(path, map);
  };
  await assert.rejects(receiveVisualMapHandoff(artifact, options), error => error.name === 'HandoffWriteError' && error.paths.some(path => path.endsWith('.md')));
  const mapPath = 'Topics/Fictional question/Map.md', notePath = 'Topics/Fictional question/Notes/Fictional question.md';
  assert.equal(repository.createdMaps, 1);
  assert.equal(repository.createdNotes, 1);
  assert.equal((await repository.readMap(mapPath)).nodes.length, 0, 'first attempt left a VAM note not linked into the map');
  const result = await receiveVisualMapHandoff(artifact, options);
  const savedMap = await repository.readMap(mapPath);
  assert.equal(repository.createdMaps, 1);
  assert.equal(repository.createdNotes, 1);
  assert.equal(savedMap.nodes.length, 1);
  assert.equal(savedMap.nodes[0].path, notePath);
  assert.equal(result.targetPath, mapPath);
  assert.ok(result.paths.includes(notePath));
});

test('reopening and accepting the same convergence proposal does not duplicate the insight', async () => {
  const { CoffeeStorage } = load('experiences/coffee-tables/storage.ts');
  const { CoffeeEngine } = load('experiences/coffee-tables/engine.ts');
  const types = load('experiences/coffee-tables/types.ts');
  const insights = load('experiences/coffee-tables/insights.ts');
  const { app } = fixture();
  const proposal = { sourceIds: ['insight-source'], summary: 'A stable accepted insight.', detail: 'Its source context remains attached.', category: 'connections' };
  const response = JSON.stringify({ proposals: [proposal] });
  const firstStore = new CoffeeStorage(app.vault, 'Workspace');
  const session = types.createSession('Repeated acceptance', 'model', 'low', 'en');
  session.status = 'completed';
  session.observerNotes = ['# Observer’s notes\n\n## Unexpected connections\n- Original insight. <!-- coffee-insight:v1:id=insight-source -->'];
  await firstStore.save(session);

  const initial = await new CoffeeStorage(app.vault, 'Workspace').load(session.id);
  const firstEngine = new CoffeeEngine(initial, async () => response, value => firstStore.save(value));
  await firstEngine.previewConvergence();
  await firstEngine.applyConvergence([0]);

  const reopenedStore = new CoffeeStorage(app.vault, 'Workspace');
  const reopened = await reopenedStore.load(session.id);
  const retryEngine = new CoffeeEngine(reopened, async () => response, value => reopenedStore.save(value));
  await retryEngine.previewConvergence();
  await retryEngine.applyConvergence([0]);

  const final = await new CoffeeStorage(app.vault, 'Workspace').load(session.id);
  const accepted = insights.baselineFromVersions(final.observerNotes, 'en');
  assert.equal(accepted.filter(item => item.summary === proposal.summary).length, 1);
  assert.deepEqual(Array.from(accepted, item => item.id), ['insight-source']);
});

test('source-resolved observer refresh uses one request and survives fresh CoffeeStorage reload', async () => {
  const { CoffeeStorage } = load('experiences/coffee-tables/storage.ts');
  const { CoffeeEngine } = load('experiences/coffee-tables/engine.ts');
  const types = load('experiences/coffee-tables/types.ts');
  const insights = load('experiences/coffee-tables/insights.ts');
  const { app } = fixture();
  const storage = new CoffeeStorage(app.vault, 'Workspace');
  const session = types.createSession('Supported audit persistence', 'fixture-model', 'low', 'en');
  const dialogue = [
    '### Parent | Guest\nClear boundaries can help children try choices they are allowed to make.',
    '### Youth | Guest\nChildren should be able to help make rules; rules set only by adults can make them less willing to speak.',
    '### Parent | Guest\nFamilies with time and flexibility can more easily negotiate rules; shift work and care pressure can change what is practical.',
    '### Youth | Guest\nWe have not discussed the child age, exact rule, safety context, or evidence for one universally best method.',
  ].join('\n\n');
  session.status = 'completed'; session.transcriptMarkdown = dialogue;
  session.rounds = [{ id: 'audit-persist-round', kind: 'initial', markdown: dialogue, notes: '', status: 'completed', createdAt: session.createdAt }];
  const oldNotes = '# Observer’s notes\n\n## Core disagreements\n- The prior accepted note remains alongside the refreshed notes. <!-- coffee-insight:v1:id=prior -->';
  session.observerNotes = [oldNotes];
  await storage.save(session);
  const reopened = await new CoffeeStorage(app.vault, 'Workspace').load(session.id);
  const generated = [
    '# Observer’s notes',
    '## Unexpected connections\n- Clear boundaries may support trying choices when children know what they can decide. <!-- coffee-insight:new --> <!-- source-id:turn-001 -->',
    '## Questions worth pursuing\n- Which choices can children make within clear boundaries? <!-- coffee-insight:new --> <!-- source-id:turn-001 -->',
    '## Core disagreements\n- Parents may value clear choices, while a youth warns that adults-only rulemaking can discourage speaking. <!-- coffee-insight:new --> <!-- source-id:turn-002 -->',
    '## Directions to explore\n- Compare how family time, flexibility, shift work and care pressure shape the ease of negotiating rules. <!-- coffee-insight:new --> <!-- source-id:turn-003 -->',
    '## Assumptions to verify\n- There is not enough context or evidence here to identify a universally best method. <!-- coffee-insight:new --> <!-- source-id:turn-004 -->',
    '## Questions and possible solutions',
    '<!-- coffee-tables-complete -->',
  ].join('\n\n');
  let calls = 0;
  const engine = new CoffeeEngine(reopened, async request => {
    calls++;
    assert.equal(calls, 1, 'the observer refresh does not dispatch a second audit request');
    request.onText?.(generated);
    return generated;
  }, value => storage.save(value));

  await engine.refreshObserverNotes();

  assert.equal(calls, 1);
  assert.equal(engine.error, '');
  assert.equal(engine.session.dirtyNotes, false);
  assert.notDeepEqual(JSON.parse(JSON.stringify(engine.session.observerNotes)), [oldNotes]);
  const fresh = await new CoffeeStorage(app.vault, 'Workspace').load(session.id);
  assert.deepEqual(JSON.parse(JSON.stringify(fresh.observerNotes)), JSON.parse(JSON.stringify(engine.session.observerNotes)));
  const published = insights.baselineFromVersions(fresh.observerNotes, 'en');
  assert.deepEqual([...new Set(published.map(item => item.category))].sort(), ['assumptions', 'connections', 'directions', 'disagreements', 'questions']);
  assert.ok(published.some(item => item.summary.includes('prior accepted note')));
});

function handoffArtifact() {
  return { version: 1, id: 'coffee-handoff-stable-id', kind: 'question', title: 'Fictional question', content: 'Confirmed context with reasons, dissent, and limits.', sourceSnapshot: 'Coffee source snapshot with exact source line.', origin: { experience: 'coffee-tables', sessionId: 'coffee-session-1', path: 'Workspace/Coffee Tables/Fictional question.md' }, sources: [{ label: 'Fictional question', path: 'Workspace/Coffee Tables/Fictional question.md', experience: 'coffee-tables', sessionId: 'coffee-session-1', artifactId: 'source-insight-1' }], metadata: { model: 'fixture-model', reasoning: 'low', reframingMethod: 'manual', sourceIdentityKind: 'persisted-insight' } };
}
function handoffOptions(repository) {
  return { repo: repository, defaultModel: () => 'fixture-model', exists: path => repository.files.has(path), mutate: work => work(), navigate: async () => {}, findHandoffCandidates: originId => repository.findCandidates(originId) };
}
function handoffRepository() {
  const maps = new Map(), notes = new Map(), files = new Set();
  return {
    maps, notes, files, createdMaps: 0, createdNotes: 0, readMapCalls: 0, readNoteCalls: 0,
    async mapFiles() { return [...maps.keys()].map(path => ({ path })); },
    async readMap(path) { this.readMapCalls++; return JSON.parse(JSON.stringify(maps.get(path))); },
    async readNote(path) { this.readNoteCalls++; return JSON.parse(JSON.stringify(notes.get(path))); },
    async createMap(title, nodes, onRootCreated) {
      const path = `Topics/${title}/Map.md`, root = `Topics/${title}`;
      if (maps.has(path)) throw new Error('map exists');
      this.createdMaps++; files.add(root); files.add(path); onRootCreated?.({ path: root });
      maps.set(path, { version: 1, id: `map-${this.createdMaps}`, title, nodes, viewport: { x: 80, y: 80, zoom: 1 } });
      return path;
    },
    async createNote(title, _model, _map, mapPath, _source, initial, onCreate) {
      this.createdNotes++;
      const id = `node-${this.createdNotes}`, path = `${mapPath.replace(/\/Map\.md$/, '')}/Notes/${title}.md`;
      files.add(path); onCreate?.(path); notes.set(path, { id, title, detail: initial.detail, thinkingOrigin: initial.thinkingOrigin });
      return { id, path, parentId: null, x: 80, y: 80, collapsed: false };
    },
    async saveMap(path, map) { maps.set(path, JSON.parse(JSON.stringify(map))); },
    seedMap(path, map) { files.add(path); maps.set(path, JSON.parse(JSON.stringify(map))); },
    seedOrphan(mapPath, notePath, nodeId, artifact) {
      files.add(notePath);
      const links = artifact.sources.filter(source => source.path).map(source => `[[${source.path}|${source.label}]]`);
      const quote = value => value.split(/\r?\n/).map(line => `> ${line.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}`).join('\n');
      const statement = 'Simulated / unverified thinking source; not an adopted user conclusion.';
      const origin = [`Initial question: ${artifact.title}`, artifact.content, statement, `Origin: ${artifact.origin.experience}; session: ${artifact.origin.sessionId}; artifact: ${artifact.id}`, 'Transformation: Manual framing confirmed by user', ...links, ...artifact.sources.map(source => `Source identity: ${JSON.stringify({ experience: source.experience, sessionId: source.sessionId, artifactId: source.artifactId, path: source.path, identityKind: artifact.metadata.sourceIdentityKind })}`), `Insight snapshot:\n${artifact.sourceSnapshot}`].join('\n\n');
      const detail = [artifact.content, statement, ...links].map(quote).join('\n\n');
      notes.set(notePath, { id: nodeId, title: artifact.title, detail, thinkingOrigin: origin });
    },
    async findCandidates(originId) {
      const result = [];
      for (const mapPath of maps.keys()) {
        const root = mapPath.replace(/\/Map\.md$/, ''), notesFolder = `${root}/Notes/`;
        for (const [notePath, note] of notes) if (notePath.startsWith(notesFolder) && note.thinkingOrigin.split(/\r?\n/).includes(originId)) result.push({ mapPath, notePath, nodeId: note.id });
      }
      return result;
    },
  };
}
