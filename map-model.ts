import { t } from "./i18n";

export interface MapNode {
  id: string;
  path: string;
  parentId: string | null;
  x: number;
  y: number;
  collapsed: boolean;
}
export interface MapDocument {
  version: 1;
  id: string;
  title: string;
  nodes: MapNode[];
  viewport: { x: number; y: number; zoom: number };
}
export const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export function descendants(nodes: MapNode[], id: string): Set<string> {
  const found = new Set<string>();
  const pending = [id];
  while (pending.length) {
    const parent = pending.pop();
    for (const node of nodes) {
      if (node.parentId === parent && node.id !== id && !found.has(node.id)) {
        found.add(node.id);
        pending.push(node.id);
      }
    }
  }
  return found;
}
export function canParent(nodes: MapNode[], id: string, parentId: string | null): boolean {
  return parentId === null || (parentId !== id && nodes.some(n => n.id === parentId) && !descendants(nodes, id).has(parentId));
}
export function visibleNodes(nodes: MapNode[]): MapNode[] {
  const hidden = new Set<string>();
  for (const node of nodes) if (node.collapsed) for (const id of descendants(nodes, node.id)) hidden.add(id);
  return nodes.filter(node => !hidden.has(node.id));
}
export function removeNodes(nodes: MapNode[], id: string, branch: boolean): MapNode[] {
  const removed = branch ? descendants(nodes, id) : new Set<string>();
  removed.add(id);
  return nodes.filter(node => !removed.has(node.id)).map(node => ({ ...node, parentId: node.parentId && removed.has(node.parentId) ? null : node.parentId }));
}
export function parseMap(content: string): MapDocument {
  const block = content.match(/```agent-map\s*\n([\s\S]*?)\n```/);
  if (!block) throw new Error(t("找不到心智圖資料區塊，請保留 agent-map 區塊。"));
  const map = JSON.parse(block[1]) as MapDocument;
  if (map.version !== 1 || typeof map.id !== "string" || typeof map.title !== "string" || !Array.isArray(map.nodes)) throw new Error(t("心智圖格式不正確。"));
  const ids = new Set<string>();
  for (const n of map.nodes) {
    if (!n || typeof n.id !== "string" || typeof n.path !== "string" || !n.path.endsWith(".md") || !Number.isFinite(n.x) || !Number.isFinite(n.y) || (n.parentId !== null && typeof n.parentId !== "string") || ids.has(n.id)) throw new Error(t("節點資料不正確或 ID 重複。"));
    ids.add(n.id);
    n.collapsed = n.collapsed === true;
  }
  for (const n of map.nodes) if (!canParent(map.nodes, n.id, n.parentId)) throw new Error(t("連結有循環或指向不存在的母議題。"));
  if (!map.viewport || !Number.isFinite(map.viewport.x) || !Number.isFinite(map.viewport.y) || !Number.isFinite(map.viewport.zoom)) map.viewport = { x: 40, y: 40, zoom: 1 };
  map.viewport.zoom = Math.min(2, Math.max(0.25, map.viewport.zoom));
  return map;
}
export function serializeMap(map: MapDocument, language: "zh-TW" | "en" = "zh-TW"): string {
  const description = language === "en"
    ? "This file stores the mind map structure. Full content lives in the topic notes. Choose Open as mind map from the file menu."
    : "此檔案保存心智圖結構；完整內容保存在各議題筆記。從檔案選單選擇「以心智圖開啟」。";
  return `---\nvisual-agent-map: true\n---\n\n# ${map.title.replace(/\n/g, " ")}\n\n${description}\n\n\`\`\`agent-map\n${JSON.stringify(map, null, 2)}\n\`\`\`\n`;
}
export function inheritModel(parentModel: string | undefined, defaultModel: string): string {
  return parentModel ?? defaultModel;
}
export class History<T> {
  private past: T[] = [];
  private future: T[] = [];
  get canUndo(): boolean { return this.past.length > 0; }
  get canRedo(): boolean { return this.future.length > 0; }
  push(entry: T): void { this.past.push(entry); if (this.past.length > 80) this.past.shift(); this.future = []; }
  undo(): T | undefined { const entry = this.past.pop(); if (entry) this.future.push(entry); return entry; }
  redo(): T | undefined { const entry = this.future.pop(); if (entry) this.past.push(entry); return entry; }
  clear(): void { this.past = []; this.future = []; }
}
