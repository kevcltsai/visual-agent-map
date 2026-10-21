// A StoreAdapter (see store-adapter.ts) backed by real files, for tests that keep their on-disk assertions.
// Like Obsidian's DataAdapter, rename refuses an existing destination.
const fs = require('node:fs/promises');

const nodeFsAdapter = {
  async exists(path) { try { await fs.access(path); return true; } catch { return false; } },
  read: path => fs.readFile(path, 'utf8'),
  write: (path, data) => fs.writeFile(path, data),
  async rename(path, newPath) {
    if (await nodeFsAdapter.exists(newPath)) throw new Error('Destination file already exists!');
    await fs.rename(path, newPath);
  },
  remove: path => fs.rm(path)
};

module.exports = { nodeFsAdapter };
