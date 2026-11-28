import { MarkdownView, View, type App, type TFile, type WorkspaceLeaf } from "obsidian";
import { t } from "../../i18n";
import type { LivingChangeSummary } from "./living-node-changes";
import { LIVING_READER_VIEW, LivingReaderView } from "./living-node-reader";

/** Owns the right-hand topic details pane. The plugin shell only forwards requests to this controller. */
export class NodeDetailsSidebar {
  private detailsLeaf: WorkspaceLeaf | null = null;
  private detailsPath: string | null = null;
  private trialOwner?: string;
  private revision = 0;
  private pending: Promise<void> = Promise.resolve();

  /** Serialize transitions of the single shared right pane; the newest selection wins. */
  private enqueue<T>(run: () => Promise<T>): Promise<T> {
    const next = this.pending.then(run);
    this.pending = next.then(
      () => {},
      () => {}
    );
    return next;
  }

  constructor(
    private readonly app: () => App,
    private readonly styleLeaf: (leaf: WorkspaceLeaf) => void
  ) {}

  /** The node-details sidebar counts as open only while its pane is actually visible. */
  detailsShown(): boolean {
    const split = this.app().workspace.rightSplit;
    if (split.collapsed) return false;
    if (this.detailsLeaf?.view instanceof LivingReaderView && this.detailsLeaf.view.containerEl.isShown()) return true;
    return this.app()
      .workspace.getLeavesOfType("markdown")
      .some(
        leaf =>
          leaf.getRoot() === split &&
          leaf.view instanceof MarkdownView &&
          !!leaf.view.file &&
          this.app().metadataCache.getFileCache(leaf.view.file)?.frontmatter?.["agent-map-node"] === true &&
          leaf.view.containerEl.isShown()
      );
  }

  openDetails(file: TFile, owner?: string): Promise<void> {
    this.trialOwner = owner;
    const revision = ++this.revision;
    return this.enqueue(async () => {
      if (revision !== this.revision) return;
      await this.openOfficial(file, revision);
    });
  }

  private async openOfficial(file: TFile, revision: number): Promise<void> {
    const markdownLeaves = this.app().workspace.getLeavesOfType("markdown");
    if (
      this.detailsLeaf &&
      ((!markdownLeaves.includes(this.detailsLeaf) && !(this.detailsLeaf.view instanceof LivingReaderView)) ||
        this.detailsLeaf.getRoot() !== this.app().workspace.rightSplit)
    )
      this.detailsLeaf = null;
    if (!this.detailsLeaf) {
      this.detailsLeaf =
        markdownLeaves
          .filter(
            leaf =>
              leaf.getRoot() === this.app().workspace.rightSplit &&
              leaf.view instanceof MarkdownView &&
              !!leaf.view.file &&
              this.app().metadataCache.getFileCache(leaf.view.file)?.frontmatter?.["agent-map-node"] === true
          )
          .sort(
            (a, b) => a.view.containerEl.getBoundingClientRect().top - b.view.containerEl.getBoundingClientRect().top
          )[0] ??
        this.app().workspace.getRightLeaf(false) ??
        this.app().workspace.getRightLeaf(true);
    }
    if (!this.detailsLeaf) throw new Error(t("ui.unable_to_open_the_right_details_sidebar"));
    const leaf = this.detailsLeaf;
    if (this.app().metadataCache.getFileCache(file)?.frontmatter?.["ai-card"] === true) {
      // An AI card is read through the reader (same presentation as the trial preview), not as raw Markdown.
      if (!(leaf.view instanceof LivingReaderView))
        await leaf.setViewState({ type: LIVING_READER_VIEW, active: false });
      if (revision !== this.revision || this.detailsLeaf !== leaf) return;
      if (!(leaf.view instanceof LivingReaderView)) throw new Error(t("ui.unable_to_open_the_right_details_sidebar"));
      await leaf.view.showOfficial(file, this.trialOwner);
    } else await leaf.openFile(file);
    if (revision !== this.revision || this.detailsLeaf !== leaf) return;
    this.detailsPath = file.path;
    this.styleLeaf(leaf);
    await this.app().workspace.revealLeaf(leaf);
  }

  showLivingTrial(
    file: TFile,
    markdown: string,
    owner: string,
    isCurrent: () => boolean,
    warnings: readonly string[] = [],
    changes?: LivingChangeSummary,
    /** An unsaved new card: no official note exists, so the editor claims the pane here instead of through openDetails. */
    draft = false
  ): Promise<boolean> {
    if (draft) this.trialOwner = owner;
    const revision = draft ? ++this.revision : this.revision;
    const current = (): boolean => revision === this.revision && this.trialOwner === owner && isCurrent();
    return this.enqueue(async () => {
      if (!current()) return false;
      if (!this.detailsLeaf || this.detailsPath !== file.path) await this.openOfficial(file, revision);
      if (!current()) return false;
      const leaf = this.detailsLeaf;
      if (!leaf) throw new Error(t("ui.unable_to_open_the_right_details_sidebar"));
      if (!(leaf.view instanceof LivingReaderView))
        await leaf.setViewState({ type: LIVING_READER_VIEW, active: false });
      if (!current() || this.detailsLeaf !== leaf) {
        // Stop during view creation must not leave an empty preview pane. A newer
        // selection has its own queued transition and must never be replaced here.
        if (revision === this.revision && this.trialOwner === owner && this.detailsLeaf === leaf)
          await this.openOfficial(file, revision);
        return false;
      }
      if (!(leaf.view instanceof LivingReaderView)) throw new Error(t("ui.unable_to_open_the_right_details_sidebar"));
      await leaf.view.show(file, markdown, owner, warnings, false, changes, draft);
      if (!current()) return false;
      await this.app().workspace.revealLeaf(leaf);
      return current();
    });
  }

  invalidateLivingTrial(owner: string): void {
    if (this.trialOwner === owner && this.detailsLeaf?.view instanceof LivingReaderView)
      this.detailsLeaf.view.markInvalid(owner);
  }

  restoreLivingOfficial(file: TFile | undefined, owner: string, release = false): Promise<void> {
    if (this.trialOwner !== owner) return Promise.resolve();
    if (file) return this.openDetails(file, release ? undefined : owner);
    // The edited card may have been deleted, or its view may have closed. Clear
    // ownership immediately, then discard only the matching transient reader.
    this.trialOwner = undefined;
    const revision = ++this.revision;
    return this.enqueue(async () => {
      if (revision !== this.revision) return;
      const leaf = this.detailsLeaf;
      if (leaf?.view instanceof LivingReaderView && leaf.view.owns(owner)) {
        leaf.detach();
        this.detailsLeaf = null;
        this.detailsPath = null;
      }
    });
  }

  closeStaleDetails(): void {
    this.revision++;
    this.trialOwner = undefined;
    const closed =
      this.detailsLeaf?.view instanceof LivingReaderView ||
      (this.detailsLeaf?.view instanceof MarkdownView && this.detailsLeaf.view.file?.path === this.detailsPath);
    if (closed) {
      this.detailsLeaf!.detach();
      this.app().workspace.trigger("file-open", null);
      this.app().workspace.trigger("active-leaf-change", this.app().workspace.getActiveViewOfType(View)?.leaf ?? null);
    }
    this.detailsLeaf = null;
    this.detailsPath = null;
  }
}
