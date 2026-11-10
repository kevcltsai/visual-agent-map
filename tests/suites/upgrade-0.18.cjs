// A frozen 0.18 vault (tests/fixtures/upgrade-0.18/vault, generated once from commit 3b92deb, see generate.cjs):
// mind maps and an AIM map under Topics, Inbox notes with `topic-state: inbox`, a pre-0.4 map outside Topics and an
// unrelated note. 0.19 must open all of it, lose nothing and rewrite nothing.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { integrationTest, load, obsidian, fixture, DEFAULT_SETTINGS } = require('../support.cjs');
const { Repository, resolveMapFolders } = load('repository.ts', { obsidian });

const FIXTURE = path.join(__dirname, '..', 'fixtures', 'upgrade-0.18', 'vault');
function fixtureFiles(dir = FIXTURE, prefix = '') {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
    ? fixtureFiles(path.join(dir, entry.name), `${prefix}${entry.name}/`)
    : [[`${prefix}${entry.name}`, fs.readFileSync(path.join(dir, entry.name), 'utf8')]]);
}
/** The data.json a 0.18 user has: no mindMapsFolder/aimFolder keys, and an inboxFolder that 0.19 ignores. */
const SAVED_0_18 = { workspaceFolder: 'Agent Workspace', topicsFolder: 'Agent Workspace/Topics', inboxFolder: 'Agent Workspace/Inbox', notesFolder: 'Agent Workspace/Nodes', mapsFolder: 'Agent Workspace/Maps' };

async function upgradedVault(mutate, language = 'en') {
  const data = fixture('en');
  const { app } = data;
  app.vault.modify = async (file, content) => app.vault.process(file, () => content);
  const repo = new Repository(app, { ...DEFAULT_SETTINGS, ...SAVED_0_18, ...resolveMapFolders(SAVED_0_18), language });
  const originals = new Map(fixtureFiles());
  if (mutate) mutate(originals);
  for (const [file, content] of originals) { await repo.folder(path.posix.dirname(file)); await app.vault.create(file, content); }
  return { ...data, repo, originals };
}
const filePaths = ({ files, contents }) => [...files.keys()].filter(key => contents.has(key)).sort();

integrationTest('fixture sanity: it holds every 0.18 shape the upgrade must survive', () => {
  const files = new Map(fixtureFiles());
  assert.ok([...files.keys()].some(file => file.startsWith('Agent Workspace/Topics/') && file.endsWith('/Map.md')), 'maps under Topics');
  assert.ok([...files.values()].some(content => /"aim":/.test(content)), 'an AIM map');
  assert.ok([...files.entries()].some(([file, content]) => file.startsWith('Agent Workspace/Inbox/') && /topic-state: inbox/.test(content)), 'Inbox notes with topic-state inbox');
  assert.ok(files.has('Agent Workspace/Maps/Pre-0.4 map.md') && files.has('Agent Workspace/Nodes/Legacy a.md'), 'a pre-0.4 map outside Topics');
  assert.ok(files.has('Journal/Daily.md'), 'an unrelated note');
  assert.ok([...files.keys()].some(file => file.includes('/Unassigned/')) && [...files.keys()].some(file => file.includes('/Archive/')));
});

// The fixture mixes notes written under a zh-TW UI (labels 所屬主題, 預覽...) and an en UI; neither UI language may relabel the other's notes.
for (const language of ['en', 'zh-TW'])
integrationTest(`upgrade 0.18 -> 0.19 under a ${language} UI: every map opens, every note reads, a rebuild changes no file and removes none`, async () => {
  const vault = await upgradedVault(undefined, language);
  const { repo, originals } = vault;
  await repo.ensureWorkspace();
  const mapFiles = await repo.mapFiles();
  assert.equal(mapFiles.length, 4, 'three Topics maps and the pre-0.4 map are discovered');
  for (const file of mapFiles) assert.ok((await repo.readMap(file.path)).nodes.length > 0, `${file.path} opens`);
  assert.equal((await repo.topics()).length, 4);
  for (const [file, content] of originals) if (/agent-map-node: true/.test(content)) await repo.readNote(file);
  assert.equal((await repo.readNote('Agent Workspace/Inbox/Loose note.md')).topicState, 'inbox');
  assert.equal((await repo.brokenTopics()).length, 0);
  await repo.rebuildDerivedData();
  await repo.reconcileMissingNodePaths();
  await repo.normalizeGeneratedNoteFilenames();
  await repo.ensureNodePresentation();
  assert.deepEqual(filePaths(vault), [...originals.keys()].sort(), 'no file added or missing');
  for (const [file, content] of originals) assert.equal(vault.contents.get(file), content, `${file} is byte-identical`);
});

