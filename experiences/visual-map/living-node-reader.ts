import {
  Component,
  ItemView,
  MarkdownRenderer,
  parseYaml,
  TFile,
  type ViewStateResult,
  type WorkspaceLeaf
} from "obsidian";
import { getUiLanguage, t } from "../../i18n";
import { readLivingLastChange, type LivingChangeSummary } from "./living-node-changes";
import { localizeLivingReader, readableDate } from "./living-node-markdown";
import {
  CANONICAL_HEADINGS,
  decodeCalloutSections,
  localizeHeadings,
  noteHeadingSet,
  removeSection
} from "../../core/repository-note-body";
import { LIVING_NODE_BEGIN, LIVING_NODE_END } from "../../core/living-node-region";

export const LIVING_READER_VIEW = "vam-living-node-reader";

export class LivingReaderView extends ItemView {
  private file?: TFile;
  /** An unsaved new card: the file only anchors links; it is not the card, so the official tab stays empty. */
  private draft = false;
  private owner?: string;
  private preview = "";
  private warnings: readonly string[] = [];
  private changes?: LivingChangeSummary;
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

  owns(owner: string): boolean {
    return this.owner === owner;
  }

  async show(
    file: TFile,
    preview: string,
    owner: string,
    warnings: readonly string[] = [],
    invalid = false,
    changes?: LivingChangeSummary,
    draft = false
  ): Promise<void> {
    this.draft = draft;
    this.file = file;
    this.owner = owner;
    this.preview = preview;
    this.warnings = [...warnings];
    this.invalid = invalid;
    this.changes = changes;
    this.tab = "trial";
    await this.paint();
  }

  /** The formal content of a Living card with no trial: the right pane's normal reading of an AI card. */
  async showOfficial(file: TFile, owner?: string): Promise<void> {
    this.draft = false;
    this.file = file;
    this.owner = owner;
    this.preview = "";
    this.warnings = [];
    this.invalid = false;
    this.changes = undefined;
    this.tab = "official";
    await this.paint();
  }

  /** workspace.json keeps which card the reader shows, so a restart reopens it with content instead of blank. */
  getState(): Record<string, unknown> {
    return this.file && !this.draft ? { file: this.file.path } : {};
  }

  /** A restored reader shows its card's formal content; without a card it stays empty and is closed at layout ready. */
  async setState(state: unknown, result: ViewStateResult): Promise<void> {
    const path: unknown = (state as { file?: unknown } | null)?.file;
    const file = typeof path === "string" ? this.app.vault.getAbstractFileByPath(path) : null;
    if (!this.file && file instanceof TFile) await this.showOfficial(file);
    await super.setState(state, result);
  }

  async onOpen(): Promise<void> {
    // A run or an edit changes the note: the formal tab follows it.
    this.registerEvent(
      this.app.vault.on("modify", changed => {
        if (this.tab === "official" && changed.path === this.file?.path) void this.paint();
      })
    );
  }

  /** A language change repaints the open reader: tab labels, banners and localized lines. */
  refreshLanguage(): void {
    if (this.file) void this.paint();
  }

  markInvalid(owner: string): void {
    if (!this.owns(owner)) return;
    this.invalid = true;
    void this.paint();
  }

  async onClose(): Promise<void> {
    this.generation++;
    this.rendered?.unload();
    this.rendered = undefined;
    this.file = undefined;
    this.owner = undefined;
    this.preview = "";
    this.warnings = [];
    this.changes = undefined;
  }

  private paintChanges(host: HTMLElement, changes: LivingChangeSummary | undefined): void {
    const lines: string[] = [];
    // No stored changes (formal tab): the card may have run before, so never call it the first run.
    if (!changes) lines.push(t("ui.living_node_changes_no_baseline"));
    else if (changes.firstRun) lines.push(t("ui.living_node_changes_first_run"));
    else {
      const counts = [
        ["ui.living_node_changes_added_0", changes.added],
        ["ui.living_node_changes_supplemented_0", changes.supplemented],
        ["ui.living_node_changes_corrected_0", changes.corrected],
        ["ui.living_node_changes_disputed_0", changes.disputed],
        ["ui.living_node_changes_invalidated_0", changes.invalidated]
      ] as const;
      for (const [key, ids] of counts) if (ids.length) lines.push(t(key, ids.length));
      if (changes.outputUpdated) lines.push(t("ui.living_node_changes_output_updated"));
      if (!lines.length) lines.push(t("ui.living_node_changes_none"));
    }
    const box = host.createDiv({ cls: "vam-living-reader-changes", attr: { role: "status" } });
    box.createEl("strong", { text: t("ui.living_node_changes_title") });
    for (const line of lines) box.createDiv({ text: line });
  }

