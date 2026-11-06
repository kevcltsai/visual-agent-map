/**
 * Mermaid blocks in a model-written detail are rendered by Obsidian, so the prompt's limits are enforced here too:
 * only flowchart/graph or a type in DIAGRAM_TYPES, with text labels. `demoteUnparsableMermaid` then asks the runtime
 * parser (Obsidian's `loadMermaid`, Mermaid or Pele depending on the version) about each remaining block. A block that breaks a limit (click, link,
 * callback or cssClass directives, HTML tags, init/config, URLs, images, icons, styles, sequence actor menus,
 * mindmap icons, C4 links/sprites/tags/styling, quadrant point styling) keeps its text but loses the `mermaid` info
 * string, so Obsidian shows it as plain code and never renders it. An unknown header is neutralized too; so is a
 * block the parser rejects (a syntax error would otherwise show as red error text in the note).
 */
/** Diagram types the mermaid in Obsidian 1.14.4 (11.13.0) detects and draws offline; checked against the bundle 2026-10-19. Obsidian 1.15 ships Pele instead; the runtime parser check is what guards syntax there. */
export const DIAGRAM_TYPES: readonly string[] = [
  "sequenceDiagram",
  "classDiagram",
  "classDiagram-v2",
  "stateDiagram",
  "stateDiagram-v2",
  "erDiagram",
  "journey",
  "gantt",
  "pie",
  "quadrantChart",
  "requirementDiagram",
  "gitGraph",
  "C4Context",
  "C4Container",
  "C4Component",
  "C4Dynamic",
  "C4Deployment",
  "mindmap",
  "timeline",
  "sankey-beta",
  "xychart-beta",
  "block-beta",
  "packet-beta",
  "kanban",
  "architecture-beta",
  "radar-beta",
  "treemap-beta",
  "venn-beta",
  "ishikawa",
  "ishikawa-beta"
];
const FLOWCHART_HEADER = /^(?:flowchart|graph)(?:\s+(?:LR|RL|TD|TB|BT))?\s*;?\s*$/i;
const TYPE_HEADER = new RegExp(`^(?:${DIAGRAM_TYPES.map(t => t.replace(/[-]/g, "\\-")).join("|")})(?![\\w-])`);
const allowedHeader = (header: string): boolean => FLOWCHART_HEADER.test(header) || TYPE_HEADER.test(header);
const UNSAFE_LINE: readonly RegExp[] = [
  // A directive starts a line or follows a `;` statement separator.
  /(?:^|;)\s*(?:click|call|href|link|links|style|classDef|class|linkStyle|interpolate)\b/i,
  /%%\s*\{/, // init or config directive
  /<\s*\/?\s*[a-z!?]/i, // HTML tag, comment or processing instruction
  /\b[a-z][a-z0-9+.-]*:\/\//i, // URL with a scheme
  /\b(?:javascript|vbscript|data|mailto|file):/i,
  /\bwww\./i,
  /:::/, // class shorthand
  /@\{/, // shape/image/icon metadata
  /\b(?:fa|fab|fas|far|img):/i,
  /!\[/, // Markdown image
  /(?:^|;)\s*(?:callback|cssClass)\b/i, // class diagram callbacks and CSS classes
  /(?:^|;)\s*(?:properties|details)\b[^:]*:/i, // sequence actor menus (they carry links)
  /::icon\s*\(/i, // mindmap icon (Font Awesome is not loaded in Obsidian)
  /\$(?:link|sprite|tags)\b/i, // C4 links, sprites and tags
  /\b(?:Update(?:Element|Rel|Boundary)Style|UpdateLayoutConfig|Add(?:Element|Rel|Boundary)Tag)\s*\(/, // C4 styling
  /\]\s*(?:radius|color|stroke-color|stroke-width)\s*:/i // quadrantChart point styling
];

/** A classDiagram annotation such as `<<interface>>`, `<<abstract>>` or `<<Service>>`; letters, digits and `_` only. */
const CLASS_ANNOTATION = /<<[A-Za-z][A-Za-z0-9_]*>>/g;

/**
 * A classDiagram class declaration: `class Name`, `class Name~T~`, each optionally followed by `{` or `["label"]`.
 * Only the `class Name~T~` prefix is exempt from the `class` directive rule, and only when nothing else but that
 * optional `{` or label follows (so `class A foo`, a cssClass directive, stays unsafe); the label is still checked.
 */
const CLASS_DECLARATION = /^class\s+[A-Za-z_][A-Za-z0-9_-]*(?:~[A-Za-z0-9_, ]*~)?(?=\s*(?:\{|\["[^"\]]*"\])?\s*$)/;

const FENCE = /^(`{3,}|~{3,})(.*)$/;
/** One layer of line prefix: indentation, a blockquote marker, or a list/task marker. */
const PREFIX = /^(?:[ \t]+|>|(?:[-*+]|\d+[.)])(?=[ \t])|\[[ xX]\](?=[ \t]))/;

/** The line without any mix of indentation, blockquote (callout) and list or task markers, in any order. */
function core(line: string): string {
  let rest = line;
  for (let match = PREFIX.exec(rest); match; match = PREFIX.exec(rest)) rest = rest.slice(match[0].length);
  return rest;
}

/** The fence on this line, or null. A backtick fence's info string cannot contain a backtick. */
function fenceOf(line: string): RegExpExecArray | null {
  const fence = FENCE.exec(core(line));
  return fence && !(fence[1][0] === "`" && fence[2].includes("`")) ? fence : null;
}

export function unsafeMermaid(body: readonly string[]): boolean {
  const lines = body.map(line => line.trim()).filter(Boolean);
  if (!lines.length) return false;
  // A leading `---` block is Mermaid front-matter configuration.
  if (lines[0] === "---") return true;
  const header = lines.find(line => !line.startsWith("%%"));
  if (!header || !allowedHeader(header)) return true;
  // Only a classDiagram annotation (`<<interface>>`) and class declaration are exempt from the HTML-tag rule: the exact token `<<word>>` is
  // swapped for a space before testing, so any other `<` (also one left behind or joined by the swap) is still checked.
  const classDiagram = /^classDiagram(?:-v2)?(?![\w-])/.test(header);
  return lines.some(line => {
    const text = classDiagram ? line.replace(CLASS_ANNOTATION, " ").replace(CLASS_DECLARATION, "C") : line;
    return UNSAFE_LINE.some(pattern => pattern.test(text));
  });
}

/**
 * Turns every unsafe mermaid block (also inside callouts and lists) into a plain code block; everything else is
 * unchanged. Each mermaid opening is checked on its own, from the line after it to the first line that could close
 * it (or the end), whatever any other fence looks like. A block whose list or quote ends early is then checked with
 * the text after it, so a misread boundary only blocks more, never lets an unsafe block through. A mermaid fence
 * quoted inside another code block is checked as well, which only changes text that is never rendered.
 */
export function neutralizeUnsafeMermaid(markdown: string): string {
  // CRLF and a lone CR are line breaks to the renderer too; split on all of them so no fence, header or directive hides.
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  lines.forEach((line, index) => {
    const fence = fenceOf(line);
    if (!fence || !/^mermaid\b/i.test(fence[2].trim())) return;
    const body: string[] = [];
    for (let next = index + 1; next < lines.length; next++) {
      const content = core(lines[next]);
      const close = FENCE.exec(content);
      if (close && close[1][0] === fence[1][0] && close[1].length >= fence[1].length && !close[2].trim()) break;
      body.push(content);
    }
    if (unsafeMermaid(body)) lines[index] = line.replace(/mermaid/i, "text");
  });
  return lines.join("\n");
}

/** `ok` parses; `invalid` is a real syntax failure; `unavailable` means no parser could be used (nothing is known about the block). */
export type MermaidVerdict = "ok" | "invalid" | "unavailable";
export type MermaidSyntaxCheck = (code: string) => Promise<MermaidVerdict>;

/** The smallest diagram every Mermaid-compatible engine accepts; used to tell a syntax error from a broken parser. */
const KNOWN_GOOD = "flowchart TD\n  A --> B";

/**
 * A syntax check on top of the parser that `load` returns (Obsidian's `loadMermaid`; the engine is not assumed).
 * A load failure or a parser without `parse` is `unavailable`. When `parse` rejects, a known-good diagram is parsed
 * once more: if that is rejected too, the parser itself is broken (`unavailable`, logged); otherwise the block is `invalid`.
 * The probe runs on every rejection, so a transient failure is never remembered.
 */
export function mermaidSyntaxCheck(load: () => Promise<unknown>): MermaidSyntaxCheck {
  return async code => {
    let parse: (text: string) => Promise<unknown>;
    try {
      const engine = (await load()) as { parse?: unknown } | null | undefined;
      if (!engine || typeof engine.parse !== "function") return "unavailable";
      const method = engine.parse as (this: unknown, text: string) => Promise<unknown>;
      parse = async text => (await method.call(engine, text)) as unknown;
    } catch {
      return "unavailable";
    }
    try {
      await parse(code);
      return "ok";
    } catch (error) {
      try {
        await parse(KNOWN_GOOD);
      } catch {
        console.warn(
          `Visual Agent Map: the Mermaid parser rejects a valid diagram, so it is treated as unavailable: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
        return "unavailable";
      }
      return "invalid";
    }
  };
}

/**
 * Turns each mermaid block the parser rejects into a plain `text` block (only its info string changes; every other
 * character, line break and block stays). The code handed to the parser has the callout, quote and list prefixes removed.
 * When the parser cannot be used the markdown is returned as it is and one log line is written; no block is demoted.
 */
export async function demoteUnparsableMermaid(
  markdown: string,
  check: MermaidSyntaxCheck | undefined
): Promise<string> {
  if (!check || !/mermaid/i.test(markdown)) return markdown;
  // Keep every line break as it is: split with the separators kept, and work on the text parts only.
  const parts = markdown.split(/(\r\n?|\n)/);
  const at = (line: number): number => line * 2;
  const count = Math.ceil(parts.length / 2);
  const demote: number[] = [];
  // The fence of the code block the scan is inside (not mermaid): a mermaid fence quoted in it is text, never a diagram.
  let outer: RegExpExecArray | null = null;
  for (let index = 0; index < count; index++) {
    const fence = fenceOf(parts[at(index)]);
    if (outer) {
      if (fence && fence[1][0] === outer[1][0] && fence[1].length >= outer[1].length && !fence[2].trim()) outer = null;
      continue;
    }
    if (!fence) continue;
    if (!/^mermaid\b/i.test(fence[2].trim())) {
      outer = fence;
      continue;
    }
    // The fence line's own prefix (indentation, "> ", list marker) is taken off every body line, so relative
    // indentation (mindmap, kanban) reaches the parser intact; a line without that prefix (lazy quote line) falls back to core().
    const opening = parts[at(index)];
    const prefix = opening.slice(0, opening.length - core(opening).length);
    // A list marker is continued by spaces of the same width.
    const continued = prefix.replace(/(?:[-*+]|\d+[.)])(?=[ \t])|\[[ xX]\](?=[ \t])/g, marker =>
      " ".repeat(marker.length)
    );
    const body: string[] = [];
    let next = index + 1;
    for (; next < count; next++) {
      const raw = parts[at(next)];
      const content = core(raw);
      const close = FENCE.exec(content);
      if (close && close[1][0] === fence[1][0] && close[1].length >= fence[1].length && !close[2].trim()) break;
      body.push(
        raw.startsWith(prefix)
          ? raw.slice(prefix.length)
          : raw.startsWith(continued)
            ? raw.slice(continued.length)
            : content
      );
    }
    // The scan resumes after this block's closing fence, so that fence is not read as the opening of another block.
    const opened = index;
    index = next;
    if (!body.some(line => line.trim())) continue;
    const verdict = await check(body.join("\n"));
    if (verdict === "unavailable") {
      console.warn("Visual Agent Map: the Mermaid parser is unavailable; diagrams were not syntax-checked.");
      return markdown;
    }
    if (verdict === "invalid") demote.push(opened);
  }
  if (!demote.length) return markdown;
  for (const index of demote) parts[at(index)] = parts[at(index)].replace(/mermaid/i, "text");
  return parts.join("");
}

/** A mermaid block of a note: `unsafe` by the allow-list; `code` is what the parser gets (null when the block is only a quoted example inside another code block, which is never rendered). */
export interface MermaidBlock {
  unsafe: boolean;
  code: string | null;
}

/** Every mermaid block of the text, read the way `neutralizeUnsafeMermaid` (allow-list) and `demoteUnparsableMermaid` (parser code) read them. Line breaks are normalized to LF first. */
function mermaidBlocks(markdown: string): Array<MermaidBlock & { key: string }> {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  // Parser code per opening line, with the same scan and prefix removal as demoteUnparsableMermaid.
  const codes = new Map<number, string>();
  let outer: RegExpExecArray | null = null;
  for (let index = 0; index < lines.length; index++) {
    const fence = fenceOf(lines[index]);
    if (outer) {
      if (fence && fence[1][0] === outer[1][0] && fence[1].length >= outer[1].length && !fence[2].trim()) outer = null;
      continue;
    }
    if (!fence) continue;
    if (!/^mermaid\b/i.test(fence[2].trim())) {
      outer = fence;
      continue;
    }
    const opening = lines[index];
    const prefix = opening.slice(0, opening.length - core(opening).length);
    const continued = prefix.replace(/(?:[-*+]|\d+[.)])(?=[ \t])|\[[ xX]\](?=[ \t])/g, marker =>
      " ".repeat(marker.length)
    );
    const body: string[] = [];
    let next = index + 1;
    for (; next < lines.length; next++) {
      const raw = lines[next];
      const content = core(raw);
      const close = FENCE.exec(content);
      if (close && close[1][0] === fence[1][0] && close[1].length >= fence[1].length && !close[2].trim()) break;
      body.push(
        raw.startsWith(prefix)
          ? raw.slice(prefix.length)
          : raw.startsWith(continued)
            ? raw.slice(continued.length)
            : content
      );
    }
    codes.set(index, body.join("\n"));
    index = next;
  }
  const blocks: Array<MermaidBlock & { key: string }> = [];
  lines.forEach((line, index) => {
    const fence = fenceOf(line);
    if (!fence || !/^mermaid\b/i.test(fence[2].trim())) return;
    const body: string[] = [];
    for (let next = index + 1; next < lines.length; next++) {
      const content = core(lines[next]);
      const close = FENCE.exec(content);
      if (close && close[1][0] === fence[1][0] && close[1].length >= fence[1].length && !close[2].trim()) break;
      body.push(content);
    }
    const code = codes.get(index) ?? null;
    blocks.push({ unsafe: unsafeMermaid(body), code, key: `${body.join("\n")}\u0000${code ?? "\u0001"}` });
  });
  return blocks;
}

/**
 * The mermaid blocks `after` has beyond those of `before` (a multiset difference, so a second copy of a block the note
 * already had counts as added). Blocks the note already had are never returned, whatever they look like.
 */
export function addedMermaidBlocks(before: string, after: string): MermaidBlock[] {
  const had = new Map<string, number>();
  for (const block of mermaidBlocks(before)) had.set(block.key, (had.get(block.key) ?? 0) + 1);
  const added: MermaidBlock[] = [];
  for (const { key, unsafe, code } of mermaidBlocks(after)) {
    const left = had.get(key) ?? 0;
    if (left > 0) had.set(key, left - 1);
    else added.push({ unsafe, code });
  }
  return added;
}
