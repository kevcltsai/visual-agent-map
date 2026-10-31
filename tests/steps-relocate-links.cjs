// Moving VAM notes (merge, remove, archive, rename, undo) must not raise Obsidian's "Update links" dialog when only
// VAM notes link to them, must still hand over to Obsidian when a user's own note links to them, and must never
// leave a half-rewritten note behind.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const support = require('./support.cjs');
const { load, obsidian, DEFAULT_SETTINGS, fixture } = support;
const linkRewrite = load('core/link-rewrite.ts');

function setup(language = 'en') {
  const data = fixture(language, { linkIndex: true });
  const notices = [];
  const { Repository } = load('repository.ts', { obsidian: { ...obsidian, Notice: class { constructor(message) { notices.push(message); } } } });
  const repo = new Repository(data.app, { ...DEFAULT_SETTINGS, language });
  const calls = { vault: [], file: [] };
  const vaultRename = data.app.vault.rename, fileRename = data.app.fileManager.renameFile;
  data.app.vault.rename = async (item, target) => { calls.vault.push([item.path, target]); return vaultRename(item, target); };
  data.app.fileManager.renameFile = async (item, target) => { calls.file.push([item.path, target]); return fileRename(item, target); };
  return { ...data, repo, notices, calls };
}
const stem = path => path.replace(/\.md$/, '');
const snapshot = contents => new Map(contents);

// Map "M" with Alpha (parent), Beta (child of Alpha), Gamma; Gamma cites Alpha and Beta in its body.
async function scenario() {
  const env = setup();
  const { repo, contents } = env;
  const mapPath = await repo.createMap('M');
  const doc = await repo.readMap(mapPath);
  const created = [];
  for (const title of ['Alpha', 'Beta', 'Gamma']) {
    const note = await repo.createNote(title, 'model-a', doc, mapPath, 'workspace');
    doc.nodes.push(note);
    created.push(note);
  }
  const [a, b, g] = created;
  b.parentId = a.id;
  await repo.saveMap(mapPath, doc);
  await repo.rebuildDerivedData();
  contents.set(g.path, `${contents.get(g.path)}\nCited [[${stem(a.path)}|Alpha]] and [[${stem(a.path)}#Part|shown]] and ![[${a.path}]] and [[Alpha]]; [[${stem(b.path)}]]. \`[[${stem(a.path)}]]\`\n`);
  return { ...env, mapPath, doc, a, b, g };
}

test('relocate: only VAM backlinks moves with vault.rename, no Obsidian rename, rewrites path links and keeps alias and heading', async () => {
  const { repo, contents, calls, notices, mapPath, a, g } = await scenario();
  const target = await repo.moveUnique(a.path, repo.topicFolder(mapPath, 'Unassigned'));
  assert.deepEqual(calls.vault, [[a.path, target]]);
  assert.deepEqual(calls.file, []);
  assert.deepEqual(notices, []);
  const text = contents.get(g.path);
  assert.ok(text.includes(`[[${stem(target)}|Alpha]]`), 'alias kept');
  assert.ok(text.includes(`[[${stem(target)}#Part|shown]]`), 'heading and alias kept');
  assert.ok(text.includes(`![[${target}]]`), 'embed keeps its mark and extension');
  assert.ok(text.includes('and [[Alpha]];'), 'bare-name link is unchanged while the file name is unchanged');
  assert.ok(text.includes(`\`[[${stem(a.path)}]]\``), 'a link inside code is not a link and stays as written');
  assert.ok(!text.replace(/`[^`]*`/g, '').includes(stem(a.path)), 'no other mention of the old path remains');
});

test('relocate: a move and its undo round trip leaves every note byte-identical', async () => {
  const { repo, contents, calls, mapPath, a } = await scenario();
  const before = snapshot(contents);
  const target = await repo.moveUnique(a.path, repo.topicFolder(mapPath, 'Unassigned'));
  assert.notDeepEqual([...contents.entries()].filter(([path]) => path !== target), [...before.entries()].filter(([path]) => path !== a.path));
  await repo.moveExact(target, a.path);
  assert.deepEqual(calls.file, []);
  assert.equal(calls.vault.length, 2);
  assert.deepEqual([...contents.entries()].sort(), [...before.entries()].sort());
});

test('relocate: after the rebuild no VAM note mentions the old path, frontmatter references included', async () => {
  const { repo, contents, doc, mapPath, a, b } = await scenario();
  const oldPath = a.path;
  const target = await repo.moveUnique(a.path, repo.topicFolder(mapPath, 'Unassigned'));
  a.path = target;
  await repo.saveMap(mapPath, doc);
  await repo.rebuildDerivedData();
  for (const [path, text] of contents) {
    if (!path.endsWith('.md') || path === mapPath) continue;
    assert.ok(!text.replace(/`[^`]*`/g, '').includes(stem(oldPath)), `${path} still mentions the old path`);
  }
  assert.ok(contents.get(b.path).includes(stem(target)), 'the child note points at the moved parent');
});

