// The note-write scope is an explicit Repository view, not node AsyncLocalStorage (whose getStore crashed the Electron renderer
// after vault fs ops). A write is guarded only when it goes through the view a transaction hands to its callbacks; a write through the
// original repository is not guarded, and the transaction then refuses at its snapshot check (it never fails open).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fixture, load, obsidian, core, deferred, root, DEFAULT_SETTINGS } = require('./support.cjs');

const { begin, isTransactionError } = load('experiences/visual-map/map-transaction.ts', { obsidian });
const TOPICS = 'Agent Workspace/Topics';
const MAP = `${TOPICS}/map-u/Map.md`;
const UNASSIGNED = `${TOPICS}/map-u/Unassigned`;

test('W1: repository.ts and the built main.js contain no async_hooks / AsyncLocalStorage', () => {
  for (const file of ['repository.ts', 'main.js']) {
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    assert.ok(!/async_hooks|AsyncLocalStorage/.test(text), `${file} still mentions async_hooks / AsyncLocalStorage`);
  }
});

function plainRepo() {
  const { repo, app, contents } = fixture('en', { linkIndex: true });
  repo.settings = { ...DEFAULT_SETTINGS, language: 'en' };
  return { repo, app, contents };
}
const note = async (app, name, text = 'x') => app.vault.create(name, text);
const tagGuard = (log, tag) => (file, current, change) => { log.push(`${tag}:${file.path}`); return change(current); };

test('W2: a write outside any scope is unguarded, and a write through the original inside a scope is unguarded too', async () => {
  const { repo, app, contents } = plainRepo();
  await note(app, 'a.md');
  const log = [];
  await repo.app.vault.process(repo.file('a.md'), c => c + '1');
  assert.deepEqual(log, []);
  await repo.withNoteWriteGuard(tagGuard(log, 'g'), async scoped => {
    await repo.app.vault.process(repo.file('a.md'), c => c + '2');
    assert.deepEqual(log, [], 'the original repository is not the scope');
    await scoped.app.vault.process(scoped.file('a.md'), c => c + '3');
  });
  assert.deepEqual(log, ['g:a.md']);
  assert.equal(contents.get('a.md'), 'x123');
  assert.equal(repo.acceptsNoteHistory(repo.file('a.md'), 'x'), false);
});

test('W3: nested scopes combine (outer sees the inner write, outer acceptsHistory applies, outer aroundHostMove wraps the inner)', async () => {
  const { repo, app } = plainRepo();
  await note(app, 'a.md');
  // A note that is not a VAM note links to it, so the move is Obsidian's own rename (the one aroundHostMove wraps).
  await note(app, 'other.md', 'see [[a]]');
  app.metadataCache.resolvedLinks = { 'other.md': { 'a.md': 1 } };
  const log = [];
  const outer = tagGuard(log, 'outer');
  outer.acceptsHistory = () => true;
  outer.aroundHostMove = async (from, to, move) => { log.push('outer:in'); await move(); log.push('outer:out'); };
  const inner = tagGuard(log, 'inner');
  inner.aroundHostMove = async (from, to, move) => { log.push('inner:in'); await move(); log.push('inner:out'); };
  await repo.withNoteWriteGuard(outer, async s1 => {
    await s1.withNoteWriteGuard(inner, async s2 => {
      assert.equal(s2.acceptsNoteHistory(s2.file('a.md'), 'x'), true);
      await s2.app.vault.process(s2.file('a.md'), c => c + '!');
      await s2.moveExact('a.md', 'b.md');
    });
    assert.equal(s1.acceptsNoteHistory(s1.file('b.md'), 'x'), true);
  });
  assert.deepEqual(log, ['outer:a.md', 'inner:a.md', 'outer:in', 'inner:in', 'inner:out', 'outer:out']);
  assert.equal(repo.acceptsNoteHistory(repo.file('b.md'), 'x'), false, 'the scope ended');
});

