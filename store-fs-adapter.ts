import { rename } from "node:fs/promises";
import type { StoreAdapter } from "./store-adapter";

/** Obsidian's `FileSystemAdapter` surface used here (vault-relative paths in, absolute path out). */
type FileSystemStoreAdapter = Omit<StoreAdapter, "replace"> & { getFullPath(path: string): string };

/**
 * Adds an atomic `replace` (Node `fs.rename` overwrites an existing destination, also on Windows) to a desktop adapter.
 * `onFallback` hears the first failed replace per path: the store then uses the remove-then-rename path, so it is logged.
 */
export function withAtomicReplace(
  adapter: FileSystemStoreAdapter,
  onFallback: (path: string, error: unknown) => void = () => {}
): StoreAdapter {
  const reported = new Set<string>();
  return {
    exists: path => adapter.exists(path),
    read: path => adapter.read(path),
    write: (path, data) => adapter.write(path, data),
    rename: (path, newPath) => adapter.rename(path, newPath),
    remove: path => adapter.remove(path),
    replace: async (path, newPath) => {
      try {
        await rename(adapter.getFullPath(path), adapter.getFullPath(newPath));
      } catch (error) {
        if (!reported.has(newPath)) {
          reported.add(newPath);
          onFallback(newPath, error);
        }
        throw error;
      }
    }
  };
}
