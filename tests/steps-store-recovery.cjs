// Fault injection at the shared JSON store boundary (usage, exchanges, pending suggestions).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./support-replay.cjs');
const { readStoreText, readStoreValue, writeStoreAtomically } = load('store-adapter.ts');
const path = 'store.json';
const temporary = path + '.tmp';
const original = '{"revision":1}';
const second = '{"revision":2}';
const third = '{"revision":3}';

// The adapter models a write that can truncate the destination before rejecting, and rename that refuses overwrite.
function fixture() {
  const files = new Map([[path, original]]);
  const writes = [];
  const faults = { rename: false, partialWrite: false, remove: false };
  const adapter = {
    exists: async name => files.has(name),
    read: async name => {
      assert.ok(files.has(name), 'read requires an existing file');
      return files.get(name);
    },
    write: async (name, text) => {
      writes.push(name);
      if (faults.partialWrite) {
        files.set(name, text.slice(0, 4));
        throw new Error('partial write');
      }
      files.set(name, text);
    },
    rename: async (from, to) => {
      if (faults.rename) throw new Error('rename failed');
      assert.ok(files.has(from));
      assert.ok(!files.has(to), 'adapter refuses overwrite');
      files.set(to, files.get(from));
      files.delete(from);
    },
    remove: async name => {
      if (faults.remove) throw new Error('remove failed');
      files.delete(name);
    }
  };
  return { files, writes, faults, adapter };
}

async function leaveRecoverableTemp(f) {
  f.faults.rename = true;
  await assert.rejects(writeStoreAtomically(f.adapter, path, second), /rename failed/);
  assert.equal(f.files.has(path), false);
  assert.equal(f.files.get(temporary), second);
}

test('store retry preserves the last recoverable snapshot if the next temp write is partial', async () => {
  const f = fixture();
  await leaveRecoverableTemp(f);
  f.faults.rename = false;
  f.faults.partialWrite = true;
  await assert.rejects(writeStoreAtomically(f.adapter, path, third), /partial write/);
  assert.equal(await readStoreText(f.adapter, path), second);
});

test('store retry does not overwrite the last recoverable snapshot if recovery rename still fails', async () => {
  const f = fixture();
  await leaveRecoverableTemp(f);
  const count = f.writes.length;
  await assert.rejects(writeStoreAtomically(f.adapter, path, third), /rename failed/);
  assert.equal(f.writes.length, count);
  assert.equal(f.files.get(temporary), second);
});

test('store retry keeps an existing primary authoritative after failed removal', async () => {
  const f = fixture();
  f.faults.remove = true;
  await assert.rejects(writeStoreAtomically(f.adapter, path, second), /remove failed/);
  assert.equal(await readStoreText(f.adapter, path), original);
  f.faults.remove = false;
  await writeStoreAtomically(f.adapter, path, third);
  assert.equal(await readStoreText(f.adapter, path), third);
  assert.equal(f.files.has(temporary), false);
});

test('store write and successful retry publish the new complete snapshot', async () => {
  const f = fixture();
  await writeStoreAtomically(f.adapter, path, second);
  assert.equal(await readStoreText(f.adapter, path), second);
  assert.equal(f.files.has(temporary), false);
  const retry = fixture();
  await leaveRecoverableTemp(retry);
  retry.faults.rename = false;
  await writeStoreAtomically(retry.adapter, path, third);
  assert.equal(await readStoreText(retry.adapter, path), third);
  assert.equal(retry.files.has(temporary), false);
});


test('a partial first write never becomes a recoverable temp and a retry publishes the full snapshot', async () => {
  const f = fixture();
  f.files.delete(path);
  f.faults.partialWrite = true;
  await assert.rejects(writeStoreAtomically(f.adapter, path, original), /partial write/);
  assert.equal(f.files.has(path), false);
  assert.equal(f.files.has(temporary), false);
  assert.equal(await readStoreValue(f.adapter, path, JSON.parse), null);
  f.faults.partialWrite = false;
  await writeStoreAtomically(f.adapter, path, second);
  assert.equal(f.files.get(path), second);
  assert.equal(f.files.has(temporary + '.writing'), false);
});

test('legacy incomplete or schema-invalid temp is preserved and never promoted', async () => {
  for (const invalid of ['{"re', '[]']) {
    const f = fixture();
    f.files.delete(path);
    f.files.set(temporary, invalid);
    await assert.rejects(readStoreValue(f.adapter, path, text => {
      const value = JSON.parse(text);
      if (!Number.isInteger(value.revision)) throw new Error('invalid store');
      return value;
    }));
    assert.equal(f.files.has(path), false);
    assert.equal(f.files.get(temporary), invalid);
  }
});


