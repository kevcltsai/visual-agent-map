// New file and folder names (FG20-01/02/03/17/20) and the derived link alias (FG20-13a). Names are only ever made for NEW
// notes and maps; a stored path is never renamed on open, rebuild or sync.
// Uses its own fake vault on top of the shared fixture: creating or renaming onto a name that differs only by case or
// Unicode form fails with "already exists", like a case-insensitive file system (the shared fixture is case-sensitive).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load, obsidian, fixture, TFile, TFolder } = require('./support.cjs');
const { safeName, linkAlias } = load('repository.ts', { obsidian });

const noLoneSurrogate = value => !/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(value) && !value.includes('\ufffd');
const fold = name => name.normalize('NFC').toUpperCase().toLowerCase();
function foldingVault(language = 'en') {
  const env = fixture(language);
  const vault = env.app.vault, create = vault.create, createFolder = vault.createFolder, rename = vault.rename;
  const clash = (path, ignore) => {
    const folder = vault.getAbstractFileByPath(path.split('/').slice(0, -1).join('/'));
    if (!(folder instanceof TFolder)) return false;
    const name = path.split('/').at(-1);
    const stem = value => value.replace(/\.md$/, '');
    return folder.children.some(child => child.path !== ignore && fold(stem(child.name)) === fold(stem(name)));
  };
  vault.create = async (path, content) => { if (clash(path)) throw new Error('File already exists.'); return create(path, content); };
  vault.createFolder = async path => { if (clash(path)) throw new Error('Folder already exists.'); return createFolder(path); };
  vault.rename = async (item, target) => { if (clash(target, item.path)) throw new Error('Destination file already exists!'); return rename(item, target); };
  env.paths = () => Array.from(env.files.keys()).sort();
  return env;
}
const addNote = async (env, title, mapPath, doc) => { const note = await env.repo.createNote(title, 'model-a', doc, mapPath, 'workspace'); doc.nodes.push(note); await env.repo.saveMap(mapPath, doc); return note; };

test('FG20-01/17 safeName cuts at a grapheme boundary and never leaves a trailing space or dot', () => {
  const noLoneSurrogate = value => !/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(value) && !value.includes('�');
  const surrogate = safeName('字'.repeat(79) + '𠝹𡃁𠝹end');
  assert.ok(noLoneSurrogate(surrogate)); assert.equal(surrogate, '字'.repeat(79));
  const spaced = safeName(`${'a'.repeat(79)} ${'b'.repeat(10)}`);
  assert.equal(spaced, 'a'.repeat(79));
  assert.equal(safeName(`${'a'.repeat(70)}${'x'.repeat(5)}. ${'b'.repeat(20)}`).endsWith('.'), false);
  const family = '👨‍👩‍👧‍👦';
  const zwj = safeName('a'.repeat(76) + family + 'tail');
  assert.ok(noLoneSurrogate(zwj)); assert.ok(!zwj.endsWith('‍')); assert.equal(zwj, 'a'.repeat(76));
  const flags = safeName('a'.repeat(77) + '🇹🇼🇯🇵');
  assert.ok(!/[\u{1F1E6}-\u{1F1FF}]$/u.test(flags.replace(/(?:[\u{1F1E6}-\u{1F1FF}]{2})+$/u, '')));
  const devanagari = safeName('a'.repeat(78) + 'क्ष' + 'x');
  assert.ok(!devanagari.endsWith('्'));
  assert.ok(safeName('字'.repeat(200)).length <= 80);
  assert.equal(safeName('short title'), 'short title');
});

test('FG20-02 safeName strips leading dots and trailing dots or spaces', () => {
  assert.equal(safeName('...second'), 'second');
  assert.equal(safeName('...brouillon.'), 'brouillon');
  assert.equal(safeName('.hidden'), 'hidden');
  assert.equal(safeName('...'), 'Untitled topic');
  assert.equal(safeName('v1.2 notes'), 'v1.2 notes');
});

