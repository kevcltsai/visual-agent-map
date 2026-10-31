import { sanitizeGeneratedTitle, titleProblem } from "../../core/title-safety";
import type { MapDocument, MapNode } from "../../map-model";
import { safeName, type Repository } from "../../repository";
import { arrangeMap } from "../../map-layout";
import { canonicalDetail } from "../../ai/result-utils";
import { standardTemplate, type DetailTemplate } from "../../ai/detail-templates";
import { noteLanguageOf, translate, translateNote, type ContentLanguage } from "../../i18n";

export const OUTLINE_NODE_LIMIT = 100;
export const OUTLINE_TITLE_LIMIT = 200;

export interface OutlineNode {
  index: number;
  title: string;
  level: number;
  parent: number | null;
  line: number;
  /** Note text that came with the node (an OPML / FreeMind file); becomes the topic's Detail. */
  body?: string;
}
/** Where an outline came from: a vault note (shown as a link), a file by name (plain text only), or nothing. */
export type OutlineSource = string | { file: string } | null;
export type OutlineIssueKey =
  | "ui.outline_error_no_headings"
  | "ui.outline_error_empty_title"
  | "ui.outline_error_multiple_roots"
  | "ui.outline_error_too_many_nodes"
  | "ui.outline_error_title_too_long"
  | "ui.outline_error_title_fence"
  | "ui.outline_error_title_brackets"
  | "ui.outline_error_vam_note"
  | "ui.outline_warning_skipped_level"
  | "ui.outline_warning_duplicate_title"
  | "ui.outline_warning_filename_collision"
  | "ui.outline_warning_ignored_lines";
export interface OutlineIssue {
  line: number;
  key: OutlineIssueKey;
  values: (string | number)[];
}
export interface OutlineParse {
  nodes: OutlineNode[];
  errors: OutlineIssue[];
  warnings: OutlineIssue[];
  totalLines: number;
  headingLines: number;
  ignoredLines: number;
  blankLines: number;
  skippedLines: number;
}

const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
const MARKDOWN_FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*(markdown|md)?[ \t]*$/i;

