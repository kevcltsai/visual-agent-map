import { MarkdownView, View, type App, type TFile, type WorkspaceLeaf } from "obsidian";
import { t } from "../../i18n";
import type { LivingChangeSummary } from "./living-node-changes";
import { LIVING_READER_VIEW, LivingReaderView } from "./living-node-reader";
import type { SideDock } from "./living-editor-room";

/**
 * Why the pane is asked to show a card. Only `user` (the card's Note action, the outline, a source link) and `trial` (the
 * AI editor's preview, living-node.md L180) may unfold the right side panel; every other request changes the pane in place.
 * - `follow`: a selection; a pane the user hid stays hidden.
 * - `editor`: the AI editor opened; a visible pane returns to the reader, a hidden one is left alone.
 * - `adopt`: the card was just written; the reader shows it again.
 * - `release`: the AI editor closed; the official note goes back, a pane the trial created goes away.
 */
export type PaneIntent = "follow" | "user" | "editor" | "trial" | "release" | "adopt";

/** The room the open AI editor makes among the side panels: the only one, besides the user, that folds or unfolds them. */
export interface PaneRoom {
  unfold(dock: SideDock): void;
  folds(dock: SideDock): boolean;
}

/**
 * The right-hand topic details pane: the only place that decides what it shows. The plugin shell only forwards requests.
 * It never unfolds the right side panel on its own: `user` unfolds it as the user's action, `trial` through the editor's
 * room (which folds it back when the editor closes); `revealLeaf` only switches to the pane's tab in an unfolded panel.
 */