test('latest snapshot writer: burst while a write is blocked persists only the in-flight and final snapshots', async () => {
  const { LatestSnapshotWriter } = load('store-adapter.ts');
  let entered, release;
  const ready = new Promise(resolve => { entered = resolve; });
  const barrier = new Promise(resolve => { release = resolve; });
  const writes = [];
  const errors = [];
  let revision = 0;
  const writer = new LatestSnapshotWriter(async () => {
    writes.push(revision);
    if (writes.length === 1) { entered(); await barrier; }
  }, error => errors.push(error));
  writer.request();
  await ready;
  for (let i = 1; i <= 100; i++) { revision = i; writer.request(); }
  assert.deepEqual(writes, [0]);
  release();
  await writer.flush();
  assert.deepEqual(writes, [0, 100]);
  assert.deepEqual(errors, []);
});

test('latest snapshot writer: a failing in-flight write and diagnostic cannot strand a newer request', async () => {
  const { LatestSnapshotWriter } = load('store-adapter.ts');
  let entered, release;
  const ready = new Promise(resolve => { entered = resolve; });
  const barrier = new Promise(resolve => { release = resolve; });
  const writes = [];
  let revision = 0;
  const writer = new LatestSnapshotWriter(async () => {
    writes.push(revision);
    if (writes.length === 1) { entered(); await barrier; throw new Error('write failed'); }
  }, () => { throw new Error('diagnostic failed'); });
  writer.request();
  await ready;
  revision = 1;
  writer.request();
  release();
  await writer.flush();
  assert.deepEqual(writes, [0, 1]);
});

test('crash after remove and before rename: reload returns and promotes the temp snapshot', async () => {
  const f = fixture();
  f.faults.rename = true; // the process dies between remove(path) and rename(temp, path)
  await assert.rejects(writeStoreAtomically(f.adapter, path, second), /rename failed/);
  assert.equal(f.files.has(path), false);
  f.faults.rename = false;
  assert.equal(await readStoreText(f.adapter, path), second);
  assert.equal(f.files.get(path), second);
  assert.equal(f.files.has(temporary), false);
});

test('only a complete temp present: load returns the data and promotes it', async () => {
  const f = fixture();
  f.files.delete(path);
  f.files.set(temporary, second);
  assert.deepEqual(await readStoreValue(f.adapter, path, JSON.parse), { revision: 2 });
  assert.equal(f.files.get(path), second);
  assert.equal(f.files.has(temporary), false);
});

// A faithful desktop adapter: replace overwrites atomically, so the primary exists at every await boundary.
function replaceFixture(failReplace = false) {
  const f = fixture();
  const seen = [];
  const watch = fn => async (...args) => { seen.push(f.files.has(path)); return fn(...args); };
  for (const key of ['exists', 'write', 'rename', 'remove']) f.adapter[key] = watch(f.adapter[key]);
  f.adapter.replace = async (from, to) => {
    if (failReplace) throw new Error('EBUSY');
    f.files.set(to, f.files.get(from));
    f.files.delete(from);
    seen.push(f.files.has(path));
  };
  return { ...f, seen };
}

test('replace available: the primary never disappears during a write', async () => {
  const f = replaceFixture();
  await writeStoreAtomically(f.adapter, path, second);
  assert.ok(f.seen.length > 0 && f.seen.every(Boolean), 'primary missing at some step');
  assert.equal(f.files.get(path), second);
  assert.equal(f.files.has(temporary), false);
});

test('replace failing falls back to remove+rename and still publishes', async () => {
  const f = replaceFixture(true);
  await writeStoreAtomically(f.adapter, path, second);
  assert.equal(f.files.get(path), second);
  assert.equal(f.files.has(temporary), false);
});

// DX-atomic: the desktop replace really renames on disk (argument order, full paths) and reports a failed replace once per path.
test('withAtomicReplace: renames the temp over the existing primary on a real file system; a failure is reported once', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const { join } = require('node:path');
  const { withAtomicReplace } = load('store-fs-adapter.ts');
  const base = fs.mkdtempSync(join(os.tmpdir(), 'vam-store-'));
  try {
    const full = p => join(base, p);
    const fallbacks = [];
    const adapter = withAtomicReplace({
      exists: async p => fs.existsSync(full(p)),
      read: async p => fs.readFileSync(full(p), 'utf8'),
      write: async (p, d) => fs.writeFileSync(full(p), d),
      rename: async (a, b) => fs.renameSync(full(a), full(b)),
      remove: async p => fs.rmSync(full(p)),
      getFullPath: full
    }, (path, error) => fallbacks.push([path, error.code]));
    fs.writeFileSync(full('s.json'), '{"v":1}');
    await writeStoreAtomically(adapter, 's.json', '{"v":2}');
    assert.equal(fs.readFileSync(full('s.json'), 'utf8'), '{"v":2}');
    assert.equal(fs.existsSync(full('s.json.tmp')), false);
    await assert.rejects(adapter.replace('missing.tmp', 's.json'));
    await assert.rejects(adapter.replace('missing.tmp', 's.json'));
    assert.deepEqual(fallbacks, [['s.json', 'ENOENT']], 'one report per path');
    assert.equal(fs.readFileSync(full('s.json'), 'utf8'), '{"v":2}', 'a failed replace leaves the primary as it was');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
