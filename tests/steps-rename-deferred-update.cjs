// A source rename with Obsidian's "update links" prompt (Just once): Obsidian applies its link replacements later, at
// offsets it took before VAM's rewrite. VAM must not write the referencing note meanwhile; it applies its own rewrite
// on the fresh content once Obsidian wrote (or, with "Do not update", at its next write of the note).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load, fixture, DEFAULT_SETTINGS, obsidian } = require('./support.cjs');

const quiet = { ...obsidian, Notice: class { setMessage() {} hide() {} } };
const { default: Plugin } = load('main.ts', { obsidian: quiet });

const SRC0 = 'Sources/Src0.md', SRC1 = 'Sources/Src1.md';
const REGION = ['<!-- visual-agent-map:living-node:begin v1 -->', 'living text', '<!-- visual-agent-map:living-node:end -->'].join('\n');

async function harness(alwaysUpdate = false) {
  const { app, repo, contents, files } = fixture('en', { linkIndex: true });
  repo.settings = { ...DEFAULT_SETTINGS, language: 'en', cliModel: 'cur-model' };
  app.vault.getConfig = key => (key === 'alwaysUpdateLinks' ? alwaysUpdate : undefined);
  app.workspace = { getLeavesOfType: () => [], requestSaveLayout() {} };
  const plugin = new Plugin();
  Object.assign(plugin, { app, repo, settings: repo.settings, registerEvent: () => {}, logs: { appendLog() {} }, saveData: async () => {} });
  plugin.scheduleExternalReconciliation = () => {};
  plugin.rebuildDerivedData = async () => {};
  plugin.views = () => [];
  await app.vault.createFolder('Sources');
  await app.vault.create(SRC0, 'source text');
  const mapPath = await repo.createMap('M');
  const doc = await repo.readMap(mapPath);
  const note = await repo.createNote('Alpha', 'model-a', doc, mapPath, 'workspace');
  doc.nodes.push(note);
  await repo.saveMap(mapPath, doc);
  await repo.updateNote(note.path, { sourcePaths: [SRC0] });
  // Quoted scalars like the ones the Living Node writers produce, and a references block above the Living Node region.
  let text = contents.get(note.path).replace(/^title: Alpha$/m, 'title: "Alpha"').replace(/^(summary: .*)$/m, line => line);
  text = `${text.replace(/\n+$/, '')}\n\n${REGION}\n`;
  contents.set(note.path, text);
  return { app, repo, contents, files, plugin, note };
}

/** The offsets Obsidian takes of the links to the renamed file when the rename starts (before any VAM write). */
function obsidianLinkUpdate(contents, path) {
  const before = contents.get(path);
  const spans = [...before.matchAll(/\[\[Sources\/Src0\]\]/g)].map(m => [m.index, m.index + m[0].length]);
  return async app => app.vault.process(app.vault.getAbstractFileByPath(path), current => {
    let out = current;
    for (const [start, end] of spans.reverse()) out = out.slice(0, start) + '[[Sources/Src1]]' + out.slice(end);
    return out;
  });
}
async function rename(h) {
  const file = h.files.get(SRC0);
  await h.app.vault.rename(file, SRC1);
  await h.plugin.applyRenames([{ pair: [SRC0, SRC1], file, external: true }]);
}
function assertIntact(text) {
  for (const mark of ['references:start -->', 'references:end -->', 'living-node:begin v1 -->', 'living-node:end -->', 'living text'])
    assert.ok(text.includes(mark), `${mark} survives\n${text}`);
  assert.ok(!text.includes('Src0'), `no link to the old path is left\n${text}`);
  assert.match(text, /\[\[Sources\/Src1\]\]/);
  assert.match(text, /Sources\/Src1\.md/, 'frontmatter source-notes follow');
  assert.match(text, /^title: "Alpha"$/m, 'quoted frontmatter of untouched keys keeps its quotes');
}

test('Just once: Obsidian applies its link update at stale offsets after the rename, the card stays intact', async () => {
  const h = await harness();
  const obsidianWrites = obsidianLinkUpdate(h.contents, h.note.path);
  await rename(h);
  await obsidianWrites(h.app);
  assert.equal(h.repo.hasDeferredRewrite(h.note.path), true, 'the rewrite waits for the note');
  await h.repo.applyDeferredRewrite(h.note.path);
  assertIntact(h.contents.get(h.note.path));
  assert.equal(h.repo.hasDeferredRewrite(h.note.path), false);
});

test('Do not update: the held rewrite is applied at the next VAM write of the note', async () => {
  const h = await harness();
  await rename(h);
  assert.match(h.contents.get(h.note.path), /Src0/, 'untouched until needed');
  await h.repo.updateNote(h.note.path, { summary: 'new summary' });
  const text = h.contents.get(h.note.path);
  assert.ok(!text.includes('Src0'), text);
  assert.match(text, /Sources\/Src1\.md/);
  assert.ok(text.includes('living-node:begin v1 -->'));
});

test('Always update: Obsidian wrote first, VAM rewrites at once on the fresh content', async () => {
  const h = await harness(true);
  const obsidianWrites = obsidianLinkUpdate(h.contents, h.note.path);
  const file = h.files.get(SRC0);
  await h.app.vault.rename(file, SRC1);
  await obsidianWrites(h.app);
  await h.plugin.applyRenames([{ pair: [SRC0, SRC1], file, external: true }]);
  assert.equal(h.repo.hasDeferredRewrite(h.note.path), false);
  assertIntact(h.contents.get(h.note.path));
});

test('An ordinary card with quoted frontmatter and no Living Node region survives Just once too', async () => {
  const h = await harness();
  h.contents.set(h.note.path, h.contents.get(h.note.path).replace(REGION, ''));
  const obsidianWrites = obsidianLinkUpdate(h.contents, h.note.path);
  await rename(h);
  await obsidianWrites(h.app);
  await h.repo.applyDeferredRewrite(h.note.path);
  const text = h.contents.get(h.note.path);
  assert.ok(text.includes('references:end -->') && text.includes('references:start -->'), text);
  assert.ok(!text.includes('Src0'), text);
  assert.match(text, /^title: "Alpha"$/m);
});

test('A note that does not link to the renamed file is rewritten at once', async () => {
  const h = await harness();
  h.contents.set(h.note.path, h.contents.get(h.note.path).replaceAll('[[Sources/Src0]]', 'plain'));
  await rename(h);
  assert.equal(h.repo.hasDeferredRewrite(h.note.path), false);
  assert.match(h.contents.get(h.note.path), /Sources\/Src1\.md/);
});
