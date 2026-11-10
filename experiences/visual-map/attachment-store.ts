import { createHash } from "node:crypto";
import { TFile, TFolder, type App } from "obsidian";

/**
 * Where attachment files go, plus same-content lookup and ownership for attachments a map transaction writes.
 * `attachmentPath` is the one place a location is chosen: a note of a mind map (its `Map.md` or a card note in its
 * `Notes/`) keeps attachments in `<map folder>/Attachments/` while the vault's attachment setting is the default (vault
 * root); any other setting, and any note outside a map, gets Obsidian's own `getAvailablePathForAttachment`. This module
 * never removes anything.
 */
const MAP_FILE = "Map.md";
const parentOf = (path: string): string => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
const nameOf = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

/** The folder holding `Map.md` when `notePath` is that map file or a card note directly in its `Notes/`; else null. */
export function mapFolderOf(app: App, notePath: string): string | null {
  const folder = parentOf(notePath);
  const root = nameOf(notePath) === MAP_FILE ? folder : nameOf(folder) === "Notes" ? parentOf(folder) : null;
  if (root === null || root === "") return null;
  return app.vault.getAbstractFileByPath(`${root}/${MAP_FILE}`) instanceof TFile ? root : null;
}

// Obsidian keeps the attachment setting in the vault config; unset, "" and "/" all mean the vault root.
const defaultAttachmentSetting = (app: App): boolean => {
  const value = (app.vault as unknown as { getConfig?: (key: string) => unknown }).getConfig?.("attachmentFolderPath");
  return value === undefined || value === null || value === "" || value === "/";
};

/**
 * A free path for a new attachment `name` written for `sourcePath`. With the default (vault root) attachment setting a
 * mind map's note gets `<map folder>/Attachments/<name>` (folder created when missing; " 1", " 2"… on a clash, as
 * Obsidian names them); otherwise the path is exactly what `getAvailablePathForAttachment` returns.
 */
export async function attachmentPath(app: App, name: string, sourcePath: string): Promise<string> {
  const map = defaultAttachmentSetting(app) ? mapFolderOf(app, sourcePath) : null;
  if (map === null) return app.fileManager.getAvailablePathForAttachment(name, sourcePath);
  const folder = `${map}/Attachments`;
  const isFolder = (): boolean => app.vault.getAbstractFileByPath(folder) instanceof TFolder;
  // Another write (an export, a second view) may create the folder between the check and createFolder: that is fine.
  if (!isFolder())
    await app.vault.createFolder(folder).catch((error: unknown) => {
      if (!isFolder()) throw error;
    });
  const dot = name.lastIndexOf(".");
  const [base, extension] = dot <= 0 ? [name, ""] : [name.slice(0, dot), name.slice(dot)];
  let path = `${folder}/${name}`;
  for (let n = 1; app.vault.getAbstractFileByPath(path); n++) path = `${folder}/${base} ${n}${extension}`;
  return path;
}

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