test('relocate: two moves in a row stay correct when the metadata cache lags behind the first rewrite', async () => {
  const { repo, app, contents, calls, mapPath, a, b, g } = await scenario();
  const staleIndex = app.metadataCache.resolvedLinks;
  Object.defineProperty(app.metadataCache, 'resolvedLinks', { get: () => staleIndex, configurable: true });
  const before = snapshot(contents);
  const folder = repo.topicFolder(mapPath, 'Unassigned');
  const first = await repo.moveUnique(a.path, folder), second = await repo.moveUnique(b.path, folder);
  const text = contents.get(g.path);
  assert.ok(text.includes(stem(first)) && text.includes(stem(second)), 'both citations follow their notes ' + JSON.stringify([first, second, text]));
  await repo.moveExact(second, b.path);
  await repo.moveExact(first, a.path);
  assert.deepEqual(calls.file, []);
  assert.deepEqual([...contents.entries()].sort(), [...before.entries()].sort());
});

test('relocate: a foreign backlink keeps Obsidian\'s rename and shows one localized notice', async () => {
  const { repo, app, contents, calls, notices, mapPath, a } = await scenario();
  await app.vault.create('My Notes/Plan.md', `Reading [[${stem(a.path)}]] tomorrow.`);
  const before = contents.get('My Notes/Plan.md');
  const target = await repo.moveUnique(a.path, repo.topicFolder(mapPath, 'Unassigned'));
  assert.deepEqual(calls.vault, []);
  assert.deepEqual(calls.file, [[a.path, target]]);
  assert.equal(notices.length, 1);
  assert.ok(notices[0].includes('1') && /Update/.test(notices[0]));
  assert.equal(contents.get('My Notes/Plan.md'), before, 'VAM never edits a non-VAM note');
});

test('relocate: a VAM note that links from a frontmatter key other than the references list is treated as foreign', async () => {
  const { repo, contents, calls, notices, mapPath, a, g } = await scenario();
  contents.set(g.path, contents.get(g.path).replace('---\n', `---\nrelated: "[[${stem(a.path)}]]"\n`));
  await repo.moveUnique(a.path, repo.topicFolder(mapPath, 'Unassigned'));
  assert.equal(calls.file.length, 1);
  assert.equal(calls.vault.length, 0);
  assert.equal(notices.length, 1);
});

test('relocate: a Markdown-style link to the moved note cannot be rewritten here and is left to Obsidian', async () => {
  const { repo, contents, calls, notices, mapPath, a, g } = await scenario();
  contents.set(g.path, `${contents.get(g.path)}\nSee [Alpha](${encodeURI(a.path)}).\n`);
  await repo.moveUnique(a.path, repo.topicFolder(mapPath, 'Unassigned'));
  assert.equal(calls.file.length, 1);
  assert.equal(notices.length, 1);
});

