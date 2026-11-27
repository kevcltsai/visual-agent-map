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
  /** Children containers of collapsed rows: filled the first time the row opens, hidden (not removed) when it closes. */
  private noteEls = new Map<string, HTMLElement>();
  private activeEl: HTMLElement | null = null;
  private branches = new Map<string, { box: HTMLElement; filled: boolean; fill: () => void }>();
  private parentOf = new Map<string, string | null>();
  /** Collapsed rows opened only while the canvas selection sits below them: outline DOM state, never written to the map. */
  private tempOpen = new Set<string>();
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
    if (map) {
      this.collapsed = new Set([...this.collapsed].filter(id => map.nodes.some(node => node.id === id)));
      this.tempOpen = new Set([...this.tempOpen].filter(id => this.collapsed.has(id)));
    }
    this.render();
    if (restoreFocus) {
      const updated = this.contentEl.querySelector<HTMLInputElement>(".vam-outline-search");
      updated?.focus();
      if (updated && selection && selection[0] !== null && selection[1] !== null)
        updated.setSelectionRange(selection[0], selection[1]);
    }
  }
  /**
   * Moves the active-row marker in place; the tree, its search box and scroll position stay untouched.
   * Collapsed ancestors of the active row open for as long as it is active (outline DOM only) and it is scrolled into view.
   * Nothing here takes focus.
   */
  setActive(path: string): void {
    if (path === this.activePath) return;
    this.activePath = path;
    const open = new Set<string>();
    const node = path ? this.map?.nodes.find(item => item.path === path) : undefined;
    const chain: string[] = [];
    for (let id = node ? this.parentOf.get(node.id) : null; id; id = this.parentOf.get(id))
      if (this.collapsed.has(id)) chain.push(id);
    // Top-down, so a branch is filled before the nested branch inside it. Only the ancestor chain is walked.
    for (const id of chain.reverse()) open.add(id);
    const changed = [...this.tempOpen]
      .filter(id => !open.has(id))
      .concat([...open].filter(id => !this.tempOpen.has(id)));
    this.tempOpen = open;
    for (const id of [...open].filter(id => changed.includes(id))) {
      const branch = this.branches.get(id);
      if (branch && !branch.filled) branch.fill();
    }
    for (const id of changed) {
      const closed = this.collapsed.has(id) && !open.has(id);
      const branch = this.branches.get(id);
      branch?.box.toggleClass("is-folded", closed);
      const toggle = this.toggleEls.get(id);
      if (!toggle) continue;
      toggle.setText(closed ? "▸" : "▾");
      toggle.setAttr("aria-label", closed ? t("ui.expand") : t("ui.collapse"));
      toggle.setAttr("aria-expanded", String(!closed));
    }
    this.markActive(path);
  }
  private markActive(path: string): void {
    if (this.noteEls.size) {
      // Only the old and the new row change: no walk over the whole tree.
      const next = path ? (this.noteEls.get(path) ?? null) : null;
      if (this.activeEl && this.activeEl !== next) {
        this.activeEl.toggleClass("is-active", false);
        this.activeEl.removeAttribute("aria-current");
      }
      if (next) {
        next.toggleClass("is-active", true);
        next.setAttr("aria-current", "true");
        next.scrollIntoView?.({ block: "nearest" });
      }
      this.activeEl = next;
      return;
    }
    let activeRow: HTMLElement | null = null;
    const rows = Array.from(this.contentEl.querySelectorAll<HTMLElement>(".vam-outline-note"));
    for (const row of rows) {
      const active = !!path && row.getAttribute("data-path") === path;
      row.toggleClass("is-active", active);
      if (active) {
        row.setAttr("aria-current", "true");
        activeRow = row;
      } else row.removeAttribute("aria-current");
    }
    activeRow?.scrollIntoView?.({ block: "nearest" });
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
    this.branches.clear();
    this.noteEls.clear();
    this.activeEl = null;
    this.parentOf.clear();
    if (!this.map) return;
    const tree = this.contentEl.createDiv("vam-outline-tree");
    const children = new Map<string | null, MapNode[]>();
    for (const node of this.map.nodes) {
      children.set(node.parentId, [...(children.get(node.parentId) ?? []), node]);
      this.parentOf.set(node.id, node.parentId);
    }
    const query = foldOutlineSearch(this.query.trim());
    const matches = (node: MapNode): boolean => {
      if (!query) return true;
      if (foldOutlineSearch(this.titles.get(node.id) ?? node.path).includes(query)) return true;
      return (children.get(node.id) ?? []).some(matches);
    };
    const closed = (id: string): boolean => this.collapsed.has(id) && !this.tempOpen.has(id);
    const append = (node: MapNode, depth: number, into: HTMLElement): void => {
      if (!matches(node)) return;
      const descendants = children.get(node.id) ?? [];
      const row = into.createDiv("vam-outline-row");
      row.style.paddingLeft = `${8 + depth * 16}px`;
      if (descendants.length) {
        const toggle = row.createEl("button", {
          text: query || !closed(node.id) ? "▾" : "▸",
          cls: "vam-outline-toggle"
        });
        toggle.disabled = !!query;
        toggle.setAttr("aria-label", !query && closed(node.id) ? t("ui.expand") : t("ui.collapse"));
        toggle.setAttr("aria-expanded", String(!!query || !closed(node.id)));
        this.toggleEls.set(node.id, toggle);
        toggle.addEventListener("click", () => {
          // The tree is rebuilt: a toggle that had focus (Space on the keyboard) keeps it on the new button of the same row.
          const hadFocus = (this.contentEl.ownerDocument as Document | undefined)?.activeElement === toggle;
          if (this.collapsed.has(node.id) && !this.tempOpen.has(node.id)) this.collapsed.delete(node.id);
          else this.collapsed.add(node.id);
          this.tempOpen.delete(node.id);
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
      this.noteEls.set(node.path, button);
      if (node.path === this.activePath) {
        this.activeEl = button;
        button.addClass("is-active");
        button.setAttr("aria-current", "true");
      }
      button.addEventListener("click", () => {
        // Mark the row in place: a re-render would drop keyboard focus from the outline.
        this.setActive(node.path);
        void this.openNote(node.path);
      });
      // Collapsed branches stay in the tree but folded away, so the canvas selection can open them without rebuilding rows.
      if (!query && this.collapsed.has(node.id) && descendants.length) {
        // Rows of a collapsed branch exist only once it has been opened; the container keeps their place in the order.
        const box = into.createDiv(closed(node.id) ? "vam-outline-children is-folded" : "vam-outline-children");
        const branch = {
          box,
          filled: false,
          fill: () => {
            branch.filled = true;
            for (const child of descendants) append(child, depth + 1, box);
          }
        };
        this.branches.set(node.id, branch);
        if (!closed(node.id)) branch.fill();
      } else for (const child of descendants) append(child, depth + 1, into);
    };
    for (const root of children.get(null) ?? []) append(root, 0, tree);
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
