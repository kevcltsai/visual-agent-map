import { ItemView, WorkspaceLeaf } from "obsidian";
import { t } from "../i18n";
import { foldSearchText } from "../i18n/han-fold";
import type { MapDocument, MapNode } from "../map-model";
import { readTopicLinks } from "../topic-links";
import { markerLabelKey, markerSymbol, readTopicMarkers, type TopicMarker } from "../topic-markers";

export const OUTLINE_VIEW_TYPE = "visual-agent-map-outline";
export const foldOutlineSearch = foldSearchText;
export class OutlineView extends ItemView {
  private map: MapDocument | null = null;
  private titles = new Map<string, string>();
  private markers = new Map<string, TopicMarker[]>();
  private links = new Map<string, string[]>();
  private collapsed = new Set<string>();
  /** The fold button of each row in the tree as last drawn, so focus can follow a rebuild. */
  private toggleEls = new Map<string, HTMLElement>();
  private query = "";
  private activePath = "";
  constructor(
    leaf: WorkspaceLeaf,
    private openNote: (path: string) => Promise<void>
  ) {
    super(leaf);
  }
  getViewType(): string {
    return OUTLINE_VIEW_TYPE;
  }
  getDisplayText(): string {
    return t("ui.topic_outline");
  }
  getIcon(): string {
    return "list-tree";
  }
  async onOpen(): Promise<void> {
    this.render();
  }
  setMap(
    map: MapDocument | null,
    titles: Map<string, string>,
    markers: Map<string, TopicMarker[]> = new Map(),
    links: Map<string, string[]> = new Map()
  ): void {
    const search = this.contentEl.querySelector<HTMLInputElement>(".vam-outline-search");
    const restoreFocus = !!search && search === document.activeElement;
    const selection = restoreFocus ? ([search.selectionStart, search.selectionEnd] as const) : null;
    this.map = map;
    this.titles = titles;
    this.markers = markers;
    this.links = links;
    if (map) this.collapsed = new Set([...this.collapsed].filter(id => map.nodes.some(node => node.id === id)));
    this.render();
    if (restoreFocus) {
      const updated = this.contentEl.querySelector<HTMLInputElement>(".vam-outline-search");
      updated?.focus();
      if (updated && selection && selection[0] !== null && selection[1] !== null)
        updated.setSelectionRange(selection[0], selection[1]);
    }
  }
  /** Moves the active-row marker in place; the tree, its search box and scroll position stay untouched. */
  setActive(path: string): void {
    if (path === this.activePath) return;
    this.activePath = path;
    const rows = Array.from(this.contentEl.querySelectorAll<HTMLElement>(".vam-outline-note"));
    for (const row of rows) {
      const active = !!path && row.getAttribute("data-path") === path;
      row.toggleClass("is-active", active);
      if (active) row.setAttr("aria-current", "true");
      else row.removeAttribute("aria-current");
    }
  }
  private render(): void {
    this.contentEl.empty();
    this.contentEl.addClass("vam-outline");
    const heading = this.contentEl.createDiv("vam-outline-heading");
    heading.createEl("strong", {
      text: this.map?.title ?? t("ui.topic_outline")
    });
    if (!this.map) {
      this.contentEl.createDiv({
        cls: "vam-outline-empty",
        text: t("ui.open_a_mind_map_to_see_its_topic_hierarchy_here")
      });
      return;
    }
    const input = this.contentEl.createEl("input", {
      type: "search",
      cls: "vam-outline-search",
      attr: { placeholder: t("ui.search_topics") }
    });
    input.value = this.query;
    input.addEventListener("input", () => {
      this.query = input.value;
      this.renderTree();
    });
    // Enter jumps to the first topic whose own title matches: the keyboard path from the search box to the map.
    input.addEventListener("keydown", event => {
      if (event.key !== "Enter" || event.isComposing || !this.query.trim()) return;
      const path = this.firstMatchPath();
      if (!path) return;
      event.preventDefault();
      this.setActive(path);
      void this.openNote(path);
    });
    this.renderTree();
  }
  /** The first topic, in outline order, whose own title contains the search text (not one that only has a matching child). */
  private firstMatchPath(): string | null {
    if (!this.map) return null;
    const query = foldOutlineSearch(this.query.trim());
    if (!query) return null;
    const children = new Map<string | null, MapNode[]>();
    for (const node of this.map.nodes) children.set(node.parentId, [...(children.get(node.parentId) ?? []), node]);
    const find = (node: MapNode): string | null => {
      if (foldOutlineSearch(this.titles.get(node.id) ?? node.path).includes(query)) return node.path;
      for (const child of children.get(node.id) ?? []) {
        const found = find(child);
        if (found) return found;
      }
      return null;
    };
    for (const root of children.get(null) ?? []) {
      const found = find(root);
      if (found) return found;
    }
    return null;
  }
  private renderTree(): void {
    this.contentEl.querySelector(".vam-outline-tree")?.remove();
    this.toggleEls.clear();
    if (!this.map) return;
    const tree = this.contentEl.createDiv("vam-outline-tree");
    const children = new Map<string | null, MapNode[]>();
    for (const node of this.map.nodes) children.set(node.parentId, [...(children.get(node.parentId) ?? []), node]);
    const query = foldOutlineSearch(this.query.trim());
    const matches = (node: MapNode): boolean => {
      if (!query) return true;
      if (foldOutlineSearch(this.titles.get(node.id) ?? node.path).includes(query)) return true;
      return (children.get(node.id) ?? []).some(matches);
    };
    const append = (node: MapNode, depth: number): void => {
      if (!matches(node)) return;
      const descendants = children.get(node.id) ?? [];
      const row = tree.createDiv("vam-outline-row");
      row.style.paddingLeft = `${8 + depth * 16}px`;
      if (descendants.length) {
        const toggle = row.createEl("button", {
          text: query || !this.collapsed.has(node.id) ? "▾" : "▸",
          cls: "vam-outline-toggle"
        });
        toggle.disabled = !!query;
        toggle.setAttr("aria-label", !query && this.collapsed.has(node.id) ? t("ui.expand") : t("ui.collapse"));
        toggle.setAttr("aria-expanded", String(!!query || !this.collapsed.has(node.id)));
        this.toggleEls.set(node.id, toggle);
        toggle.addEventListener("click", () => {
          // The tree is rebuilt: a toggle that had focus (Space on the keyboard) keeps it on the new button of the same row.
          const hadFocus = (this.contentEl.ownerDocument as Document | undefined)?.activeElement === toggle;
          if (this.collapsed.has(node.id)) this.collapsed.delete(node.id);
          else this.collapsed.add(node.id);
          this.renderTree();
          if (hadFocus) this.toggleEls.get(node.id)?.focus();
        });
      } else row.createSpan("vam-outline-spacer");
      const title = this.titles.get(node.id) ?? node.path.split("/").pop() ?? node.path;
      const button = row.createEl("button", { text: title, cls: "vam-outline-note" });
      button.title = title;
      button.setAttr("dir", "auto");
      button.setAttr("data-path", node.path);
      // Only whitelisted ids, in the fixed order. The symbols are decoration; the names reach assistive technology.
      const marks = readTopicMarkers({ "topic-markers": this.markers.get(node.id) });
      if (marks.length) {
        const listSeparator = t("ui.list_separator");
        const names = marks.map(id => t(markerLabelKey(id))).join(listSeparator);
        button.setAttr(
          "aria-label",
          `${title}${listSeparator === "、" ? "，" : ", "}${t("share.viewer_markers_0", names)}`
        );
        const row = button.createSpan("vam-markers");
        for (const id of marks) {
          const mark = row.createSpan({ cls: "vam-marker", text: markerSymbol(id), attr: { "aria-hidden": "true" } });
          mark.dataset.marker = id;
        }
      }
      // A row with links shows a quiet arrow (decoration); the count joins the accessible name. The outline never opens a link.
      const linkCount = readTopicLinks({ "topic-links": this.links.get(node.id) }).length;
      if (linkCount) {
        const listSeparator = t("ui.list_separator");
        const base = button.getAttr("aria-label") ?? title;
        button.setAttr(
          "aria-label",
          `${base}${listSeparator === "、" ? "，" : ", "}${t("ui.outline_links_0", String(linkCount))}`
        );
        button.createSpan({ cls: "vam-outline-links", text: "↗", attr: { "aria-hidden": "true" } });
      }
      if (node.path === this.activePath) {
        button.addClass("is-active");
        button.setAttr("aria-current", "true");
      }
      button.addEventListener("click", () => {
        // Mark the row in place: a re-render would drop keyboard focus from the outline.
        this.setActive(node.path);
        void this.openNote(node.path);
      });
      if (query || !this.collapsed.has(node.id)) for (const child of descendants) append(child, depth + 1);
    };
    for (const root of children.get(null) ?? []) append(root, 0);
    if (!tree.childElementCount) {
      tree.createDiv({ cls: "vam-outline-empty", text: t(query ? "ui.no_matching_topics" : "ui.empty_outline_hint") });
      if (query)
        tree.createEl("button", { text: t("ui.clear_search") }).addEventListener("click", () => {
          this.query = "";
          this.render();
        });
    }
  }
}