test('FG20-01 a surrogate-pair title creates a card at the path it reports, and the file exists', async () => {
  const env = foldingVault(); const mapPath = await env.repo.createMap('M'); const doc = await env.repo.readMap(mapPath);
  const note = await env.repo.createNote('字'.repeat(79) + '𠝹𡃁𠝹end', 'model-a', doc, mapPath, 'workspace');
  assert.ok(env.app.vault.getAbstractFileByPath(note.path) instanceof TFile);
  assert.ok(!note.path.includes('�'));
  assert.equal(env.paths().filter(path => path.includes('�')).length, 0);
});

test('FG20-02 dot titles create visible cards, and a dot-only title falls back to the untitled name', async () => {
  const env = foldingVault(); const mapPath = await env.repo.createMap('M'); const doc = await env.repo.readMap(mapPath);
  for (const title of ['...second', '...', '...brouillon.']) {
    const note = await env.repo.createNote(title, 'model-a', doc, mapPath, 'workspace');
    assert.ok(!note.path.split('/').at(-1).startsWith('.'), note.path);
    assert.ok(!note.path.replace(/\.md$/, '').endsWith('.'), note.path);
    assert.ok(env.app.vault.getAbstractFileByPath(note.path).parent.children.includes(env.app.vault.getAbstractFileByPath(note.path)));
  }
  const map = await env.repo.createMap('.x');
  assert.equal(map, 'Agent Workspace/Mind Maps/x/Map.md');
});

test('FG20-03 a title that differs only by Greek final sigma or case gets a numeric suffix and a card', async () => {
  const env = foldingVault(); const mapPath = await env.repo.createMap('M'); const doc = await env.repo.readMap(mapPath);
  const first = await addNote(env, 'λόγος', mapPath, doc);
  const second = await addNote(env, 'ΛΌΓΟΣ', mapPath, doc);
  const third = await addNote(env, 'λόγοσ', mapPath, doc);
  const folder = first.path.split('/').slice(0, -1).join('/');
  assert.equal(second.path, `${folder}/ΛΌΓΟΣ 2.md`);
  assert.equal(third.path, `${folder}/λόγοσ 3.md`);
  const ascii = await addNote(env, 'Λόγος', mapPath, doc);
  const upper = await addNote(env, 'ΛΟΓΟΣ', mapPath, doc);
  assert.equal(new Set([first, second, third, ascii, upper].map(n => n.path)).size, 5);
  assert.equal((await env.repo.readMap(mapPath)).nodes.length, 5);
});

test('FG20-03 a collision the plugin cannot see is retried with the next suffix and reports the created path', async () => {
  const env = foldingVault(); const mapPath = await env.repo.createMap('M'); const doc = await env.repo.readMap(mapPath);
  const target = `${mapPath.replace(/Map\.md$/, 'Notes')}/Hidden.md`; const create = env.app.vault.create; let tries = 0;
  env.app.vault.create = async (path, content) => { if (path === target && tries++ < 1) throw new Error('File already exists.'); return create(path, content); };
  const note = await env.repo.createNote('Hidden', 'model-a', doc, mapPath, 'workspace');
  assert.equal(note.path, target.replace(/\.md$/, ' 2.md'));
  assert.ok(env.app.vault.getAbstractFileByPath(note.path) instanceof TFile);
  env.app.vault.create = async () => { throw new Error('File already exists.'); };
  await assert.rejects(env.repo.createNote('Never', 'model-a', doc, mapPath, 'workspace'), /already exists/);
});

test('FG20-20 renaming a map onto a case-only variant of another map is a localized error that changes nothing', async () => {
  const env = foldingVault('en'); const lower = await env.repo.createMap('модель'); const other = await env.repo.createMap('Модель 2');
  const before = env.paths(), content = new Map(env.contents);
  await assert.rejects(env.repo.renameTopic(other, 'МОДЕЛЬ'), error => error.message === 'A topic folder with this name already exists.');
  assert.deepEqual(env.paths(), before);
  for (const [path, text] of content) assert.equal(env.contents.get(path), text);
  const again = await env.repo.createMap('МОДЕЛЬ');
  assert.equal(again, 'Agent Workspace/Mind Maps/МОДЕЛЬ 3/Map.md');
  const renamed = await env.repo.renameTopic(lower, 'Модель');
  assert.equal(renamed, 'Agent Workspace/Mind Maps/Модель/Map.md');
});