test('W4: concurrent interleaved scopes are isolated from each other', async () => {
  const { repo, app } = plainRepo();
  await note(app, 'a.md');
  await note(app, 'b.md');
  const logA = [], logB = [];
  const gate = deferred();
  const first = repo.withNoteWriteGuard(tagGuard(logA, 'A'), async s => {
    await gate.promise;
    await s.app.vault.process(s.file('a.md'), c => c + 'A');
  });
  const second = repo.withNoteWriteGuard(tagGuard(logB, 'B'), async s => {
    await s.app.vault.process(s.file('b.md'), c => c + 'B');
    gate.resolve();
    await first;
    await s.app.vault.process(s.file('a.md'), c => c + 'b');
  });
  await Promise.all([first, second]);
  assert.deepEqual(logA, ['A:a.md']);
  assert.deepEqual(logB, ['B:b.md', 'B:a.md']);
});

async function harness() {
  const { repo, app, contents } = fixture('en', { linkIndex: true });
  repo.settings = { ...DEFAULT_SETTINGS, language: 'en' };
  const doc = { id: 'map-u', title: 'map-u', version: 1, nodes: [], viewport: { x: 0, y: 0, zoom: 1 } };
  await repo.ensureTopicFolders(`${TOPICS}/map-u`);
  await app.vault.create(MAP, core.serializeMap(doc));
  const nodes = [];
  for (const title of ['Parent', 'Child A']) {
    const node = await repo.createNote(title, 'gpt-6-luna', doc, MAP, 'workspace');
    node.parentId = nodes.length ? nodes[0].id : null;
    doc.nodes.push(node);
    nodes.push(node);
  }
  await repo.saveMap(MAP, doc);
  const [parent, a] = nodes.map(n => n.path);
  await repo.rebuildDerivedData();
  const deps = { repo, rebuildDerivedData: async () => repo.rebuildDerivedData(), onApplied: () => {}, checkConflict: async () => {} };
  const rejected = async promise => { try { await promise; } catch (error) { return error; } return assert.fail('expected a rejection'); };
  return { repo, app, contents, parent, a, deps, rejected };
}
const patch = (repo, path) => repo.updateNote(path, { summary: 'Scoped summary', detail: 'Scoped detail' });

test('W5: a rewriteNote callback that writes through the repository it is handed commits', async () => {
  const h = await harness();
  await begin(h.deps).rewriteNote(h.parent, async (path, attachment, repo) => { await patch(repo, path); }).commit();
  assert.match(h.contents.get(h.parent), /Scoped summary/);
});

test('W6: fail closed: a callback writing a tracked note through the original repository makes commit refuse and undo nothing else', async () => {
  const h = await harness();
  const mapBefore = h.contents.get(MAP);
  const error = await h.rejected(
    begin(h.deps)
      .rewriteNote(h.parent, async path => { await patch(h.repo, path); })
      .park(h.a, UNASSIGNED, 'map-u', 'unassigned')
      .commit()
  );
  assert.ok(isTransactionError(error, 'guard'), `refused with guard, got ${error?.message}`);
  assert.ok(h.app.vault.getAbstractFileByPath(h.a), 'the parked note went back');
  assert.equal(h.contents.get(MAP), mapBefore);
});

test('W7: two interleaved transactions track only their own notes', async () => {
  const h = await harness();
  const gate = deferred(), started = deferred();
  const slow = begin(h.deps)
    .rewriteNote(h.parent, async (path, attachment, repo) => { started.resolve(); await gate.promise; await patch(repo, path); })
    .commit();
  await started.promise;
  const fast = await begin(h.deps).rewriteNote(h.a, async (path, attachment, repo) => { await patch(repo, path); }).commit();
  assert.ok(fast);
  gate.resolve();
  await slow;
  assert.match(h.contents.get(h.parent), /Scoped summary/);
  assert.match(h.contents.get(h.a), /Scoped summary/);
});
