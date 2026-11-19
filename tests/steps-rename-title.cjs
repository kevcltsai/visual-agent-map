// T13: a vault rename of a map node's note makes its title follow the new file name when the title was the old file name.
// A custom title, a folder move (same name), a note on no map and a note edited while the rename is handled are left alone.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load, fixture, DEFAULT_SETTINGS, obsidian } = require('./support.cjs');

const quiet = { ...obsidian, Notice: class { setMessage() {} hide() {} } };
const { default: Plugin } = load('main.ts', { obsidian: quiet });

async function harness() {
  const { app, repo, contents, files } = fixture('en', { linkIndex: true });
  repo.settings = { ...DEFAULT_SETTINGS, language: 'en', cliModel: 'cur-model' };
  app.workspace = { getLeavesOfType: () => [], requestSaveLayout() {} };
  const plugin = new Plugin();
  Object.assign(plugin, { app, repo, settings: repo.settings, registerEvent: () => {}, logs: { appendLog() {} }, saveData: async () => {} });
  plugin.scheduleExternalReconciliation = () => {};
  plugin.rebuildDerivedData = async () => {};
  plugin.views = () => [];
  const mapPath = await repo.createMap('M');
  const doc = await repo.readMap(mapPath);
  const note = await repo.createNote('Alpha', 'model-a', doc, mapPath, 'workspace');
  doc.nodes.push(note);
  await repo.saveMap(mapPath, doc);
  /** Renames on disk, then lets the plugin handle the rename event the way the vault listener queues it. */
  const rename = async (from, to) => {
    const file = files.get(from);
    await app.vault.rename(file, to);
    await plugin.applyRenames([{ pair: [from, to], file, external: true }]);
    return files.get(to);
  };
  const titleOf = async path => (await repo.readNote(path)).title;
  return { app, repo, contents, files, plugin, note, mapPath, rename, titleOf };
}
const dirOf = path => path.slice(0, path.lastIndexOf('/'));

test('T13 title equal to the old file name follows the new file name (heading and title field), through the guarded write', async () => {
  const h = await harness();
  assert.equal(await h.titleOf(h.note.path), 'Alpha');
  const target = `${dirOf(h.note.path)}/Omega.md`;
  await h.rename(h.note.path, target);
  assert.equal(await h.titleOf(target), 'Omega');
  assert.match(h.contents.get(target), /^# Omega$/m);
  assert.match(h.contents.get(target), /^title: Omega$/m);
  const map = await h.repo.readMap(h.mapPath);
  assert.equal(map.nodes[0].path, target, 'the map follows as before');
});

test('T13 a custom title is kept', async () => {
  const h = await harness();
  await h.repo.updateNote(h.note.path, { title: 'My own chapter name' });
  const target = `${dirOf(h.note.path)}/Omega.md`;
  const before = h.contents.get(h.note.path);
  await h.rename(h.note.path, target);
  assert.equal(await h.titleOf(target), 'My own chapter name');
  assert.equal(h.contents.get(target), before, 'the note is not rewritten');
});

test('T13 a folder move with the same file name changes nothing', async () => {
  const h = await harness();
  const target = `${dirOf(h.note.path)}/Sub/Alpha.md`;
  await h.app.vault.createFolder?.(`${dirOf(h.note.path)}/Sub`).catch(() => undefined);
  const before = h.contents.get(h.note.path);
  await h.rename(h.note.path, target);
  assert.equal(h.contents.get(target), before);
  assert.equal(await h.repo.followRenamedTitle(h.note.path, target), false);
});

test('T13 a note that is on no map is ignored, even when its title is its file name', async () => {
  const h = await harness();
  const plain = `${dirOf(h.note.path)}/Plain.md`;
  h.app.vault.create ? await h.app.vault.create(plain, '# Plain\n\nbody\n') : h.contents.set(plain, '# Plain\n\nbody\n');
  const target = `${dirOf(plain)}/Renamed.md`;
  const before = h.contents.get(plain);
  await h.rename(plain, target);
  assert.equal(h.contents.get(target), before);
});

test('T13 a note edited while the rename is handled keeps the edit and its old title (the guarded write refuses)', async () => {
  const h = await harness();
  const target = `${dirOf(h.note.path)}/Omega.md`;
  await h.app.vault.rename(h.files.get(h.note.path), target);
  await h.plugin.rebaseMaps([[h.note.path, target]]);
  const read = h.app.vault.read.bind(h.app.vault);
  let raced = false;
  h.app.vault.read = async file => {
    const text = await read(file);
    if (file.path === target && !raced) { raced = true; h.contents.set(target, `${text}\nowner typed this\n`); }
    return text;
  };
  const changed = await h.repo.followRenamedTitle(h.note.path, target);
  assert.equal(changed, false);
  assert.match(h.contents.get(target), /owner typed this/);
  assert.match(h.contents.get(target), /^# Alpha$/m, 'title left as it was');
  // Handled again without the race: it follows.
  h.app.vault.read = read;
  assert.equal(await h.repo.followRenamedTitle(h.note.path, target), true);
  assert.match(h.contents.get(target), /owner typed this/);
  assert.equal(await h.titleOf(target), 'Omega');
});