test('relocate: renaming a note rewrites bare-name links to the new name', async () => {
  const { repo, contents, calls, a, g } = await scenario();
  const target = await repo.renameNote(a.path, 'Alpha prime');
  assert.deepEqual(calls.file, []);
  assert.equal(calls.vault.length, 1);
  assert.ok(contents.get(g.path).includes('and [[Alpha prime]];'));
  assert.ok(contents.get(g.path).includes(`[[${stem(target)}|Alpha]]`));
});

test('relocate: a note edited between planning and writing throws, undoes the move and every earlier rewrite', async () => {
  const { repo, app, contents, calls, files, mapPath, a, b, g } = await scenario();
  contents.set(b.path, `${contents.get(b.path)}\nAlso [[${stem(a.path)}]].\n`);
  const originals = snapshot(contents);
  const process = app.vault.process;
  let writes = 0;
  app.vault.process = async (file, change) => { if (++writes === 2) contents.set(file.path, `${contents.get(file.path)}\nedited meanwhile`); return process(file, change); };
  await assert.rejects(repo.moveUnique(a.path, repo.topicFolder(mapPath, 'Unassigned')), /changed/);
  assert.ok(files.has(a.path), 'the note is back at its original path');
  assert.equal(calls.vault.length, 2, 'moved, then moved back');
  const changed = [b.path, g.path].filter(path => contents.get(path) !== originals.get(path));
  assert.equal(changed.length, 1, 'only the note edited by the user differs');
  assert.ok(contents.get(changed[0]).endsWith('edited meanwhile'));
  for (const path of [a.path, b.path, g.path]) assert.ok(!contents.get(path)?.includes('Unassigned'), `${path} has no half-written link`);
});

test('relocate: renaming a topic folder rewrites full-path links to the notes inside, from inside and outside the folder', async () => {
  const { repo, contents, calls, notices, mapPath, a, b, g } = await scenario();
  const otherPath = await repo.createMap('Other');
  const otherDoc = await repo.readMap(otherPath);
  const other = await repo.createNote('Outside', 'model-a', otherDoc, otherPath, 'workspace');
  otherDoc.nodes.push(other);
  await repo.saveMap(otherPath, otherDoc);
  contents.set(other.path, `${contents.get(other.path)}\nSee [[${stem(a.path)}|Alpha]].\n`);
  const next = await repo.renameTopic(mapPath, 'M renamed');
  const root = repo.topicRoot(next);
  assert.deepEqual(calls.file, []);
  assert.equal(calls.vault.length, 1);
  assert.deepEqual(notices, []);
  const moved = path => path.replace(repo.topicRoot(mapPath), root);
  assert.ok(contents.get(other.path).includes(`[[${stem(moved(a.path))}|Alpha]]`));
  assert.ok(contents.get(moved(g.path)).includes(`[[${stem(moved(a.path))}|Alpha]]`));
  assert.ok(contents.get(moved(g.path)).includes(`[[${stem(moved(b.path))}]]`));
});

