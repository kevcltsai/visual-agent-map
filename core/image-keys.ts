import { fencedLines } from "../ai/markdown-blocks";

/**
 * The identity of an image link, so the same picture written twice is recognised. On upload.wikimedia.org a thumbnail
 * (`/thumb/<a>/<ab>/<File>/<N>px-<File>`) and its original (`/<a>/<ab>/<File>`) are one image: the key is the project
 * (`commons`, `en`, ...) and the URL-decoded file name. commons.wikimedia.org `Special:FilePath/<File>` is the same file of
 * `commons`. Any other link is the same image only when the strings are equal once surrounding `<>` are stripped.
 */
export function imageKey(url: string): string {
  const link = url.trim().replace(/^<(.*)>$/, "$1");
  const upload =
    /^https?:\/\/upload\.wikimedia\.org\/wikipedia\/([^/]+)\/(?:thumb\/[0-9a-f]\/[0-9a-f]{2}\/([^/?#]+)\/\d+px-[^/?#]+|[0-9a-f]\/[0-9a-f]{2}\/([^/?#]+))(?:[?#].*)?$/i.exec(
      link
    );
  if (upload) return wikimediaKey(upload[1], upload[2] ?? upload[3]);
  const filePath = /^https?:\/\/commons\.wikimedia\.org\/wiki\/Special:FilePath\/([^/?#]+)(?:[?#].*)?$/i.exec(link);
  if (filePath) return wikimediaKey("commons", filePath[1]);
  return link;
}

function wikimediaKey(project: string, file: string): string {
  let name = file;
  try {
    name = decodeURIComponent(file);
  } catch {
    /* A malformed escape stays as written. */
  }
  return `wikimedia:${project.toLowerCase()}:${name.replace(/ /g, "_")}`;
}

const EMBED = /!\[[^\]\n]*\]\((<[^>\n]+>|[^)\s]+)(?:\s+"[^"\n]*")?\)/g;
/** A line that is one image embed and nothing else (a callout's `>` prefix allowed). */
const EMBED_LINE = /^\s*(?:>\s*)*!\[[^\]\n]*\]\((<[^>\n]+>|[^)\s]+)(?:\s+"[^"\n]*")?\)\s*$/;
/** A note's Preview section (its callout does not count as an image the note already has). */
const PREVIEW_SECTION = /^##\s+(?:Preview|預覽|预览)\s*$/;

/** Lines of the leading YAML frontmatter, opening and closing `---` included. */
function frontmatterMarks(lines: string[]): boolean[] {
  const marks = lines.map(() => false);
  if (!/^---\s*$/.test(lines[0] ?? "")) return marks;
  const end = lines.findIndex((line, index) => index > 0 && /^(?:---|\.\.\.)\s*$/.test(line));
  for (let index = 0; end > 0 && index <= end; index++) marks[index] = true;
  return marks;
}

/** Lines inside a `## Preview` section of a whole note file. */
function previewMarks(lines: string[], code: boolean[]): boolean[] {
  let inside = false;
  return lines.map((line, index) => {
    if (!code[index] && /^#{1,2}\s/.test(line)) inside = PREVIEW_SECTION.test(line);
    return inside;
  });
}

interface ScanOptions {
  /** The text is a whole file: frontmatter and the Preview section are not image content. */
  file?: boolean;
}

/** The image keys of every embed in `markdown` outside fences (and, for a whole file, outside frontmatter and Preview). */
export function imageKeysIn(markdown: string, options: ScanOptions = {}): Set<string> {
  const lines = markdown.split("\n");
  const code = fencedLines(lines);
  const front = options.file ? frontmatterMarks(lines) : lines.map(() => false);
  const preview = options.file ? previewMarks(lines, code) : lines.map(() => false);
  const keys = new Set<string>();
  lines.forEach((line, index) => {
    if (code[index] || front[index] || preview[index]) return;
    for (const match of line.matchAll(EMBED)) keys.add(imageKey(match[1]));
  });
  return keys;
}

/**
 * New content only: drops an image embed line whose image is already in `seen` (content that survives the write) or
 * earlier in the new content. Text lines (titles, source links) stay; a blank line left doubled by a drop is removed.
 * Fence content is never changed. With `range`, only lines starting inside [start, end) are new: the others are the
 * surviving content and their images count as seen. `file` reads frontmatter and Preview as no image content.
 */
export function dedupeImageEmbeds(
  markdown: string,
  options: ScanOptions & { seen?: Iterable<string>; range?: { start: number; end: number } } = {}
): string {
  const lines = markdown.split("\n");
  const code = fencedLines(lines);
  const front = options.file ? frontmatterMarks(lines) : lines.map(() => false);
  const preview = options.file ? previewMarks(lines, code) : lines.map(() => false);
  const starts: number[] = [];
  let offset = 0;
  for (const line of lines) {
    starts.push(offset);
    offset += line.length + 1;
  }
  const isNew = (index: number): boolean =>
    !options.range || (starts[index] >= options.range.start && starts[index] < options.range.end);
  const seen = new Set(options.seen ?? []);
  const content = (index: number): boolean => !code[index] && !front[index] && !preview[index];
  if (options.range)
    lines.forEach((line, index) => {
      if (isNew(index) || !content(index)) return;
      for (const match of line.matchAll(EMBED)) seen.add(imageKey(match[1]));
    });
  const out: string[] = [];
  let dropped = false;
  lines.forEach((line, index) => {
    if (dropped && !line.trim() && (out.length === 0 || !out[out.length - 1].trim()) && isNew(index)) {
      dropped = false;
      return;
    }
    dropped = false;
    if (!isNew(index) || !content(index)) return void out.push(line);
    const embed = EMBED_LINE.exec(line);
    if (embed) {
      const key = imageKey(embed[1]);
      if (seen.has(key)) {
        dropped = true;
        return;
      }
      seen.add(key);
      return void out.push(line);
    }
    for (const match of line.matchAll(EMBED)) seen.add(imageKey(match[1]));
    out.push(line);
  });
  return out.join("\n");
}