integrationTest('the upgrade check can fail: a note that 0.19 would have to repair is reported as changed', async () => {
  const vault = await upgradedVault(files => {
    const key = 'Agent Workspace/Topics/Beta budget/Notes/Budget.md';
    files.set(key, files.get(key).replace(/^topic-state:.*\n/m, ''));
  });
  await vault.repo.rebuildDerivedData();
  assert.notEqual(vault.contents.get('Agent Workspace/Topics/Beta budget/Notes/Budget.md'), vault.originals.get('Agent Workspace/Topics/Beta budget/Notes/Budget.md'));
});

for (const language of ['en', 'zh-TW'])
integrationTest(`Organize on the upgraded vault under a ${language} UI moves the Topics mind maps only (an old AIM map stays in Topics); Inbox, pre-0.4 map, its notes and other files stay byte-identical, and moved notes keep their labels`, async () => {
  const vault = await upgradedVault(undefined, language);
  const { repo, app, originals } = vault;
  await repo.ensureWorkspace();
  await repo.rebuildDerivedData();
  const mapping = await repo.organizeWorkspaceFolders(await repo.planOrganizeWorkspaceFolders());
  assert.deepEqual([...mapping.values()].sort(), [
    'Agent Workspace/Mind Maps/Alpha trip/Map.md', 'Agent Workspace/Mind Maps/Beta budget/Map.md'
  ]);
  assert.ok(app.vault.getAbstractFileByPath('Agent Workspace/Topics/Steak doneness/Map.md'), 'the old AIM map stays where it was');
  // Moved notes: the original text with only the moved path prefixes replaced (labels in each note's own language), `updated` aside.
  const pairs = [...mapping.entries()].map(([from, to]) => [from.replace(/\/Map\.md$/, '/'), to.replace(/\/Map\.md$/, '/')]);
  const strip = text => text.replace(/^updated:.*\n/m, '');
  let movedNotes = 0;
  for (const [file, content] of originals) {
    if (!file.startsWith('Agent Workspace/Topics/') || file.endsWith('/Map.md')) continue;
    const next = pairs.reduce((out, [from, to]) => out.split(from).join(to), file);
    const text = pairs.reduce((out, [from, to]) => out.split(from).join(to), content);
    assert.equal(strip(vault.contents.get(next)), strip(text), `${file} keeps its text and labels`);
    movedNotes++;
  }
  assert.ok(movedNotes >= 6);
  const untouched = [...originals.keys()].filter(file => !file.startsWith('Agent Workspace/Topics/'));
  for (const file of untouched) assert.equal(vault.contents.get(file), originals.get(file), `${file} untouched`);
  assert.equal(filePaths(vault).length, originals.size, 'no file lost');
  for (const file of await repo.mapFiles()) {
    const doc = await repo.readMap(file.path);
    for (const node of doc.nodes) assert.ok(app.vault.getAbstractFileByPath(node.path), `${file.path} -> ${node.path}`);
  }
  assert.equal((await repo.readNote('Agent Workspace/Inbox/Loose note.md')).topicState, 'inbox');
  const book = await repo.readNote('Agent Workspace/Mind Maps/Alpha trip/Notes/Book trains.md');
  assert.deepEqual(Array.from(book.sourcePaths), ['Agent Workspace/Mind Maps/Alpha trip/Notes/Plan the trip.md']);
  assert.equal((await repo.planOrganizeWorkspaceFolders()).moves.length, 0, 'a second run has nothing to do');
  await assert.rejects(repo.renameTopic('Agent Workspace/Maps/Pre-0.4 map.md', 'Renamed'), /view-only|只能檢視/);
});
