import { parseYaml } from "obsidian";
import type { RenamePair } from "./rename-batch";

/** Whether `content` has a wiki or markdown link that points at the file a pair moved away from. */
export function linksToRenamed(content: string, pairs: readonly RenamePair[]): boolean {
  const targets: string[] = [];
  for (const m of content.matchAll(/!?\[\[([^\]|#^]+)/g)) targets.push(m[1]);
  for (const m of content.matchAll(/\]\(<?([^)#>]+)/g)) {
    try {
      targets.push(decodeURIComponent(m[1]));
    } catch {
      targets.push(m[1]);
    }
  }
  const bare = (path: string): string =>
    path
      .trim()
      .replace(/^\.?\//, "")
      .replace(/\.md$/i, "");
  return pairs.some(([from, to]) => {
    if (from === to) return false;
    const old = bare(from);
    return targets.some(target => {
      const t = bare(target);
      return t === old || old.endsWith(`/${t}`);
    });
  });
}

/** Splits a frontmatter block into its top-level key blocks (the key line and the lines indented under it). */
function yamlBlocks(yaml: string): { key: string | undefined; text: string }[] {
  const blocks: { key: string | undefined; text: string }[] = [];
  for (const line of yaml.split("\n")) {
    const key = /^(?:([A-Za-z][\w-]*)|"([A-Za-z][\w-]*)"|'([A-Za-z][\w-]*)')\s*:/.exec(line);
    const name = key ? (key[1] ?? key[2] ?? key[3]) : undefined;
    if (name || !blocks.length) blocks.push({ key: name, text: line });
    else blocks[blocks.length - 1].text += `\n${line}`;
  }
  return blocks;
}

/**
 * `rewritten` is a re-serialised frontmatter; every top-level key whose value is unchanged from the frontmatter of
 * `original` keeps the original lines, so quoting and layout survive a write that did not touch the key.
 */
export function keepFrontmatterFormatting(original: string, rewritten: string): string {
  const head = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(original);
  if (!head || head[1].includes("\r")) return rewritten;
  const before = new Map<string, string>();
  for (const block of yamlBlocks(head[1])) if (block.key && !before.has(block.key)) before.set(block.key, block.text);
  const same = (a: string, b: string): boolean => {
    try {
      return JSON.stringify(parseYaml(a)) === JSON.stringify(parseYaml(b));
    } catch {
      return false;
    }
  };
  const trailing = rewritten.endsWith("\n");
  const out = yamlBlocks(trailing ? rewritten.slice(0, -1) : rewritten).map(block => {
    const old = block.key ? before.get(block.key) : undefined;
    return old !== undefined && old !== block.text && same(old, block.text) ? old : block.text;
  });
  return out.join("\n") + (trailing ? "\n" : "");
}