// The merge move sequence of the view: the parent cites its three children, a new merged note cites them as sources,
// then each source is parked in turn. `lag` makes the metadata cache forget the frontmatter of every note VAM has
// created or written (Obsidian's cache lags behind a fresh write), the situation a later move of the same operation sees.
async function mergeScenario({ lag = true } = {}) {
  const env = setup();
  const { repo, app, contents } = env;
  const touched = new Set();
  if (lag) {
    const cache = app.metadataCache.getFileCache, process = app.vault.process, create = app.vault.create;
    app.metadataCache.getFileCache = file => (touched.has(file.path) ? { frontmatter: undefined } : cache(file));
    app.vault.process = async (file, change) => { touched.add(file.path); return process(file, change); };
    app.vault.create = async (path, content) => { touched.add(path); return create(path, content); };
  }
  const mapPath = await repo.createMap('M');
  const doc = await repo.readMap(mapPath);
  const make = async (title, parent) => {
    const note = await repo.createNote(title, 'model-a', doc, mapPath, 'workspace');
    if (parent) note.parentId = parent.id;
    doc.nodes.push(note);
    return note;
  };
  const core = await make('Core');
  const sources = [];
  for (const title of ['M1', 'M2', 'M3']) sources.push(await make(title, core));
  await repo.saveMap(mapPath, doc);
  await repo.rebuildDerivedData();
  const merged = await repo.createNote('Merged', 'model-a', doc, mapPath, 'workspace', { detail: 'x' });
  const footnotes = sources.map((source, index) => `[^${index + 1}]: [[${source.path}|${source.title}]]`).join('\n');
  await repo.updateNote(merged.path, { sourcePaths: sources.map(source => source.path), status: 'completed', detail: `Body.[^1]\n\n${footnotes}\n` });
  touched.add(merged.path);
  return { ...env, mapPath, core, sources, merged };
}
const unresolvedLinks = (env) => {
  const out = [];
  for (const [path, text] of env.contents) {
    if (!path.endsWith('.md')) continue;
    const body = text.replace(/^---\n[\s\S]*?\n---\n/, '').replace(/`[^`]*`/g, '');
    for (const match of body.matchAll(/!?\[\[([^\]|#\n]+)/g)) if (!env.app.metadataCache.getFirstLinkpathDest(match[1].trim())) out.push([path, match[1]]);
  }
  return out;
};

for (const lag of [false, true]) {
  test(`relocate: merging three siblings moves every source without Obsidian's dialog and undo restores them (cache lag: ${lag})`, async () => {
    const env = await mergeScenario({ lag });
    const { repo, contents, calls, notices, mapPath, sources, merged } = env;
    const before = snapshot(contents);
    const folder = repo.topicFolder(mapPath, 'Unassigned');
    const parked = [];
    for (const source of sources) parked.push(await repo.moveUnique(source.path, folder));
    assert.deepEqual(calls.file, [], 'no Obsidian rename, so no Update links dialog');
    assert.equal(calls.vault.length, 3);
    assert.deepEqual(notices, []);
    assert.deepEqual(unresolvedLinks(env), [], 'every link still resolves');
    const text = contents.get(merged.path);
    for (const path of parked) assert.ok(text.includes(stem(path)), 'the merged note follows its source');
    assert.ok(text.includes('source-notes:'), 'the source-notes frontmatter is left for VAM to repair');
    for (const [index, source] of sources.entries()) await repo.moveExact(parked[index], source.path);
    assert.deepEqual(calls.file, [], 'undo also avoids the dialog');
    assert.deepEqual(unresolvedLinks(env), []);
    const strip = map => [...map.entries()].map(([path, value]) => [path, withoutUpdated(String(value))]).sort();
    assert.deepEqual(strip(contents), strip(before), 'undo restores every note except the updated line');
  });
}

test('relocate: a note that is not VAM-owned stays foreign even when a VAM note links to the same source', async () => {
  const env = await mergeScenario({ lag: true });
  const { repo, app, contents, calls, notices, mapPath, sources } = env;
  await app.vault.create('My Notes/Plan.md', `Reading [[${stem(sources[1].path)}]] tomorrow.`);
  const plan = contents.get('My Notes/Plan.md');
  const folder = repo.topicFolder(mapPath, 'Unassigned');
  await repo.moveUnique(sources[0].path, folder);
  assert.deepEqual(calls.file, []);
  await repo.moveUnique(sources[1].path, folder);
  assert.equal(calls.file.length, 1, 'the user note hands the second move to Obsidian');
  assert.equal(notices.length, 1);
  assert.equal(contents.get('My Notes/Plan.md'), plan, 'VAM never edits a non-VAM note');
});

