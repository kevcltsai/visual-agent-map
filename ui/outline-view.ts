import { ItemView, WorkspaceLeaf } from "obsidian";
import { t } from "../i18n";
import type { MapDocument, MapNode } from "../map-model";

export const OUTLINE_VIEW_TYPE = "visual-agent-map-outline";

export class OutlineView extends ItemView {
  private map: MapDocument | null = null;
  private titles = new Map<string, string>();
  private collapsed = new Set<string>();
  private query = "";
  private activePath = "";
  constructor(leaf: WorkspaceLeaf, private openNote: (path: string) => Promise<void>) { super(leaf); }
  getViewType(): string { return OUTLINE_VIEW_TYPE; }
  getDisplayText(): string { return t("ui.topic_outline"); }
  getIcon(): string { return "list-tree"; }
  async onOpen(): Promise<void> { this.render(); }
  setMap(map: MapDocument | null, titles: Map<string, string>): void {
    const search = this.contentEl.querySelector<HTMLInputElement>(".vam-outline-search");
    const restoreFocus = !!search && search === document.activeElement;
    const selection = restoreFocus ? [search.selectionStart, search.selectionEnd] as const : null;
    this.map = map;
    this.titles = titles;
    if (map) this.collapsed = new Set([...this.collapsed].filter(id => map.nodes.some(node => node.id === id)));
    this.render();
    if (restoreFocus) {
      const updated = this.contentEl.querySelector<HTMLInputElement>(".vam-outline-search");
      updated?.focus();
      if (updated && selection && selection[0] !== null && selection[1] !== null) updated.setSelectionRange(selection[0], selection[1]);
    }
  }
  setActivePath(path: string): void { this.activePath = path; this.render(); }
  private render(): void {
    this.contentEl.empty();
    this.contentEl.addClass("vam-outline");
    const heading = this.contentEl.createDiv("vam-outline-heading");
    heading.createEl("strong", { text: this.map?.title ?? t("ui.topic_outline") });
    if (!this.map) { this.contentEl.createDiv({ cls: "vam-outline-empty", text: t("ui.open_a_mind_map_to_see_its_topic_hierarchy_here") }); return; }
    const input = this.contentEl.createEl("input", { type: "search", cls: "vam-outline-search", attr: { placeholder: t("ui.search_topics") } });
    input.value = this.query;
    input.addEventListener("input", () => { this.query = input.value; this.renderTree(); });
    this.renderTree();
  }
  private renderTree(): void {
    this.contentEl.querySelector(".vam-outline-tree")?.remove();
    if (!this.map) return;
    const tree = this.contentEl.createDiv("vam-outline-tree");
    const children = new Map<string | null, MapNode[]>();
    for (const node of this.map.nodes) children.set(node.parentId, [...(children.get(node.parentId) ?? []), node]);
    const query = this.query.trim().toLocaleLowerCase();
    const matches = (node: MapNode): boolean => {
      if (!query) return true;
      if ((this.titles.get(node.id) ?? node.path).toLocaleLowerCase().includes(query)) return true;
      return (children.get(node.id) ?? []).some(matches);
    };
    const append = (node: MapNode, depth: number): void => {
      if (!matches(node)) return;
      const descendants = children.get(node.id) ?? [];
      const row = tree.createDiv("vam-outline-row");
      row.style.paddingLeft = `${8 + depth * 16}px`;
      if (descendants.length) {
        const toggle = row.createEl("button", { text: query || !this.collapsed.has(node.id) ? "▾" : "▸", cls: "vam-outline-toggle" });
        toggle.disabled = !!query;
        toggle.setAttr("aria-label", !query && this.collapsed.has(node.id) ? t("ui.expand") : t("ui.collapse"));
        toggle.addEventListener("click", () => { if (this.collapsed.has(node.id)) this.collapsed.delete(node.id); else this.collapsed.add(node.id); this.renderTree(); });
      } else row.createSpan("vam-outline-spacer");
      const title = this.titles.get(node.id) ?? node.path.split("/").pop() ?? node.path;
      const button = row.createEl("button", { text: title, cls: "vam-outline-note" });
      button.title = title;
      if (node.path === this.activePath) button.addClass("is-active");
      button.addEventListener("click", () => { void this.openNote(node.path); });
      if (query || !this.collapsed.has(node.id)) for (const child of descendants) append(child, depth + 1);
    };
    for (const root of children.get(null) ?? []) append(root, 0);
    if (!tree.childElementCount) tree.createDiv({ cls: "vam-outline-empty", text: t("ui.no_matching_topics") });
  }
}
