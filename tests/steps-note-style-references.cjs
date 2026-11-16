// note-style-integrity P2: ai/note-style-references.ts over pure-data fake ports (no Obsidian, no vault). Same matrix as the
// characterization tests C1-C14 in steps-note-style-manage.cjs, plus the order in which the ports are called.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadSource, root } = require('./support-replay.cjs');

const R = loadSource('export * from "./ai/note-style-references";');
const plain = value => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

/** Fake ports over plain data. `state.settings` can be swapped; every port call is logged with its name. */
function fake(settings = {}, options = {}) {
  const state = { settings, saves: 0, log: [], topics: options.topics ?? [], renamedTopics: [], failSave: false, failTrash: false, failTopics: new Set(options.failTopics ?? []), rename: options.rename, part: options.part ?? { changed: [], failed: [] }, onRename: undefined };
  state.ports = {
    settings: () => state.settings,
    save: async () => { state.saves++; state.log.push('save'); if (state.failSave) throw new Error('disk'); },
    files: {
      renameFile: async (category, ref, name) => {
        state.log.push('renameFile');
        await state.onRename?.();
        return state.rename ?? { ok: true, ref: `file:${name}` };
      },
      rewritePartRefs: async (category, from, to) => { state.log.push('rewritePartRefs'); if (state.partThrows) throw new Error('boom'); state.partArgs = [category, from, to]; return state.part; },
      trashFile: async () => { state.log.push('trashFile'); if (state.failTrash) throw new Error('nope'); }
    },
    topics: {
      list: () => { state.log.push('topics.list'); return state.topics; },
      rename: async (file, from, to) => { state.log.push('topics.rename'); if (state.failTopics.has(file)) throw new Error('locked'); state.renamedTopics.push([file, from, to]); return true; }
    }
  };
  return state;
}

test('module: no Obsidian, repository or i18n import (pure data ports)', () => {
  const source = fs.readFileSync(path.join(root, 'ai', 'note-style-references.ts'), 'utf8');
  for (const bad of ['obsidian', 'repository', 'i18n']) assert.doesNotMatch(source, new RegExp(`from ["'][^"']*${bad}["']`), bad);
});

test('C1 rename: a failing save is swallowed; settingsFailed is set, topics are still written', async () => {
  const s = fake({ noteStyleByKind: { hypothesis: 'file:W' } }, { topics: [{ path: 'a.md', ref: 'file:W' }] });
  s.failSave = true;
  const result = await R.renameStyleReferences(s.ports, 'recipe', 'file:W', 'M');
  assert.deepEqual(plain(result), { ok: true, ref: 'file:M', topics: 1, styles: 0, failed: [], settingsFailed: true });
  assert.deepEqual(plain(s.settings.noteStyleByKind), { hypothesis: 'file:M' });
  assert.equal(s.saves, 1);
});

test('C2 rename a part: style files that fail come back in failed, in order; a rewritePartRefs that rejects goes out after the save', async () => {
  const s = fake({ noteStyleRecipe: { migrated: 1, legacy: { templates: { t: 'file:Mine' }, tones: {} } } }, { part: { changed: ['x'], failed: ['User2.md'] } });
  s.failSave = true;
  const result = await R.renameStyleReferences(s.ports, 'structure', 'file:Mine', 'Plan');
  assert.deepEqual(plain(result), { ok: true, ref: 'file:Plan', topics: 0, styles: 1, failed: ['User2.md'], settingsFailed: true });
  assert.deepEqual(s.partArgs, ['structure', 'Mine', 'Plan']);
  assert.deepEqual(s.log, ['renameFile', 'save', 'rewritePartRefs']);
  const other = fake({ noteStyleRecipe: { migrated: 1, legacy: { templates: { t: 'file:Mine' }, tones: {} } } });
  other.partThrows = true;
  await assert.rejects(R.renameStyleReferences(other.ports, 'structure', 'file:Mine', 'Plan'), /boom/);
  assert.equal(other.saves, 1);
});

test('C2 rename: topics that cannot be written are listed in failed and do not stop the others', async () => {
  const s = fake({}, { topics: [{ path: 'a.md', ref: 'file:W' }, { path: 'b.md', ref: 'file:W' }, { path: 'c.md', ref: 'file:W' }, { path: 'd.md', ref: 'file:Other' }], failTopics: ['b.md'] });
  const result = await R.renameStyleReferences(s.ports, 'recipe', 'file:W', 'M');
  assert.deepEqual(plain(result), { ok: true, ref: 'file:M', topics: 2, styles: 0, failed: ['b.md'], settingsFailed: false });
  assert.deepEqual(s.renamedTopics.map(item => item[0]), ['a.md', 'c.md']);
});

test('C3 rename refused: the store answer comes back as the same object; nothing is saved or written', async () => {
  const refused = { ok: false, reason: 'taken' };
  const s = fake({ noteStyleByKind: { hypothesis: 'file:W' } }, { rename: refused, topics: [{ path: 'a.md', ref: 'file:W' }] });
  assert.equal(await R.renameStyleReferences(s.ports, 'recipe', 'file:W', 'Other'), refused);
  assert.equal(s.saves, 0);
  assert.deepEqual(s.log, ['topics.list', 'renameFile']);
});

