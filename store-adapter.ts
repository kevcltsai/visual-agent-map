/** The slice of Obsidian's `DataAdapter` the plugin-folder JSON stores need (paths are vault-relative and normalized). */
export interface StoreAdapter {
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<string>;
  write(path: string, data: string): Promise<void>;
  rename(path: string, newPath: string): Promise<void>;
  remove(path: string): Promise<void>;
}

/**
 * Decode the primary, or a recoverable temp snapshot. Validate before promoting the temp: older versions could
 * leave a partial first write there. A rejected snapshot stays untouched, and the caller fails closed.
 */
export async function readStoreValue<T>(
  adapter: StoreAdapter,
  path: string,
  decode: (text: string) => T
): Promise<T | null> {
  if (await adapter.exists(path)) return decode(await adapter.read(path));
  const temporary = `${path}.tmp`;
  if (!(await adapter.exists(temporary))) return null;
  const value = decode(await adapter.read(temporary));
  await adapter.rename(temporary, path);
  return value;
}

export async function readStoreText(adapter: StoreAdapter, path: string): Promise<string | null> {
  return readStoreValue(adapter, path, text => text);
}

/**
 * Writes `<path>.tmp` then renames it over `path`. Obsidian's `DataAdapter.rename` refuses an existing destination
 * (unlike `fs.rename`), so the old file is removed first; the window between the two calls is kept to those two awaits.
 */
export async function writeStoreAtomically(adapter: StoreAdapter, path: string, text: string): Promise<void> {
  const temporary = `${path}.tmp`;
  // A previous write may have removed the old file but failed to publish its complete temp file.
  // Recover that snapshot before a retry can truncate it. The primary still wins when both exist.
  if (!(await adapter.exists(path)) && (await adapter.exists(temporary))) await adapter.rename(temporary, path);
  if (await adapter.exists(path)) {
    await adapter.write(temporary, text);
    await adapter.remove(path);
  } else {
    // A partially written first snapshot must not look like a recoverable temp.
    const staging = `${temporary}.writing`;
    await adapter.write(staging, text);
    await adapter.rename(staging, temporary);
  }
  await adapter.rename(temporary, path);
}
