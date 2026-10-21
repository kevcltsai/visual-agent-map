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
