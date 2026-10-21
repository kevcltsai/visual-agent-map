import type { MapNode } from "../map-model";

export interface TopicTreeOptions {
  nodes: MapNode[];
  title: (node: MapNode) => string;
  /** Accessible name of the list. */
  label: string;
  /** Topics that can be picked; the rest stay visible, disabled, so the hierarchy still reads. */
  selectable: (node: MapNode) => boolean;
  onChoose: (id: string) => void;
  /** Text of an extra first row that picks "" (for example "no parent"). */
  rootChoice?: string;
  /** The picked id ("" for the root choice); shown as selected. */
  value?: string;
}

/**
 * Topics as an indented tree, in the same order and indentation as the side outline, so a picker
 * shows where each topic sits. Nodes whose parent is missing from `nodes` are listed as roots.
 */
export function renderTopicTree(parent: HTMLElement, options: TopicTreeOptions): { select: (id: string) => void } {
  const tree = parent.createDiv({ cls: "vam-topic-tree", attr: { role: "listbox", "aria-label": options.label } });
  const ids = new Set(options.nodes.map(node => node.id));
  const children = new Map<string | null, MapNode[]>();
  for (const node of options.nodes) {
    const key = node.parentId && ids.has(node.parentId) ? node.parentId : null;
    children.set(key, [...(children.get(key) ?? []), node]);
  }
  const rows: HTMLButtonElement[] = [];
  const row = (id: string, text: string, depth: number, enabled: boolean): void => {
    const button = tree.createEl("button", { cls: "vam-topic-tree-row", text, attr: { role: "option" } });
    button.style.paddingLeft = `${8 + depth * 16}px`;
    button.dataset.id = id;
    button.title = text;
    button.setAttr("dir", "auto");
    button.disabled = !enabled;
    button.setAttr("aria-disabled", String(!enabled));
    if (enabled) button.addEventListener("click", () => options.onChoose(id));
    rows.push(button);
  };
  if (options.rootChoice !== undefined) row("", options.rootChoice, 0, true);
  const append = (node: MapNode, depth: number, seen: Set<string>): void => {
    if (seen.has(node.id)) return;
    seen.add(node.id);
    row(node.id, options.title(node), depth, options.selectable(node));
    for (const child of children.get(node.id) ?? []) append(child, depth + 1, seen);
  };
  const seen = new Set<string>();
  for (const root of children.get(null) ?? []) append(root, 0, seen);
  const select = (id: string): void => {
    for (const button of rows) {
      const selected = button.dataset.id === id;
      button.toggleClass("is-selected", selected);
      button.setAttr("aria-selected", String(selected));
    }
  };
  if (options.value !== undefined) select(options.value);
  return { select };
}
