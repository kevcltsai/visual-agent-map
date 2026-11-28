import { App, TFile } from "obsidian";
import { tNote } from "../i18n";
import { contentHash } from "../core/content-hash";
import { fencedLines, sourceFootnoteDefinition } from "./result-utils";
import { sourcesHeadingKeys, standardTemplate, type DetailTemplate } from "./detail-templates";

export interface ReferenceDocument {
  path: string;
  content: string;
  external?: boolean;
  key?: string;
  /** The VAM note's `node-id`; read from the content's frontmatter when not given. A non-VAM note has none. */
  nodeId?: string;
  /** {@link sourceRevision} of the content; computed when not given. */
  rev?: string;
}
/** The key that tells whether the documents a task was given changed: what the model sees, without the citation identity (`nodeId`, `rev`). */
export function documentsSnapshot(documents: ReferenceDocument[]): string {
  return JSON.stringify(
    documents.map(document => {
      const { nodeId, rev, ...rest } = document;
      return rest;
    })
  );
}
export interface ReferenceGroup {
  id: string;
  name: string;
  location: string;
  documents: ReferenceDocument[];
}

export async function readMarkdownFile(app: App, file: TFile): Promise<ReferenceDocument> {
  if (file.extension.toLowerCase() !== "md")
    throw new Error(`Only Markdown can be used as local reference: ${file.path}`);
  return { path: file.path, content: await app.vault.read(file) };
}

