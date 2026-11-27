// A source rename with Obsidian's "update links" prompt (Just once): Obsidian applies its link replacements later, at
// offsets it took before VAM rewrote the referencing note. VAM rewrites at once (as for every rename) and remembers what
// it wrote; a later modify that is exactly such a stale-position link update and breaks the note is put back to VAM's text.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load, fixture, DEFAULT_SETTINGS, obsidian } = require('./support.cjs');

const quiet = { ...obsidian, Notice: class { setMessage() {} hide() {} } };
const { default: Plugin } = load('main.ts', { obsidian: quiet });
const { isStaleLinkWrite, structureIsHealthy, markersLost } = load('core/rename-repair.ts');

const REGION = ['<!-- vam-living-node:begin v1 -->', 'living text', '<!-- vam-living-node:end v1 -->'].join('\n');

async function harness({ alwaysUpdate = false, living = true } = {}) {
  const { app, repo, contents, files } = fixture('en', { linkIndex: true });
  repo.settings = { ...DEFAULT_SETTINGS, language: 'en', cliModel: 'cur-model' };
  app.vault.getConfig = key => (key === 'alwaysUpdateLinks' ? alwaysUpdate : undefined);
  app.workspace = { getLeavesOfType: () => [], requestSaveLayout() {} };
  const plugin = new Plugin();
  const lines = [];
  Object.assign(plugin, { app, repo, settings: repo.settings, registerEvent: () => {}, logs: { appendLog: (...args) => lines.push(args.join(' ')) }, saveData: async () => {} });
  plugin.scheduleExternalReconciliation = () => {};
  plugin.rebuildDerivedData = async () => {};
  plugin.views = () => [];
  await app.vault.createFolder('Sources');
  for (const name of ['Src0', 'Src2']) await app.vault.create(`Sources/${name}.md`, 'source text');
  const mapPath = await repo.createMap('M');
  const doc = await repo.readMap(mapPath);
  const note = await repo.createNote('Alpha', 'model-a', doc, mapPath, 'workspace');
  doc.nodes.push(note);
  await repo.saveMap(mapPath, doc);
  await repo.updateNote(note.path, { sourcePaths: ['Sources/Src0.md'] });
  // Quoted scalars (the shape VAM's own writers leave); VAM's rewrite of the changed keys drops them and shrinks the text.
  const shape = raw => {
    let text = raw.replace(/^title: .*$/m, 'title: "Alpha"').replace(/^updated: .*$/m, 'updated: "2020-01-01T00:00:00.000Z"');
    text = text.replace(/^(\s+- )(Sources\/Src\d\.md)$/gm, '$1"$2"');
    return living ? `${text.replace(/\n+$/, '')}\n\n${REGION}\n` : text;
  };
  contents.set(note.path, shape(contents.get(note.path)));
  const addCard = async (title, source) => {
    const other = await repo.createNote(title, 'model-a', doc, mapPath, 'workspace');
    doc.nodes.push(other);
    await repo.saveMap(mapPath, doc);
    await repo.updateNote(other.path, { sourcePaths: [source] });
    contents.set(other.path, shape(contents.get(other.path)).replace('title: "Alpha"', `title: "${title}"`));
    return other;
  };
  return { app, repo, contents, files, plugin, note, lines, addCard };
}

/** What Obsidian collects when the rename starts: the spans of the links to the old file, in the note as it is then. */
function obsidianUpdater(h, oldLink, newLink, path = h.note.path) {
  const before = h.contents.get(path);
  const spans = [...before.matchAll(new RegExp(oldLink.replace(/[[\]/]/g, '\\$&'), 'g'))].map(m => [m.index, m.index + m[0].length]);
  assert.ok(spans.length > 0, 'the card links to the renamed file');
  return () => h.app.vault.process(h.files.get(path), current => {
    let out = current;
    for (const [start, end] of [...spans].reverse()) out = out.slice(0, start) + newLink + out.slice(end);
    return out;
  });
}
async function rename(h, from, to) {
  const file = h.files.get(from);
  await h.app.vault.rename(file, to);
  await h.plugin.applyRenames([{ pair: [from, to], file, external: true }]);
}
const modified = (h, path = h.note.path) => h.repo.renameWatch.check(path, line => h.lines.push(line));
function assertIntact(text, living = true) {
  for (const mark of ['references:start -->', 'references:end -->']) assert.ok(text.includes(mark), `${mark}\n${text}`);
  if (living) for (const mark of ['vam-living-node:begin v1 -->', 'vam-living-node:end v1 -->', 'living text']) assert.ok(text.includes(mark), `${mark}\n${text}`);
  assert.match(text, /^title: "Alpha"$/m, 'quoted frontmatter of untouched keys keeps its quotes');
}

