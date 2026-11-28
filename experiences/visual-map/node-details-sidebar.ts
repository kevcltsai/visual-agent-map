import { MarkdownView, View, type App, type TFile, type WorkspaceLeaf } from "obsidian";
import { t } from "../../i18n";
import type { LivingChangeSummary } from "./living-node-changes";
import { LIVING_READER_VIEW, LivingReaderView } from "./living-node-reader";

/** Owns the right-hand topic details pane. The plugin shell only forwards requests to this controller. */
export class NodeDetailsSidebar {
  private detailsLeaf: WorkspaceLeaf | null = null;
  private detailsPath: string | null = null;
  /** The pane was open and follows the selection; closing its tab (Cmd+W) does not end that, closing the map does. */
  private following = false;
  private trialOwner?: string;
  private revision = 0;
  private pending: Promise<void> = Promise.resolve();
  private readonly revealListeners = new Set<() => void>();
  private revealingCount = 0;

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

  /** Whether the leaf is still in the workspace: a closed tab (Cmd+W, detach) is not, even if the object lingers. */
  private attached(leaf: WorkspaceLeaf): boolean {
    let found = false;
    this.app().workspace.iterateAllLeaves(item => {
      if (item === leaf) found = true;
    });
    return found;
  }

  /** The right dock's leaves that are this pane: readers (also restored, not yet loaded ones) and node notes. */
  private paneLeaves(): WorkspaceLeaf[] {
    const workspace = this.app().workspace;
    const node = (leaf: WorkspaceLeaf): boolean =>
      leaf.view instanceof MarkdownView &&
      !!leaf.view.file &&
      this.app().metadataCache.getFileCache(leaf.view.file)?.frontmatter?.["agent-map-node"] === true;
    return [
      ...workspace.getLeavesOfType(LIVING_READER_VIEW),
      ...workspace.getLeavesOfType("markdown").filter(node)
    ].filter(leaf => leaf.getRoot() === workspace.rightSplit);
  }

  /**
   * The node-details sidebar counts as open while its pane is visible, and while the pane the user had open was closed
   * as a tab (Cmd+W on the reader or the native editor): the next selection opens it again in the expanded right dock.
   */
  detailsShown(): boolean {
    if (this.app().workspace.rightSplit.collapsed) return false;
    if (this.following && this.detailsLeaf && !this.attached(this.detailsLeaf)) return true;
    return this.paneLeaves().some(leaf => leaf.view.containerEl.isShown());
  }

  /** Called after this pane revealed its leaf (which can unfold the right side panel); returns the unsubscribe. */
  onReveal(listener: () => void): () => void {
    this.revealListeners.add(listener);
    return () => this.revealListeners.delete(listener);
  }

  /** True while this pane is revealing its leaf: a side panel unfolding now is VAM's doing, not the user's. */
  revealing(): boolean {
    return this.revealingCount > 0;
  }

  private async reveal(leaf: WorkspaceLeaf): Promise<void> {
    this.revealingCount++;
    try {
      await this.app().workspace.revealLeaf(leaf);
    } finally {
      this.revealingCount--;
    }
    for (const listener of [...this.revealListeners]) listener();
  }

  /** A plain selection: the native editor the user opened for this same card is kept. */
  openDetails(file: TFile, owner?: string): Promise<void> {
    return this.open(file, owner, owner === undefined);
  }

  private open(file: TFile, owner: string | undefined, keepEditor: boolean): Promise<void> {
    this.trialOwner = owner;
    const revision = ++this.revision;
    return this.enqueue(async () => {
      if (revision !== this.revision) return;
      await this.openOfficial(file, revision, keepEditor);
    });
  }

  /** Layout ready: a reader restored from workspace.json with no card (or a deleted one) closes instead of staying blank. */
  closeEmptyReaders(): void {
    for (const leaf of this.app().workspace.getLeavesOfType(LIVING_READER_VIEW)) {
      const path: unknown = (leaf.getViewState().state as { file?: unknown } | undefined)?.file;
      if (typeof path === "string" && this.app().vault.getAbstractFileByPath(path)) continue;
      leaf.detach();
      if (this.detailsLeaf === leaf) this.detailsLeaf = null;
    }
  }