export function dedupeReferenceGroups(groups: ReferenceGroup[]): ReferenceGroup[] {
  const seen = new Set<string>();
  return groups.map(group => ({
    ...group,
    documents: group.documents.filter(document => {
      const key = document.key || document.path;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
  }));
}

/** One document is split into parts above this many characters. */
export const REFERENCE_DOCUMENT_CHARACTER_LIMIT = 150_000;
/** Sources that fit one batch (characters) go to the model as written; chinese text is about 1 token per character. */
export const REFERENCE_BATCH_CHARACTER_LIMIT = 160_000;

export function packReferenceChunks(chunks: string[], characterLimit = REFERENCE_BATCH_CHARACTER_LIMIT): string[] {
  const batches: string[] = [];
  let batch = "";
  for (const chunk of chunks) {
    if (batch && batch.length + chunk.length > characterLimit) {
      batches.push(batch);
      batch = "";
    }
    batch += `${batch ? "\n\n" : ""}${chunk}`;
  }
  if (batch) batches.push(batch);
  return batches;
}

export function referenceBatches(
  groups: ReferenceGroup[],
  documentLimit = REFERENCE_DOCUMENT_CHARACTER_LIMIT,
  batchLimit = REFERENCE_BATCH_CHARACTER_LIMIT
): string[] {
  const chunks: string[] = [];
  let sourceNumber = 0;
  for (const group of dedupeReferenceGroups(groups))
    for (const document of group.documents) {
      sourceNumber++;
      const id = `S${sourceNumber}`;
      const citation = document.external
        ? "external Markdown; cite the exact path as plain text"
        : "Vault Markdown; cite as an Obsidian wikilink";
      const pieces = document.content.match(new RegExp(`[\\s\\S]{1,${documentLimit}}`, "g")) ?? [""];
      pieces.forEach((piece, index) =>
        chunks.push(
          `[${id}] ${citation}: ${document.path}${pieces.length > 1 ? ` (part ${index + 1}/${pieces.length})` : ""}\n${piece}`
        )
      );
    }
  return packReferenceChunks(chunks, batchLimit);
}

export function referenceCatalog(groups: ReferenceGroup[]): string {
  const documents = dedupeReferenceGroups(groups).flatMap(group => group.documents);
  return documents
    .map(
      (document, index) =>
        `[S${index + 1}] ${document.external ? "External file (plain path)" : "Vault note (wikilink)"}: ${document.path}`
    )
    .join("\n");
}

/** A resolver is scoped to one transformation, so detail lines reuse the same lookup without retaining documents across calls. */
function createWikilinkResolver(documents: ReferenceDocument[]): (text: string) => string {
  type Lookup = Map<string, ReferenceDocument | null>;
  let index: { exact: Lookup; basename: Lookup } | undefined;
  let first = true;
  const add = (map: Lookup, key: string, document: ReferenceDocument): void => {
    map.set(key, map.has(key) ? null : document);
  };
  const build = (): { exact: Lookup; basename: Lookup } => {
    const exact: Lookup = new Map();
    const basename: Lookup = new Map();
    for (const document of documents) {
      add(exact, document.path, document);
      const name = document.path.split("/").pop() ?? document.path;
      const stem = name.replace(/\.md$/i, "");
      add(basename, name, document);
      if (stem !== name) add(basename, stem, document);
    }
    return { exact, basename };
  };
  const find = (name: string): ReferenceDocument | null | undefined => {
    // A single link does not pay the cost of indexing every document.
    if (first) {
      first = false;
      const exact = documents.filter(document => document.path === name);
      const matches = exact.length
        ? exact
        : documents.filter(document => {
            const basename = document.path.split("/").pop() ?? document.path;
            return basename === name || basename.replace(/\.md$/i, "") === name;
          });
      return matches.length > 1 ? null : matches[0];
    }
    index ??= build();
    return index.exact.has(name) ? index.exact.get(name) : index.basename.get(name);
  };
  return text =>
    text.replace(/\[\[([^\]]+)\]\]/g, (original, target: string) => {
      const name = target.split("|")[0].trim();
      const document = find(name);
      if (document === null) return tNote("note.source_unconfirmed_0", name);
      if (!document?.external) return original;
      return tNote("note.external_source_0", document.path);
    });
}

/** Stable short footnote label for a source path (same path => same label across runs). */
export function sourceFootnoteLabel(path: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < path.length; index++) {
    hash ^= path.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `src-${hash.toString(36).padStart(7, "0")}`;
}

/** An external document and a vault note can share a path text (`docs/x.md`); the label tells them apart. */
function documentFootnoteLabel(document: ReferenceDocument): string {
  return sourceFootnoteLabel(document.external ? `external:${document.path}` : document.path);
}

/** Summary shows on map cards: drop `[S#]` marker runs (with their separators and brackets), keep other link handling. */
export function resolveSummaryReferences(summary: string, groups: ReferenceGroup[]): string {
  const documents = dedupeReferenceGroups(groups).flatMap(group => group.documents);
  // Remove whole runs of markers ("[S1]、[S2]", "（[S1], [S2]）") and nothing else, so ordinary text is untouched.
  const run = String.raw`\[S\d+\](?:\s*[,，、;；]?\s*\[S\d+\])*`;
  const stripped = summary
    .replace(new RegExp(String.raw`[ \t]*[（(]\s*${run}\s*[）)]`, "g"), "")
    .replace(new RegExp(String.raw`[ \t]*${run}`, "g"), "")
    .trim();
  return createWikilinkResolver(documents)(stripped);
}

const FOOTNOTE_REFERENCE = /\[\^([^\]\s]+)\](?!\()/g;
const FRONTMATTER = /^---\n([\s\S]*?)\n---(?:\n|$)/;

/**
 * A source's revision: the last 8 hex digits of {@link contentHash} over its body, where the body is the content with
 * CRLF and CR turned into LF, the leading `---` frontmatter block removed and trailing whitespace trimmed. Frontmatter
 * edits and line-ending changes keep the revision; any other text change gives a new one.
 */
export function sourceRevision(content: string): string {
  return contentHash(content.replace(/\r\n?/g, "\n").replace(FRONTMATTER, "").trimEnd()).slice(-8);
}

/** The `node-id` in a VAM note's frontmatter, when it is a plain id (letters, digits, `_`, `-`). */
export function sourceNodeId(content: string): string | undefined {
  const yaml = FRONTMATTER.exec(content.replace(/\r\n?/g, "\n"))?.[1];
  return yaml ? /^node-id:[ \t]*(["']?)([A-Za-z0-9_][A-Za-z0-9_-]*)\1[ \t]*$/m.exec(yaml)?.[2] : undefined;
}

const revisions = new WeakMap<ReferenceDocument, string>();
function documentRevision(document: ReferenceDocument): string {
  if (document.rev) return document.rev;
  let rev = revisions.get(document);
  if (!rev) revisions.set(document, (rev = sourceRevision(document.content)));
  return rev;
}

function documentNodeId(document: ReferenceDocument): string | undefined {
  const id = document.nodeId ?? sourceNodeId(document.content);
  return id && /^[A-Za-z0-9_][A-Za-z0-9_-]*$/.test(id) ? id : undefined;
}

function footnoteTarget(document: ReferenceDocument): string {
  const basename = (document.path.split("/").pop() ?? document.path).replace(/\.md$/i, "");
  if (document.external) return tNote("note.external_source_0", document.path);
  // An Obsidian comment: older versions keep it as plain footnote text and the reading view hides it.
  return `[[${document.path}|${basename}]]%%vam-src:${documentNodeId(document) ?? "-"}:${documentRevision(document)}%%`;
}

export type CitationStatus = "same" | "changed" | "missing" | "relocated";

/**
 * A source footnote's target against the current documents: `same` when the linked path is there with the cited
 * revision (or the target names no revision), `changed` when its text changed since, `relocated` when the path is gone
 * but a note with the cited node id is there (renamed or moved), `missing` otherwise. Only an exact path matches, so
 * a namesake at another path is never taken for the source. Null when the target is not a source wikilink.
 */
export function compareCitation(
  target: string,
  documents: ReferenceDocument[]
): { status: CitationStatus; document?: ReferenceDocument } | null {
  const match = /^\[\[([^\]|#]+)[^\]]*\]\](?:%%vam-src:([A-Za-z0-9_-]+):([0-9a-f]{8})%%)?$/.exec(target.trim());
  if (!match) return null;
  const path = match[1].trim();
  const [, , nodeId, rev] = match;
  const vault = documents.filter(document => !document.external);
  const atPath = vault.find(document => document.path === path || document.path === `${path}.md`);
  if (atPath) return { status: rev && documentRevision(atPath) !== rev ? "changed" : "same", document: atPath };
  const moved = nodeId && nodeId !== "-" ? vault.find(document => documentNodeId(document) === nodeId) : undefined;
  return moved ? { status: "relocated", document: moved } : { status: "missing" };
}

/** Same note => same key, whether or not the wikilink carries a display name. */
function targetKey(target: string): string {
  const link = /^\[\[([^\]|]+)/.exec(target);
  return link ? link[1].trim().replace(/\.md$/i, "") : target;
}

/** Applies `edit` to the parts of a line outside inline code spans. */
function outsideInlineCode(line: string, edit: (text: string) => string): string {
  return line
    .split(/(`+[^`]*`+)/)
    .map((part, index) => (index % 2 ? part : edit(part)))
    .join("");
}

function sourceDefinitions(detail: string): Map<string, string> {
  const lines = detail.split("\n");
  const code = fencedLines(lines);
  const definitions = new Map<string, string>();
  lines.forEach((line, index) => {
    const definition = code[index] ? null : sourceFootnoteDefinition(line);
    if (definition) definitions.set(definition.label, definition.target);
  });
  return definitions;
}

function footnoteDefinitionLabels(content: string): Set<string> {
  const lines = content.split("\n");
  const code = fencedLines(lines);
  const labels = new Set<string>();
  lines.forEach((line, index) => {
    const match = code[index] ? null : /^\[\^([^\]\s]+)\]:/.exec(line);
    if (match) labels.add(match[1]);
  });
  return labels;
}

function usesFootnote(content: string, label: string): boolean {
  const lines = content.split("\n");
  const code = fencedLines(lines);
  return lines.some(
    (line, index) =>
      !code[index] &&
      outsideInlineCode(line, text =>
        [...text.matchAll(FOOTNOTE_REFERENCE)].some(match => match[1] === label) ? "\u0000" : ""
      ).includes("\u0000")
  );
}

function definesFootnote(content: string, label: string): boolean {
  const lines = content.split("\n");
  const code = fencedLines(lines);
  const prefix = `[^${label}]:`;
  return lines.some((line, index) => !code[index] && line.startsWith(prefix));
}

/**
 * Detail: `[S#]` becomes a source footnote. Source footnotes are then numbered [^1], [^2]… by first appearance, one
 * number per note, with their definitions at the end of the evidence section (or the detail). A source footnote the
 * reply kept without its definition is restored from the selected sources or the previous detail. Only source
 * footnotes are touched: code, other footnotes and footnote-like text stay as written.
 */
export function resolveDetailReferences(
  detail: string,
  groups: ReferenceGroup[],
  previousDetail = "",
  template?: DetailTemplate
): string {
  const documents = dedupeReferenceGroups(groups).flatMap(group => group.documents);
  const resolveWikilinks = createWikilinkResolver(documents);
  const cited = new Map<string, string>();
  const source = (line: string): string => {
    const identified = line.replace(/\[S(\d+)\]/g, (original, number: string) => {
      const document = documents[Number(number) - 1];
      if (!document) return tNote("note.source_unconfirmed_0", original);
      const label = documentFootnoteLabel(document);
      cited.set(label, footnoteTarget(document));
      return `[^${label}]`;
    });
    return documents.length ? resolveWikilinks(identified) : identified;
  };
  const lines = detail.split("\n");
  const code = fencedLines(lines);
  const body: string[] = [];
  const bodyCode: boolean[] = [];
  const defined = new Map<string, string>();
  const reserved = new Set<string>();
  const dropped = new Set<string>();
  lines.forEach((line, index) => {
    if (!code[index]) {
      // The reply's own definition line for a marker (`[S1]: [[note]] …`, also in a list item or quote): VAM writes that definition, so the line is dropped.
      if (/^[ \t]*(?:>[ \t]*)*(?:[-*+][ \t]+)?\[S\d+\]:[ \t]*\[\[[^\]]+\]\]/.test(line)) return;
      const definition = sourceFootnoteDefinition(line);
      if (definition) {
        defined.set(definition.label, definition.target);
        return;
      }
      const other = /^\[\^([^\]\s]+)\]:/.exec(line);
      if (other) reserved.add(other[1]);
    }
    body.push(code[index] ? line : outsideInlineCode(line, source));
    bodyCode.push(code[index]);
  });
  const previous = sourceDefinitions(previousDetail);
  const writerLabels = footnoteDefinitionLabels(previousDetail);
  const byLabel = new Map(documents.map(document => [documentFootnoteLabel(document), document]));
  const targetOf = (label: string): string | undefined => {
    const target = cited.get(label) ?? defined.get(label) ?? previous.get(label);
    if (target) return target;
    const document = byLabel.get(label);
    if (document) return footnoteTarget(document);
    // The writer's own footnote (defined in the previous detail) is never re-pointed at a reference note.
    if (writerLabels.has(label)) return undefined;
    // A label copied from a reference note: exactly one defining document is the source; several are ambiguous; a
    // label no document defines but one uses is a copied undefined reference. All but the first drop the marker.
    const owners = documents.filter(candidate => definesFootnote(candidate.content, label));
    if (owners.length === 1) return footnoteTarget(owners[0]);
    if (owners.length > 1 || documents.some(candidate => usesFootnote(candidate.content, label))) dropped.add(label);
    return undefined;
  };
  // A footnote kept as written (not a source and not resolvable) keeps its number; sources never reuse it.
  body.forEach((line, index) => {
    if (bodyCode[index]) return;
    outsideInlineCode(line, text => {
      for (const [, label] of text.matchAll(FOOTNOTE_REFERENCE))
        if (!label.startsWith("src-") && !targetOf(label) && !dropped.has(label)) reserved.add(label);
      return text;
    });
  });
  const numbers = new Map<string, number>();
  const ordered: string[] = [];
  let next = 0;
  const number = (target: string): number => {
    const key = targetKey(target);
    if (!numbers.has(key)) {
      do next++;
      while (reserved.has(String(next)));
      numbers.set(key, next);
      ordered.push(`[^${next}]: ${target}`);
    }
    return numbers.get(key)!;
  };
  const renumbered = body.map((line, index) =>
    bodyCode[index]
      ? line
      : outsideInlineCode(line, text =>
          text.replace(FOOTNOTE_REFERENCE, (original, label: string) => {
            if (reserved.has(label)) return original;
            const target = targetOf(label);
            if (target) return `[^${number(target)}]`;
            if (label.startsWith("src-")) return ` ${tNote("note.source_unconfirmed_0", label)}`;
            // Copied from several reference notes that each define it: no single source, so drop the marker.
            return dropped.has(label) ? "" : original;
          })
        )
  );
  // Removing definition lines can leave stacked blank lines outside code; keep one.
  const compact = renumbered.filter(
    (line, index) =>
      bodyCode[index] || line.trim() || index === 0 || renumbered[index - 1].trim() || bodyCode[index - 1]
  );
  const text = compact.join("\n").trimEnd();
  if (!ordered.length) return text;
  const headings = sourcesHeadingKeys(template ?? standardTemplate("en"));
  const textLines = text.split("\n");
  const textCode = fencedLines(textLines);
  const start = textLines.findIndex((line, index) => {
    const match = textCode[index] ? null : /^###\s+(.+?)\s*$/.exec(line);
    return !!match && headings.has(match[1].toLocaleLowerCase());
  });
  if (start < 0) return `${text}\n\n${ordered.join("\n")}\n`;
  let end = textLines.findIndex((line, index) => index > start && !textCode[index] && /^###\s+/.test(line));
  if (end < 0) end = textLines.length;
  while (end > start + 1 && !textLines[end - 1].trim()) end--;
  return [
    ...textLines.slice(0, end),
    "",
    ...ordered,
    ...(end < textLines.length && textLines[end].trim() ? [""] : []),
    ...textLines.slice(end)
  ].join("\n");
}
