import { Component, ItemView, MarkdownRenderer, type TFile, type WorkspaceLeaf } from "obsidian";
import { t } from "../../i18n";
import { decodeCalloutSections, removeSection } from "../../core/repository-note-body";

export const LIVING_READER_VIEW = "vam-living-node-reader";

export class LivingReaderView extends ItemView {
  private file?: TFile;
  private preview = "";
  private tab: "official" | "trial" = "trial";
  private invalid = false;
  private generation = 0;
  private rendered?: Component;

  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
  }

  getViewType(): string {
    return LIVING_READER_VIEW;
  }

  getDisplayText(): string {
    return t("ui.living_node_trial");
  }

  getIcon(): string {
    return "book-open";
  }

  async show(file: TFile, preview: string, invalid = false): Promise<void> {
    this.file = file;
    this.preview = preview;
    this.invalid = invalid;
    this.tab = "trial";
    await this.paint();
  }

  markInvalid(): void {
    this.invalid = true;
    void this.paint();
  }

  async onClose(): Promise<void> {
    this.generation++;
    this.rendered?.unload();
    this.rendered = undefined;
    this.file = undefined;
    this.preview = "";
  }

  private async paint(): Promise<void> {
    const file = this.file;
    if (!file) return;
    const generation = ++this.generation;
    this.rendered?.unload();
    const component = new Component();
    component.load();
    this.rendered = component;
    const host = this.contentEl;
    host.empty();
    host.addClass("vam-living-reader");
    const tabs = host.createDiv({ cls: "vam-living-reader-tabs", attr: { role: "tablist" } });
    for (const [value, name] of [
      ["official", t("ui.living_node_official")],
      ["trial", t("ui.living_node_trial")]
    ] as const) {
      const tab = tabs.createEl("button", {
        text: name,
        attr: { type: "button", role: "tab", "aria-selected": String(value === this.tab) }
      });
      tab.addEventListener("click", () => {
        this.tab = value;
        void this.paint();
      });
    }
    if (this.tab === "trial")
      host.createDiv({ cls: "vam-living-reader-banner", text: t(this.invalid ? "ui.living_node_trial_invalid" : "ui.living_node_trial_unsaved") });
    const outline = host.createDiv("vam-living-reader-outline");
    const content = host.createDiv("vam-living-reader-content");
    try {
      let markdown = this.preview;
      if (this.tab === "official") {
        markdown = decodeCalloutSections((await this.app.vault.read(file)).replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, ""));
        markdown = removeSection(markdown, "Prompt");
        markdown = removeSection(markdown, "Rules");
      }
      if (generation !== this.generation) return;
      await MarkdownRenderer.render(this.app, markdown, content, file.path, component);
      if (generation !== this.generation) return;
      for (const heading of Array.from(content.querySelectorAll<HTMLElement>("h1,h2,h3,h4,h5,h6"))) {
        const button = outline.createEl("button", { text: heading.textContent ?? "", attr: { type: "button" } });
        button.style.paddingInlineStart = `${(Number(heading.tagName.slice(1)) - 1) * 8 + 8}px`;
        button.addEventListener("click", () => heading.scrollIntoView({ block: "start" }));
      }
    } catch {
      if (generation === this.generation) content.setText(t("ui.note_missing"));
    }
  }
}
