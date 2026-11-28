import { rename } from "node:fs/promises";
import type { StoreAdapter } from "./store-adapter";

/** Obsidian's `FileSystemAdapter` surface used here (vault-relative paths in, absolute path out). */
type FileSystemStoreAdapter = Omit<StoreAdapter, "replace"> & { getFullPath(path: string): string };

/** Adds an atomic `replace` (Node `fs.rename` overwrites an existing destination, also on Windows) to a desktop adapter. */
export function withAtomicReplace(adapter: FileSystemStoreAdapter): StoreAdapter {
  return {
    exists: path => adapter.exists(path),
    read: path => adapter.read(path),
    write: (path, data) => adapter.write(path, data),
    rename: (path, newPath) => adapter.rename(path, newPath),
    remove: path => adapter.remove(path),
    replace: (path, newPath) => rename(adapter.getFullPath(path), adapter.getFullPath(newPath))
  };
}
