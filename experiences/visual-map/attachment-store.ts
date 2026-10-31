import { createHash } from "node:crypto";
import { TFile, TFolder, type App } from "obsidian";

/**
 * Same-content lookup and ownership for attachments a map transaction writes. Locations always come from Obsidian's
 * attachment settings (`getAvailablePathForAttachment`); this module never builds a folder path of its own and never
 * removes anything.
 */
export interface Fingerprint {
  size: number;
  sha256: string;
}

export const fingerprintOf = (data: ArrayBuffer): Fingerprint => ({
  size: data.byteLength,
  sha256: createHash("sha256").update(new Uint8Array(data)).digest("hex")
});

// Files created by a step that has not finished committing, with the step that owns each. Another step must not reuse
// one: the owner may still trash it while rolling back.
let pending: Array<{ path: string; owner: object }> = [];

export function claim(path: string, owner: object): void {
  pending.push({ path, owner });
}
export function release(owner: object): void {
  pending = pending.filter(item => item.owner !== owner);
}
const heldByOther = (path: string, owner: object): boolean =>
  pending.some(item => item.path === path && item.owner !== owner);

const extensionOf = (path: string): string => {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot + 1);
};
// Size first: only a file of the same size is read and hashed.
const sameContent = async (app: App, file: TFile, print: Fingerprint): Promise<boolean> =>
  file.stat.size === print.size && fingerprintOf(await app.vault.readBinary(file)).sha256 === print.sha256;

/**
 * A file in the folder of `path` (as Obsidian chose it) with the same extension, size and sha256 that no other unfinished
 * step owns; null when there is none.
 */
export async function findSame(app: App, path: string, print: Fingerprint, owner: object): Promise<string | null> {
  const slash = path.lastIndexOf("/");
  const folder = app.vault.getAbstractFileByPath(slash < 0 ? "/" : path.slice(0, slash));
  if (!(folder instanceof TFolder)) return null;
  const extension = extensionOf(path);
  for (const child of folder.children) {
    if (!(child instanceof TFile) || child.extension !== extension || heldByOther(child.path, owner)) continue;
    if (await sameContent(app, child, print)) return child.path;
  }
  return null;
}

/** The file at `path` when it is still there with the content it was written with; otherwise null. */
export async function unchangedFile(app: App, path: string, print: Fingerprint): Promise<TFile | null> {
  const file = app.vault.getAbstractFileByPath(path);
  return file instanceof TFile && (await sameContent(app, file, print)) ? file : null;
}

/** True when any note links to or embeds `path` according to Obsidian's link index. */
export function isLinked(app: App, path: string): boolean {
  return Object.values(app.metadataCache.resolvedLinks ?? {}).some(targets => (targets[path] ?? 0) > 0);
}