  private async openOfficial(file: TFile, revision: number, keepEditor = false): Promise<void> {
    const workspace = this.app().workspace;
    const current = this.detailsLeaf;
    if (
      current &&
      (!this.attached(current) ||
        current.getRoot() !== workspace.rightSplit ||
        !(current.view instanceof MarkdownView || current.view instanceof LivingReaderView))
    ) {
      // Its tab was closed or moved: what it showed is gone with it.
      this.detailsLeaf = null;
      this.detailsPath = null;
    }
    if (!this.detailsLeaf) {
      // A pane already in the dock is taken over (a reader or node note restored from workspace.json, or one left by
      // an earlier session), with what it shows, so no second pane is added next to it.
      const adopted = this.paneLeaves().sort(
        (a, b) => a.view.containerEl.getBoundingClientRect().top - b.view.containerEl.getBoundingClientRect().top
      )[0];
      if (adopted?.view instanceof MarkdownView) this.detailsPath = adopted.view.file?.path ?? null;
      this.detailsLeaf = adopted ?? workspace.getRightLeaf(false) ?? workspace.getRightLeaf(true);
    }
    if (!this.detailsLeaf) throw new Error(t("ui.unable_to_open_the_right_details_sidebar"));
    const leaf = this.detailsLeaf;
    const aiCard = this.app().metadataCache.getFileCache(file)?.frontmatter?.["ai-card"] === true;
    if (
      keepEditor &&
      aiCard &&
      leaf.view instanceof MarkdownView &&
      leaf.view.file?.path === file.path &&
      this.detailsPath === file.path
    ) {
      // The user opened this card in the native editor ("Open in editor") and selected it again: keep it so cursor,
      // focus and undo survive. Another card, the AI editor opening or closing, or a closed tab return to the reader.
      return;
    }
    if (aiCard) {
      // An AI card is read through the reader (same presentation as the trial preview), not as raw Markdown.
      if (!(leaf.view instanceof LivingReaderView))
        await leaf.setViewState({ type: LIVING_READER_VIEW, active: false });
      if (revision !== this.revision || this.detailsLeaf !== leaf) return;
      if (!(leaf.view instanceof LivingReaderView)) throw new Error(t("ui.unable_to_open_the_right_details_sidebar"));
      await leaf.view.showOfficial(file, this.trialOwner);
    } else await leaf.openFile(file);
    if (revision !== this.revision || this.detailsLeaf !== leaf) return;
    this.detailsPath = file.path;
    this.following = true;
    this.styleLeaf(leaf);
    await this.reveal(leaf);
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
      if (!this.detailsLeaf || !this.attached(this.detailsLeaf) || this.detailsPath !== file.path)
        await this.openOfficial(file, revision);
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
      await this.reveal(leaf);
      return current();
    });
  }

  invalidateLivingTrial(owner: string): void {
    if (this.trialOwner === owner && this.detailsLeaf?.view instanceof LivingReaderView)
      this.detailsLeaf.view.markInvalid(owner);
  }

  restoreLivingOfficial(file: TFile | undefined, owner: string, release = false): Promise<void> {
    if (this.trialOwner !== owner) return Promise.resolve();
    if (file && release) return this.open(file, undefined, false);
    if (file) {
      // After Adopt only the reader's content is refreshed: the card was just written, so the metadata cache
      // may not say "ai-card" yet and a normal open would swap the pane to the native editor.
      return this.enqueue(async () => {
        const leaf = this.detailsLeaf;
        if (this.trialOwner === owner && this.detailsPath === file.path && leaf?.view instanceof LivingReaderView)
          await leaf.view.showOfficial(file, owner);
      });
    }
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
    this.following = false;
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