test('link-rewrite: retargetWikilink keeps embeds, extension, heading and alias, and refuses relative or partial paths', () => {
  const { retargetWikilink } = linkRewrite;
  assert.equal(retargetWikilink('[[A/B/X]]', 'A/B/X.md', 'C/X.md'), '[[C/X]]');
  assert.equal(retargetWikilink('![[A/B/X.md#h|alias]]', 'A/B/X.md', 'C/X.md'), '![[C/X.md#h|alias]]');
  assert.equal(retargetWikilink('[[A/B/X\\|alias]]', 'A/B/X.md', 'C/X.md'), '[[C/X\\|alias]]');
  assert.equal(retargetWikilink('[[X]]', 'A/B/X.md', 'C/X.md'), '[[X]]');
  assert.equal(retargetWikilink('[[X#h]]', 'A/B/X.md', 'A/B/Y.md'), '[[Y#h]]');
  assert.equal(retargetWikilink('[[B/X]]', 'A/B/X.md', 'C/X.md'), null);
  assert.equal(retargetWikilink('[[../B/X]]', 'A/B/X.md', 'C/X.md'), null);
  assert.equal(retargetWikilink('[[A/B/X.png]]', 'A/B/X.md', 'C/X.md'), null);
});

test('link-rewrite: code is ignored, other files are untouched, and Markdown links to a moved file are reported', () => {
  const { rewriteLinkTargets } = linkRewrite;
  const moves = new Map([['A/X.md', 'B/X.md']]);
  const resolve = link => ({ 'A/X': 'A/X.md', 'A/Y': 'A/Y.md', X: 'A/X.md' })[link.replace(/\.md$/, '')];
  const text = 'a [[A/X]] b [[A/Y]]\n```\n[[A/X]]\n```\nand `[[A/X]]` and [x](A/X.md)';
  const result = rewriteLinkTargets(text, resolve, moves);
  assert.equal(result.text, 'a [[B/X]] b [[A/Y]]\n```\n[[A/X]]\n```\nand `[[A/X]]` and [x](A/X.md)');
  assert.equal(result.hits, 2);
  assert.deepEqual([...result.unsupported], ['](A/X.md)']);
});

// ---- View-layer rollback and undo, with the link index on (the production move path) ----------------------------
// setLifecycle (not part of the link work) re-writes `agent-map-id:` at the end of the frontmatter after a park and
// unpark; the line is compared by value elsewhere, so it is dropped here and everything else stays byte-for-byte.
const withoutUpdated = text => text.replace(/^updated:.*\n/m, '').replace(/^agent-map-id:.*\n/m, '');
const LEGACY = 'Agent Workspace/Topics';