test('C4 rename unchanged: ok with unchanged and zero counts, no save, no write', async () => {
  const s = fake({ noteStyleByKind: { hypothesis: 'file:W' } }, { rename: { ok: true, ref: 'file:W', unchanged: true }, topics: [{ path: 'a.md', ref: 'file:W' }] });
  assert.deepEqual(plain(await R.renameStyleReferences(s.ports, 'recipe', 'file:W', 'W')), { ok: true, ref: 'file:W', unchanged: true, topics: 0, styles: 0, failed: [] });
  assert.equal(s.saves, 0);
  assert.deepEqual(s.log, ['topics.list', 'renameFile']);
});

test('C5 call order: a style reads the topics before renameFile, then save, then the topic writes; a part never reads the topics', async () => {
  const s = fake({ noteStyleByKind: { hypothesis: 'file:W' } }, { topics: [{ path: 'a.md', ref: 'file:W' }, { path: 'b.md', ref: 'file:W' }] });
  await R.renameStyleReferences(s.ports, 'recipe', 'file:W', 'M');
  assert.deepEqual(s.log, ['topics.list', 'renameFile', 'save', 'topics.rename', 'topics.rename']);
  const p = fake({ noteStyleDefaults: { voice: 'file:Calm' } }, { topics: [{ path: 'a.md', ref: 'file:Calm' }] });
  await R.renameStyleReferences(p.ports, 'voice', 'file:Calm', 'Soft');
  assert.deepEqual(p.log, ['renameFile', 'save', 'rewritePartRefs']);
});

test('C6 rename a format: the global format follows, no legacy table is invented; a structure with nothing to follow saves nothing', async () => {
  const s = fake({ noteStyleDefaults: { format: 'file:F', voice: 'file:Calm' } });
  await R.renameStyleReferences(s.ports, 'format', 'file:F', 'F2');
  assert.deepEqual(plain(s.settings), { noteStyleDefaults: { format: 'file:F2', voice: 'file:Calm' } });
  assert.equal(s.saves, 1);
  const bare = fake({});
  await R.renameStyleReferences(bare.ports, 'structure', 'file:Mine', 'Plan');
  assert.equal(bare.saves, 0);
  assert.deepEqual(plain(bare.settings), {});
  const voice = fake({ noteStyleRecipe: { migrated: 1, mapsNotified: true, legacy: { templates: {}, tones: { x: 'file:Mine' } } } });
  await R.renameStyleReferences(voice.ports, 'voice', 'file:Mine', 'Calm');
  assert.deepEqual(plain(voice.settings.noteStyleRecipe), { migrated: 1, mapsNotified: true, legacy: { templates: {}, tones: { x: 'file:Calm' } } }, 'spread keeps the marker');
});

test('C7 rename a style nothing refers to: no save', async () => {
  const s = fake({ noteStyleByKind: { atomic: 'file:Other' } }, { topics: [{ path: 'a.md', ref: 'file:Other' }] });
  assert.deepEqual(plain(await R.renameStyleReferences(s.ports, 'recipe', 'file:W', 'M')), { ok: true, ref: 'file:M', topics: 0, styles: 0, failed: [], settingsFailed: false });
  assert.equal(s.saves, 0);
});

test('C8 delete when the trash fails: false, nothing else changes, no save', async () => {
  const s = fake({ noteStyleByKind: { hypothesis: 'file:W' }, noteStyleDefaults: { voice: 'file:W' } });
  s.failTrash = true;
  const before = JSON.stringify(s.settings);
  assert.equal(await R.deleteStyleReferences(s.ports, 'recipe', 'file:W'), false);
  assert.equal(JSON.stringify(s.settings), before);
  assert.equal(s.saves, 0);
});

test('C9 delete: a save that throws after the trash rejects (F1, pinned)', async () => {
  const s = fake({ noteStyleByKind: { hypothesis: 'file:W' } });
  s.failSave = true;
  await assert.rejects(R.deleteStyleReferences(s.ports, 'recipe', 'file:W'), /disk/);
  assert.equal('noteStyleByKind' in s.settings, false);
  assert.deepEqual(s.log, ['trashFile', 'save']);
});

test('C10 delete a part: the global voice or format that named it goes back to the default; anything else saves nothing', async () => {
  const a = fake({ noteStyleDefaults: { voice: 'file:Calm' } });
  assert.equal(await R.deleteStyleReferences(a.ports, 'voice', 'file:Calm'), true);
  assert.equal('noteStyleDefaults' in a.settings, false);
  assert.equal(a.saves, 1);
  const b = fake({ noteStyleDefaults: { voice: 'file:Calm', format: 'file:F' } });
  await R.deleteStyleReferences(b.ports, 'format', 'file:F');
  assert.deepEqual(plain(b.settings.noteStyleDefaults), { voice: 'file:Calm' });
  assert.equal(b.saves, 1);
  for (const [category, ref, defaults] of [['voice', 'file:Calm', { voice: 'file:Other' }], ['structure', 'file:Mine', { voice: 'file:Mine' }], ['voice', 'file:Calm', undefined]]) {
    const c = fake(defaults ? { noteStyleDefaults: defaults } : {});
    await R.deleteStyleReferences(c.ports, category, ref);
    assert.equal(c.saves, 0, `${category} ${ref}`);
    assert.deepEqual(plain(c.settings.noteStyleDefaults), defaults);
  }
});