  /** The formal tab's changes: the last changed commit while it is still the latest check, "no changes" after a later no-change run, else no baseline. */
  private lastChangeOf(raw: string): LivingChangeSummary | undefined {
    const stored = readLivingLastChange(raw, parseYaml);
    if (!stored) return undefined;
    return stored.checkedAt === undefined || stored.checkedAt === stored.at
      ? stored.changes
      : {
          ...stored.changes,
          added: [],
          supplemented: [],
          corrected: [],
          disputed: [],
          invalidated: [],
          outputUpdated: false
        };
  }

  /**
   * A Living note without a `## Current Summary` section still has its summary in the frontmatter (the card face shows it);
   * the reader shows it as that section. Display only: the note file is not changed.
   */
  private withFrontmatterSummary(markdown: string, raw: string): string {
    if (/^## Current Summary[ \t]*\r?$/m.test(markdown)) return markdown;
    let summary: unknown;
    try {
      const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw)?.[1];
      const parsed = fm === undefined ? undefined : (parseYaml(fm) as Record<string, unknown> | null);
      if (parsed?.["ai-card"] !== true) return markdown;
      summary = parsed["summary"];
    } catch {
      return markdown;
    }
    if (typeof summary !== "string" || !summary.trim()) return markdown;
    const block = `## Current Summary\n\n${summary.trim()}\n\n`;
    const title = /^# .*\r?\n+/.exec(markdown);
    return title ? title[0] + block + markdown.slice(title[0].length) : block + markdown;
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
    if (!this.draft) {
      // Hand edits happen in the native editor; this is the visible, keyboard-reachable way there.
      const edit = host.createEl("button", { text: t("ui.living_node_open_in_editor"), attr: { type: "button" } });
      edit.addEventListener("click", () => void this.leaf.openFile(file));
    }
    if (this.tab === "trial") {
      host.createDiv({
        cls: "vam-living-reader-banner",
        text: t(this.invalid ? "ui.living_node_trial_invalid" : "ui.living_node_trial_unsaved")
      });
      for (const warning of this.warnings)
        host.createDiv({ cls: "vam-living-reader-banner", text: warning, attr: { role: "status" } });
      if (this.changes) this.paintChanges(host, this.changes);
    }
    let raw = "";
    if (this.tab === "official") {
      try {
        if (!this.draft) raw = await this.app.vault.read(file);
      } catch {
        // The content block below reports the missing note.
      }
      if (generation !== this.generation) return;
      this.paintChanges(host, this.lastChangeOf(raw));
    }
    const outline = host.createDiv("vam-living-reader-outline");
    const content = host.createDiv("vam-living-reader-content");
    try {
      let markdown = this.preview;
      if (this.tab === "official") {
        const body = raw.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "");
        markdown = decodeCalloutSections(body);
        markdown = removeSection(markdown, "Prompt");
        markdown = removeSection(markdown, "Rules");
        markdown = this.withFrontmatterSummary(markdown, raw);
        markdown = localizeHeadings(markdown, noteHeadingSet(body) ?? CANONICAL_HEADINGS);
      }
      markdown = localizeLivingReader(
        markdown,
        {
          aiLatest: t("ui.living_node_ai_latest"),
          source: (title, date) => t("ui.living_node_source_line_0_1", title, date),
          generated: at => t("ui.living_node_generated_0", at),
          date: (iso, time) => readableDate(iso, getUiLanguage(), time)
        },
        this.tab === "trial"
      );
      // The official tab reads like the trial preview: the markers around the managed region are not for the reader.
      if (this.tab === "official")
        markdown = markdown.split(LIVING_NODE_BEGIN).join("").split(LIVING_NODE_END).join("");
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
