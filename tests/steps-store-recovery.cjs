// Fault injection at the shared JSON store boundary (usage, exchanges, pending suggestions).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./support-replay.cjs');
const { readStoreText, writeStoreAtomically } = load('store-adapter.ts');
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
