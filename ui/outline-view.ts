import { ItemView, Notice, WorkspaceLeaf } from "obsidian";
import { t, getUiLanguage } from "../i18n";
import type { MapDocument, MapNode } from "../map-model";
import type { CoffeeNavigationSnapshot } from "../experiences/coffee-tables/segments";

export const OUTLINE_VIEW_TYPE = "visual-agent-map-outline";

export class OutlineView extends ItemView {
  private map: MapDocument | null = null;
  private titles = new Map<string, string>();
  private collapsed = new Set<string>();
  private query = "";
  private activePath = "";
  private sample = false;
  private coffee: CoffeeNavigationSnapshot | null = null;
  private coffeeActive = false;
  private locateCoffee: ((item: string) => boolean) | null = null;
  private fillCoffee: (() => void) | null = null;
  constructor(leaf: WorkspaceLeaf, private openNote: (path: string) => Promise<void>) { super(leaf); }
  getViewType(): string { return OUTLINE_VIEW_TYPE; }
  getDisplayText(): string { return t("ui.topic_outline"); }
  getIcon(): string { return "list-tree"; }
  async onOpen(): Promise<void> { this.render(); }
  setMap(map: MapDocument | null, titles: Map<string, string>, sample = false): void {
    const search = this.contentEl.querySelector<HTMLInputElement>(".vam-outline-search");
    const restoreFocus = !!search && search === document.activeElement;
    const selection = restoreFocus ? [search.selectionStart, search.selectionEnd] as const : null;
    this.map = map;
    this.sample = sample;
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
  setCoffeeOutline(snapshot: CoffeeNavigationSnapshot | null, active: boolean, locate: ((item: string) => boolean) | null, fill: (() => void) | null = null): void {
    const search = this.contentEl.querySelector<HTMLInputElement>(".vam-outline-search"), restoreFocus = !!search && search === document.activeElement;
    const selection = restoreFocus ? [search.selectionStart, search.selectionEnd] as const : null;
    this.coffee = snapshot; this.coffeeActive = active; this.locateCoffee = locate; this.fillCoffee = fill; this.render();
    if (restoreFocus) { const updated = this.contentEl.querySelector<HTMLInputElement>(".vam-outline-search"); updated?.focus(); if (updated && selection && selection[0] !== null && selection[1] !== null) updated.setSelectionRange(selection[0], selection[1]); }
  }
  private render(): void {
    this.contentEl.empty();
    this.contentEl.addClass("vam-outline");
    const heading = this.contentEl.createDiv("vam-outline-heading");
    heading.createEl("strong", { text: this.coffeeActive ? (this.coffee?.topic ?? "Coffee Tables") : (this.map?.title ?? t("ui.topic_outline")) });
    if (this.coffeeActive) { this.renderCoffee(); return; }
    if (!this.map) { this.contentEl.createDiv({ cls: "vam-outline-empty", text: t(this.sample ? "ui.sample_outline_hint" : "ui.open_a_mind_map_to_see_its_topic_hierarchy_here") }); return; }
    const input = this.contentEl.createEl("input", { type: "search", cls: "vam-outline-search", attr: { placeholder: t("ui.search_topics") } });
    input.value = this.query;
    input.addEventListener("input", () => { this.query = input.value; this.renderTree(); });
    this.renderTree();
  }
  private renderCoffee(): void {
    this.contentEl.createEl("h4", { text: t("ui.coffee_segments") });
    const snapshot = this.coffee;
    if (!snapshot?.segments.length) { this.contentEl.createDiv({ cls: "vam-outline-empty", text: t("ui.coffee_segments_empty") }); return; }
    if (!snapshot.readOnly && snapshot.segments.some(item => !item.summary && item.text.trim() && item.status !== "generating")) {
      const fill = this.contentEl.createEl("button", {text: t("ui.coffee_fill_summaries")}); fill.addEventListener("click", () => this.fillCoffee?.());
    }
    const tree = this.contentEl.createDiv("vam-outline-tree");
    snapshot.segments.forEach((item, index) => {
      const button = tree.createEl("button", { cls: "vam-coffee-segment" });
      const kind = t(item.kind === "question" ? "ui.coffee_segment_question" : item.kind === "continuation" ? "ui.coffee_segment_continuation" : item.kind === "legacy" ? "ui.coffee_segment_legacy" : "ui.coffee_segment_initial");
      button.createEl("strong", { text: getUiLanguage() === "zh-TW" ? `第 ${index + 1} 段・${kind}` : `Segment ${index + 1} · ${kind}` });
      button.createSpan({text: item.status === "generating" ? t("ui.coffee_segment_generating") : item.summary ?? t("ui.coffee_segment_no_summary")});
      if (item.status === "error") button.createEl("small", {text: t("ui.coffee_segment_incomplete")});
      button.addEventListener("click", () => { if (!this.locateCoffee?.(item.id)) new Notice(t("ui.coffee_segment_no_content")); });
    });
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
    if (!tree.childElementCount) {
      tree.createDiv({ cls: "vam-outline-empty", text: t(query ? "ui.no_matching_topics" : "ui.empty_outline_hint") });
      if (query) tree.createEl("button", { text: t("ui.clear_search") }).addEventListener("click", () => { this.query = ""; this.render(); });
    }
  }
}
