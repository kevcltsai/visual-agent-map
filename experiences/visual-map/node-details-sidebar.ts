import { MarkdownView, View, type App, type TFile, type WorkspaceLeaf } from "obsidian";
import { t } from "../../i18n";

/** Owns the right-hand topic details pane. The plugin shell only forwards requests to this controller. */
export class NodeDetailsSidebar {
  private detailsLeaf: WorkspaceLeaf | null = null;
  private detailsPath: string | null = null;

  constructor(
    private readonly app: () => App,
    private readonly styleLeaf: (leaf: WorkspaceLeaf) => void
  ) {}

  /** The node-details sidebar counts as open only while its pane is actually visible. */
  detailsShown(): boolean {
    const split = this.app().workspace.rightSplit;
    if (split.collapsed) return false;
    return this.app().workspace
      .getLeavesOfType("markdown")
      .some(
        leaf =>
          leaf.getRoot() === split &&
          leaf.view instanceof MarkdownView &&
          !!leaf.view.file &&
          this.app().metadataCache.getFileCache(leaf.view.file)?.frontmatter?.["agent-map-node"] === true &&
          leaf.view.containerEl.isShown()
      );
  }


  async openDetails(file: TFile): Promise<void> {
    const markdownLeaves = this.app().workspace.getLeavesOfType("markdown");
    if (
      this.detailsLeaf &&
      (!markdownLeaves.includes(this.detailsLeaf) || this.detailsLeaf.getRoot() !== this.app().workspace.rightSplit)
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
    await this.detailsLeaf.openFile(file);
    this.detailsPath = file.path;
    this.styleLeaf(this.detailsLeaf);
    await this.app().workspace.revealLeaf(this.detailsLeaf);
  }


  closeStaleDetails(): void {
    const closed =
      this.detailsLeaf?.view instanceof MarkdownView && this.detailsLeaf.view.file?.path === this.detailsPath;
    if (closed) {
      this.detailsLeaf!.detach();
      this.app().workspace.trigger("file-open", null);
      this.app().workspace.trigger("active-leaf-change", this.app().workspace.getActiveViewOfType(View)?.leaf ?? null);
    }
    this.detailsLeaf = null;
    this.detailsPath = null;
  }

}
