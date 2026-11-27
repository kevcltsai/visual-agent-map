import { livingMarkerState } from "./living-node-region";
import type { RenamePair } from "./rename-batch";

const WINDOW_MS = 10 * 60 * 1000;
const MAX_LENGTH = 400_000;
const REFERENCES_START = "visual-agent-map:references:start";
const REFERENCES_END = "visual-agent-map:references:end";

/** The Living Node markers are paired (or absent) and the references block markers come as a start and an end. */
export function structureIsHealthy(content: string): boolean {
  if (livingMarkerState(content) === "corrupt") return false;
  const count = (needle: string): number => content.split(needle).length - 1;
  return count(REFERENCES_START) === count(REFERENCES_END);
}

const MARKER = /<!-- (?:visual-agent-map|vam-living-node):[^>]*-->/g;

/** Whether `after` has fewer of some VAM marker comment (Living Node, references, detail ...) than `before`. */
export function markersLost(before: string, after: string): boolean {
  const counts = (text: string): Map<string, number> => {
    const map = new Map<string, number>();
    for (const [marker] of text.matchAll(MARKER)) map.set(marker, (map.get(marker) ?? 0) + 1);
    return map;
  };
  const kept = counts(after);
  for (const [marker, count] of counts(before)) if ((kept.get(marker) ?? 0) < count) return true;
  return !structureIsHealthy(after) && structureIsHealthy(before);
}

const bare = (path: string): string =>
  path
    .trim()
    .replace(/^\.?\//, "")
    .replace(/\.md$/i, "");

/** The length of the link text Obsidian's updater writes at `at` for a note now at one of `targets`, or 0. */
function linkLength(text: string, at: number, targets: readonly string[]): number {
  const wiki = /!?\[\[([^\]|#^\n]+)(?:[#^|][^\]\n]*)?\]\]/y;
  const markdown = /!?\[[^\]\n]*\]\(<?([^)#>\n]+)(?:#[^)\n]*)?>?\)/y;
  for (const [pattern, decode] of [
    [wiki, false],
    [markdown, true]
  ] as const) {
    pattern.lastIndex = at;
    const match = pattern.exec(text);
    if (!match) continue;
    let target = match[1];
    if (decode) {
      try {
        target = decodeURIComponent(target);
      } catch {
        /* keep the text as written */
      }
    }
    const found = bare(target);
    if (targets.some(to => to === found || to.endsWith(`/${found}`))) return match[0].length;
  }
  return 0;
}

/**
 * Whether `after` is `before` with one or more stretches replaced by link texts that point at a renamed note, and
 * nothing else changed: exactly what Obsidian's updater does with positions taken before `before` was written.
 */
export function isStaleLinkWrite(before: string, after: string, pairs: readonly RenamePair[]): boolean {
  if (before === after || before.length > MAX_LENGTH || after.length > MAX_LENGTH) return false;
  const targets = pairs.map(([, to]) => bare(to));
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  )
    suffix++;
  const a = before.slice(prefix, before.length - suffix);
  const b = after.slice(prefix, after.length - suffix);
  const seen = new Set<string>();
  // a[i..] must become b[j..]: copy equal text, or swap some stretch of `a` for a link text in `b`.
  const walk = (start: number, from: number): boolean => {
    let i = start,
      j = from;
    for (;;) {
      if (j === b.length) return i === a.length;
      const key = `${i}:${j}`;
      if (seen.has(key)) return false;
      const length = linkLength(b, j, targets);
      if (length) {
        seen.add(key);
        for (let next = i; next <= a.length; next++) if (walk(next, j + length)) return true;
      }
      if (i < a.length && a[i] === b[j]) {
        i++;
        j++;
      } else return false;
    }
  };
  return walk(0, 0);
}

/**
 * Remembers what VAM wrote into a note when it followed a rename. If the note's next modification is exactly an
 * Obsidian link update applied at stale positions that broke the note's structure, VAM's version is put back; any other
 * change ends the watch. A harmless stale write becomes the new baseline.
 */
export class RenameRepairWatch {
  private readonly watched = new Map<string, { content: string; pairs: RenamePair[]; at: number }>();

  constructor(
    private readonly io: {
      read(path: string): Promise<string>;
      process(path: string, change: (content: string) => string): Promise<unknown>;
    },
    private readonly now: () => number = Date.now
  ) {}

  remember(path: string, content: string, pairs: readonly RenamePair[]): void {
    if (!structureIsHealthy(content)) {
      this.watched.delete(path);
      return;
    }
    this.watched.set(path, { content, pairs: [...pairs], at: this.now() });
  }

  watching(path: string): boolean {
    return this.watched.has(path);
  }

  async check(path: string, log: (line: string) => void): Promise<void> {
    const watch = this.watched.get(path);
    if (!watch) return;
    if (this.now() - watch.at > WINDOW_MS) return void this.watched.delete(path);
    const current = await this.io.read(path);
    if (current === watch.content) return;
    if (!isStaleLinkWrite(watch.content, current, watch.pairs)) return void this.watched.delete(path);
    if (!markersLost(watch.content, current)) {
      watch.content = current;
      return;
    }
    let restored = false;
    await this.io.process(path, text => {
      if (text !== current) return text;
      restored = true;
      return watch.content;
    });
    if (restored) log(`rename_stale_link_write_repaired path=${path}`);
    else this.watched.delete(path);
  }
}
