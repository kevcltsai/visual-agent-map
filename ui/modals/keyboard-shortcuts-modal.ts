import { App, Modal, Platform } from "obsidian";
import { t, type TranslationKey } from "../../i18n";

/** The map's keys, as the card and view handlers bind them; `Mod` reads ⌘ on macOS and Ctrl elsewhere. */
export const MAP_KEYBOARD_SHORTCUTS: readonly { keys: readonly string[]; action: TranslationKey }[] = [
  { keys: ["↑", "↓", "←", "→"], action: "ui.shortcut_move_between_cards" },
  { keys: ["Enter"], action: "ui.shortcut_open_details" },
  { keys: ["F2"], action: "ui.shortcut_rename" },
  { keys: ["Mod+Enter"], action: "ui.shortcut_add_subtopic" },
  { keys: ["Shift+Enter"], action: "ui.shortcut_add_sibling" },
  { keys: ["Alt+↑", "Alt+↓"], action: "ui.shortcut_reorder_sibling" },
  { keys: ["Space"], action: "ui.shortcut_toggle_collapse" },
  { keys: ["Delete", "Backspace"], action: "ui.shortcut_remove" },
  { keys: ["Tab"], action: "ui.shortcut_card_tools" },
  { keys: ["Shift+F10"], action: "ui.shortcut_context_menu" },
  { keys: ["Mod+F"], action: "ui.shortcut_search_map" },
  { keys: ["Mod+Z"], action: "ui.shortcut_undo" },
  { keys: ["Mod+Shift+Z"], action: "ui.shortcut_redo" },
  { keys: ["Mod+C"], action: "ui.shortcut_copy" },
  { keys: ["Mod+X"], action: "ui.shortcut_cut" },
  { keys: ["Mod+V"], action: "ui.shortcut_paste" },
  { keys: ["Esc"], action: "ui.shortcut_clear_selection" }
];

export function shortcutLabel(keys: string, mac = Platform.isMacOS): string {
  return keys
    .replace(/Mod/g, mac ? "⌘" : "Ctrl")
    .replace(/Shift/g, mac ? "⇧" : "Shift")
    .replace(/Alt/g, mac ? "⌥" : "Alt");
}

/** "Keyboard shortcuts": the map's keys, and where to give the VAM commands hotkeys of one's own. */
export class KeyboardShortcutsModal extends Modal {
  constructor(app: App) {
    super(app);
  }
  onOpen(): void {
    this.titleEl.setText(t("ui.keyboard_shortcuts"));
    const table = this.contentEl.createEl("table", { cls: "vam-shortcuts" });
    const body = table.createEl("tbody");
    for (const entry of MAP_KEYBOARD_SHORTCUTS) {
      const row = body.createEl("tr");
      const keys = row.createEl("td", { cls: "vam-shortcuts-keys" });
      entry.keys.forEach((key, index) => {
        if (index) keys.appendText(" ");
        keys.createEl("kbd", { text: shortcutLabel(key) });
      });
      row.createEl("td", { text: t(entry.action) });
    }
    this.contentEl.createEl("p", { cls: "vam-modal-intro", text: t("ui.keyboard_shortcuts_hotkeys_hint") });
  }
  onClose(): void {
    this.contentEl.empty();
  }
}
