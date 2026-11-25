import type { MapDocument } from "../map-model";
import { rebaseLegacyAimNotePaths } from "./legacy-aim-paths";

/** Point node paths and retained legacy AIM references at moved notes. Returns whether anything changed. */
export function rebaseMapNotePaths(map: MapDocument, rebase: (path: string) => string): boolean {
  let changed = false;
  const move = (path: string): string => {
    const next = rebase(path);
    if (next !== path) changed = true;
    return next;
  };
  for (const node of map.nodes) node.path = move(node.path);
  if (map.aim) rebaseLegacyAimNotePaths(map.aim, move);
  return changed;
}
/** A rebase function that moves exactly one note path. */
export function moveNotePath(oldPath: string, newPath: string): (path: string) => string {
  return path => (path === oldPath ? newPath : path);
}
export function writeMapContent(content: string, map: MapDocument): string {
  return content
    .replace(/^# .*$/m, () => `# ${map.title.replace(/\n/g, " ")}`)
    .replace(/```agent-map\s*\n[\s\S]*?\n```/, () => `\`\`\`agent-map\n${JSON.stringify(map, null, 2)}\n\`\`\``);
}
/** Node id, x and y of every node, sorted by id: the part of a Map.md that a drag or a layout changes (viewport left out). */
export function coordinatePrint(map: MapDocument): string {
  const nodes = [...map.nodes].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return JSON.stringify(nodes.map(node => [node.id, node.x, node.y]));
}
