/** The slice of Obsidian's `DataAdapter` the plugin-folder JSON stores need (paths are vault-relative and normalized). */
export interface StoreAdapter {
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<string>;
  write(path: string, data: string): Promise<void>;
  rename(path: string, newPath: string): Promise<void>;
  remove(path: string): Promise<void>;
}

/** The file's text, or null when it does not exist yet (the old ENOENT case). */
export async function readStoreText(adapter: StoreAdapter, path: string): Promise<string | null> {
  if (!(await adapter.exists(path))) return null;
  return adapter.read(path);
}

/**
 * Writes `<path>.tmp` then renames it over `path`. Obsidian's `DataAdapter.rename` refuses an existing destination
 * (unlike `fs.rename`), so the old file is removed first; the window between the two calls is kept to those two awaits.
 */
export async function writeStoreAtomically(adapter: StoreAdapter, path: string, text: string): Promise<void> {
  const temporary = `${path}.tmp`;
  await adapter.write(temporary, text);
  if (await adapter.exists(path)) await adapter.remove(path);
  await adapter.rename(temporary, path);
}