test('Just once on a Living Node card: the stale-position update is put back, markers and references intact', async () => {
  const h = await harness();
  const stale = obsidianUpdater(h, '[[Sources/Src0]]', '[[S1]]');
  await rename(h, 'Sources/Src0.md', 'Sources/S1.md');
  const vam = h.contents.get(h.note.path);
  assert.ok(!vam.includes('Sources/Src0'), 'VAM already followed the rename');
  await stale();
  assert.equal(markersLost(vam, h.contents.get(h.note.path)), true, 'precondition: the stale write damaged the card');
  await modified(h);
  assert.equal(h.contents.get(h.note.path), vam);
  assertIntact(h.contents.get(h.note.path));
  assert.match(h.contents.get(h.note.path), /\[\[Sources\/S1\]\]/);
  assert.match(h.contents.get(h.note.path), /Sources\/S1\.md/);
  assert.ok(h.lines.some(line => line.includes('rename_stale_link_write_repaired')));
});

test('Just once on an ordinary card with quoted frontmatter is put back too', async () => {
  const h = await harness({ living: false });
  const stale = obsidianUpdater(h, '[[Sources/Src0]]', '[[S1]]');
  await rename(h, 'Sources/Src0.md', 'Sources/S1.md');
  const vam = h.contents.get(h.note.path);
  await stale();
  await modified(h);
  assert.equal(h.contents.get(h.note.path), vam);
  assertIntact(vam, false);
});

test('two cards, each hit by its own stale write: both are put back', async () => {
  const h = await harness();
  const other = await h.addCard('Beta', 'Sources/Src2.md');
  const staleA = obsidianUpdater(h, '[[Sources/Src0]]', '[[S1]]');
  const staleB = obsidianUpdater(h, '[[Sources/Src2]]', '[[S3]]', other.path);
  const fileA = h.files.get('Sources/Src0.md'),
    fileB = h.files.get('Sources/Src2.md');
  await h.app.vault.rename(fileA, 'Sources/S1.md');
  await h.app.vault.rename(fileB, 'Sources/S3.md');
  await h.plugin.applyRenames([
    { pair: ['Sources/Src0.md', 'Sources/S1.md'], file: fileA, external: true },
    { pair: ['Sources/Src2.md', 'Sources/S3.md'], file: fileB, external: true }
  ]);
  const vamA = h.contents.get(h.note.path),
    vamB = h.contents.get(other.path);
  await staleA();
  await staleB();
  await modified(h);
  await modified(h, other.path);
  assert.equal(h.contents.get(h.note.path), vamA);
  assert.equal(h.contents.get(other.path), vamB);
});

test('a user edit before the stale write ends the watch: nothing is repaired (documented residual)', async () => {
  const h = await harness();
  const stale = obsidianUpdater(h, '[[Sources/Src0]]', '[[S1]]');
  await rename(h, 'Sources/Src0.md', 'Sources/S1.md');
  h.contents.set(h.note.path, `${h.contents.get(h.note.path)}\nmy own words\n`);
  await modified(h);
  assert.equal(h.repo.renameWatch.watching(h.note.path), false);
  await stale();
  const damaged = h.contents.get(h.note.path);
  await modified(h);
  assert.equal(h.contents.get(h.note.path), damaged);
});

test('a write that is not exactly a link replacement is never touched', async () => {
  const h = await harness();
  await rename(h, 'Sources/Src0.md', 'Sources/S1.md');
  const vam = h.contents.get(h.note.path);
  const typed = vam.replace('living text', 'living [[Elsewhere]] text');
  h.contents.set(h.note.path, typed);
  await modified(h);
  assert.equal(h.contents.get(h.note.path), typed);
  assert.equal(isStaleLinkWrite('a [[X]] b', 'a [[Other]] b', [['Sources/Src0.md', 'Sources/S1.md']]), false);
  assert.equal(isStaleLinkWrite('a XXXX b', 'a [[S1]] b', [['Sources/Src0.md', 'Sources/S1.md']]), true);
  assert.equal(structureIsHealthy('<!-- vam-living-node:begin v1 -->'), false);
});

test('Do not update: nothing waits, a Run Card commit right after the rename succeeds', async () => {
  const h = await harness();
  await rename(h, 'Sources/Src0.md', 'Sources/S1.md');
  const read = h.contents.get(h.note.path);
  const outcome = await h.repo.updateNoteGuarded(h.note.path, { summary: 'new summary' }, { expectedContent: read });
  assert.equal(outcome, 'written');
  assert.match(h.contents.get(h.note.path), /Sources\/S1\.md/);
});

test('Always update: Obsidian wrote first, VAM rewrites on the fresh content and watches nothing', async () => {
  const h = await harness({ alwaysUpdate: true });
  const stale = obsidianUpdater(h, '[[Sources/Src0]]', '[[S1]]');
  const file = h.files.get('Sources/Src0.md');
  await h.app.vault.rename(file, 'Sources/S1.md');
  await stale();
  await h.plugin.applyRenames([{ pair: ['Sources/Src0.md', 'Sources/S1.md'], file, external: true }]);
  assert.equal(h.repo.renameWatch.watching(h.note.path), false);
  assertIntact(h.contents.get(h.note.path));
  assert.ok(!h.contents.get(h.note.path).includes('Src0'));
});