test('FG20-13a linkAlias removes link-breaking characters and falls back to the folder name', () => {
  const title = 'Fence ``` and --- %%x%% "q" [[L]] #t';
  const alias = linkAlias(title, 'folder');
  assert.ok(!/[[\]|`\n]/.test(alias)); assert.ok(!alias.includes('%%'));
  assert.equal(linkAlias('a | b\n c', 'folder'), 'a b c');
  assert.equal(linkAlias('[[]]|`', 'folder'), 'folder');
  assert.equal(linkAlias('a%%%b', 'folder'), 'a%b');
  assert.equal(linkAlias('a%%%%b', 'folder'), 'a%b');
  assert.ok(!linkAlias('%%%%%x%%%', 'folder').includes('%%'));
});

test('FG20-13a the derived Topic link of a note uses the safe alias and the note still parses', async () => {
  const env = foldingVault('en'); const title = 'Fence ``` and --- %%x%% "q" [[L]] #t';
  const mapPath = await env.repo.createMap(title); const doc = await env.repo.readMap(mapPath);
  const note = await addNote(env, 'child', mapPath, doc);
  await env.repo.rebuildDerivedData();
  const text = env.contents.get(note.path);
  const line = text.split('\n').find(row => row.includes('Topic: [['));
  assert.ok(line, text);
  const alias = line.match(/\|(.*)\]\]/)[1];
  assert.ok(!/[[\]|`]/.test(alias), line);
  assert.equal((await env.repo.readNote(note.path)).title, 'child');
});

test('DP2 existing paths made by the old 80-cut stay byte-identical through open, rebuild and sync', async () => {
  const env = foldingVault(); const mapPath = await env.repo.createMap('M'); const doc = await env.repo.readMap(mapPath);
  const notes = [];
  for (const title of ['one', 'two', 'three']) notes.push(await addNote(env, title, mapPath, doc));
  const folder = notes[0].path.split('/').slice(0, -1).join('/');
  const oldNames = [`${'字'.repeat(79)}�`, `${'a'.repeat(79)} `, 'ends with dots...'];
  for (const [index, note] of notes.entries()) {
    const target = `${folder}/${oldNames[index]}.md`; await env.app.vault.rename(env.app.vault.getAbstractFileByPath(note.path), target);
    note.path = target;
  }
  await env.repo.saveMap(mapPath, doc);
  const before = env.paths(), nodePaths = doc.nodes.map(node => node.path);
  await env.repo.readMap(mapPath); await env.repo.rebuildDerivedData(); await env.repo.ensureNodePresentation();
  await env.repo.rebuildDerivedData(); await env.repo.normalizeGeneratedNoteFilenames();
    assert.deepEqual((await env.repo.readMap(mapPath)).nodes.map(node => node.path), nodePaths);
  assert.deepEqual(env.paths(), before);
});

test('names fold only case and sigma: Straße and Strasse stay distinct, Greek cases still collide', async () => {
  const env = foldingVault(); const mapPath = await env.repo.createMap('M'); const doc = await env.repo.readMap(mapPath);
  const a = await addNote(env, 'Straße', mapPath, doc); const b = await addNote(env, 'Strasse', mapPath, doc);
  assert.ok(a.path.endsWith('/Straße.md')); assert.ok(b.path.endsWith('/Strasse.md'));
  const g = await addNote(env, 'λόγος', mapPath, doc);
  assert.ok((await addNote(env, 'ΛΌΓΟΣ', mapPath, doc)).path.endsWith('ΛΌΓΟΣ 2.md'));
  assert.ok((await addNote(env, 'λόγοσ', mapPath, doc)).path.endsWith('λόγοσ 3.md')); assert.ok(g);
});

test('renameTopic with an explicit targetRoot keeps the exact-match check (no case-folded block)', async () => {
  const env = foldingVault('en'); await env.repo.createMap('Alpha'); const other = await env.repo.createMap('Beta');
  const desired = 'Agent Workspace/Mind Maps/ALPHA';
  assert.equal(await env.repo.renameTopic(other, 'Beta', desired), `${desired}/Map.md`);
});
