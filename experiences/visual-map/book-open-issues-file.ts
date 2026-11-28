/**
 * Writes the book's closing "still open" page into the book's folder (`core/book-pipeline/open-issues.ts` decides the text and the
 * name). A same-named file without the page's marker is somebody's note: it is never touched, the next free name is used. A file
 * with the marker (an earlier run's page) is rewritten. With `existingOnly` no file is created: only such an earlier page is rewritten,
 * and with none the result is ok with an empty path. The vault is reached through three small functions so tests can fake it.
 */
import { chooseOpenIssuesFile, openIssuesFileName } from "../../core/book-pipeline/open-issues";
import type { ContentLanguage } from "../../i18n";

export interface OpenIssuesVault {
  /** A file's text, or undefined when there is no such file. */
  read(path: string): Promise<string | undefined>;
  create(path: string, content: string): Promise<void>;
  modify(path: string, content: string): Promise<void>;
}

const join = (folder: string, name: string): string => (folder ? `${folder.replace(/\/+$/, "")}/${name}` : name);

export async function writeOpenIssuesFile(
  vault: OpenIssuesVault,
  folder: string,
  language: ContentLanguage,
  content: string,
  existingOnly = false
): Promise<{ ok: true; path: string } | { ok: false }> {
  try {
    // chooseOpenIssuesFile reads synchronously: read the candidate names first, up to the first one it would take.
    const seen = new Map<string, string | undefined>();
    for (let copy = 1; copy <= 20; copy++) {
      const name = openIssuesFileName(language, copy);
      const text = await vault.read(join(folder, name));
      seen.set(name, text);
      if (chooseOpenIssuesFile(language, key => seen.get(key)) === name) break;
    }
    const name = chooseOpenIssuesFile(language, key => seen.get(key));
    if (name === undefined || !seen.has(name)) return { ok: false };
    const path = join(folder, name);
    if (seen.get(name) === undefined) {
      if (existingOnly) return { ok: true, path: "" };
      await vault.create(path, content);
    } else await vault.modify(path, content);
    return { ok: true, path };
  } catch {
    return { ok: false };
  }
}