/** Heading text as plain text: Markdown emphasis, code and link syntax removed, escapes resolved. */
export function outlineTitle(raw: string): string {
  // The sentinel is a private-use character absent from the input, so restoring can only match our own markers.
  let code = 0xe000;
  while (raw.includes(String.fromCharCode(code))) code++;
  const mark = String.fromCharCode(code);
  const kept: string[] = [];
  // One left-to-right pass: backslash escapes and code spans are literal text that no later rule may touch.
  const protectedText = raw.replace(
    /\\([!-/:-@[-`{-~])|(`+)([^`]*?)\2/g,
    (_match, character: string | undefined, _ticks: string | undefined, content: string | undefined) => {
      kept.push(character ?? content ?? "");
      return `${mark}${kept.length - 1}${mark}`;
    }
  );
  const plain = protectedText
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
    .replace(/\[\[([^\]]+)\]\]/g, "$1")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\*\*(?=\S)(.+?)(?<=\S)\*\*/g, "$1")
    .replace(/(^|[^\p{L}\p{N}_])__(?=\S)(.+?)(?<=\S)__(?![\p{L}\p{N}_])/gu, "$1$2")
    .replace(/\*(?=\S)(.+?)(?<=\S)\*/g, "$1")
    .replace(/(^|[^\p{L}\p{N}_])_(?=\S)(.+?)(?<=\S)_(?![\p{L}\p{N}_])/gu, "$1$2");
  return plain.replace(new RegExp(`${mark}(\\d+)${mark}`, "g"), (_match, index: string) => kept[Number(index)]).trim();
}

/**
 * Unwraps an outline the AI returned inside a single fence holding headings. Only a fence labelled markdown / md,
 * or a bare fence that is the first non-blank line, qualifies; any other fenced block stays code.
 */
function unwrapFencedOutline(lines: string[]): string[] {
  const firstContent = lines.findIndex(line => line.trim() !== "");
  let index = 0;
  while (index < lines.length) {
    const open = FENCE_OPEN.exec(lines[index]);
    if (!open || (open[1][0] === "`" && open[2].includes("`"))) {
      index++;
      continue;
    }
    const marker = open[1];
    const labelled = MARKDOWN_FENCE.exec(lines[index]);
    const qualifies = !!labelled && (!!labelled[2] || index === firstContent);
    let close = -1;
    for (let next = index + 1; next < lines.length; next++) {
      const candidate = FENCE_CLOSE.exec(lines[next]);
      if (candidate && candidate[1][0] === marker[0] && candidate[1].length >= marker.length) {
        close = next;
        break;
      }
    }
    if (close < 0) return lines;
    if (!qualifies) {
      index = close + 1;
      continue;
    }
    const inner = lines.slice(index + 1, close);
    // A bare fence has no label vouching for it, so it must hold nothing but headings (a bash block does not).
    if (!labelled[2] && inner.some(line => line.trim() !== "" && !HEADING.test(line))) return lines;
    const outside = [...lines.slice(0, index), ...lines.slice(close + 1)];
    if (!inner.some(line => HEADING.test(line)) || outside.some(line => HEADING.test(line))) return lines;
    // Keep line numbers stable: the fence lines become blank.
    return lines.map((line, position) => (position === index || position === close ? "" : line));
  }
  return lines;
}

/**
 * Cleans the headings of an AI-written outline draft before it is put in the outline box, where the user sees and can
 * edit it. Only headings whose title would break a note change; everything else is kept exactly.
 */
export function sanitizeOutlineDraft(markdown: string): string {
  return markdown
    .split("\n")
    .map(line => {
      const heading = HEADING.exec(line);
      if (!heading) return line;
      const title = outlineTitle((heading[2] ?? "").replace(/(^|[ \t]+)#+[ \t]*$/, ""));
      if (!titleProblem(title)) return line;
      return `${heading[1]} ${sanitizeGeneratedTitle(title)}`;
    })
    .join("\n");
}

export function parseOutline(input: string): OutlineParse {
  const lines = unwrapFencedOutline(
    (input.charCodeAt(0) === 0xfeff ? input.slice(1) : input).replace(/\r\n?/g, "\n").split("\n")
  );
  const nodes: OutlineNode[] = [];
  const errors: OutlineIssue[] = [];
  const warnings: OutlineIssue[] = [];
  let headingLines = 0,
    ignoredLines = 0,
    blankLines = 0,
    skippedLines = 0;
  let fence: string | null = null;
  let block: "html" | "obsidian" | "math" | null = null;
  let start = 0;
  let vamNote = false;
  if (lines[0]?.trim() === "---") {
    const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
    if (end > 0) {
      start = end + 1;
      skippedLines += start;
      vamNote = lines.slice(1, end).some(line => /^(visual-agent-map|agent-map-node)[ \t]*:/.test(line));
    }
  }
  const stack: OutlineNode[] = [];
  const seenTitles = new Map<string, number>();
  const seenFiles = new Map<string, string>();
  let rootLevel = 0;
  for (let index = start; index < lines.length; index++) {
    const line = lines[index];
    const lineNumber = index + 1;
    if (line.includes("<!-- visual-agent-map:")) vamNote = true;
    if (fence) {
      skippedLines++;
      const close = FENCE_CLOSE.exec(line);
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length) fence = null;
      continue;
    }
    if (block) {
      skippedLines++;
      const end = block === "html" ? "-->" : block === "obsidian" ? "%%" : "$$";
      if (line.includes(end)) block = null;
      continue;
    }
    const open = FENCE_OPEN.exec(line);
    if (open && !(open[1][0] === "`" && open[2].includes("`"))) {
      skippedLines++;
      fence = open[1];
      continue;
    }
    const trimmed = line.trim();
    if (trimmed.startsWith("<!--")) {
      skippedLines++;
      if (!trimmed.includes("-->", 4)) block = "html";
      continue;
    }
    if (trimmed.startsWith("%%")) {
      skippedLines++;
      if (!trimmed.slice(2).includes("%%")) block = "obsidian";
      continue;
    }
    if (trimmed.startsWith("$$")) {
      skippedLines++;
      if (!trimmed.slice(2).includes("$$")) block = "math";
      continue;
    }
    if (!trimmed) {
      blankLines++;
      continue;
    }
    const heading = HEADING.exec(line);
    if (!heading) {
      ignoredLines++;
      continue;
    }
    headingLines++;
    const level = heading[1].length;
    const text = heading[2] ?? "";
    const raw = text.replace(/(^|[ \t]+)#+[ \t]*$/, "");
    const title = outlineTitle(raw);
    if (!title) {
      errors.push({ line: lineNumber, key: "ui.outline_error_empty_title", values: [lineNumber] });
      continue;
    }
    if ([...title].length > OUTLINE_TITLE_LIMIT)
      errors.push({
        line: lineNumber,
        key: "ui.outline_error_title_too_long",
        values: [lineNumber, OUTLINE_TITLE_LIMIT]
      });
    // The user's text is never rewritten: a title that would break the note is refused with the reason (D-2026-10-95).
    const problem = titleProblem(title);
    if (problem) errors.push({ line: lineNumber, key: `ui.outline_error_title_${problem}`, values: [lineNumber] });
    if (!nodes.length) rootLevel = level;
    else if (level <= rootLevel) {
      errors.push({ line: lineNumber, key: "ui.outline_error_multiple_roots", values: [lineNumber] });
      continue;
    }
    while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
    const parent = stack[stack.length - 1] ?? null;
    if (parent && level > parent.level + 1)
      warnings.push({ line: lineNumber, key: "ui.outline_warning_skipped_level", values: [lineNumber] });
    const node: OutlineNode = {
      index: nodes.length,
      title,
      level,
      parent: parent ? parent.index : null,
      line: lineNumber
    };
    nodes.push(node);
    stack.push(node);
    if (seenTitles.has(title))
      warnings.push({ line: lineNumber, key: "ui.outline_warning_duplicate_title", values: [lineNumber, title] });
    else {
      seenTitles.set(title, lineNumber);
      const file = safeName(title).toLocaleLowerCase();
      const other = seenFiles.get(file);
      if (other !== undefined && other !== title)
        warnings.push({ line: lineNumber, key: "ui.outline_warning_filename_collision", values: [lineNumber, title] });
      else seenFiles.set(file, title);
    }
  }
  if (vamNote) errors.unshift({ line: 1, key: "ui.outline_error_vam_note", values: [] });
  if (!nodes.length && !errors.length) errors.push({ line: 0, key: "ui.outline_error_no_headings", values: [] });
  if (nodes.length > OUTLINE_NODE_LIMIT)
    errors.push({ line: 0, key: "ui.outline_error_too_many_nodes", values: [nodes.length, OUTLINE_NODE_LIMIT] });
  if (ignoredLines) warnings.push({ line: 0, key: "ui.outline_warning_ignored_lines", values: [ignoredLines] });
  return {
    nodes,
    errors,
    warnings,
    totalLines: lines.length,
    headingLines,
    ignoredLines,
    blankLines,
    skippedLines
  };
}

export interface OutlineCreateResult {
  mapPath: string;
  nodes: MapNode[];
  created: number;
  total: number;
  failure?: string;
}

function errorText(error: unknown): string {
  const message = (error as { message?: unknown } | null)?.message;
  return typeof message === "string" ? message : String(error);
}

function localDate(now: Date): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** The outline root's import line, in the template's log section (or its first section when it has none). */
function outlineRootDetail(
  language: ContentLanguage,
  template: DetailTemplate,
  source: OutlineSource,
  now: Date
): string {
  // A file name is untrusted text: it is logged as plain words, with nothing that could form a link, embed or marker.
  const log =
    source && typeof source === "object"
      ? translateNote(
          language,
          "ui.outline_import_log_file",
          localDate(now),
          source.file.replace(/[[\]|<>`!\r\n]+/g, " ").trim()
        )
      : source
        ? translateNote(language, "ui.outline_import_log_source", localDate(now), source)
        : translateNote(language, "ui.outline_import_log", localDate(now));
  const heading = (template.sections.find(section => section.role === "log") ?? template.sections[0]).name;
  return canonicalDetail(`### ${heading}\n\n- ${log}`, noteLanguageOf(language), template);
}

/**
 * Creates one note per outline heading in `mapPath`'s topic folder, in outline order with parents by index; the
 * outline root hangs under `parentId` (null for a top-level topic). The first failure stops creation; every note
 * created so far is returned, with the failure, for the caller to keep or discard. Does not save the map.
 */
async function createOutlineNotes(
  repository: Repository,
  map: MapDocument,
  mapPath: string,
  model: string,
  nodes: OutlineNode[],
  rootDetail: string,
  parentId: string | null,
  detailTemplateId?: string,
  manualModel = false,
  toneId?: string
): Promise<{ created: MapNode[]; failure?: string }> {
  const created: MapNode[] = [];
  for (const node of nodes) {
    try {
      const top = node.parent === null;
      const note = await repository.createNote(
        node.title,
        model,
        map,
        mapPath,
        // A manual model marks only the top-level topic; its children inherit it and resolve to the same model.
        top && manualModel ? "manual" : top && parentId === null ? "workspace" : "inherited",
        // A topic created from an outline starts in Quick mode (its first research, if any, is the short one).
        // A node's own note text, when the file had one, is its Detail as written; otherwise a root gets the import log.
        node.body
          ? { detail: node.body, researchMode: "local" }
          : top
            ? { detail: rootDetail, researchMode: "local" }
            : { researchMode: "local" }
      );
      note.parentId = top ? parentId : created[node.parent!].id;
      created.push(note);
      if (detailTemplateId || toneId)
        await repository.updateNote(note.path, {
          ...(detailTemplateId ? { detailTemplateId } : {}),
          ...(toneId ? { toneId } : {})
        });
    } catch (error) {
      return { created, failure: errorText(error) };
    }
  }
  return { created };
}

/** Creates a new map from parsed outline nodes; never edits the source note or other maps. */
export async function createOutlineMap(
  repository: Repository,
  model: string,
  nodes: OutlineNode[],
  source: OutlineSource,
  now = new Date(),
  template?: DetailTemplate,
  manualModel = false
): Promise<OutlineCreateResult> {
  const language = repository.settings.language;
  const detailTemplate = template ?? standardTemplate(noteLanguageOf(language));
  if (!nodes.length) throw new Error(translate(language, "ui.outline_error_no_headings"));
  const mapPath = await repository.createMap(nodes[0].title, []);
  let map;
  try {
    map = await repository.readMap(mapPath);
  } catch (error) {
    // The map folder exists already; callers must not offer a retry that would create a second map.
    throw Object.assign(new Error(errorText(error)), { mapCreated: true });
  }
  const rootDetail = outlineRootDetail(language, detailTemplate, source, now);
  const { created, failure } = await createOutlineNotes(
    repository,
    map,
    mapPath,
    model,
    nodes,
    rootDetail,
    null,
    undefined,
    manualModel
  );
  map.nodes = arrangeMap(created);
  try {
    await repository.saveMap(mapPath, map);
  } catch (error) {
    const message = errorText(error);
    // The map folder and notes exist now; callers must not offer a retry that would create a second map.
    throw Object.assign(
      new Error(
        translate(
          language,
          "ui.outline_import_map_save_failed",
          `${message} (${created.map(node => node.path).join(", ")})`
        )
      ),
      { mapCreated: true }
    );
  }
  return { mapPath, nodes: map.nodes, created: created.length, total: nodes.length, ...(failure ? { failure } : {}) };
}

export interface OutlineAddResult {
  /** The created notes as map nodes (not yet in the map), outline root first. */
  created: MapNode[];
  total: number;
  failure?: string;
}

/**
 * Creates the outline's notes in an existing map's topic folder, its root under `parentId` (null for a new
 * top-level tree). The caller writes the returned nodes into the map. A chosen template and tone are recorded on
 * each created topic; the map's own default is never changed.
 */
export async function addOutlineToMap(
  repository: Repository,
  map: MapDocument,
  mapPath: string,
  model: string,
  nodes: OutlineNode[],
  source: OutlineSource,
  parentId: string | null,
  template: DetailTemplate,
  detailTemplateId?: string,
  now = new Date(),
  manualModel = false,
  toneId?: string
): Promise<OutlineAddResult> {
  const language = repository.settings.language;
  if (!nodes.length) throw new Error(translate(language, "ui.outline_error_no_headings"));
  const rootDetail = outlineRootDetail(language, template, source, now);
  const { created, failure } = await createOutlineNotes(
    repository,
    map,
    mapPath,
    model,
    nodes,
    rootDetail,
    parentId,
    detailTemplateId,
    manualModel,
    toneId
  );
  return { created, total: nodes.length, ...(failure ? { failure } : {}) };
}

/** Quick explore's bounds: levels below the topic and topics in total, as chosen in the dialog. */
export const QUICK_OUTLINE_MAX_LEVELS = 6;
export const QUICK_OUTLINE_MAX_TOPICS = 30;
export interface OutlineLimits {
  levels: number;
  maxTopics: number;
}
/**
 * Keeps an outline within `levels` below its root and `maxTopics` topics besides the root. A single top heading is
 * the root (the topic itself); several top headings are all first-level topics. The size is filled level by level,
 * so every main branch survives before any branch grows deeper; a node is kept only when its parent was, and the
 * result keeps document order, so it is still a valid tree. `dropped` counts the rest.
 */
export function limitOutline(nodes: OutlineNode[], limits: OutlineLimits): { nodes: OutlineNode[]; dropped: number } {
  const singleRoot = nodes.filter(node => node.parent === null).length === 1;
  const depth = new Map<number, number>();
  for (const node of nodes) {
    const parentDepth = node.parent === null ? undefined : depth.get(node.parent);
    if (node.parent !== null && parentDepth === undefined) continue;
    depth.set(node.index, node.parent === null ? (singleRoot ? 0 : 1) : parentDepth! + 1);
  }
  const kept = new Set<number>();
  let topics = 0;
  for (let level = 0; level <= limits.levels; level++)
    for (const node of nodes) {
      if (depth.get(node.index) !== level || (node.parent !== null && !kept.has(node.parent))) continue;
      if (level > 0) {
        if (topics >= limits.maxTopics) break;
        topics++;
      }
      kept.add(node.index);
    }
  const result = nodes.filter(node => kept.has(node.index));
  return { nodes: result, dropped: nodes.length - result.length };
}
