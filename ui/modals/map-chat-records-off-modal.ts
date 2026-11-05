import { App, Modal, Notice, TFile } from "obsidian";
import { t } from "../../i18n";
import { recordFilesIn } from "../../core/map-chat-records";
import { modalActions } from "./action-bar";

/** What the settings flow needs from a record writer (MapChatRecordWriter has both). */
export interface MapChatRecordsSwitch {
  setEnabled(on: boolean): void;
  idle(): Promise<void>;
}

/** "Also delete the saved conversations?": Keep is the default, Escape and closing the dialog also keep. */
export class MapChatRecordsOffModal extends Modal {
  private decided = false;
  constructor(
    app: App,
    private readonly count: number,
    private readonly decide: (remove: boolean) => void
  ) {
    super(app);
  }
  private finish(remove: boolean): void {
    if (this.decided) return;
    this.decided = true;
    this.decide(remove);
  }
  onClose(): void {
    this.finish(false);
  }
  onOpen(): void {
    this.titleEl.setText(t("ui.map_chat_records_off_title"));
    this.contentEl.createEl("p", { text: t("ui.map_chat_records_off_body_0", this.count), cls: "vam-modal-intro" });
    const actions = modalActions(this);
    const keep = actions.createEl("button", { text: t("ui.map_chat_records_keep"), cls: "mod-cta" });
    const remove = actions.createEl("button", {
      text: t("ui.map_chat_records_delete_0", this.count),
      cls: "mod-warning"
    });
    keep.addEventListener("click", () => {
      this.finish(false);
      this.close();
    });
    remove.addEventListener("click", () => {
      this.finish(true);
      this.close();
    });
    // Start on Keep, so a stray Enter never deletes; Obsidian may move focus after onOpen, so take it back.
    keep.focus();
    window.setTimeout(() => keep.focus(), 0);
  }
}

export interface MapChatRecordsOffDeps {
  app: App;
  writers: Iterable<MapChatRecordsSwitch>;
  /** Asks keep or delete with the count; resolves true to delete. Defaults to {@link MapChatRecordsOffModal}. */
  ask?: (count: number) => Promise<boolean>;
  /** False when the switch was turned back on while the dialog was open: then nothing is deleted. */
  stillOff?: () => boolean;
}

/**
 * The records switch was turned off. Writers stop taking new lines at once; once their queued work has run, every record file
 * in the Vault is counted (including those of maps whose Map.md was deleted). Zero: nothing to ask. Otherwise the owner chooses
 * keep (files untouched) or delete (each file goes to the trash through `fileManager.trashFile`, never a permanent delete).
 * Returns how many files were sent to the trash and how many failed.
 */
export async function turnMapChatRecordsOff(deps: MapChatRecordsOffDeps): Promise<{ deleted: number; failed: number }> {
  const writers = Array.from(deps.writers);
  for (const writer of writers) writer.setEnabled(false);
  await Promise.all(writers.map(writer => writer.idle()));
  const scan = (): TFile[] => recordFilesIn(deps.app.vault.getFiles());
  const count = scan().length;
  if (count === 0) return { deleted: 0, failed: 0 };
  const ask =
    deps.ask ??
    ((n: number) => new Promise<boolean>(resolve => new MapChatRecordsOffModal(deps.app, n, resolve).open()));
  if (!(await ask(count)) || deps.stillOff?.() === false) return { deleted: 0, failed: 0 };
  // The queues were empty when we counted and nothing new is accepted, but look again in case the owner took a while.
  await Promise.all(writers.map(writer => writer.idle()));
  let deleted = 0;
  let failed = 0;
  for (const file of scan()) {
    try {
      await deps.app.fileManager.trashFile(file);
      deleted++;
    } catch {
      failed++;
    }
  }
  if (failed) new Notice(t("ui.map_chat_records_delete_failed_0", failed));
  return { deleted, failed };
}