// Map "M" with Parent, children Alpha, Beta, Gamma; every note cites its siblings and the Parent cites all three.
async function viewScenario() {
  const data = fixture('en', { linkIndex: true });
  const { repo, app, contents } = data;
  const mapPath = await repo.createMap('M');
  const doc = await repo.readMap(mapPath);
  const parent = await repo.createNote('Parent', 'model-a', doc, mapPath, 'workspace');
  doc.nodes.push(parent);
  const sources = [];
  for (const [index, name] of ['Alpha', 'Beta', 'Gamma'].entries()) {
    const note = await repo.createNote(name, 'model-a', doc, mapPath, 'workspace', { detail: `${name} detail` });
    note.parentId = parent.id; note.x = 400; note.y = 300 - index * 100;
    doc.nodes.push(note); sources.push(note);
  }
  await repo.saveMap(mapPath, doc);
  const cite = list => list.map(note => `[[${stem(note.path)}|${note.path.split('/').pop().replace(/\.md$/, '')}]] and [[${stem(note.path)}#Part]]`).join('; ');
  for (const note of [parent, ...sources])
    contents.set(note.path, `${contents.get(note.path)}\nCites ${cite([parent, ...sources].filter(other => other !== note))}.\n`);
  await repo.rebuildDerivedData();
  const plugin = { repo, settings: { ...DEFAULT_SETTINGS }, rebuildDerivedData: () => repo.rebuildDerivedData(), mutate: work => work(), running: new Set(), abortChartJobs() {}, addChartsAfterWrite() {}, quickExpandPending: new Set(), activeTasks: new Map(), expansionBatches: new Map(), currentModelChoice() { return { model: this.settings.cliModel, reasoning: 'auto' }; } };
  const { VisualAgentMapView } = load('main.ts', { obsidian }, { requestAnimationFrame: run => { run(); return 1; }, cancelAnimationFrame() {} });
  const view = new VisualAgentMapView({ app }, plugin);
  view.path = mapPath; view.map = doc; view.render = () => {}; view.focusNode = () => {}; view.drawEdges = () => {}; view.updateHistoryButtons = () => {};
  await view.hydrate();
  const calls = { file: [] };
  const renameFile = app.fileManager.renameFile;
  app.fileManager.renameFile = async (item, target) => { calls.file.push([item.path, target]); return renameFile(item, target); };
  const watched = [parent, ...sources].map(note => note.path);
  const original = new Map(watched.map(path => [path, contents.get(path)]));
  const select = () => { view.multiSelected = new Set(sources.map(note => note.id)); };
  const merge = async () => {
    select();
    const check = view.mergeCheck();
    assert.equal(check.ok, true);
    await view.mergeSelected('Merged', { path: mapPath, mapId: doc.id, sources: check.sources.map(note => ({ id: note.id, path: note.path })) });
  };
  return { ...data, calls, mapPath, doc, parent, sources, view, plugin, watched, original, select, merge };
}
function assertRestored(h, message) {
  for (const path of h.watched) {
    assert.ok(h.files.has(path), `${message}: ${path} is back at its path`);
    assert.equal(withoutUpdated(h.contents.get(path)), withoutUpdated(h.original.get(path)), `${message}: ${path} is byte-identical`);
  }
}

test('view: a merge that fails during the second source move restores every path and link text', async () => {
  const h = await viewScenario();
  const rename = h.app.vault.rename, process = h.app.vault.process;
  let renames = 0, armed = false, injected = false;
  h.app.vault.rename = async (item, target) => { if (item.path.startsWith(`${h.mapPath.replace(/\/Map\.md$/, '')}/Notes/`) && target.includes('/Unassigned/') && ++renames === 2) armed = true; return rename(item, target); };
  h.app.vault.process = async (file, change) => {
    if (armed && file.path === h.parent.path) { armed = false; injected = true; h.contents.set(file.path, h.contents.get(file.path).replace('Cites ', 'Cites edited meanwhile ')); }
    return process(file, change);
  };
  await assert.rejects(h.merge(), /changed/);
  assert.ok(injected, 'the mid-move edit really happened');
  h.app.vault.rename = rename; h.app.vault.process = process;
  assert.ok(renames >= 2, 'the failure came during the second source move');
  for (const path of h.watched) assert.ok(h.files.has(path), `${path} is back at its path`);
  for (const path of h.watched) {
    const expected = path === h.parent.path ? h.original.get(path).replace('Cites ', 'Cites edited meanwhile ') : h.original.get(path);
    assert.equal(withoutUpdated(h.contents.get(path)), withoutUpdated(expected), `${path} has its original text (only the user's edit differs)`);
  }
  const saved = await h.repo.readMap(h.mapPath);
  assert.deepEqual([...saved.nodes.map(n => n.id).filter(id => h.sources.some(s => s.id === id))].sort(), h.sources.map(s => s.id).sort(), 'the map still lists the three cards');
  assert.ok(h.view.map.nodes.some(n => n.id === h.sources[0].id));
});

test('view: merge then undo leaves every note byte-identical except the updated line', async () => {
  const h = await viewScenario();
  await h.merge();
  for (const note of h.sources) assert.ok(!h.files.has(note.path), `${note.path} moved to Unassigned`);
  assert.notEqual(h.contents.get(h.parent.path), h.original.get(h.parent.path), 'the parent\'s citations followed the moves');
  await h.view.travel(false);
  assertRestored(h, 'after undo');
  assert.equal(h.calls.file.length, 0, 'no Obsidian rename dialog path was used');
});

