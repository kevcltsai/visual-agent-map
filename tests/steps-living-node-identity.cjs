const { test } = require('node:test');
const assert = require('node:assert/strict');
const support = require('./support.cjs');
const { LivingIdentityStore, resolveLivingSources, livingConfigRef, readLivingIdentityEntries } =
  support.load('experiences/visual-map/living-node-sources.ts');
const plain = x => JSON.parse(JSON.stringify(x));
const nodes = [{ id: 'root', path: 'root.md' }];
const note = link => ({ kind: 'note', link, exact: true });
const stat = (ctime, size) => ({ ctime, size });
let n = 0;
const make = saved => new LivingIdentityStore(saved, () => {}, () => 'id' + ++n);
// A port over the store, like the runtime adapter: the file at the path is looked at through observe().
function portFor(store, files) {
  return { resolveAuthorized: link => {
    const f = files[link]; if (!f) return undefined;
    const e = store.observe(link, f);
    return { identity: e.refId, path: link, ...(e.state === 'resolved' ? {} : { unresolved: true }) };
  } };
}
const resolve = (store, files, refs = [note('a.md')]) => resolveLivingSources(nodes, 'root', refs, [], portFor(store, files));

test('identity: rename keeps the bound identity and does not change consumer input', () => {
  const store = make(); const files = { 'a.md': stat(10, 5) };
  const before = resolve(store, files).sources[0];
  store.renamed('a.md', 'b.md');
  const after = resolve(store, { 'b.md': stat(10, 5) }, [note('b.md')]).sources[0];
  assert.equal(after.identity, before.identity);
  assert.equal(store.at('b.md').state, 'resolved');
  assert.equal(store.at('b.md').continuityGen, 1);
  assert.equal(store.at('a.md'), undefined);
  const id = path => store.at(path)?.refId;
  assert.equal(livingConfigRef(note('b.md'), id), livingConfigRef({ kind: 'note', link: 'b.md', exact: true }, id));
  assert.match(livingConfigRef(note('b.md'), id), /"id"/);
});

test('identity: delete then same-path recreate with a new ctime is unresolved and never rebound', () => {
  const store = make(); resolve(store, { 'a.md': stat(10, 5) });
  store.deleted('a.md');
  assert.equal(store.at('a.md').state, 'dangling');
  store.created('a.md', stat(99, 5));
  assert.equal(store.at('a.md').state, 'dangling');
  const result = resolve(store, { 'a.md': stat(99, 5) });
  assert.deepEqual(plain(result.failures.map(f => [f.reason, f.required])), [['source-replaced', true]]);
  assert.equal(result.sources.length, 0);
});

test('identity: same-path replacement while running (create without delete, or changed ctime) is unresolved', () => {
  const a = make(); resolve(a, { 'a.md': stat(10, 5) });
  a.created('a.md', stat(11, 5));
  assert.equal(a.at('a.md').state, 'dangling');
  const b = make(); resolve(b, { 'a.md': stat(10, 5) });
  const r = resolve(b, { 'a.md': stat(12, 5) });
  assert.equal(r.failures[0].reason, 'source-replaced');
});

test('identity: undo of a delete that restores the same ctime and size restores identity; ctime alone does not', () => {
  const store = make(); const first = resolve(store, { 'a.md': stat(10, 5) }).sources[0].identity;
  store.deleted('a.md');
  store.created('a.md', stat(10, 6));
  assert.equal(store.at('a.md').state, 'dangling');
  store.created('a.md', stat(10, 5));
  assert.equal(store.at('a.md').state, 'resolved');
  assert.equal(resolve(store, { 'a.md': stat(10, 5) }).sources[0].identity, first);
});

test('identity: restore without a ctime stays unresolved', () => {
  const store = make(); resolve(store, { 'a.md': stat(0, 5) });
  store.deleted('a.md'); store.created('a.md', stat(0, 5));
  assert.equal(store.at('a.md').state, 'dangling');
});

test('identity: restart keeps resolved only when path, ctime and size match', () => {
  const store = make(); resolve(store, { 'a.md': stat(10, 5), 'b.md': stat(20, 7), 'c.md': stat(30, 1), 'd.md': stat(40, 1) },
    ['a.md', 'b.md', 'c.md', 'd.md'].map(note));
  const reloaded = make(JSON.parse(JSON.stringify(store.entries())));
  reloaded.revalidate(path => ({ 'a.md': stat(10, 5), 'b.md': stat(21, 7), 'c.md': stat(30, 2) })[path]);
  assert.deepEqual(['a.md', 'b.md', 'c.md', 'd.md'].map(p => reloaded.at(p).state), ['resolved', 'unknown', 'unknown', 'unknown']);
  const r = resolve(reloaded, { 'b.md': stat(21, 7) }, [note('b.md')]);
  assert.equal(r.failures[0].reason, 'source-replaced');
});