test('C11 settings replaced while a call waits (or between calls): every function reads settings() when it runs', async () => {
  const s = fake({ noteStyleByKind: { hypothesis: 'file:W' } });
  const fresh = { noteStyleByKind: { action: 'file:W', atomic: 'file:Other' } };
  s.onRename = () => { s.settings = fresh; };
  await R.renameStyleReferences(s.ports, 'recipe', 'file:W', 'M');
  assert.deepEqual(plain(fresh.noteStyleByKind), { action: 'file:M', atomic: 'file:Other' });
  const two = { noteStyleByKind: { atomic: 'file:Z', action: 'file:Z' } };
  s.settings = two;
  assert.deepEqual(plain(await R.clearKindStyles(s.ports, 'file:Z')), ['atomic', 'action']);
  assert.equal('noteStyleByKind' in two, false);
  const three = {};
  s.settings = three;
  await R.setKindStyle(s.ports, 'action', 'file:Q');
  assert.deepEqual(plain(three.noteStyleByKind), { action: 'file:Q' });
  const four = {};
  s.settings = four;
  await R.setGlobalPart(s.ports, 'voice', 'builtin:guide');
  assert.deepEqual(plain(four.noteStyleDefaults), { voice: 'builtin:guide' });
});

test('C12 clearKindStyles / setKindStyle / setGlobalPart: a throwing save rejects after the memory changed; one save each; no-ops save nothing', async () => {
  const s = fake({ noteStyleByKind: { hypothesis: 'file:W' } });
  s.failSave = true;
  await assert.rejects(R.clearKindStyles(s.ports, 'file:W'), /disk/);
  assert.equal('noteStyleByKind' in s.settings, false);
  await assert.rejects(R.setKindStyle(s.ports, 'action', 'file:Q'), /disk/);
  assert.deepEqual(plain(s.settings.noteStyleByKind), { action: 'file:Q' });
  await assert.rejects(R.setGlobalPart(s.ports, 'voice', 'builtin:guide'), /disk/);
  assert.equal(s.saves, 3);
  s.failSave = false;
  assert.deepEqual(plain(await R.clearKindStyles(s.ports, 'file:None')), []);
  await R.setGlobalPart(s.ports, 'voice', 'file:');
  await R.setGlobalPart(s.ports, 'format', 'plain');
  assert.equal(s.saves, 3);
  await R.setKindStyle(s.ports, 'action', 'builtin:action');
  assert.equal('noteStyleByKind' in s.settings, false, 'a table that became empty is removed, not {}');
  await R.setGlobalPart(s.ports, 'voice', 'builtin:academic');
  assert.equal('noteStyleDefaults' in s.settings, false);
  assert.equal(s.saves, 5);
});

test('C13 a topic that appears while renameFile waits is not followed (F2, pinned)', async () => {
  const s = fake({}, { topics: [{ path: 'a.md', ref: 'file:W' }] });
  s.onRename = () => { s.topics = [...s.topics, { path: 'late.md', ref: 'file:W' }]; };
  const result = await R.renameStyleReferences(s.ports, 'recipe', 'file:W', 'M');
  assert.equal(result.topics, 1);
  assert.deepEqual(s.renamedTopics.map(item => item[0]), ['a.md']);
  assert.equal(s.log.filter(name => name === 'topics.list').length, 1);
});

test('C14 rename and delete started together on the same style: with a store that serializes, the trash finds no file and answers false', async () => {
  const s = fake({ noteStyleByKind: { hypothesis: 'file:W' } }, { topics: [{ path: 'a.md', ref: 'file:W' }] });
  let renamed = false;
  let queue = Promise.resolve();
  const serial = task => { const run = queue.then(task); queue = run.catch(() => undefined); return run; };
  const realRename = s.ports.files.renameFile;
  s.ports.files.renameFile = (...args) => serial(async () => { const out = await realRename(...args); renamed = true; return out; });
  s.ports.files.trashFile = () => serial(async () => { s.log.push('trashFile'); if (renamed) throw new Error('missing'); });
  const [a, b] = await Promise.all([R.renameStyleReferences(s.ports, 'recipe', 'file:W', 'M'), R.deleteStyleReferences(s.ports, 'recipe', 'file:W')]);
  assert.equal(a.ok, true);
  assert.equal(b, false);
  assert.deepEqual(plain(s.settings.noteStyleByKind), { hypothesis: 'file:M' });
  assert.equal(s.saves, 1);
});
