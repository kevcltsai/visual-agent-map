const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./support-replay.cjs');
const { VaultWriteRecovery } = load('core/vault-write-recovery.ts');
const id = 'a0000000-0000-0000-0000-000000000000';
const folder = 'plugin/write-recovery';
const snapshot = folder + '/' + id + '.json';
const original = '---\nagent-map-node: true\n---\n# Original\n';
function fixture() {
  const files = new Map(), retained = [], dirs = new Set();
  let text = original, path = 'Note.md', stopped = false, writes = 0;
  const faults = { backup: false, corruptBackup: false, source: false, cleanup: false, external: false, moved: false, unload: false };
  const adapter = {
    exists: async p => files.has(p) || dirs.has(p),
    mkdir: async p => { dirs.add(p); },
    read: async p => { assert.ok(files.has(p)); return files.get(p); },
    write: async (p, value) => {
      if (faults.backup) throw new Error('disk full');
      files.set(p, faults.corruptBackup ? value.slice(0, 5) : value);
    },
    rename: async (from, to) => {
      assert.ok(files.has(from) && !files.has(to));
      files.set(to, files.get(from)); files.delete(from);
    },
    remove: async p => { if (faults.cleanup) throw new Error('cleanup'); files.delete(p); },
    list: async () => ({ files: [...files.keys()] })
  };
  const journal = new VaultWriteRecovery(adapter, folder, p => retained.push(p), () => id);
  const write = {
    path: () => path,
    read: async () => text,
    process: async change => {
      assert.ok(files.has(snapshot), 'verified recovery exists before any source write');
      if (faults.external) text = 'new owner text';
      if (faults.moved) path = 'Renamed.md';
      if (faults.unload) stopped = true;
      const next = change(text);
      writes++;
      if (faults.source) { text = next.slice(0, 4); throw new Error('interrupted write'); }
      text = next;
      return text;
    },
    change: () => 'new VAM text',
    stopped: () => stopped,
    stoppedError: () => new Error('unloaded'),
    conflictError: () => new Error('conflict'),
    backupError: () => new Error('backup not verified')
  };
  return { files, retained, journal, write, faults, text: () => text, writes: () => writes };
}

test('successful Markdown write clears its own verified recovery copy', async () => {
  const f = fixture();
  assert.equal(await f.journal.process(f.write), 'new VAM text');
  assert.equal(f.text(), 'new VAM text');
  assert.equal(f.files.size, 0);
  assert.equal(await f.journal.pendingCount(), 0);
});

test('partial source write retains exact previous Markdown and does not automatically replace the damaged file', async () => {
  const f = fixture(); f.faults.source = true;
  await assert.rejects(f.journal.process(f.write), /interrupted write/);
  assert.equal(f.text(), 'new ');
  assert.deepEqual(JSON.parse(f.files.get(snapshot)), { version: 1, path: 'Note.md', content: original });
  assert.deepEqual(f.retained, [snapshot]);
  assert.equal(await f.journal.pendingCount(), 1);
});

test('unverified recovery copy cannot authorize a source write', async () => {
  for (const fault of ['backup', 'corruptBackup']) {
    const f = fixture(); f.faults[fault] = true;
    await assert.rejects(f.journal.process(f.write), /backup not verified/);
    assert.equal(f.text(), original);
    assert.equal(f.writes(), 0);
    assert.equal(f.files.has(snapshot), false);
  }
});

test('external content change or rename before the callback refuses a stale write', async () => {
  for (const fault of ['external', 'moved']) {
    const f = fixture(); f.faults[fault] = true;
    await assert.rejects(f.journal.process(f.write), /conflict/);
    assert.equal(f.text(), fault === 'external' ? 'new owner text' : original);
    assert.equal(f.writes(), 0);
    assert.equal(f.files.size, 0);
  }
});

test('unload refuses the source callback and leaves the recovery copy alone', async () => {
  const f = fixture(); f.faults.unload = true;
  await assert.rejects(f.journal.process(f.write), /unloaded/);
  assert.equal(f.text(), original);
  assert.equal(f.writes(), 0);
  assert.equal(JSON.parse(f.files.get(snapshot)).content, original);
});

test('cleanup failure leaves a recovery copy without falsely reporting the committed write as failed', async () => {
  const f = fixture(); f.faults.cleanup = true;
  assert.equal(await f.journal.process(f.write), 'new VAM text');
  assert.equal(JSON.parse(f.files.get(snapshot)).content, original);
  assert.deepEqual(f.retained, [snapshot]);
});
