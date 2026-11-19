/**
 * The note backup service: copies a note byte for byte into the vault's backup folder (`<style folder>/<backup>/<notes>`).
 * One helper for the map view's write-back and the plugin (the picture-book runner and the notes apply), so a backup never
 * needs an open map tab.
 */
import { TFile, TFolder, type Vault } from "obsidian";
import { backupNote, type BackupResult } from "../../ai/note-writeback";
import { CANONICAL_LANGUAGES } from "../../ai/note-style-file";
import { resolveBlockFolder } from "../../core/blocks/block-files";
import { translate, type UiLanguage } from "../../i18n";

/** Backs `content` up; `{ ok: false }` (never a throw) means nothing was saved and the caller must not replace the note. */
export function backupNoteFile(
  vault: Vault,
  input: { styleFolder: string; language: UiLanguage; path: string; content: string }
): Promise<BackupResult> {
  const folderAt = (path: string): TFolder | null => {
    const found = vault.getAbstractFileByPath(path);
    return found instanceof TFolder ? found : null;
  };
  const exists = (candidate: string): boolean => folderAt(candidate) !== null;
  const backups = resolveBlockFolder(input.styleFolder, "backup", exists, input.language);
  const names = [...new Set(CANONICAL_LANGUAGES.map(code => translate(code, "ui.style_folder_backup_notes")))];
  const notes =
    names.find(name => exists(`${backups}/${name}`)) ?? translate(input.language, "ui.style_folder_backup_notes");
  return backupNote(
    {
      folderExists: async candidate => exists(candidate),
      list: async folder =>
        (folderAt(folder)?.children ?? []).filter(child => child instanceof TFile).map(child => child.name),
      createFolder: async folder => {
        await vault.createFolder(folder);
      },
      create: async (file, text) => {
        await vault.create(file, text);
      },
      read: async file => {
        const found = vault.getAbstractFileByPath(file);
        if (!(found instanceof TFile)) throw new Error(file);
        return vault.read(found);
      }
    },
    { notePath: input.path, content: input.content, folder: `${backups}/${notes}`, now: new Date() }
  ).catch(() => ({ ok: false as const }));
}