export class NodeDetailsSidebar {
  private detailsLeaf: WorkspaceLeaf | null = null;
  private detailsPath: string | null = null;
  /** The card the user opened natively from the reader (「在編輯器開啟」): kept when that card is selected again. */
  private nativePath: string | null = null;
  /** A pane leaf the trial created in a closed pane: it goes away again when the editor closes. */
  private trialLeaf: WorkspaceLeaf | null = null;
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
    private readonly styleLeaf: (leaf: WorkspaceLeaf) => void,
    private readonly room: () => PaneRoom | null = () => null
  ) {}

  /** A reader whose 「在編輯器開啟」 goes through this pane, so the native editor is known to be the user's. */
  createReader(leaf: WorkspaceLeaf): LivingReaderView {
    return new LivingReaderView(leaf, file => this.openInEditor(leaf, file));
  }

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
   * Whether the pane follows the selection: it is open and the user has not hidden it. A pane the user closed (Cmd+W,
   * detach) or whose side panel the user folded stays as it is for every card; the card's Note action (「筆記」) opens it
   * again. A side panel the AI editor folded for room does not count as hidden: the pane changes in place behind it.
   */
  detailsShown(): boolean {
    const split = this.app().workspace.rightSplit;
    if (split.collapsed) return !this.splitHidden() && this.paneLeaves().length > 0;
    return this.paneLeaves().some(leaf => leaf.view.containerEl.isShown());
  }

  /** The right side panel may unfold only for `user` (the user's own action) and `trial` (VAM's, through the editor's room). */
  private async reveal(leaf: WorkspaceLeaf, intent: PaneIntent): Promise<void> {
    const split = this.app().workspace.rightSplit;
    if (split.collapsed) {
      if (intent === "user") split.expand();
      else if (intent === "trial") {
        const room = this.room();
        if (room) room.unfold(split);
        else split.expand();
      }
      if (split.collapsed) return;
    }
    await this.app().workspace.revealLeaf(leaf);
  }

  /**
   * Shows the card in the pane. `owner` is the AI editor (its view session) the pane now belongs to; without an intent a
   * request is the editor's when it has an owner, else the user's. `aiCard` comes from the caller's model: the metadata
   * cache can lag behind a write just made.
   */
  openDetails(
    file: TFile,
    owner?: string,
    intent: PaneIntent = owner === undefined ? "user" : "editor",
    aiCard?: boolean
  ): Promise<void> {
    if (intent === "follow" && !this.detailsShown()) return Promise.resolve();
    if (intent !== "adopt") this.trialOwner = owner;
    const revision = ++this.revision;
    return this.enqueue(async () => {
      if (revision !== this.revision) return;
      await this.openOfficial(file, revision, intent, aiCard);
    });
  }

  /** The right side panel is folded and not by the AI editor's room: the user hid the pane. */
  private splitHidden(): boolean {
    const split = this.app().workspace.rightSplit;
    return split.collapsed && !this.room()?.folds(split);
  }

  /** The reader's 「在編輯器開啟」: the card opens natively in the pane's leaf, as the user's own choice. */
  openInEditor(leaf: WorkspaceLeaf, file: TFile): Promise<void> {
    const revision = ++this.revision;
    return this.enqueue(async () => {
      if (revision !== this.revision) return;
      this.detailsLeaf = leaf;
      await leaf.openFile(file);
      this.detailsPath = file.path;
      this.nativePath = file.path;
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

  /** A layout change: a pane tab the user closed (Cmd+W, detach) is noticed now, not on the next request. */
  layoutChanged(): void {
    if (this.detailsLeaf && !this.attached(this.detailsLeaf)) this.forget();
  }

  private forget(): void {
    if (this.trialLeaf === this.detailsLeaf) this.trialLeaf = null;
    this.detailsLeaf = null;
    this.detailsPath = null;
    this.nativePath = null;
  }

  /** The pane's leaf: the current one, one already in the dock, or (when `create`) a new one. Null for a closed pane. */
  private paneLeaf(create: boolean): WorkspaceLeaf | null {
    const workspace = this.app().workspace;
    const current = this.detailsLeaf;
    if (
      current &&
      (!this.attached(current) ||
        current.getRoot() !== workspace.rightSplit ||
        !(current.view instanceof MarkdownView || current.view instanceof LivingReaderView))
    )
      // Its tab was closed or moved: what it showed is gone with it.
      this.forget();
    if (!this.detailsLeaf) {
      // A pane already in the dock is taken over (a reader or node note restored from workspace.json, or one left by
      // an earlier session), with what it shows, so no second pane is added next to it.
      const adopted = this.paneLeaves().sort(
        (a, b) => a.view.containerEl.getBoundingClientRect().top - b.view.containerEl.getBoundingClientRect().top
      )[0];
      if (adopted?.view instanceof MarkdownView) this.detailsPath = adopted.view.file?.path ?? null;
      this.detailsLeaf = adopted ?? (create ? (workspace.getRightLeaf(false) ?? workspace.getRightLeaf(true)) : null);
    }
    return this.detailsLeaf;
  }

  private async openOfficial(file: TFile, revision: number, intent: PaneIntent, aiCard?: boolean): Promise<void> {
    // Only an explicit request opens a closed pane; the editor and a selection leave it closed.
    const leaf = this.paneLeaf(intent === "user");
    if (!leaf) {
      if (intent === "user") throw new Error(t("ui.unable_to_open_the_right_details_sidebar"));
      return;
    }
    // The editor opening changes only a pane the user can see.
    if (intent === "editor" && this.splitHidden()) return;
    if (intent === "user") this.trialLeaf = null;
    const isAiCard = aiCard ?? this.app().metadataCache.getFileCache(file)?.frontmatter?.["ai-card"] === true;
    const native = leaf.view instanceof MarkdownView && leaf.view.file?.path === file.path;
    if (isAiCard && native && this.nativePath === file.path && intent !== "editor") {
      // The user opened this card in the native editor (「在編輯器開啟」) and selected it again: keep it so cursor, focus
      // and undo survive (also behind a panel the user folded, when the AI editor closes). Another card, the AI editor
      // opening over it, or a closed tab return to the reader.
      return;
    }
    if (intent === "adopt" && !(this.detailsPath === file.path && leaf.view instanceof LivingReaderView)) return;
    this.nativePath = null;
    if (isAiCard) {
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
    if (intent !== "adopt") await this.reveal(leaf, intent);
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
      // The preview shows even in a pane the user closed (living-node.md L180): a leaf made for it goes when the editor does.
      const had = this.paneLeaf(false);
      const leaf = had ?? this.paneLeaf(true);
      if (!leaf) throw new Error(t("ui.unable_to_open_the_right_details_sidebar"));
      if (!had) this.trialLeaf = leaf;
      if (!(leaf.view instanceof LivingReaderView))
        await leaf.setViewState({ type: LIVING_READER_VIEW, active: false });
      if (!current() || this.detailsLeaf !== leaf) {
        // Stop during view creation must not leave an empty preview pane. A newer
        // selection has its own queued transition and must never be replaced here.
        if (revision === this.revision && this.trialOwner === owner && this.detailsLeaf === leaf)
          await this.openOfficial(file, revision, "release");
        return false;
      }
      if (!(leaf.view instanceof LivingReaderView)) throw new Error(t("ui.unable_to_open_the_right_details_sidebar"));
      this.nativePath = null;
      await leaf.view.show(file, markdown, owner, warnings, false, changes, draft);
      if (!current()) return false;
      this.detailsPath = file.path;
      await this.reveal(leaf, "trial");
      return current();
    });
  }

  invalidateLivingTrial(owner: string): void {
    if (this.trialOwner === owner && this.detailsLeaf?.view instanceof LivingReaderView)
      this.detailsLeaf.view.markInvalid(owner);
  }

  /**
   * The editor of `owner` adopted (`file`, not released) or closed (`release`). Closing puts the official note back in
   * place and never unfolds a side panel; the editor gives the side panels back only after this.
   */
  restoreLivingOfficial(file: TFile | undefined, owner: string, release = false, aiCard?: boolean): Promise<void> {
    if (this.trialOwner !== owner) return Promise.resolve();
    // After Adopt the card was just written: the caller says it is an AI card, the metadata cache may not yet.
    if (file && !release) return this.openDetails(file, owner, "adopt", true);
    this.trialOwner = undefined;
    const revision = ++this.revision;
    return this.enqueue(async () => {
      if (revision !== this.revision) return;
      const leaf = this.detailsLeaf;
      if (leaf && leaf === this.trialLeaf) {
        // The trial opened this pane in a closed one: closed again, as the user left it.
        leaf.detach();
        this.forget();
        return;
      }
      if (file) {
        await this.openOfficial(file, revision, "release", aiCard);
        return;
      }
      // The edited card may have been deleted, or its view may have closed: discard only the matching transient reader.
      if (leaf?.view instanceof LivingReaderView && leaf.view.owns(owner)) {
        leaf.detach();
        this.forget();
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
    this.forget();
  }
}
