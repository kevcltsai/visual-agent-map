// The plugin-level note backup service (T6b): a byte-exact copy into the style folder's backup folder with no view involved.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const S = require('./support.cjs');

class TFile { constructor(path) { this.path = path; this.name = path.split('/').pop(); } }
class TFolder { constructor(path) { this.path = path; this.children = []; } }
const { backupNoteFile } = S.load('experiences/visual-map/note-backup.ts', { obsidian: { TFile, TFolder } });

function fakeVault(failCreate = false) {
  const files = new Map(); const folders = new Map();
  const vault = {
    getAbstractFileByPath: path => files.get(path) ?? folders.get(path) ?? null,
    createFolder: async path => { folders.set(path, new TFolder(path)); },
    create: async (path, text) => { if (failCreate) throw new Error('disk'); const f = new TFile(path); f.text = text; files.set(path, f); const dir = path.slice(0, path.lastIndexOf('/')); folders.get(dir)?.children.push(f); return f; },
    read: async file => file.text
  };
  return { vault, files, folders };
}

test('backupNoteFile: saves an exact copy under the style folder with no view, and reports ok', async () => {
  const { vault, files } = fakeVault();
  const saved = await backupNoteFile(vault, { styleFolder: 'Styles', language: 'en', path: 'Cards/Ch1.md', content: 'body ==a==%%備註#1：x%%' });
  assert.equal(saved.ok, true);
  assert.ok(files.get(saved.path), 'the copy exists');
  assert.equal(files.get(saved.path).text, 'body ==a==%%備註#1：x%%');
  assert.ok(saved.path.startsWith('Styles/'));
});

test('backupNoteFile: a failing vault answers { ok: false } and never throws', async () => {
  const { vault } = fakeVault(true);
  assert.deepEqual(JSON.parse(JSON.stringify(await backupNoteFile(vault, { styleFolder: 'Styles', language: 'en', path: 'Cards/Ch1.md', content: 'x' }))), { ok: false });
});