test('identity: offline rename becomes unresolved after restart (old path gone)', () => {
  const store = make(); resolve(store, { 'a.md': stat(10, 5) });
  const reloaded = make(store.entries());
  reloaded.revalidate(() => undefined);
  assert.equal(reloaded.at('a.md').state, 'unknown');
});

test('identity: persisted state is never recomputed from missing events (journal rollover)', () => {
  const store = make(); resolve(store, { 'a.md': stat(10, 5) });
  store.deleted('a.md'); store.created('a.md', stat(50, 5));
  const reloaded = make(JSON.parse(JSON.stringify(store.entries())));
  for (let i = 0; i < 500; i++) reloaded.observe('noise' + i + '.md', stat(i + 1, 1));
  reloaded.revalidate(() => stat(50, 5));
  assert.equal(reloaded.at('a.md').state, 'dangling');
  const again = make(reloaded.entries());
  assert.equal(again.observe('a.md', stat(10, 5)).state, 'dangling');
});

test('identity: content edit keeps identity and the size follows it for restart', () => {
  const store = make(); const id = resolve(store, { 'a.md': stat(10, 5) }).sources[0].identity;
  store.modified('a.md', stat(10, 9));
  assert.equal(store.at('a.md').size, 9);
  const reloaded = make(store.entries()); reloaded.revalidate(() => stat(10, 9));
  assert.equal(resolve(reloaded, { 'a.md': stat(10, 9) }).sources[0].identity, id);
});

test('identity: renaming onto another bound path makes the reference need confirmation', () => {
  const store = make(); resolve(store, { 'a.md': stat(10, 5), 'b.md': stat(20, 5) }, [note('a.md'), note('b.md')]);
  store.renamed('a.md', 'b.md');
  assert.equal(store.at('b.md').state, 'unknown');
});

test('identity: explicit reconfirm gives a new identity and clears the failure', () => {
  const store = make(); const old = resolve(store, { 'a.md': stat(10, 5) }).sources[0].identity;
  store.deleted('a.md'); store.created('a.md', stat(99, 5));
  store.reconfirm('a.md', stat(99, 5));
  const r = resolve(store, { 'a.md': stat(99, 5) });
  assert.equal(r.failures.length, 0);
  assert.notEqual(r.sources[0].identity, old);
});

test('identity: corrupt persisted entries are dropped, not repaired', () => {
  assert.deepEqual(plain(readLivingIdentityEntries([{ refId: 'x', path: 'a.md', ctime: 1, size: 1, state: 'bogus', continuityGen: 0 }, 5, null])), []);
  assert.deepEqual(plain(readLivingIdentityEntries('nope')), []);
});

test('runtime adapter: a rename of a referenced note keeps the evidence identity and a replacement is flagged', () => {
  const { TFile } = support.obsidian;
  const { sourceResolver, setLivingIdentityStore } = support.load('experiences/visual-map/living-node-runtime.ts', { obsidian: support.obsidian });
  const store = make();
  const mk = (path, ctime, size) => { const f = new TFile(path); f.stat = { ctime, mtime: 1, size }; return f; };
  const files = new Map([['a.md', mk('a.md', 10, 5)]]);
  const app = { vault: { configDir: '.obsidian', getAbstractFileByPath: p => files.get(p) ?? null }, metadataCache: {} };
  setLivingIdentityStore(app, store);
  const r = sourceResolver(app);
  const first = r.resolveAuthorized('a.md', 'root.md', 'explicit', true);
  assert.equal(first.unresolved, undefined);
  const moved = files.get('a.md'); files.delete('a.md'); moved.path = 'b.md'; files.set('b.md', moved);
  store.renamed('a.md', 'b.md');
  const second = r.resolveAuthorized('b.md', 'root.md', 'explicit', true);
  assert.equal(second.identity, first.identity); assert.equal(second.unresolved, undefined);
  files.set('b.md', mk('b.md', 77, 5));
  assert.equal(r.resolveAuthorized('b.md', 'root.md', 'explicit', true).unresolved, true);
  setLivingIdentityStore(app, undefined);
  assert.equal(r.resolveAuthorized('b.md', 'root.md', 'explicit', true).identity, 'b.md');
});

test('settings: the saved identity state survives load, a non-list is dropped', () => {
  const { settingsFromSaved } = support.load('settings-from-saved.ts');
  const entry = { refId: 'x', path: 'a.md', ctime: 1, size: 2, state: 'resolved', continuityGen: 0 };
  assert.deepEqual(plain(settingsFromSaved({ livingSourceIdentity: [entry] }).livingSourceIdentity), [entry]);
  assert.equal(settingsFromSaved({ livingSourceIdentity: 'bad' }).livingSourceIdentity, undefined);
});