test('view: remove then undo leaves every note byte-identical except the updated line', async () => {
  const h = await viewScenario();
  h.select();
  await h.view.removeSelected();
  for (const note of h.sources) assert.ok(!h.files.has(note.path), `${note.path} moved to Unassigned`);
  await h.view.travel(false);
  assertRestored(h, 'after undo');
  assert.equal(h.calls.file.length, 0);
});

// ---- Organize and "reported success but not moved", failures injected through vault.rename ------------------------
async function organizeScenario() {
  const data = fixture('en', { linkIndex: true });
  const { repo, app, contents, files } = data;
  app.vault.modify = async (file, content) => app.vault.process(file, () => content);
  await repo.folder(LEGACY);
  const paths = {};
  for (const title of ['Alpha', 'Beta']) {
    const mapPath = await repo.renameTopic(await repo.createMap(title), title, `${LEGACY}/${title}`);
    const doc = await repo.readMap(mapPath);
    const first = await repo.createNote('First', 'model', doc, mapPath, 'workspace');
    const second = await repo.createNote('Second', 'model', doc, mapPath, 'inherited');
    second.parentId = first.id; doc.nodes.push(first, second);
    await repo.saveMap(mapPath, doc);
    await repo.updateNote(first.path, { detail: `Links to [[${stem(second.path)}]] and [[Second]].` });
    await repo.updateNote(second.path, { sourcePaths: [first.path], referencePaths: [first.path] });
    paths[title] = mapPath;
  }
  await repo.rebuildDerivedData();
  return { ...data, paths, snapshot: () => ({ paths: [...files.keys()].sort(), contents: new Map(contents) }) };
}
function assertUnchanged(h, before, message) {
  assert.deepEqual([...h.files.keys()].sort(), before.paths, `${message}: file and folder paths`);
  assert.equal(h.contents.size, before.contents.size, `${message}: file count`);
  for (const [path, content] of before.contents) assert.equal(h.contents.get(path), content, `${message}: ${path}`);
}

test('organize: a vault.rename failure on a later map restores every moved path and content', async () => {
  const h = await organizeScenario();
  const plan = await h.repo.planOrganizeWorkspaceFolders();
  assert.equal(plan.moves.length, 2);
  const before = h.snapshot();
  const rename = h.app.vault.rename;
  let failed = 0;
  h.app.vault.rename = async (item, target) => { if (target.startsWith('Agent Workspace/Mind Maps/Beta')) { failed++; throw new Error('injected move failure'); } return rename(item, target); };
  await assert.rejects(h.repo.organizeWorkspaceFolders(plan), /injected move failure/);
  h.app.vault.rename = rename;
  assert.ok(failed >= 1);
  assertUnchanged(h, before, 'after a failed second move');
});

test('organize: a vault.rename that reports success without moving is stopped and restored', async () => {
  const h = await organizeScenario();
  const plan = await h.repo.planOrganizeWorkspaceFolders();
  const before = h.snapshot();
  const rename = h.app.vault.rename;
  let calls = 0;
  h.app.vault.rename = async (item, target) => { if (++calls === 2) return; return rename(item, target); };
  await assert.rejects(h.repo.organizeWorkspaceFolders(plan), /did not take effect on disk/);
  h.app.vault.rename = rename;
  assertUnchanged(h, before, 'a silently ignored rename');
});

test('relocate: a vault.rename that reports success without moving a note throws the localized error and writes nothing', async () => {
  for (const [language, pattern] of [['en', /did not take effect on disk/], ['zh-TW', /沒有實際生效/]]) {
    const { repo, app, contents, mapPath, a } = await scenario();
    repo.settings.language = language;
    const before = snapshot(contents);
    app.vault.rename = async () => {};
    await assert.rejects(repo.moveUnique(a.path, repo.topicFolder(mapPath, 'Unassigned')), pattern, language);
    assert.deepEqual([...contents.entries()].sort(), [...before.entries()].sort(), `${language}: nothing was written`);
  }
});
