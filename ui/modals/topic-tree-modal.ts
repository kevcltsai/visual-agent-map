import { App, Modal } from "obsidian";
import { t } from "../../i18n";
import type { MapNode } from "../../map-model";
import { renderTopicTree } from "../topic-tree";
import { modalActions } from "./action-bar";

/** Picks one topic from the map's hierarchy; choosing a row closes the dialog and runs `choose`. */
export class TopicTreeModal extends Modal {
  constructor(
    app: App,
    private titleText: string,
    private description: string,
    private nodes: MapNode[],
    private title: (node: MapNode) => string,
    private selectable: (node: MapNode) => boolean,
    private choose: (node: MapNode) => void
  ) {
    super(app);
  }
  private cancelEl: HTMLButtonElement | null = null;
  /** Obsidian's open() moves the focus to the first topic row after onOpen; Cancel takes it back, so a stray Enter never moves topics. */
  open(): void {
    super.open();
    this.cancelEl?.focus();
  }
  onOpen(): void {
    this.titleEl.setText(this.titleText);
    this.contentEl.createEl("p", { text: this.description, cls: "vam-modal-intro" });
    renderTopicTree(this.contentEl, {
      nodes: this.nodes,
      title: this.title,
      label: this.description,
      selectable: this.selectable,
      onChoose: id => {
        const node = this.nodes.find(item => item.id === id);
        if (!node) return;
        this.close();
        this.choose(node);
      }
    });
    const cancel = modalActions(this).createEl("button", { text: t("ui.cancel") });
    cancel.addEventListener("click", () => this.close());
    // Start on Cancel, so a stray Enter never moves topics.
    this.cancelEl = cancel;
    cancel.focus();
  }
}
