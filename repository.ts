import { App, Notice, TAbstractFile, TFile, TFolder, normalizePath, parseYaml, stringifyYaml } from "obsidian";
import { isOutputOnlyLanguage, resolveAimContentLanguage } from "./experiences/aim/content-language";
import { resolveMapTextLanguage, textLanguageOf } from "./experiences/visual-map/map-text-language";
import { createHash } from "node:crypto";
import {
  isNoteLanguage,
  noteLanguageOf,
  tNote,
  translate,
  translateNote,
  type NoteLanguage,
  type TranslationKey,
  type UiLanguage
} from "./i18n";
import { MapDocument, MapNode, serializeMap, parseMap, type AimReuseRecord } from "./map-model";
import type { CoffeeStyle } from "./experiences/coffee-tables/types";
import type { ReasoningLevel, ResearchDepth, ResearchMode, VisualMode } from "./ai/types";
import { normalizeReasoningLevel } from "./ai/task-policy";
import type { PromptPreset } from "./ai/prompt-presets";
import { sourcesHeadingKeys, standardTemplate, type DetailTemplate } from "./ai/detail-templates";
import { fencedLines } from "./ai/markdown-blocks";
import { findWikilinks, linkPathOf, rewriteLinkTargets, splitFrontmatter } from "./core/link-rewrite";
import {
  managedHeadingValue,
  managedSectionValue,
  readRelevance,
  readRelevanceGoal,
  normalizeRelevanceGoal,
  normalizeRelevanceContext,
  readRelevanceContext,
  readRelevanceLevel,
  type RelevanceLevel,
  type NoteRelevance
} from "./note-values";
import { upgradeLegacyAimText } from "./experiences/aim/legacy-names";
export type { ReasoningLevel, ResearchDepth, ResearchMode, VisualMode, VisualReference } from "./ai/types";
export { normalizeReasoningLevel } from "./ai/task-policy";

export type Status = "idea" | "running" | "completed" | "error";
export type ModelSource = "workspace" | "inherited" | "manual";
export type TopicState = "active" | "unassigned" | "archived" | "inbox";
export type TopicCollection = "Notes" | "Unassigned" | "Archive";
export interface Note {
  /** The note's stored `content-language` frontmatter, when present. */
  contentLanguage?: NoteLanguage;
  title: string;
  summary: string;
  prompt: string;
  rules: string;
  detail: string;
  thinkingOrigin?: string;
  visualReferences: string;
  newFindings: string;
  preview: string;
  previewSection?: string;
  previewInitialized?: boolean;
  model: string;
  modelSource: ModelSource;
  reasoning?: ReasoningLevel;
  researchMode: ResearchMode;
  researchDepth: ResearchDepth;
  visualMode: VisualMode;
  detailTemplateId?: string;
  /** Per-topic tone preset id (frontmatter `tone`); absent = use the map default. */
  toneId?: string;
  detailFormatIssues: string[];
  status: Status;
  mapId: string;
  topicId: string;
  topicState: TopicState;
  sourcePaths: string[];
  referencePaths?: string[];
  /** Read-only grading from frontmatter (see readRelevance); absent when missing or invalid. */
  relevance?: NoteRelevance;
}
export type NotePatch = Partial<Note>;
export interface Settings {
  detailTemplates: DetailTemplate[];
  defaultDetailTemplateId?: string;
  coffeeStyles?: CoffeeStyle[];
  /** Custom tone/outline presets; built-ins live in ai/prompt-presets.ts. Absent = none. */
  promptPresets?: PromptPreset[];
  defaultCoffeeStyleId?: string;
  language: UiLanguage;
  workspaceFolder: string;
  /** Legacy container (pre-0.19): maps here stay openable; new maps go to mindMapsFolder / aimFolder. */
  topicsFolder: string;
  mindMapsFolder: string;
  aimFolder: string;
  notesFolder: string;
  mapsFolder: string;
  mapId: string;
  codexPath: string;
  claudePath: string;
  cliModel: string;
  cliReasoning: ReasoningLevel;
  previewSize?: "small" | "medium" | "large";
  previewScale: number;
  models: string;
  migrated: boolean;
  structureVersion: number;
  firstUseNoticeSeen: boolean;
  codexUsageNoticeSeen: boolean;
  claudeUsageNoticeSeen: boolean;
  aiExchangeLoggingEnabled: boolean;
  markdownSelectionAiAutoOpen: boolean;
  /** Add diagrams after research (default on): the chart step after a note or an AIM conclusion is written. */
  addDiagramsAfterResearch: boolean;
  workspaceInitialized: boolean;
  sampleTourVersionSeen: number;
  canvasHintSeen: boolean;
}
export interface TopicInfo {
  id: string;
  title: string;
  mapPath: string;
  root: string;
}
export interface BrokenTopic {
  title: string;
  root: string;
  noteCount: number;
}
/**
 * Map container folders for loaded settings: a saved value wins (never rewritten for upgraded users);
 * otherwise they derive from the saved workspace folder, so a custom workspace gets sibling folders.
 */
export function resolveMapFolders(
  saved: Partial<Pick<Settings, "workspaceFolder" | "mindMapsFolder" | "aimFolder">> | null | undefined
): Pick<Settings, "mindMapsFolder" | "aimFolder"> {
  const workspace = saved?.workspaceFolder || DEFAULT_SETTINGS.workspaceFolder;
  return {
    mindMapsFolder: saved?.mindMapsFolder || `${workspace}/Mind Maps`,
    aimFolder: saved?.aimFolder || `${workspace}/AIM`
  };
}

/** Folders that hold managed topic folders: the two current containers plus the legacy Topics container. */
export function managedMapContainers(
  settings: Pick<Settings, "topicsFolder" | "mindMapsFolder" | "aimFolder">
): string[] {
  return [settings.mindMapsFolder, settings.aimFolder, settings.topicsFolder];
}
/** The container (from managedMapContainers) that holds `path`, or undefined for maps outside all of them. */
export function managedMapContainer(
  settings: Pick<Settings, "topicsFolder" | "mindMapsFolder" | "aimFolder">,
  path: string
): string | undefined {
  return managedMapContainers(settings).find(folder => path.startsWith(`${folder}/`));
}
export function isManagedMapPath(
  settings: Pick<Settings, "topicsFolder" | "mindMapsFolder" | "aimFolder">,
  path: string
): boolean {
  return managedMapContainer(settings, path) !== undefined;
}

export interface OrganizeMove {
  mapPath: string;
  title: string;
  kind: "mind" | "aim";
  fromRoot: string;
  toRoot: string;
}
interface PriorContent {
  path: string;
  content: string;
}
/** Reports "moving topic `title`, step `done` of `total`" before each topic move starts. */
export type MoveProgress = (done: number, total: number, title: string) => void;
export interface OrganizePlan {
  moves: OrganizeMove[];
  /** Maps that could not be read: left exactly where they are. */
  skipped: { mapPath: string; error: string }[];
  /** Titles of AIM maps with a running or saving research attempt; any entry refuses the whole batch. */
  busy: string[];
}

export const DEFAULT_SETTINGS: Settings = {
  detailTemplates: [],
  coffeeStyles: [],
  promptPresets: [],
  language: "en",
  workspaceFolder: "Agent Workspace",
  topicsFolder: "Agent Workspace/Topics",
  mindMapsFolder: "Agent Workspace/Mind Maps",
  aimFolder: "Agent Workspace/AIM",
  notesFolder: "Agent Workspace/Nodes",
  mapsFolder: "Agent Workspace/Maps",
  mapId: "default",
  codexPath: "codex",
  claudePath: "claude",
  cliModel: "gpt-5.6-luna",
  cliReasoning: "low",
  previewScale: 120,
  models: "",
  migrated: false,
  structureVersion: 2,
  firstUseNoticeSeen: false,
  codexUsageNoticeSeen: false,
  claudeUsageNoticeSeen: false,
  aiExchangeLoggingEnabled: false,
  markdownSelectionAiAutoOpen: true,
  addDiagramsAfterResearch: true,
  workspaceInitialized: false,
  sampleTourVersionSeen: 0,
  canvasHintSeen: false
};

const REFERENCE_START = "<!-- visual-agent-map:references:start -->";
const REFERENCE_END = "<!-- visual-agent-map:references:end -->";
const DETAIL_START = "<!-- visual-agent-map:detail:start -->";
const DETAIL_END = "<!-- visual-agent-map:detail:end -->";
/**
 * The AIM open-items marker of a conclusion note. It is saved right after the Detail block, so Detail holds only what
 * the reader reads; `readNote` hands it back at the end of `detail`, where the AIM code and older notes keep it.
 */
const OPEN_ITEMS_MARKER = /\n*^<!--\s*aim-open-items\s+\[[^\n]*\]\s*-->[ \t]*$/m;
function splitOpenItems(value: string): { text: string; marker: string } {
  const match = OPEN_ITEMS_MARKER.exec(value);
  return match
    ? {
        text: (value.slice(0, match.index) + value.slice(match.index + match[0].length)).trim(),
        marker: match[0].trim()
      }
    : { text: value, marker: "" };
}
const NOTE_CSS_CLASS = "visual-agent-map-node";
/**
 * Point every reference to a moved note at its new path: node paths and the AIM records that must name the same note
 * (results, drafts, pending commits, input snapshots, reuse sources). An attempt whose input snapshot changed gets
 * the matching snapshot hash, and so do its drafts. Changing only node paths leaves an AIM map unreadable.
 * Returns whether anything changed.
 */
export function hasActiveAimAttempt(map: MapDocument): boolean {
  return !!map.aim?.runs.some(run =>
    run.attempts.some(attempt => attempt.status === "running" || attempt.status === "saving")
  );
}

export function rebaseMapNotePaths(map: MapDocument, rebase: (path: string) => string): boolean {
  let changed = false;
  const move = (path: string): string => {
    const next = rebase(path);
    if (next !== path) changed = true;
    return next;
  };
  const moveReuse = (record: AimReuseRecord | undefined): void => {
    if (record) record.sourceNotePath = move(record.sourceNotePath);
  };
  for (const node of map.nodes) node.path = move(node.path);
  const aim = map.aim;
  if (!aim) return changed;
  const hashSnapshot = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  for (const branch of aim.branches) {
    const snapshotBefore = JSON.stringify(branch.inputSnapshot);
    for (const result of branch.inputSnapshot.upstreamResults) result.notePath = move(result.notePath);
    for (const item of branch.researchPlan ?? []) if (item.source) item.source.notePath = move(item.source.notePath);
    for (const result of branch.results) {
      result.notePath = move(result.notePath);
      moveReuse(result.reuse);
    }
    if (JSON.stringify(branch.inputSnapshot) === snapshotBefore) continue;
    const hash = hashSnapshot({ branch: branch.inputSnapshot, answer: branch.answerSnapshot });
    for (const run of aim.runs) {
      if (run.branchId !== branch.id) continue;
      for (const attempt of run.attempts) {
        attempt.inputSnapshotHash = hash;
        for (const draft of aim.resultDrafts ?? [])
          if (draft.runId === run.id && draft.attemptId === attempt.id) draft.inputSnapshotHash = hash;
      }
    }
  }
  for (const run of aim.runs)
    for (const attempt of run.attempts)
      if (attempt.retainedReports) attempt.retainedReports.notePath = move(attempt.retainedReports.notePath);
  for (const draft of aim.resultDrafts ?? []) {
    draft.notePath = move(draft.notePath);
    moveReuse(draft.reuse);
  }
  if (aim.rootDraft) aim.rootDraft.notePath = move(aim.rootDraft.notePath);
  if (aim.questionDraft) aim.questionDraft.notePath = move(aim.questionDraft.notePath);
  for (const pending of aim.pendingCommits) pending.notePath = move(pending.notePath);
  return changed;
}
/** A rebase function that moves exactly one note path. */
export function moveNotePath(oldPath: string, newPath: string): (path: string) => string {
  return path => (path === oldPath ? newPath : path);
}
function writeMapContent(content: string, map: MapDocument): string {
  return content
    .replace(/^# .*$/m, () => `# ${map.title.replace(/\n/g, " ")}`)
    .replace(/```agent-map\s*\n[\s\S]*?\n```/, () => `\`\`\`agent-map\n${JSON.stringify(map, null, 2)}\n\`\`\``);
}
function marker(value: unknown): boolean {
  return value === true || value === "true";
}
function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}
function parentPath(path: string): string {
  return path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
}
function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function ensureNoteCssClass(fm: Record<string, unknown>): boolean {
  const current = Array.isArray(fm.cssclasses)
    ? fm.cssclasses.map(String)
    : typeof fm.cssclasses === "string"
      ? fm.cssclasses.split(/[\s,]+/).filter(Boolean)
      : [];
  if (current.includes(NOTE_CSS_CLASS)) return false;
  fm.cssclasses = [...current, NOTE_CSS_CLASS];
  return true;
}

const SAFE_NAME_LIMIT = 80;

type GraphemeSegmenter = new (
  locale?: string,
  options?: { granularity: "grapheme" }
) => { segment(input: string): Iterable<{ segment: string }> };

/** Splits text into grapheme clusters (code points when `Intl.Segmenter` is unavailable). */
function graphemes(value: string): string[] {
  const Segmenter = (Intl as { Segmenter?: GraphemeSegmenter }).Segmenter;
  if (Segmenter)
    return Array.from(new Segmenter(undefined, { granularity: "grapheme" }).segment(value), part => part.segment);
  return Array.from(value);
}

/**
 * A file or folder name for a NEW note or map. Never applied to existing paths (a stored path is never renamed).
 * Cuts at 80 UTF-16 units on a grapheme boundary, and never leaves a leading dot (hidden file) or a trailing dot or space.
 */
export function safeName(title: string): string {
  const cleaned = title
    .replace(/[\\/:*?"<>|#^[\]]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[\s.]+/, "");
  let cut = cleaned;
  if (cleaned.length > SAFE_NAME_LIMIT) {
    cut = "";
    for (const part of graphemes(cleaned)) {
      if (cut.length + part.length > SAFE_NAME_LIMIT) break;
      cut += part;
    }
  }
  return cut.replace(/[\s.]+$/, "") || tNote("note.untitled_topic");
}

/** Case- and form-insensitive name used to detect a collision on a case-insensitive file system. */
function foldName(value: string): string {
  return value.normalize("NFC").toLowerCase().replace(/ς/g, "σ");
}

/** Folds a file name without its extension, so a final sigma before ".md" folds as it does inside the name. */
function foldEntryName(name: string, isFile: boolean): string {
  const dot = isFile ? name.lastIndexOf(".") : -1;
  return dot > 0 ? `${foldName(name.slice(0, dot))}.${name.slice(dot + 1).toLowerCase()}` : foldName(name);
}

/** A link alias safe inside `[[path|alias]]` and a YAML list item: no brackets, pipe, backtick or line breaks. */
export function linkAlias(title: string, fallback: string): string {
  const alias = title
    .replace(/[[\]|`\r\n]/g, " ")
    .replace(/%{2,}/g, "%")
    .replace(/\s+/g, " ")
    .trim();
  return alias || fallback;
}

/** Folder name of a map, used as the link alias when the map title has nothing usable in it. */
function aliasFallback(mapPath: string): string {
  return parentPath(mapPath).split("/").at(-1) || mapPath;
}

function frontmatter(content: string): Record<string, unknown> {
  const yaml = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
  return yaml ? ((parseYaml(yaml) ?? {}) as Record<string, unknown>) : {};
}

/** A frontmatter value the relevance writers set: a string, a list of strings, true, or null to remove the key. */
type FrontmatterValue = string | string[] | boolean | null;
/**
 * Sets or removes top-level frontmatter keys and leaves every other line, and the body, exactly as it was. A key that
 * is already there keeps its place; new keys go at the end. Strings are written as JSON strings, which are valid YAML
 * double-quoted scalars.
 */
export function setFrontmatterKeys(content: string, values: Record<string, FrontmatterValue>): string {
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  const render = (key: string, value: string | string[] | boolean): string[] =>
    typeof value === "boolean"
      ? [`${key}: ${value}`]
      : Array.isArray(value)
        ? [`${key}:`, ...value.map(item => `  - ${JSON.stringify(item)}`)]
        : [`${key}: ${JSON.stringify(value)}`];
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?=\r?\n|$)/.exec(content);
  if (!match) {
    const lines = Object.entries(values).flatMap(([key, value]) => (value === null ? [] : render(key, value)));
    return lines.length ? `---${eol}${lines.join(eol)}${eol}---${eol}${content}` : content;
  }
  const kept: string[] = [];
  const written = new Set<string>();
  let skipping = false;
  for (const line of match[1].split(/\r?\n/)) {
    const key = /^([A-Za-z][\w-]*):/.exec(line)?.[1];
    if (key) {
      skipping = Object.keys(values).includes(key);
      if (skipping && !written.has(key)) {
        written.add(key);
        const value = values[key];
        if (value !== null) kept.push(...render(key, value));
      }
    } else if (skipping && !/^\s+|^-(\s|$)/.test(line) && line !== "") skipping = false;
    if (!skipping) kept.push(line);
  }
  for (const [key, value] of Object.entries(values))
    if (!written.has(key) && value !== null) kept.push(...render(key, value));
  return `---${eol}${kept.join(eol)}${eol}---${content.slice(match[0].length)}`;
}
const localDate = (date = new Date()): string =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
/** What the map file's frontmatter said about the goal before a write; handed back to restore it exactly. */
export interface RelevanceGoalState {
  goal: string | undefined;
  history: string[] | undefined;
  level?: RelevanceLevel | undefined;
  context?: string | undefined;
}
/** The three setup values of a map's relevance grading, as read from the map file. */
export interface RelevanceSetup {
  goal: string | undefined;
  level: RelevanceLevel | undefined;
  context: string | undefined;
}

function noteTitle(content: string, fm: Record<string, unknown>, fallback: string): string {
  const body = content.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "");
  return /^# (.+)$/m.exec(body)?.[1]?.trim() || text(fm.title, fallback);
}

type NoteSection =
  | "Thinking Origin"
  | "Current Summary"
  | "Prompt"
  | "Rules"
  | "Detail"
  | "Visual References"
  | "Working Findings"
  | "New Findings"
  | "預覽"
  | "Preview"
  | "User Notes";
const noteContentLanguage = (fm: Record<string, unknown>): NoteLanguage | undefined =>
  isNoteLanguage(fm["content-language"]) ? fm["content-language"] : undefined;
const placeholder = (language: NoteLanguage): string => translate(language, "detail.no_conclusion_yet");
export const isPlaceholder = (value: string): boolean =>
  value === translate("zh-TW", "detail.no_conclusion_yet") || value === translate("en", "detail.no_conclusion_yet");
const previewHeading = (language: NoteLanguage): NoteSection => translate(language, "detail.preview") as NoteSection;

/**
 * Preview (right after the summary) and Prompt (after Detail) are written as collapsed callouts (`> [!info]- 預覽`,
 * `> [!info]- Prompt`) so the note opens on the answer. Every read and write first turns these callouts back into the `## ` sections the rest
 * of this module works with; `noteBody` writes them as callouts again. Older notes keep their `## ` sections.
 */
const CALLOUT_SECTION = /^> \[!info\][+-]? (預覽|Preview|Prompt)[ \t]*\r?$/;
function decodeCalloutSections(content: string): string {
  const lines = content.split("\n");
  const code = fencedLines(lines);
  const out: string[] = [];
  let inDetail = false;
  // Thinking Origin is quoted source text: a line there that looks like a callout title is still source text.
  let origin: "none" | "heading" | "quote" = "none";
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (line.trim() === DETAIL_START) inDetail = true;
    if (line.trim() === DETAIL_END) inDetail = false;
    if (/^## Thinking Origin\s*$/.test(line)) origin = "heading";
    else if (origin === "heading" && line.startsWith(">")) origin = "quote";
    else if (origin === "heading" && line.trim()) origin = "none";
    else if (origin === "quote" && !line.startsWith(">")) origin = "none";
    const callout = inDetail || code[index] || origin !== "none" ? null : CALLOUT_SECTION.exec(line);
    if (!callout) {
      out.push(line);
      continue;
    }
    // A callout ends at the first line without ">" or at the next Preview/Prompt callout title.
    let end = index + 1;
    while (end < lines.length && lines[end].startsWith(">") && !CALLOUT_SECTION.test(lines[end])) end++;
    out.push(
      `## ${callout[1]}`,
      "",
      ...lines.slice(index + 1, end).map(item => item.replace(/^> ?/, "").replace(/\r$/, "")),
      ""
    );
    index = end - 1;
  }
  return out.join("\n");
}
function calloutSection(title: string, value: string): string {
  const lines = value.trim().split("\n");
  return [`> [!info]- ${title}`, ...lines.map(line => (line ? `> ${line}` : ">"))].join("\n");
}
const previewSection = (content: string): string =>
  [...new Set([section(content, "Preview"), section(content, "預覽")].filter(Boolean))].join("\n\n");

function sectionBounds(content: string, heading: NoteSection): { start: number; end: number } | null {
  if (heading === "Detail") {
    const managedStart = content.indexOf(DETAIL_START),
      managedEnd = content.indexOf(DETAIL_END);
    if (managedStart >= 0 && managedEnd > managedStart)
      return { start: managedStart + DETAIL_START.length, end: managedEnd };
  }
  const match = new RegExp(`^## ${heading.replace(" ", "\\s+")}\\s*$`, "m").exec(content);
  if (!match) return null;
  const start = match.index + match[0].length;
  const next = /^## .+$/m.exec(content.slice(start));
  const reference = content.indexOf(REFERENCE_START, start);
  const candidates = [next ? start + next.index : content.length, reference >= 0 ? reference : content.length];
  return { start, end: Math.min(...candidates) };
}

/** Detail as the app uses it: the Detail block, plus the open-items marker saved after it. */
function detailWithOpenItems(content: string): string {
  const detail = section(content, "Detail");
  if (splitOpenItems(detail).marker) return detail;
  const end = content.indexOf(DETAIL_END);
  const after = end >= 0 ? content.slice(end + DETAIL_END.length) : "";
  const next = after.search(/^## /m);
  const { marker } = splitOpenItems(next >= 0 ? after.slice(0, next) : after);
  return marker ? `${detail}\n\n${marker}` : detail;
}

function section(content: string, heading: NoteSection): string {
  const bounds = sectionBounds(content, heading);
  return bounds ? content.slice(bounds.start, bounds.end).trim() : "";
}

function replaceSection(content: string, heading: NoteSection, value: string): string {
  const bounds = sectionBounds(content, heading);
  if (bounds) {
    if (heading === "Detail" && !content.slice(0, bounds.start).includes(DETAIL_START)) {
      return `${content.slice(0, bounds.start)}\n\n${DETAIL_START}\n${managedSectionValue(value)}\n${DETAIL_END}\n\n${content.slice(bounds.end).replace(/^\s*/, "")}`;
    }
    return `${content.slice(0, bounds.start)}\n${managedSectionValue(value)}\n${content.slice(bounds.end)}`;
  }
  const reference = content.indexOf(REFERENCE_START);
  const at = reference >= 0 ? reference : content.length;
  const managed =
    heading === "Detail" ? `${DETAIL_START}\n${managedSectionValue(value)}\n${DETAIL_END}` : managedSectionValue(value);
  return `${content.slice(0, at).trimEnd()}\n\n## ${heading}\n\n${managed}\n\n${content.slice(at).trimStart()}`;
}

// Blockquoted, escaped source text cannot impersonate managed sections or markers.
export function originMarkdown(value: string): string {
  return value
    .split(/\r?\n/)
    .map(line => `> ${line.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}`)
    .join("\n");
}
function readThinkingOrigin(content: string): string | undefined {
  const value = section(content, "Thinking Origin");
  if (!value) return undefined;
  return value
    .split("\n")
    .map(line => line.replace(/^> ?/, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"))
    .join("\n");
}

function replaceSummarySection(content: string, value: string): string {
  if (sectionBounds(content, "Current Summary")) return replaceSection(content, "Current Summary", value);
  const title = /^# .*$/m.exec(content);
  if (!title) return replaceSection(content, "Current Summary", value);
  const at = title.index + title[0].length;
  return `${content.slice(0, at)}\n\n## Current Summary\n\n${managedSectionValue(value)}\n\n${content.slice(at).trimStart()}`;
}

function removeSection(content: string, heading: NoteSection): string {
  if (heading === "Detail") {
    const managedStart = content.indexOf(DETAIL_START),
      managedEnd = content.indexOf(DETAIL_END);
    if (managedStart >= 0 && managedEnd > managedStart) {
      const headingMatch = /^## Detail\s*$/m.exec(content.slice(0, managedStart));
      const start = headingMatch ? headingMatch.index : managedStart;
      return `${content.slice(0, start).trimEnd()}\n\n${content.slice(managedEnd + DETAIL_END.length).trimStart()}`;
    }
  }
  const bounds = sectionBounds(content, heading);
  if (!bounds) return content;
  const headingMatch = new RegExp(`^## ${heading.replace(" ", "\\s+")}\\s*$`, "m").exec(content.slice(0, bounds.start));
  if (!headingMatch) return content;
  return `${content.slice(0, headingMatch.index).trimEnd()}\n\n${content.slice(bounds.end).trimStart()}`;
}

function ensurePreview(content: string, language: NoteLanguage, textLanguage: NoteLanguage = language): string {
  const legacy = section(content, "User Notes");
  const preview = previewSection(content);
  const merged = [isPlaceholder(preview) ? placeholder(textLanguage) : preview, legacy].filter(Boolean).join("\n\n");
  const clean = removeSection(removeSection(removeSection(content, "User Notes"), "預覽"), "Preview");
  return replaceSection(clean, previewHeading(language), merged);
}

function withoutReference(content: string): string {
  const managed = new RegExp(`\\n?${REFERENCE_START}[\\s\\S]*?${REFERENCE_END}\\n?`, "m");
  if (managed.test(content)) return content.replace(managed, "\n");
  const legacy = /\n?^## 關聯議題\s*\n+(?:母議題：[^\n]*\n+)?(?:子議題：[^\n]*\n*)?$/m;
  return legacy.test(content) ? content.replace(legacy, "\n") : content;
}

function detailWithVisualReferences(detail: string, visualReferences: string, template: DetailTemplate): string {
  let current = detail.trim();
  const references = visualReferences
    .trim()
    .split(/\n(?=\*\*[^\n]+\*\*\n|### )/)
    .filter(Boolean);
  for (const reference of references) {
    const image = reference.match(/!\[[^\]]*\]\(([^)]+)\)/);
    if (!image || current.includes(`](${image[1]})`)) continue;
    const block = reference.replace(/^### (.+)$/gm, "**$1**").trim();
    const title = block.match(/^\*\*(.+)\*\*/)?.[1];
    const paragraphs = current.split("\n\n");
    const related = title ? paragraphs.findIndex(text => !/^#{1,6} /.test(text) && text.includes(title)) : -1;
    if (related >= 0) {
      paragraphs.splice(related + 1, 0, block);
      current = paragraphs.join("\n\n");
    } else {
      const keys = sourcesHeadingKeys(template);
      const lines = current.split("\n");
      const code = fencedLines(lines);
      const at = lines.findIndex((line, index) => {
        const heading = code[index] ? null : /^###\s+(.+?)\s*$/.exec(line);
        return !!heading && keys.has(heading[1].toLocaleLowerCase());
      });
      current =
        at < 0
          ? [current.trimEnd(), block].filter(Boolean).join("\n\n")
          : [lines.slice(0, at).join("\n").trimEnd(), block, lines.slice(at).join("\n").trimStart()]
              .filter(Boolean)
              .join("\n\n");
    }
  }
  return current;
}

function initialPreview(summary: string, detail: string): string {
  const image = detail.match(/!\[[^\]]*\]\((?:https?:\/\/[^)\s]+)\)/)?.[0];
  return [summary.trim(), image].filter(Boolean).join("\n\n");
}

function noteBody(
  title: string,
  summary: string,
  language: NoteLanguage,
  prompt = "",
  rules = "",
  preview = "",
  detail = "",
  visualReferences = "",
  newFindings = "",
  leftover = "",
  layout: "answer-first" | "legacy" = "answer-first"
): string {
  if (layout === "legacy") {
    const legacyBlock = `${DETAIL_START}\n${detailWithVisualReferences(detail, visualReferences, standardTemplate(language))}\n${DETAIL_END}`;
    return (
      [
        `# ${title}`,
        `## Current Summary\n\n${summary.trim() || placeholder(language)}`,
        `## Prompt\n\n${prompt.trim()}`,
        rules.trim() ? `## Rules\n\n${rules.trim()}` : "",
        `## ${previewHeading(language)}\n\n${preview.trim()}`,
        `## Detail\n\n${legacyBlock}`,
        newFindings.trim() ? `## Working Findings\n\n${newFindings.trim()}` : "",
        leftover.trim()
      ]
        .filter(Boolean)
        .join("\n\n") + "\n"
    );
  }
  const { text: readerDetail, marker } = splitOpenItems(detail);
  const detailBlock = `${DETAIL_START}\n${detailWithVisualReferences(readerDetail, visualReferences, standardTemplate(language))}\n${DETAIL_END}${marker ? `\n\n${marker}` : ""}`;
  // The answer comes first: summary, the Preview callout (it feeds the hover card), then Detail; the task text follows
  // as a collapsed callout, and an empty (or placeholder) Preview and an empty Prompt are left out. Whether Preview was initialized stays in frontmatter.
  return (
    [
      `# ${title}`,
      `## Current Summary\n\n${summary.trim() || placeholder(language)}`,
      preview.trim() && !isPlaceholder(preview.trim()) ? calloutSection(previewHeading(language), preview) : "",
      `## Detail\n\n${detailBlock}`,
      prompt.trim() ? calloutSection("Prompt", prompt) : "",
      rules.trim() ? `## Rules\n\n${rules.trim()}` : "",
      newFindings.trim() ? `## Working Findings\n\n${newFindings.trim()}` : "",
      leftover.trim()
    ]
      .filter(Boolean)
      .join("\n\n") + "\n"
  );
}

function normalizeBodyOrder(
  content: string,
  title: string,
  summaryFallback: string,
  language: NoteLanguage,
  textLanguage: NoteLanguage = language
): string {
  const clean = ensurePreview(withoutReference(content), language, textLanguage);
  const currentSummary = section(clean, "Current Summary") || summaryFallback;
  const summary = isPlaceholder(currentSummary) ? placeholder(textLanguage) : currentSummary;
  const prompt = section(clean, "Prompt");
  const rules = section(clean, "Rules");
  const preview = previewSection(clean);
  const detail = detailWithVisualReferences(
    section(clean, "Detail"),
    section(clean, "Visual References"),
    standardTemplate(language)
  );
  const newFindings = section(clean, "Working Findings") || section(clean, "New Findings");
  let leftover = clean.replace(/^# .*$(?:\r?\n)*/m, "");
  // An open-items marker saved after the Detail block is left over once Detail is removed; it goes back beside Detail.
  const openItems = splitOpenItems(leftover);
  leftover = openItems.text;
  for (const heading of [
    "Current Summary",
    "Prompt",
    "Rules",
    "預覽",
    "Preview",
    "Detail",
    "Visual References",
    "Working Findings",
    "New Findings"
  ] as NoteSection[])
    leftover = removeSection(leftover, heading);
  const withMarker = openItems.marker && !splitOpenItems(detail).marker ? `${detail}\n\n${openItems.marker}` : detail;
  // A note written before the answer-first layout (its Prompt sits above Detail) keeps its layout, so a write that
  // does not change its content leaves it byte-identical; new notes use the answer-first layout.
  const detailAt = clean.search(/^## Detail\s*$/m);
  const legacy = /^## Prompt\s*$/m.test(detailAt >= 0 ? clean.slice(0, detailAt) : clean);
  return noteBody(
    title,
    summary,
    language,
    prompt,
    rules,
    preview,
    withMarker,
    "",
    newFindings,
    leftover,
    legacy ? "legacy" : "answer-first"
  );
}

const REFERENCE_LABELS = ["所屬主題", "所屬心智圖", "母議題", "子議題", "來源議題", "狀態"];
const ENGLISH_REFERENCE_LABELS = ["Topic", "Mind map", "Parent topic", "Child topics", "Source topic", "Status"];
/** The fixed text of a note's relationship lines, by note language (the labels are in the order of {@link REFERENCE_LABELS}). */
interface ReferenceText {
  readonly labels: readonly string[];
  readonly none: string;
  readonly archived: string;
  readonly unassigned: string;
  readonly colon: string;
  readonly listSeparator: string;
}
const REFERENCE_TEXT: Readonly<Record<NoteLanguage, ReferenceText>> = {
  "zh-TW": {
    labels: REFERENCE_LABELS,
    none: "無",
    archived: "已封存",
    unassigned: "未歸類",
    colon: "：",
    listSeparator: "、"
  },
  en: {
    labels: ENGLISH_REFERENCE_LABELS,
    none: "None",
    archived: "Archived",
    unassigned: "Unassigned",
    colon: ": ",
    listSeparator: ", "
  }
};
function localizeReference(value: string, language: NoteLanguage): string {
  const match =
    /^(所屬主題|所屬心智圖|母議題|子議題|來源議題|狀態|Topic|Mind map|Parent topic|Child topics|Source topic|Status)[：:]\s*(.*)$/.exec(
      value
    );
  if (!match) return value;
  const index = (REFERENCE_LABELS.includes(match[1]) ? REFERENCE_LABELS : ENGLISH_REFERENCE_LABELS).indexOf(match[1]);
  const target = REFERENCE_TEXT[language];
  const plain =
    match[2] === "無" || match[2] === "None"
      ? target.none
      : match[2] === "已封存" || match[2] === "Archived"
        ? target.archived
        : match[2] === "未歸類" || match[2] === "Unassigned"
          ? target.unassigned
          : match[2];
  return `${target.labels[index]}${target.colon}${plain}`;
}

/**
 * The language a note's derived scaffolding (Preview heading, summary placeholder, relationship labels) is already
 * written in, or undefined when it has none. A rebuild keeps it, so changing the UI language never relabels notes.
 */
function derivedLabelLanguage(content: string, fm: Record<string, unknown>): NoteLanguage | undefined {
  if (Array.isArray(fm["agent-map-references"]))
    for (const entry of fm["agent-map-references"]) {
      const label = /^([^：:]+)[：:]/.exec(String(entry))?.[1];
      if (label && REFERENCE_LABELS.includes(label)) return "zh-TW";
      if (label && ENGLISH_REFERENCE_LABELS.includes(label)) return "en";
    }
  if (/^(?:## |> \[!info\][+-]? )預覽[ \t]*$/m.test(content)) return "zh-TW";
  if (/^(?:## |> \[!info\][+-]? )Preview[ \t]*$/m.test(content)) return "en";
  const summary = section(content, "Current Summary");
  if (summary === placeholder("zh-TW")) return "zh-TW";
  if (summary === placeholder("en")) return "en";
  return undefined;
}

function withReferenceLinks(body: string, fm: Record<string, unknown>, language: NoteLanguage): string {
  const sources = Array.isArray(fm["source-notes"]) ? fm["source-notes"].map(String).filter(Boolean) : [];
  const relationships = Array.isArray(fm["agent-map-references"])
    ? fm["agent-map-references"].map(String).filter(text => text.includes("[["))
    : [];
  const label = translate(language, "note.source_topic_label");
  const links = [
    ...relationships.map(value => localizeReference(value, language)),
    ...sources.map(path => `${label}[[${noteLink(path)}]]`)
  ];
  const clean = withoutReference(body).trimEnd();
  return links.length
    ? `${clean}\n\n${REFERENCE_START}\n## Reference Links\n\n${[...new Set(links)].map(link => `- ${link}`).join("\n")}\n${REFERENCE_END}\n`
    : `${clean}\n`;
}

function noteLink(path: string): string {
  return path.replace(/\.md$/, "").replace(/\|/g, "\\|");
}

/** Files an OS leaves in a folder; they do not make it non-empty. */
const OS_LITTER = new Set([".ds_store", "thumbs.db", "desktop.ini"]);
const VAULT_WRITES = new Set([
  "create",
  "createBinary",
  "createFolder",
  "modify",
  "process",
  "append",
  "delete",
  "trash",
  "rename",
  "copy"
]);
const FILE_MANAGER_WRITES = new Set(["renameFile", "trashFile", "processFrontMatter"]);

/** A view of `target` whose write methods throw once `disposed()` is true; reads and everything else pass through. */
function guardWrites<T extends object>(target: T, writes: Set<string>, disposed: () => boolean, message: string): T {
  return new Proxy(target, {
    get(object, property) {
      const value = Reflect.get(object, property, object) as unknown;
      if (typeof property !== "string" || typeof value !== "function") return value;
      const call = value as (this: object, ...args: unknown[]) => unknown;
      return writes.has(property)
        ? (...args: unknown[]) => {
            if (disposed()) return Promise.reject(new Error(message));
            return Reflect.apply(call, object, args);
          }
        : (...args: unknown[]): unknown => Reflect.apply(call, object, args);
    }
  });
}

export class Repository {
  readonly app: App;
  /** Set when the plugin unloads: from then on no Repository write point does anything (in-flight work stops at its next write). */
  private disposed = false;

  constructor(
    app: App,
    readonly settings: Settings
  ) {
    const stopped = (): boolean => this.disposed;
    const message = "Visual Agent Map was unloaded; this write was not performed.";
    this.app = new Proxy(app, {
      get(object, property) {
        const value = Reflect.get(object, property, object) as unknown;
        if (property === "vault") return guardWrites(value as object, VAULT_WRITES, stopped, message);
        if (property === "fileManager") return guardWrites(value as object, FILE_MANAGER_WRITES, stopped, message);
        return value;
      }
    });
  }

  /**
   * The single decision of which language a note's derived scaffolding (relationship labels, Preview heading, summary
   * placeholder, Reference Links) is written in: the language it already has, else the current UI language. Every writer
   * of such text uses this, so no write path can relabel a note just because the UI language differs.
   */
  scaffoldLanguage(content: string, fm: Record<string, unknown>): NoteLanguage {
    return derivedLabelLanguage(content, fm) ?? this.noteLanguage;
  }

  /** Called from onunload: no later write (including a rollback) may happen. */
  dispose(): void {
    this.disposed = true;
  }
  isDisposed(): boolean {
    return this.disposed;
  }

  /** Containers that temporarily count as managed while a folder-setting change moves topics into them. */
  private pendingContainers: string[] = [];
  /** Called once per vault-wide scan that skipped unreadable maps. */
  onUnreadableMaps?: (failures: { path: string; error: string }[]) => void;

  /** The language fixed note text is written in for the current interface language (always "zh-TW" or "en"). */
  private get noteLanguage(): NoteLanguage {
    return noteLanguageOf(this.settings.language);
  }

  private message(key: TranslationKey): string {
    return translate(this.settings.language, key);
  }

  file(path: string): TFile {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) throw new Error(`${this.message("error.file_not_found")}: ${path}`);
    return file;
  }

  hasNote(path: string): boolean {
    return this.app.vault.getAbstractFileByPath(path) instanceof TFile;
  }

  async folder(path: string): Promise<void> {
    let current = "";
    for (const part of normalizePath(path).split("/").filter(Boolean)) {
      current = current ? `${current}/${part}` : part;
      if (!this.app.vault.getAbstractFileByPath(current)) await this.app.vault.createFolder(current);
    }
  }

  workspaceExists(): boolean {
    return this.app.vault.getAbstractFileByPath(this.settings.workspaceFolder) instanceof TFolder;
  }

  async workspaceCandidates(): Promise<string[]> {
    const candidates = new Set<string>();
    // The folder names are the configured ones (relative to the workspace folder) plus the defaults and legacy Topics.
    const workspace = `${this.settings.workspaceFolder}/`;
    const names = new Set(["Topics", "Mind Maps", "AIM"]);
    for (const folder of managedMapContainers(this.settings))
      names.add(folder.startsWith(workspace) ? folder.slice(workspace.length) : (folder.split("/").at(-1) ?? folder));
    const escape = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const containerPattern = new RegExp(`^(.*)/(?:${[...names].map(escape).join("|")})/[^/]+/Map\\.md$`);
    for (const file of this.app.vault.getMarkdownFiles()) {
      const match = file.path.match(containerPattern);
      if (!match?.[1]) continue;
      try {
        parseMap(await this.app.vault.read(file));
        candidates.add(match[1]);
      } catch {
        /* Ignore unrelated files named Map.md. */
      }
    }
    return [...candidates].sort((left, right) => left.localeCompare(right));
  }

  async ensureWorkspace(): Promise<void> {
    await this.folder(this.settings.mindMapsFolder);
    await this.folder(this.settings.aimFolder);
  }

  unique(folder: string, name: string, avoid?: ReadonlySet<string>): string {
    const base = normalizePath(`${folder}/${safeName(name)}`);
    let path = `${base}.md`,
      number = 2;
    while (avoid?.has(path) || this.pathTaken(path)) path = `${base} ${number++}.md`;
    return path;
  }

  /** Taken when the path exists, or when a sibling has the same name once case and Unicode form are folded. */
  private pathTaken(path: string): boolean {
    return !!this.app.vault.getAbstractFileByPath(path) || !!this.foldedSibling(path, "");
  }

  /** A child of `path`'s folder whose folded name equals `path`'s, other than `exclude`. */
  private foldedSibling(path: string, exclude: string): TAbstractFile | null {
    const folder = this.app.vault.getAbstractFileByPath(parentPath(path));
    if (!(folder instanceof TFolder)) return null;
    const wanted = foldEntryName(path.split("/").at(-1) ?? path, /\.md$/i.test(path));
    return (
      folder.children.find(
        child => child.path !== exclude && foldEntryName(child.name, child instanceof TFile) === wanted
      ) ?? null
    );
  }

  uniqueFolder(folder: string, name: string): string {
    const base = normalizePath(`${folder}/${safeName(name)}`);
    let path = base,
      number = 2;
    while (this.app.vault.getAbstractFileByPath(path) || this.foldedSibling(path, "")) path = `${base} ${number++}`;
    return path;
  }

  topicRoot(mapPath: string): string {
    return parentPath(mapPath);
  }
  topicFolder(mapPath: string, collection: TopicCollection): string {
    return `${this.topicRoot(mapPath)}/${collection}`;
  }

  async ensureTopicFolders(root: string): Promise<void> {
    await this.folder(root);
    for (const name of ["Notes", "Unassigned", "Archive"]) await this.folder(`${root}/${name}`);
  }

  /**
   * The model a topic actually runs on. The stored `model:` is a creation-time snapshot and is never rewritten:
   * manual keeps it, workspace follows the current setting, inherited uses the nearest manual ancestor's stored model
   * and otherwise the current setting.
   */
  private async effectiveModel(
    path: string,
    stored: string | undefined,
    source: ModelSource,
    map?: MapDocument
  ): Promise<string> {
    const current = this.settings.cliModel;
    if (source === "manual") return stored || current;
    if (source === "workspace") return current;
    let owner = map?.nodes.some(node => node.path === path) ? map : undefined;
    if (!owner) {
      for (const file of await this.mapFiles()) {
        if (!path.startsWith(`${this.topicRoot(file.path)}/`)) continue;
        try {
          const candidate = await this.readMap(file.path);
          if (candidate.nodes.some(node => node.path === path)) {
            owner = candidate;
            break;
          }
        } catch {
          /* An unreadable map cannot supply ancestors. */
        }
      }
    }
    const seen = new Set<string>();
    let node = owner?.nodes.find(item => item.path === path);
    while (node && node.parentId && !seen.has(node.id)) {
      seen.add(node.id);
      const parent = owner!.nodes.find(item => item.id === node!.parentId);
      if (!parent) break;
      try {
        const fm = frontmatter(await this.app.vault.read(this.file(parent.path)));
        if (fm["model-source"] === "manual" && text(fm.model)) return text(fm.model);
      } catch {
        /* A missing ancestor note is skipped. */
      }
      node = parent;
    }
    return current;
  }

  async readNote(path: string, map?: MapDocument): Promise<Note> {
    const file = this.file(path),
      content = decodeCalloutSections(upgradeLegacyAimText(await this.app.vault.read(file))),
      fm = frontmatter(content);
    const status = text(fm.status, "idea");
    const normalized = status === "review" || status === "accepted" ? "completed" : status;
    const source = text(fm["model-source"], "workspace");
    const modelSource: ModelSource = ["workspace", "inherited", "manual"].includes(source)
      ? (source as ModelSource)
      : "workspace";
    const model = await this.effectiveModel(path, text(fm.model), modelSource, map);
    const state = text(
      fm["topic-state"],
      path.includes("/Archive/") ? "archived" : path.includes("/Unassigned/") ? "unassigned" : "active"
    );
    return {
      title: noteTitle(content, fm, file.basename),
      summary: section(content, "Current Summary") || text(fm.summary, placeholder(this.noteLanguage)),
      prompt: section(content, "Prompt"),
      rules: section(content, "Rules"),
      detail: detailWithOpenItems(content),
      thinkingOrigin: readThinkingOrigin(content),
      visualReferences: section(content, "Visual References"),
      newFindings: section(content, "Working Findings") || section(content, "New Findings"),
      preview: [previewSection(content), section(content, "User Notes")].filter(Boolean).join("\n\n"),
      previewSection: previewSection(content),
      previewInitialized: fm["preview-initialized"] === true,
      model,
      modelSource,
      reasoning: normalizeReasoningLevel(fm["reasoning-level"] ?? this.settings.cliReasoning),
      researchMode: fm["research-mode"] === "local" ? "local" : "research",
      researchDepth:
        fm["research-depth"] === "fast" || fm["research-depth"] === "deep" ? fm["research-depth"] : "normal",
      visualMode: fm["visual-mode"] === "on" || fm["visual-mode"] === "off" ? fm["visual-mode"] : "auto",
      ...(typeof fm["detail-template"] === "string" && fm["detail-template"]
        ? { detailTemplateId: fm["detail-template"] }
        : {}),
      ...(typeof fm.tone === "string" && fm.tone ? { toneId: fm.tone } : {}),
      ...(noteContentLanguage(fm) ? { contentLanguage: noteContentLanguage(fm) } : {}),
      ...(readRelevance(fm) ? { relevance: readRelevance(fm) } : {}),
      detailFormatIssues: Array.isArray(fm["detail-format-issues"])
        ? fm["detail-format-issues"].filter((v): v is string => typeof v === "string")
        : [],
      status: ["idea", "running", "completed", "error"].includes(normalized) ? (normalized as Status) : "idea",
      mapId: text(fm["agent-map-id"]),
      topicId: text(fm["topic-id"], text(fm["agent-map-id"])),
      topicState: ["active", "unassigned", "archived", "inbox"].includes(state) ? (state as TopicState) : "active",
      referencePaths: Array.isArray(fm["reference-materials"])
        ? fm["reference-materials"].filter((value): value is string => typeof value === "string" && Boolean(value))
        : [],
      sourcePaths: Array.isArray(fm["source-notes"])
        ? fm["source-notes"].filter((value): value is string => typeof value === "string" && Boolean(value))
        : []
    };
  }

  /**
   * `options.contentLanguage` is the AIM content language: it only chooses the language of generated placeholder text;
   * headings and the reference frame stay in the interface language. Notes created by AIM remember it in frontmatter.
   */
  async updateNote(
    path: string,
    patch: NotePatch,
    options: { contentLanguage?: NoteLanguage; detailTemplate?: DetailTemplate } = {}
  ): Promise<void> {
    await this.app.vault.process(this.file(path), content => {
      const fm = frontmatter(content);
      // One decision for every label this write emits: the note's own scaffolding language (see scaffoldLanguage).
      const language = this.scaffoldLanguage(content, fm);
      ensureNoteCssClass(fm);
      if (Array.isArray(fm["agent-map-references"]))
        fm["agent-map-references"] = fm["agent-map-references"].map(value =>
          localizeReference(String(value), language)
        );
      fm.title = patch.title ?? noteTitle(content, fm, baseName(path).replace(/\.md$/, ""));
      for (const key of ["summary", "model", "status"] as const) if (patch[key] !== undefined) fm[key] = patch[key];
      if (patch.modelSource !== undefined) fm["model-source"] = patch.modelSource;
      if (patch.reasoning !== undefined) fm["reasoning-level"] = normalizeReasoningLevel(patch.reasoning);
      if (patch.researchMode !== undefined) fm["research-mode"] = patch.researchMode;
      if (patch.researchDepth !== undefined) fm["research-depth"] = patch.researchDepth;
      if (patch.visualMode !== undefined) fm["visual-mode"] = patch.visualMode;
      if (patch.detailTemplateId !== undefined)
        patch.detailTemplateId ? (fm["detail-template"] = patch.detailTemplateId) : delete fm["detail-template"];
      if (patch.toneId !== undefined) patch.toneId ? (fm.tone = patch.toneId) : delete fm.tone;
      if (patch.detailFormatIssues !== undefined)
        patch.detailFormatIssues.length
          ? (fm["detail-format-issues"] = patch.detailFormatIssues)
          : delete fm["detail-format-issues"];
      if (patch.mapId !== undefined) patch.mapId ? (fm["agent-map-id"] = patch.mapId) : delete fm["agent-map-id"];
      if (patch.topicId !== undefined) patch.topicId ? (fm["topic-id"] = patch.topicId) : delete fm["topic-id"];
      if (patch.topicState !== undefined) fm["topic-state"] = patch.topicState;
      if (patch.referencePaths !== undefined)
        patch.referencePaths.length
          ? (fm["reference-materials"] = [...new Set(patch.referencePaths)])
          : delete fm["reference-materials"];
      if (patch.sourcePaths !== undefined)
        patch.sourcePaths.length ? (fm["source-notes"] = patch.sourcePaths) : delete fm["source-notes"];
      fm.updated = new Date().toISOString();
      let body = decodeCalloutSections(content.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, ""));
      // AIM notes carry their content language; every other note keeps following the interface language.
      const textLanguage = options.contentLanguage ?? noteContentLanguage(fm) ?? language;
      if (options.contentLanguage !== undefined && noteContentLanguage(fm) === undefined)
        fm["content-language"] = options.contentLanguage;
      body = ensurePreview(body, language, textLanguage);
      if (isPlaceholder(text(fm.summary))) fm.summary = placeholder(textLanguage);
      if (patch.title !== undefined) {
        const heading = managedHeadingValue(patch.title);
        body = body.replace(/^# .*$/m, () => `# ${heading}`);
      }
      if (patch.summary !== undefined) body = replaceSummarySection(body, patch.summary);
      if (patch.prompt !== undefined) body = replaceSection(body, "Prompt", patch.prompt);
      if (patch.rules !== undefined) body = replaceSection(body, "Rules", patch.rules);
      // A new detail carries its own open items, if any; the marker of the old one goes with it.
      if (patch.detail !== undefined) body = replaceSection(splitOpenItems(body).text, "Detail", patch.detail);
      if (patch.thinkingOrigin !== undefined)
        body = replaceSection(body, "Thinking Origin", originMarkdown(patch.thinkingOrigin));
      if (patch.visualReferences !== undefined) {
        body = removeSection(body, "Visual References");
        if (patch.visualReferences.trim())
          body = replaceSection(
            body,
            "Detail",
            detailWithVisualReferences(
              section(body, "Detail"),
              patch.visualReferences,
              options.detailTemplate ?? standardTemplate(language)
            )
          );
      }
      if (patch.newFindings !== undefined) {
        if (patch.newFindings.trim()) body = replaceSection(body, "Working Findings", patch.newFindings);
        else {
          body = removeSection(body, "Working Findings");
          body = removeSection(body, "New Findings");
        }
      }
      if (patch.preview !== undefined) {
        body = replaceSection(body, previewHeading(language), patch.preview);
        fm["preview-initialized"] = true;
      } else if (patch.previewSection !== undefined) {
        body = replaceSection(body, previewHeading(language), patch.previewSection);
      } else if (
        patch.summary !== undefined &&
        patch.summary.trim() &&
        !isPlaceholder(patch.summary) &&
        fm["preview-initialized"] !== true
      ) {
        const preview = previewSection(body).trim();
        if (!preview || isPlaceholder(preview))
          body = replaceSection(body, previewHeading(language), initialPreview(patch.summary, section(body, "Detail")));
        fm["preview-initialized"] = true;
      }
      if (patch.previewInitialized !== undefined) fm["preview-initialized"] = patch.previewInitialized;
      body = normalizeBodyOrder(
        body,
        text(fm.title, path.replace(/\.md$/, "")),
        text(fm.summary, placeholder(textLanguage)),
        language,
        textLanguage
      );
      return `---\n${stringifyYaml(fm)}---\n${withReferenceLinks(body, fm, language)}`;
    });
  }

  async createNote(
    title: string,
    model: string,
    map: MapDocument,
    mapPath: string,
    modelSource: ModelSource,
    initial: Pick<NotePatch, "detail" | "thinkingOrigin" | "summary" | "reasoning"> = {},
    onCreate?: (path: string) => void
  ): Promise<MapNode> {
    const folder = this.topicFolder(mapPath, "Notes");
    await this.ensureTopicFolders(this.topicRoot(mapPath));
    const id = crypto.randomUUID();
    const metadata = {
      "agent-map-node": true,
      "node-id": id,
      "topic-id": map.id,
      "topic-state": "active",
      "agent-map-id": map.id,
      title,
      summary: placeholder(this.noteLanguage),
      "preview-initialized": false,
      model,
      "model-source": modelSource,
      "reasoning-level": initial.reasoning ?? this.settings.cliReasoning,
      status: "idea",
      cssclasses: [NOTE_CSS_CLASS]
    };
    const origin = initial.thinkingOrigin ? `## Thinking Origin\n\n${originMarkdown(initial.thinkingOrigin)}` : "";
    const created = await this.createUniqueNote(
      folder,
      title,
      `---\n${stringifyYaml(metadata)}---\n${noteBody(title, initial.summary ?? placeholder(this.noteLanguage), this.noteLanguage, "", "", placeholder(this.noteLanguage), initial.detail ?? "", "", "", origin)}`,
      onCreate
    );
    return { id, path: created.path, parentId: null, x: 80, y: 80, collapsed: false };
  }

  /**
   * Creates a note at a free name. If the file system still reports "already exists" (a case-insensitive collision
   * `pathTaken` could not see), it tries the next free suffix, at most 5 times. Returns the file actually created.
   */
  private async createUniqueNote(
    folder: string,
    title: string,
    content: string,
    onCreate?: (path: string) => void
  ): Promise<TFile> {
    const failed = new Set<string>();
    for (let attempt = 1; ; attempt++) {
      const path = this.unique(folder, title, failed);
      onCreate?.(path);
      try {
        return await this.app.vault.create(path, content);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (attempt >= 5 || !/already exists/i.test(message)) throw error;
        failed.add(path);
      }
    }
  }

  /** Idempotently create a reserved note identity for a journaled AIM result draft. */
  async createNoteAt(
    title: string,
    model: string,
    map: MapDocument,
    mapPath: string,
    modelSource: ModelSource,
    path: string,
    id: string,
    initial: Pick<NotePatch, "detail" | "thinkingOrigin" | "summary" | "reasoning" | "prompt"> & {
      /** Language of the placeholder text only (AIM content language); section headings stay in the interface language. */
      contentLanguage?: NoteLanguage;
    } = {}
  ): Promise<MapNode> {
    const textLanguage = initial.contentLanguage ?? this.noteLanguage;
    const folder = this.topicFolder(mapPath, "Notes");
    await this.ensureTopicFolders(this.topicRoot(mapPath));
    if (parentPath(path) !== folder || !path.endsWith(".md") || !id.trim())
      throw new Error("A reserved note must use a valid identity inside this map's Notes folder.");
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing) {
      if (existing instanceof TFile) {
        const fm = frontmatter(await this.app.vault.read(existing));
        if (marker(fm["agent-map-node"]) && text(fm["node-id"]) === id)
          return { id, path, parentId: null, x: 80, y: 80, collapsed: false };
      }
      throw new Error(`Reserved result note path already belongs to another file: ${path}`);
    }
    const metadata = {
      "agent-map-node": true,
      "node-id": id,
      "topic-id": map.id,
      "topic-state": "active",
      "agent-map-id": map.id,
      title,
      summary: initial.summary ?? placeholder(textLanguage),
      "preview-initialized": false,
      model,
      "model-source": modelSource,
      "reasoning-level": initial.reasoning ?? this.settings.cliReasoning,
      status: "idea",
      cssclasses: [NOTE_CSS_CLASS],
      ...(initial.contentLanguage ? { "content-language": initial.contentLanguage } : {})
    };
    const origin = initial.thinkingOrigin ? `## Thinking Origin\n\n${originMarkdown(initial.thinkingOrigin)}` : "";
    await this.app.vault.create(
      path,
      `---\n${stringifyYaml(metadata)}---\n${noteBody(title, metadata.summary, this.noteLanguage, initial.prompt ?? "", "", placeholder(textLanguage), initial.detail ?? "", "", "", origin)}`
    );
    return { id, path, parentId: null, x: 80, y: 80, collapsed: false };
  }

  async duplicateNote(sourcePath: string, map: MapDocument, mapPath: string): Promise<MapNode> {
    const folder = this.topicFolder(mapPath, "Notes");
    await this.ensureTopicFolders(this.topicRoot(mapPath));
    const source = await this.app.vault.read(this.file(sourcePath));
    const metadata = frontmatter(source);
    const sourceTitle = text(metadata.title, this.file(sourcePath).basename);
    const suffixLanguage = textLanguageOf(sourceTitle, resolveMapTextLanguage(map, this.settings.language));
    const title = `${sourceTitle} ${translateNote(suffixLanguage, "note.copy_suffix")}`;
    const id = crypto.randomUUID();
    metadata["node-id"] = id;
    metadata["topic-id"] = map.id;
    metadata["agent-map-id"] = map.id;
    metadata["topic-state"] = "active";
    metadata.title = title;
    const body = source.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "").replace(/^# .*$/m, `# ${title}`);
    const created = await this.createUniqueNote(folder, title, `---\n${stringifyYaml(metadata)}---\n${body}`);
    return { id, path: created.path, parentId: null, x: 80, y: 80, collapsed: false };
  }

  async readMap(path: string): Promise<MapDocument> {
    return parseMap(await this.app.vault.read(this.file(path)));
  }

  /** The map file's `relevance-goal` frontmatter, if any. The map file keeps its frontmatter across saves. */
  async readRelevanceGoal(path: string): Promise<string | undefined> {
    return readRelevanceGoal(frontmatter(await this.app.vault.read(this.file(path))));
  }

  /** The goal, level and context keys of the map file in one read. */
  async readRelevanceSetup(path: string): Promise<RelevanceSetup> {
    const fm = frontmatter(await this.app.vault.read(this.file(path)));
    return { goal: readRelevanceGoal(fm), level: readRelevanceLevel(fm), context: readRelevanceContext(fm) };
  }

  /**
   * Sets or removes only the relevance keys of a note's frontmatter (`relevance-tier`, `relevance-reason`,
   * `relevance-manual`). An AI grade writes the tier and reason and removes the manual flag; a tier set by hand
   * (`manual`) writes the tier and `relevance-manual: true` and removes the reason; null removes all three. The body
   * and every other key stay as they were, and `updated` is not bumped: grading is not an edit of the note.
   */
  async writeRelevance(path: string, value: NoteRelevance | null): Promise<void> {
    const reason = value && !value.manual ? value.reason.replace(/\s+/g, " ").trim() : "";
    if (value && !value.manual && !reason) throw new Error("A relevance reason is required.");
    await this.app.vault.process(this.file(path), content =>
      setFrontmatterKeys(content, {
        "relevance-tier": value ? value.tier : null,
        "relevance-reason": value && !value.manual ? reason : null,
        "relevance-manual": value?.manual ? true : null
      })
    );
  }

  /**
   * Sets the map's `relevance-goal`, `relevance-level` and `relevance-context` (a missing level or context removes
   * its key) in one write and, when the goal differs from the current goal (or there was none), appends
   * `"YYYY-MM-DD: <goal>"` (local date) to `relevance-goal-history`. Only those keys change; the history records the
   * goal alone. `changed` is about the goal (the history); `setupChanged` is true when any of the three values
   * differs. Resolves with what was there before, for {@link restoreRelevanceGoal}.
   */
  async writeRelevanceGoal(
    mapPath: string,
    goal: string,
    level?: RelevanceLevel,
    context?: string
  ): Promise<{ previous: RelevanceGoalState; next: RelevanceGoalState; changed: boolean; setupChanged: boolean }> {
    const next = normalizeRelevanceGoal(goal);
    if (!next) throw new Error("A relevance goal is required.");
    const nextLevel = readRelevanceLevel({ "relevance-level": level });
    const nextContext = context === undefined ? undefined : normalizeRelevanceContext(context);
    let previous: RelevanceGoalState = { goal: undefined, history: undefined };
    let nextState: RelevanceGoalState = { goal: next, history: undefined, level: nextLevel, context: nextContext };
    let changed = false;
    let setupChanged = false;
    await this.app.vault.process(this.file(mapPath), content => {
      const fm = frontmatter(content);
      previous = {
        goal: typeof fm["relevance-goal"] === "string" ? fm["relevance-goal"] : undefined,
        history: Array.isArray(fm["relevance-goal-history"])
          ? fm["relevance-goal-history"].filter((item): item is string => typeof item === "string")
          : undefined,
        level: typeof fm["relevance-level"] === "string" ? (fm["relevance-level"] as RelevanceLevel) : undefined,
        context: typeof fm["relevance-context"] === "string" ? fm["relevance-context"] : undefined
      };
      changed = previous.goal?.trim() !== next;
      setupChanged = changed || readRelevanceLevel(fm) !== nextLevel || readRelevanceContext(fm) !== nextContext;
      nextState = {
        goal: next,
        history: changed ? [...(previous.history ?? []), `${localDate()}: ${next}`] : previous.history,
        level: nextLevel,
        context: nextContext
      };
      return setFrontmatterKeys(content, {
        "relevance-goal": next,
        "relevance-level": nextLevel ?? null,
        "relevance-context": nextContext ?? null,
        ...(changed ? { "relevance-goal-history": nextState.history ?? null } : {})
      });
    });
    return { previous, next: nextState, changed, setupChanged };
  }

  /** Puts the goal, level, context and history keys back exactly as {@link writeRelevanceGoal} found them (a missing value removes the key). */
  async restoreRelevanceGoal(mapPath: string, state: RelevanceGoalState): Promise<void> {
    await this.app.vault.process(this.file(mapPath), content =>
      setFrontmatterKeys(content, {
        "relevance-goal": state.goal ?? null,
        "relevance-level": state.level ?? null,
        "relevance-context": state.context ?? null,
        "relevance-goal-history": state.history ?? null
      })
    );
  }

  /**
   * Legacy AIM maps have no stored content language. Persist the derived value the first time the map is written
   * anyway (never on open), so later interface-language changes cannot change it.
   */
  private stampAimContentLanguage(map: MapDocument): void {
    if (!map.aim) return;
    const resolved = resolveAimContentLanguage(map, this.settings.language);
    if (map.aim.contentLanguage === undefined) map.aim.contentLanguage = noteLanguageOf(resolved);
    // Both fields are written together on the first write; a map upgraded from the note-language-only form gets the
    // output-only language pinned here so a later title edit cannot change it.
    if (map.aim.outputLanguage === undefined && isOutputOnlyLanguage(resolved)) map.aim.outputLanguage = resolved;
  }

  async saveMap(path: string, map: MapDocument): Promise<void> {
    this.stampAimContentLanguage(map);
    await this.app.vault.process(this.file(path), content => {
      parseMap(content);
      return writeMapContent(content, map);
    });
  }

  /**
   * Read-modify-write on the current file content in one vault.process call, so a caller holding an older copy of
   * the map cannot overwrite fields it did not change (for example, research state saved meanwhile).
   */
  async updateMap(path: string, change: (map: MapDocument) => void): Promise<MapDocument> {
    let updated: MapDocument | undefined;
    await this.app.vault.process(this.file(path), content => {
      const map = parseMap(content);
      change(map);
      this.stampAimContentLanguage(map);
      updated = map;
      return writeMapContent(content, map);
    });
    return updated!;
  }

  /**
   * Markdown files whose frontmatter sets `key`. Indexed files are judged from the metadata cache; only files the
   * cache has not indexed yet (for example, created moments ago) are read, so a large vault is not read in full.
   */
  async markedFiles(key: "visual-agent-map" | "agent-map-node"): Promise<TFile[]> {
    const files: TFile[] = [];
    for (const file of this.app.vault.getMarkdownFiles()) {
      const cache = this.app.metadataCache.getFileCache(file);
      if (cache ? marker(cache.frontmatter?.[key]) : marker(frontmatter(await this.app.vault.cachedRead(file))[key]))
        files.push(file);
    }
    return files;
  }

  async mapFiles(): Promise<TFile[]> {
    return (await this.markedFiles("visual-agent-map")).sort((a, b) => a.path.localeCompare(b.path));
  }

  /**
   * Vault-wide scans read every map through here: a map that cannot be parsed is skipped (never written) and
   * reported once per scan, so one broken Map.md does not stop the scan or leave later maps stale. Opening or editing
   * one specific map keeps using readMap and still surfaces its error.
   */
  async readableMaps(): Promise<{ file: TFile; map: MapDocument }[]> {
    return (await this.scanMaps()).readable;
  }

  /**
   * Only for scans that tolerate a missing map; destructive planners (migration) must use readMap so a broken map
   * fails them loudly instead of being skipped.
   */
  private async scanMaps(): Promise<{
    readable: { file: TFile; map: MapDocument }[];
    skippedRoots: string[];
  }> {
    const readable: { file: TFile; map: MapDocument }[] = [],
      failures: { path: string; error: string }[] = [];
    for (const file of await this.mapFiles()) {
      try {
        readable.push({ file, map: await this.readMap(file.path) });
      } catch (error) {
        failures.push({ path: file.path, error: error instanceof Error ? error.message : String(error) });
      }
    }
    if (failures.length) this.onUnreadableMaps?.(failures);
    return { readable, skippedRoots: failures.map(item => this.topicRoot(item.path)) };
  }

  /**
   * Whether a rename of `file` (previously at `oldPath`) can affect VAM data, decided from the metadata cache without
   * reading notes: the file is a VAM note or map, or a VAM note cites the old path. Uncached files count as relevant.
   */
  renameAffectsVam(file: TFile, oldPath: string): boolean {
    const own = this.app.metadataCache.getFileCache(file);
    if (!own || marker(own.frontmatter?.["agent-map-node"]) || marker(own.frontmatter?.["visual-agent-map"]))
      return true;
    for (const note of this.app.vault.getMarkdownFiles()) {
      const fm = this.app.metadataCache.getFileCache(note)?.frontmatter;
      if (!fm || !marker(fm["agent-map-node"])) continue;
      if ([fm["source-notes"], fm["reference-materials"]].some(list => Array.isArray(list) && list.includes(oldPath)))
        return true;
    }
    return false;
  }

  /** Whether any map lists `path` as a node; only map files are read. */
  async isMapNodePath(path: string): Promise<boolean> {
    for (const { map } of await this.readableMaps()) if (map.nodes.some(node => node.path === path)) return true;
    return false;
  }

  async reconcileMissingNodePaths(): Promise<number> {
    const candidates = new Map<string, string[]>();
    for (const file of await this.markedFiles("agent-map-node")) {
      const fm = this.app.metadataCache.getFileCache(file)?.frontmatter ?? frontmatter(await this.app.vault.read(file));
      const id = text(fm["node-id"]);
      if (id) candidates.set(id, [...(candidates.get(id) ?? []), file.path]);
    }
    let repaired = 0;
    for (const { file, map } of await this.readableMaps()) {
      let changed = false;
      for (const node of [...map.nodes]) {
        if (this.app.vault.getAbstractFileByPath(node.path) instanceof TFile) continue;
        const matches = candidates.get(node.id) ?? [];
        if (matches.length !== 1) continue;
        const oldPath = node.path;
        rebaseMapNotePaths(map, moveNotePath(oldPath, matches[0]));
        changed = true;
        repaired++;
        await this.replaceSourcePath(oldPath, matches[0]);
      }
      if (changed) await this.saveMap(file.path, map);
    }
    return repaired;
  }

  async topics(): Promise<TopicInfo[]> {
    const topics: TopicInfo[] = [];
    for (const { file, map } of await this.readableMaps()) {
      topics.push({ id: map.id, title: map.title, mapPath: file.path, root: this.topicRoot(file.path) });
    }
    return topics;
  }

  async brokenTopics(): Promise<BrokenTopic[]> {
    const broken: BrokenTopic[] = [];
    for (const containerPath of managedMapContainers(this.settings)) {
      const root = this.app.vault.getAbstractFileByPath(containerPath);
      if (!(root instanceof TFolder)) continue;
      for (const child of root.children) {
        if (!(child instanceof TFolder) || this.app.vault.getAbstractFileByPath(`${child.path}/Map.md`)) continue;
        const prefix = `${child.path}/Notes/`;
        const noteCount = this.app.vault.getMarkdownFiles().filter(file => file.path.startsWith(prefix)).length;
        broken.push({ title: child.name, root: child.path, noteCount });
      }
    }
    return broken.sort((a, b) => a.title.localeCompare(b.title));
  }

  async rebuildMissingMap(root: string): Promise<string> {
    const path = `${root}/Map.md`;
    if (this.app.vault.getAbstractFileByPath(path)) throw new Error(this.message("error.map_already_exists"));
    const files = this.app.vault
      .getMarkdownFiles()
      .filter(
        file =>
          file.path.startsWith(`${root}/Notes/`) &&
          marker(this.app.metadataCache.getFileCache(file)?.frontmatter?.["agent-map-node"])
      );
    const first = files[0] ? await this.readNote(files[0].path) : null,
      id = first?.topicId || crypto.randomUUID();
    const nodes: MapNode[] = files.map((file, index) => ({
      id: crypto.randomUUID(),
      path: file.path,
      parentId: null,
      x: 80 + Math.floor(index / 6) * 340,
      y: 80 + (index % 6) * 220,
      collapsed: false
    }));
    const map: MapDocument = { version: 1, id, title: baseName(root), nodes, viewport: { x: 40, y: 40, zoom: 1 } };
    await this.app.vault.create(path, serializeMap(map, this.noteLanguage));
    for (const file of files) await this.setLifecycle(file.path, id, id, "active");
    await this.rebuildDerivedData();
    return path;
  }

  async relinkMissingMap(root: string, sourcePath: string): Promise<string> {
    const target = `${root}/Map.md`;
    if (this.app.vault.getAbstractFileByPath(target)) throw new Error(this.message("error.map_already_exists"));
    const map = await this.readMap(sourcePath),
      candidates = this.app.vault.getMarkdownFiles().filter(file => file.path.startsWith(`${root}/Notes/`));
    const byId = new Map<string, string>();
    for (const file of candidates) {
      const fm = frontmatter(await this.app.vault.read(file));
      const id = text(fm["node-id"]);
      if (id) byId.set(id, file.path);
    }
    for (const node of [...map.nodes])
      if (!(this.app.vault.getAbstractFileByPath(node.path) instanceof TFile) && byId.has(node.id))
        rebaseMapNotePaths(map, moveNotePath(node.path, byId.get(node.id)!));
    await this.moveExact(sourcePath, target);
    await this.saveMap(target, map);
    for (const node of map.nodes)
      if (this.app.vault.getAbstractFileByPath(node.path) instanceof TFile)
        await this.setLifecycle(node.path, map.id, map.id, "active");
    await this.rebuildDerivedData();
    return target;
  }

  async assignedNotePaths(exceptMapId?: string): Promise<Set<string>> {
    const assigned = new Set<string>();
    for (const { map } of await this.readableMaps()) {
      if (map.id === exceptMapId) continue;
      for (const node of map.nodes) assigned.add(node.path);
    }
    return assigned;
  }

  async collectionFiles(mapPath: string, collection: TopicCollection): Promise<TFile[]> {
    const prefix = `${this.topicFolder(mapPath, collection)}/`;
    return this.app.vault
      .getMarkdownFiles()
      .filter(
        file =>
          file.path.startsWith(prefix) &&
          marker(this.app.metadataCache.getFileCache(file)?.frontmatter?.["agent-map-node"])
      )
      .sort((a, b) => a.basename.localeCompare(b.basename));
  }

  async moveUnique(path: string, folder: string): Promise<string> {
    await this.folder(folder);
    const file = this.file(path),
      desired = normalizePath(`${folder}/${baseName(path)}`);
    const target = this.app.vault.getAbstractFileByPath(desired) ? this.unique(folder, file.basename) : desired;
    await this.relocate(file, target);
    await this.replaceSourcePath(path, target);
    return target;
  }

  async moveExact(path: string, target: string): Promise<void> {
    await this.folder(parentPath(target));
    if (this.app.vault.getAbstractFileByPath(target))
      throw new Error(`${this.message("error.target_exists")}: ${target}`);
    await this.relocate(this.file(path), target);
    await this.replaceSourcePath(path, target);
  }

  async renameNote(path: string, title: string, exactTarget?: string): Promise<string> {
    await this.updateNote(path, { title });
    const folder = parentPath(path),
      desired = exactTarget ?? normalizePath(`${folder}/${safeName(title)}.md`);
    if (desired === path) return path;
    const target =
      exactTarget ?? (this.app.vault.getAbstractFileByPath(desired) ? this.unique(folder, title) : desired);
    await this.relocate(this.file(path), target);
    await this.replaceSourcePath(path, target);
    return target;
  }

  /**
   * Moves or renames a note or folder. When every note that links to it is a VAM note, the move is made with
   * `vault.rename` (no "Update links" dialog) and the links in those VAM notes are rewritten here. When any other
   * note links to it, Obsidian's own `renameFile` runs so the user's link preference is honoured, after one Notice.
   * The link rewrite reads the notes' current text, not the metadata cache, so a note rewritten a moment ago by the
   * previous move of the same operation is handled correctly. If a rewrite cannot be applied (the note changed in the
   * meantime) this undoes its own writes and the move, then throws, so the caller's rollback sees an unmoved note.
   */
  private async relocate(item: TFile | TFolder, target: string): Promise<void> {
    const resolvedLinks = this.app.metadataCache.resolvedLinks as Record<string, Record<string, number>> | undefined;
    if (!resolvedLinks) {
      await this.app.fileManager.renameFile(item, target);
      return;
    }
    const moves = new Map<string, string>();
    const collect = (entry: TFile | TFolder): void => {
      if (entry instanceof TFile) moves.set(entry.path, `${target}${entry.path.slice(item.path.length)}`);
      else for (const child of entry.children) if (child instanceof TFile || child instanceof TFolder) collect(child);
    };
    collect(item);
    const plan = await this.planLinkRewrites(item, moves, resolvedLinks);
    if (plan.foreign > 0) {
      new Notice(translate(this.settings.language, "ui.move_links_dialog_notice_0", plan.foreign));
      await this.app.fileManager.renameFile(item, target);
      return;
    }
    const origin = item.path;
    await this.app.vault.rename(item, target);
    // Trust the disk, not the await: the note must really be at its new place before its links are rewritten.
    if (!this.app.vault.getAbstractFileByPath(target)) throw new Error(this.message("error.move_not_applied"));
    const written: Array<{ path: string; before: string; after: string }> = [];
    try {
      for (const edit of plan.edits) {
        const path = moves.get(edit.path) ?? edit.path,
          file = this.app.vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile)) throw new Error(`${this.message("error.file_not_found")}: ${path}`);
        await this.app.vault.process(file, current => {
          if (current !== edit.before)
            throw new Error(translate(this.settings.language, "error.move_links_note_changed_0", path));
          return edit.after;
        });
        written.push({ path, before: edit.before, after: edit.after });
      }
    } catch (error) {
      try {
        for (const entry of written.reverse()) {
          const file = this.app.vault.getAbstractFileByPath(entry.path);
          if (file instanceof TFile)
            await this.app.vault.process(file, current => (current === entry.after ? entry.before : current));
        }
        const moved = this.app.vault.getAbstractFileByPath(target);
        if (moved) await this.app.vault.rename(moved, origin);
      } catch (rollbackError) {
        const original = error instanceof Error ? error.message : String(error);
        throw new Error(
          translate(
            this.settings.language,
            "error.move_undo_failed_0",
            original,
            rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
          )
        );
      }
      throw error;
    }
  }

  /**
   * Which notes would have to change for `moves` (old path to new path): `foreign` counts notes Obsidian must update
   * (any non-VAM note, or a VAM note whose link cannot be rewritten here); `edits` holds the complete new text of each
   * VAM note whose links change. Computed before anything is moved, so a failure writes nothing.
   */
  private async planLinkRewrites(
    item: TFile | TFolder,
    moves: ReadonlyMap<string, string>,
    resolvedLinks: Record<string, Record<string, number>>
  ): Promise<{ foreign: number; edits: Array<{ path: string; before: string; after: string }> }> {
    // The metadata cache drops or lags a note's frontmatter right after VAM created or rewrote it (an earlier move of
    // the same operation), so a miss there is not proof of a foreign note: the note's own text decides.
    const owned = async (file: TFile): Promise<boolean> => {
      const cached = this.app.metadataCache.getFileCache(file)?.frontmatter;
      if (marker(cached?.["agent-map-node"]) || marker(cached?.["visual-agent-map"])) return true;
      const fm = frontmatter(await this.app.vault.read(file));
      return marker(fm["agent-map-node"]) || marker(fm["visual-agent-map"]);
    };
    const foreign = new Set<string>(),
      candidates = new Map<string, TFile>();
    for (const [linkerPath, targets] of Object.entries(resolvedLinks)) {
      if (!Object.keys(targets).some(path => moves.has(path))) continue;
      const linker = this.app.vault.getAbstractFileByPath(linkerPath);
      // A path that no longer exists is a cache entry that lags behind a move VAM just made; the note is found at its new path below.
      if (!linker) continue;
      if (linker instanceof TFile && linker.extension === "md" && (await owned(linker)))
        candidates.set(linkerPath, linker);
      else foreign.add(linkerPath);
    }
    // The cache can lag behind VAM's own recent writes, so VAM notes are also found by their current text.
    // Moving a folder keeps every file name, so only full-path links (which contain the folder path) can change.
    const needles = item instanceof TFolder ? [`${item.path}/`] : [item.path.replace(/\.md$/i, ""), item.basename];
    for (const file of await this.markedFiles("agent-map-node")) {
      if (candidates.has(file.path) || foreign.has(file.path)) continue;
      const text = await this.app.vault.cachedRead(file);
      if (needles.some(needle => text.includes(needle))) candidates.set(file.path, file);
    }
    const edits: Array<{ path: string; before: string; after: string }> = [];
    for (const [path, file] of candidates) {
      const before = await this.app.vault.read(file),
        resolve = (linkPath: string): string | undefined =>
          linkPath ? this.app.metadataCache.getFirstLinkpathDest(linkPath, path)?.path : undefined;
      const { head, body } = splitFrontmatter(before);
      // Frontmatter links are VAM's own `agent-map-references`, regenerated by rebuildDerivedData; any other key is the user's.
      // `source-notes` and `reference-materials` hold plain vault paths, not wikilinks, and are repaired by replaceSourcePath.
      const fm = frontmatter(before);
      const userKeyLink = Object.entries(fm).some(
        ([key, value]) =>
          key !== "agent-map-references" &&
          findWikilinks(JSON.stringify(value)).some(link => moves.has(resolve(linkPathOf(link.target)) ?? ""))
      );
      const result = rewriteLinkTargets(body, resolve, moves);
      if (userKeyLink || result.unsupported.length) {
        foreign.add(path);
        continue;
      }
      if (result.text !== body) edits.push({ path, before, after: head + result.text });
    }
    return { foreign: foreign.size, edits };
  }

  async replaceSourcePath(oldPath: string, newPath: string): Promise<void> {
    if (oldPath === newPath) return;
    for (const file of await this.markedFiles("agent-map-node")) {
      // Skip notes whose indexed frontmatter does not mention the old path.
      const cached = this.app.metadataCache.getFileCache(file)?.frontmatter;
      if (
        cached &&
        ![cached["source-notes"], cached["reference-materials"]].some(
          list => Array.isArray(list) && list.includes(oldPath)
        )
      )
        continue;
      const note = await this.readNoteIfManaged(file);
      if (note?.referencePaths?.includes(oldPath))
        await this.updateNote(file.path, {
          referencePaths: note.referencePaths.map(path => (path === oldPath ? newPath : path))
        });
      if (!note?.sourcePaths.includes(oldPath)) continue;
      await this.updateNote(file.path, {
        sourcePaths: note.sourcePaths.map(path => (path === oldPath ? newPath : path))
      });
    }
  }

  private async readNoteIfManaged(file: TFile): Promise<Note | null> {
    const content = await this.app.vault.read(file),
      fm = frontmatter(content);
    return marker(fm["agent-map-node"]) ? this.readNote(file.path) : null;
  }

  async normalizeGeneratedNoteFilenames(): Promise<number> {
    let renamed = 0;
    for (const { file: mapFile, map } of await this.readableMaps()) {
      let changed = false;
      for (const node of map.nodes) {
        const file = this.app.vault.getAbstractFileByPath(node.path);
        if (!(file instanceof TFile) || !/^新的子議題(?: \d+)*$/.test(file.basename)) continue;
        const note = await this.readNote(node.path);
        if (!note.title.trim() || safeName(note.title) === file.basename) continue;
        const oldPath = node.path,
          newPath = await this.renameNote(oldPath, note.title);
        rebaseMapNotePaths(map, moveNotePath(oldPath, newPath));
        changed = true;
        renamed++;
        await this.replaceSourcePath(oldPath, newPath);
      }
      if (changed) await this.saveMap(mapFile.path, map);
    }
    for (const file of await this.markedFiles("agent-map-node")) {
      if (!/^新的子議題(?: \d+)*$/.test(file.basename)) continue;
      const note = await this.readNoteIfManaged(file);
      if (!note || !note.title.trim() || safeName(note.title) === file.basename) continue;
      const oldPath = file.path,
        newPath = await this.renameNote(oldPath, note.title);
      await this.replaceSourcePath(oldPath, newPath);
      renamed++;
    }
    if (renamed) await this.rebuildDerivedData();
    return renamed;
  }

  async setLifecycle(path: string, topicId: string, mapId: string, state: TopicState): Promise<void> {
    await this.updateNote(path, { topicId, mapId, topicState: state });
  }

  /**
   * Rebuilds derived note fields. `scope` limits which notes are rewritten (maps are always read in full): a folder
   * prefix, or several roots plus individual note paths (a move rebuilds only the moved topics and their citing notes).
   */
  async rebuildDerivedData(scope?: string | { roots: string[]; paths?: Iterable<string> }): Promise<void> {
    const roots = typeof scope === "string" ? [scope] : (scope?.roots ?? []),
      extra = new Set(typeof scope === "string" ? [] : (scope?.paths ?? []));
    const inScope = (path: string): boolean =>
      !scope || extra.has(path) || roots.some(root => path.startsWith(`${root}/`));
    const ownership = new Map<string, { map: MapDocument; mapPath: string; node: MapNode }>();
    const topics = new Map<string, { map: MapDocument; mapPath: string }>();
    const scan = await this.scanMaps();
    for (const { file: mapFile, map } of scan.readable) {
      topics.set(map.id, { map, mapPath: mapFile.path });
      for (const node of map.nodes) {
        const existing = ownership.get(node.path);
        if (existing && existing.map.id !== map.id)
          throw new Error(`${this.message("error.note_in_multiple_maps")}: ${node.path}`);
        ownership.set(node.path, { map, mapPath: mapFile.path, node });
      }
    }

    // Map-owned paths are included even if the metadata cache has not caught up with a just-written note.
    const nodeFiles = new Map((await this.markedFiles("agent-map-node")).map(file => [file.path, file]));
    for (const path of ownership.keys()) {
      const file = this.app.vault.getAbstractFileByPath(path);
      if (file instanceof TFile) nodeFiles.set(path, file);
    }
    for (const file of nodeFiles.values()) {
      if (!inScope(file.path)) continue;
      // Notes inside an unreadable map's folder are not judged without that map: leave them exactly as they are.
      if (scan.skippedRoots.some(root => file.path.startsWith(`${root}/`) && !ownership.has(file.path))) continue;
      // Compare against the in-memory copy, then derive again from the file's current content inside the write,
      // so an edit made after this read is not replaced by stale text.
      const cached = await this.app.vault.cachedRead(file),
        derived = this.derivedNoteContent(file, cached, ownership, topics);
      if (derived === null || derived === cached) continue;
      await this.app.vault.process(
        file,
        content => this.derivedNoteContent(file, content, ownership, topics) ?? content
      );
    }
  }

  /** The node note with derived lifecycle fields and references applied, or null when it is not a VAM node note. */
  private derivedNoteContent(
    file: TFile,
    content: string,
    ownership: Map<string, { map: MapDocument; mapPath: string; node: MapNode }>,
    topics: Map<string, { map: MapDocument; mapPath: string }>
  ): string | null {
    const fm = frontmatter(content);
    if (!marker(fm["agent-map-node"])) return null;
    // Existing derived labels keep their language; only a note without any uses the current UI language.
    const language = this.scaffoldLanguage(content, fm);
    ensureNoteCssClass(fm);
    fm.title = noteTitle(content, fm, file.basename);
    const owner = ownership.get(file.path);
    // `topic-state: inbox` is a legacy value (the Inbox concept was removed in 0.19): it is read and kept as written.
    let state: TopicState = file.path.includes("/Archive/")
      ? "archived"
      : file.path.includes("/Unassigned/")
        ? "unassigned"
        : owner
          ? "active"
          : (text(fm["topic-state"], "unassigned") as TopicState);
    if (owner) {
      fm["agent-map-id"] = owner.map.id;
      fm["topic-id"] = owner.map.id;
      fm["topic-state"] = "active";
      state = "active";
      if (fm["model-source"] === undefined) fm["model-source"] = owner.node.parentId ? "inherited" : "workspace";
    } else {
      delete fm["agent-map-id"];
      if (state === "inbox") {
        // Legacy Inbox note: keep topic-id and the state exactly as written.
        fm["topic-state"] = "inbox";
      } else if (
        fm["topic-state"] !== undefined ||
        file.path.includes("/Archive/") ||
        file.path.includes("/Unassigned/")
      )
        fm["topic-state"] = state;
      // else: an unowned note that never had a state keeps none (no rewrite just to say "unassigned").
    }
    // Notes owned by an AIM map write their placeholder text in the map's content language.
    const textLanguage = owner?.map.aim
      ? noteLanguageOf(resolveAimContentLanguage(owner.map, language))
      : (noteContentLanguage(fm) ?? language);
    let body = ensurePreview(
      decodeCalloutSections(content.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "")),
      language,
      textLanguage
    );
    if (isPlaceholder(text(fm.summary))) fm.summary = placeholder(textLanguage);
    const topicId = text(fm["topic-id"]),
      topic = topics.get(topicId);
    if (owner) {
      if (!body.includes(DETAIL_START)) body = replaceSection(body, "Detail", section(body, "Detail"));
      const parent = owner.node.parentId ? owner.map.nodes.find(item => item.id === owner.node.parentId) : undefined;
      const children = owner.map.nodes.filter(item => item.parentId === owner.node.id);
      const ref = REFERENCE_TEXT[language];
      const [topicLabel, mapLabel, parentLabel, childLabel] = ref.labels;
      fm["agent-map-references"] = [
        `${topicLabel}${ref.colon}[[${noteLink(owner.mapPath)}|${linkAlias(owner.map.title, aliasFallback(owner.mapPath))}]]`,
        `${mapLabel}${ref.colon}[[${noteLink(owner.mapPath)}]]`,
        `${parentLabel}${ref.colon}${parent ? `[[${noteLink(parent.path)}]]` : ref.none}`,
        `${childLabel}${ref.colon}${
          children.length ? children.map(child => `[[${noteLink(child.path)}]]`).join(ref.listSeparator) : ref.none
        }`
      ];
      body = withoutReference(body);
    } else if (topic && (state === "unassigned" || state === "archived")) {
      const ref = REFERENCE_TEXT[language];
      const [topicLabel, , , , , statusLabel] = ref.labels;
      fm["agent-map-references"] = [
        `${topicLabel}${ref.colon}[[${noteLink(topic.mapPath)}|${linkAlias(topic.map.title, aliasFallback(topic.mapPath))}]]`,
        `${statusLabel}${ref.colon}${state === "archived" ? ref.archived : ref.unassigned}`
      ];
      body = withoutReference(body);
    } else {
      delete fm["agent-map-references"];
      body = withoutReference(body);
    }
    body = normalizeBodyOrder(
      body,
      text(fm.title, file.basename),
      text(fm.summary, placeholder(textLanguage)),
      language,
      textLanguage
    );
    return `---\n${stringifyYaml(fm)}---\n${withReferenceLinks(body, fm, language)}`;
  }

  async ensureNodePresentation(): Promise<void> {
    for (const file of await this.markedFiles("agent-map-node")) {
      const fm = frontmatter(await this.app.vault.cachedRead(file));
      if (!marker(fm["agent-map-node"]) || !ensureNoteCssClass(fm)) continue;
      // Rebuild from the current content so an edit after the check above is kept.
      await this.app.vault.process(file, content => {
        const current = frontmatter(content);
        if (!marker(current["agent-map-node"]) || !ensureNoteCssClass(current)) return content;
        const body = content.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "");
        return `---\n${stringifyYaml(current)}---\n${body}`;
      });
    }
  }

  async createMap(
    title: string,
    nodes: MapNode[] = [],
    onRootCreated?: (folder: TFolder) => void,
    aim?: MapDocument["aim"]
  ): Promise<string> {
    const container = aim ? this.settings.aimFolder : this.settings.mindMapsFolder;
    await this.folder(container);
    const preferredRoot = normalizePath(`${container}/${safeName(title)}`);
    const preferredFolder = this.app.vault.getAbstractFileByPath(preferredRoot);
    // A failed first Map.md write can leave only the just-created empty topic folder.
    // For an identity-bearing AIM create, reuse that empty folder on retry;
    // any non-empty existing folder remains untouched and receives the usual suffix.
    const recoverEmptyAimFolder =
      !!aim?.creationId && preferredFolder instanceof TFolder && preferredFolder.children.length === 0;
    const root = recoverEmptyAimFolder ? preferredRoot : this.uniqueFolder(container, title);
    const folder =
      recoverEmptyAimFolder && preferredFolder instanceof TFolder
        ? preferredFolder
        : await this.app.vault.createFolder(root);
    onRootCreated?.(folder);
    if (!aim?.creationId) await this.ensureTopicFolders(root);
    const path = `${root}/Map.md`;
    const map: MapDocument = {
      version: 1,
      id: crypto.randomUUID(),
      title,
      nodes,
      viewport: { x: 40, y: 40, zoom: 1 },
      ...(aim ? { aim } : {})
    };
    await this.app.vault.create(path, serializeMap(map, this.noteLanguage));
    // Persist the request identity before adding subfolders so a partial setup can be found and resumed.
    if (aim?.creationId) await this.ensureTopicFolders(root);
    return path;
  }

  /** Why `path` cannot be a Mind Maps/AIM folder, or null: empty, inside/around the legacy Topics folder, or clashing with the other one. */
  mapFolderProblem(key: "mindMapsFolder" | "aimFolder", path: string): "error.map_folder_invalid" | null {
    const other = this.settings[key === "mindMapsFolder" ? "aimFolder" : "mindMapsFolder"];
    const related = (a: string, b: string): boolean => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
    const workspace = this.settings.workspaceFolder;
    if (!path || path === workspace || !path.startsWith(`${workspace}/`)) return "error.map_folder_invalid";
    if (path.split("/").some(part => !part || part === "." || part === "..")) return "error.map_folder_invalid";
    if (related(path, this.settings.topicsFolder) || related(path, other)) return "error.map_folder_invalid";
    return null;
  }

  /**
   * Changes the Mind Maps/AIM folder on the same move engine as Organize: every topic in the old container moves to the
   * new one (links, node paths and cited paths follow; any failure restores everything and the setting is unchanged),
   * then the old folder is removed only if it is empty. Returns old Map.md path -> new Map.md path.
   * `busy` lets the caller veto when an open view has AIM work running.
   */
  async changeMapFolder(
    key: "mindMapsFolder" | "aimFolder",
    path: string,
    busy: (mapPath: string) => boolean = () => false,
    onProgress?: MoveProgress
  ): Promise<Map<string, string>> {
    const next = normalizePath(path),
      current = this.settings[key];
    if (next === current) return new Map();
    const problem = this.mapFolderProblem(key, next);
    if (problem) throw new Error(this.message(problem));
    const old = this.app.vault.getAbstractFileByPath(current);
    let mapping = new Map<string, string>();
    if (old instanceof TFolder) {
      const moves: OrganizeMove[] = [];
      for (const file of await this.mapFiles()) {
        const root = parentPath(file.path);
        if (file.name !== "Map.md" || parentPath(root) !== current) continue;
        let map: MapDocument;
        try {
          map = await this.readMap(file.path);
        } catch {
          throw new Error(this.message("error.map_folder_unreadable"));
        }
        if (hasActiveAimAttempt(map) || busy(file.path)) throw new Error(this.message("error.organize_aim_busy"));
        const toRoot = normalizePath(`${next}/${root.split("/").at(-1) ?? safeName(map.title)}`);
        if (this.app.vault.getAbstractFileByPath(toRoot)) throw new Error(this.message("error.map_folder_exists"));
        moves.push({ mapPath: file.path, title: map.title, kind: map.aim ? "aim" : "mind", fromRoot: root, toRoot });
      }
      if (moves.length || !this.app.vault.getAbstractFileByPath(next)) {
        await this.folder(parentPath(next));
        if (!this.app.vault.getAbstractFileByPath(next)) await this.folder(next);
      }
      mapping = await this.runTopicMoves(moves, [next], onProgress);
      const left = this.app.vault.getAbstractFileByPath(current);
      // Never delete a non-empty folder; a failed removal only leaves an empty folder behind.
      if (left instanceof TFolder && left.children.length === 0) {
        try {
          await this.app.fileManager.trashFile(left);
        } catch {
          /* The empty old folder stays. */
        }
      }
    }
    this.settings[key] = next;
    return mapping;
  }

  /** The legacy folders that are cleaned up once empty: the old Topics folder and the old Inbox folder. */
  legacyCleanupFolders(): string[] {
    return [this.settings.topicsFolder, `${this.settings.workspaceFolder}/Inbox`];
  }

  /**
   * Whether `path` holds nothing but OS litter on disk. Obsidian's vault tree hides dot-files and dot-folders, so a
   * folder that looks empty there can still hold user content (.git, .sessions, hidden notes): ask the disk. Folders in
   * `allowed` (topics about to move out) do not count. A failed listing counts as not empty.
   */
  private async emptyOnDisk(path: string, allowed: Set<string> = new Set()): Promise<boolean> {
    try {
      const listing = await this.app.vault.adapter.list(path);
      return (
        listing.folders.every(folder => allowed.has(folder)) &&
        listing.files.every(file => OS_LITTER.has((file.split("/").at(-1) ?? file).toLowerCase()))
      );
    } catch {
      return false;
    }
  }

  /**
   * Which legacy folders are (or, after `plan`'s moves, will be) empty both in Obsidian's vault tree and on disk (OS
   * litter aside). Never lists a folder that still holds anything, hidden content included.
   */
  async emptyLegacyFolders(plan?: OrganizePlan): Promise<string[]> {
    const moving = new Set((plan?.moves ?? []).map(move => move.fromRoot));
    const empty: string[] = [];
    for (const path of this.legacyCleanupFolders()) {
      const folder = this.app.vault.getAbstractFileByPath(path);
      if (!(folder instanceof TFolder) || !folder.children.every(child => moving.has(child.path))) continue;
      if (await this.emptyOnDisk(path, moving)) empty.push(path);
    }
    return empty;
  }

  /** Moves the legacy Topics/Inbox folders to the trash only if empty (re-checked on disk right before); returns what went. */
  async removeEmptyLegacyFolders(): Promise<string[]> {
    const removed: string[] = [];
    for (const path of this.legacyCleanupFolders()) {
      if (this.disposed) break;
      const folder = this.app.vault.getAbstractFileByPath(path);
      if (!(folder instanceof TFolder) || folder.children.length) continue;
      if (!(await this.emptyOnDisk(path))) continue;
      try {
        await this.app.fileManager.trashFile(folder);
        removed.push(path);
      } catch {
        /* The empty folder stays. */
      }
    }
    return removed;
  }

  /**
   * Read-only preview of "Organize workspace folders": every readable topic folder directly inside the legacy Topics
   * folder moves to Mind Maps (no `aim`) or AIM (`aim`). Unreadable maps are listed, never moved; a running or saving
   * AIM attempt anywhere refuses the whole batch.
   */
  async planOrganizeWorkspaceFolders(): Promise<OrganizePlan> {
    const plan: OrganizePlan = { moves: [], skipped: [], busy: [] };
    const reserved = new Set<string>();
    for (const file of await this.mapFiles()) {
      const root = parentPath(file.path);
      if (file.name !== "Map.md" || parentPath(root) !== this.settings.topicsFolder) continue;
      let map: MapDocument;
      try {
        map = await this.readMap(file.path);
      } catch (error) {
        plan.skipped.push({ mapPath: file.path, error: error instanceof Error ? error.message : String(error) });
        continue;
      }
      if (hasActiveAimAttempt(map)) plan.busy.push(map.title);
      const container = map.aim ? this.settings.aimFolder : this.settings.mindMapsFolder;
      // A misconfigured target equal to the source container would rename every topic on every run.
      if (container === this.settings.topicsFolder) continue;
      const base = normalizePath(`${container}/${root.split("/").at(-1) ?? safeName(map.title)}`);
      let toRoot = base,
        number = 2;
      while (this.app.vault.getAbstractFileByPath(toRoot) || reserved.has(toRoot)) toRoot = `${base} ${number++}`;
      reserved.add(toRoot);
      plan.moves.push({ mapPath: file.path, title: map.title, kind: map.aim ? "aim" : "mind", fromRoot: root, toRoot });
    }
    return plan;
  }

  /**
   * Moves each planned topic folder with Obsidian's rename (so links update) via renameTopic. Any failure restores every
   * topic already moved (folder, Map.md text, path references). Returns old Map.md path -> new Map.md path.
   */
  async organizeWorkspaceFolders(plan: OrganizePlan, onProgress?: MoveProgress): Promise<Map<string, string>> {
    if (plan.busy.length) throw new Error(this.message("error.organize_aim_busy"));
    return this.runTopicMoves(plan.moves, [], onProgress);
  }

  /**
   * The shared move engine (Organize and folder-setting changes): re-checks for AIM work right before the first write,
   * moves each topic, and on any failure restores every topic already moved. `alsoManaged` lists containers that are
   * not yet in the settings but hold topics during the move (so renameTopic and the rollback accept them).
   */
  private async runTopicMoves(
    moves: OrganizeMove[],
    alsoManaged: string[] = [],
    onProgress?: MoveProgress
  ): Promise<Map<string, string>> {
    // Re-check just before the first write: the plan may be stale.
    for (const move of moves)
      if (hasActiveAimAttempt(await this.readMap(move.mapPath)))
        throw new Error(this.message("error.organize_aim_busy"));
    this.pendingContainers = alsoManaged;
    try {
      return await this.moveTopicsWithRollback(moves, onProgress);
    } finally {
      this.pendingContainers = [];
    }
  }

  private async moveTopicsWithRollback(moves: OrganizeMove[], onProgress?: MoveProgress): Promise<Map<string, string>> {
    const done: { move: OrganizeMove; newMapPath: string; originalMap: string; journal: PriorContent[] }[] = [],
      mapping = new Map<string, string>();
    // Only the moved topics and the notes that cite them can change: rebuild just those, once.
    const scope = (): { roots: string[]; paths: string[] } => ({
      roots: moves.flatMap(move => [move.fromRoot, move.toRoot]),
      paths: done.flatMap(item => item.journal.map(prior => prior.path))
    });
    try {
      for (const [index, move] of moves.entries()) {
        if (this.disposed) throw new Error(this.message("error.plugin_unloaded"));
        onProgress?.(index + 1, moves.length, move.title);
        await this.folder(parentPath(move.toRoot));
        const originalMap = await this.app.vault.read(this.file(move.mapPath));
        const newMapPath = await this.renameTopic(move.mapPath, move.title, move.toRoot, { rebuild: false });
        const journal: PriorContent[] = [];
        // Trust the disk, not the order of awaits: the topic must really be at its new place before going on.
        if (
          !(this.app.vault.getAbstractFileByPath(move.toRoot) instanceof TFolder) ||
          !(this.app.vault.getAbstractFileByPath(newMapPath) instanceof TFile)
        )
          throw new Error(this.message("error.move_not_applied"));
        done.push({ move, newMapPath, originalMap, journal });
        mapping.set(move.mapPath, newMapPath);
        await this.rebasePathPrefix(move.fromRoot, move.toRoot, journal);
      }
      await this.rebuildDerivedData(scope());
      return mapping;
    } catch (error) {
      const rollbackErrors: string[] = [];
      for (const { move, newMapPath, originalMap, journal } of [...done].reverse()) {
        try {
          // Put back the exact text of every note and map the path rebase rewrote, then undo the folder move.
          for (const prior of [...journal].reverse()) {
            const file = this.app.vault.getAbstractFileByPath(prior.path);
            if (file instanceof TFile) await this.app.vault.modify(file, prior.content);
          }
          await this.renameTopic(newMapPath, move.title, move.fromRoot, { rebuild: false });
          await this.app.vault.modify(this.file(`${move.fromRoot}/Map.md`), originalMap);
        } catch (rollbackError) {
          rollbackErrors.push(
            `${move.fromRoot}: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`
          );
        }
      }
      try {
        await this.rebuildDerivedData(scope());
      } catch (rebuildError) {
        rollbackErrors.push(rebuildError instanceof Error ? rebuildError.message : String(rebuildError));
      }
      if (rollbackErrors.length)
        throw new Error(
          `Organize failed (${error instanceof Error ? error.message : String(error)}); rollback also failed (${rollbackErrors.join("; ")}).`
        );
      throw error;
    }
  }

  /** After a folder move: point note `source-notes`/`reference-materials` and other maps' references at the new prefix. */
  private async rebasePathPrefix(from: string, to: string, journal: PriorContent[]): Promise<void> {
    const rebase = (path: string): string =>
      path.startsWith(`${from}/`) ? `${to}/${path.slice(from.length + 1)}` : path;
    for (const file of await this.markedFiles("agent-map-node")) {
      const cached = this.app.metadataCache.getFileCache(file)?.frontmatter;
      const mentions = (list: unknown): boolean =>
        Array.isArray(list) && list.some(item => typeof item === "string" && item.startsWith(`${from}/`));
      if (cached && !mentions(cached["source-notes"]) && !mentions(cached["reference-materials"])) continue;
      const note = await this.readNoteIfManaged(file);
      if (!note) continue;
      const patch: NotePatch = {};
      const references = note.referencePaths ?? [];
      if (references.some(path => rebase(path) !== path)) patch.referencePaths = references.map(rebase);
      if (note.sourcePaths.some(path => rebase(path) !== path)) patch.sourcePaths = note.sourcePaths.map(rebase);
      if (!Object.keys(patch).length) continue;
      journal.push({ path: file.path, content: await this.app.vault.read(file) });
      await this.updateNote(file.path, patch);
    }
    for (const { file, map } of await this.readableMaps()) {
      if (!rebaseMapNotePaths(map, rebase)) continue;
      journal.push({ path: file.path, content: await this.app.vault.read(file) });
      await this.saveMap(file.path, map);
    }
  }

  async renameTopic(
    mapPath: string,
    title: string,
    targetRoot?: string,
    options: { rebuild?: boolean } = {}
  ): Promise<string> {
    const file = this.file(mapPath),
      root = file.parent;
    if (
      !(root instanceof TFolder) ||
      !(isManagedMapPath(this.settings, mapPath) || this.pendingContainers.some(c => mapPath.startsWith(`${c}/`)))
    )
      throw new Error(this.message("error.legacy_map_view_only"));
    // A rename keeps the topic in the container it is already in (Mind Maps, AIM or legacy Topics).
    const desired = targetRoot
      ? normalizePath(targetRoot)
      : normalizePath(`${parentPath(root.path)}/${safeName(title)}`);
    if (
      desired !== root.path &&
      (this.app.vault.getAbstractFileByPath(desired) || (!targetRoot && this.foldedSibling(desired, root.path)))
    )
      throw new Error(this.message("error.topic_folder_exists"));
    const originalRoot = root.path;
    const originalMapPath = `${originalRoot}/Map.md`,
      originalContent = await this.app.vault.read(this.file(originalMapPath));
    const originalMap = parseMap(originalContent);
    if (hasActiveAimAttempt(originalMap)) {
      throw new Error(
        "An AIM research attempt is still running or saving. Wait for it to finish before renaming this topic."
      );
    }
    // A rename only changes this topic's folder: rebuild just it (or nothing, when a batch rebuilds once itself).
    const rebuild = async (): Promise<void> => {
      if (options.rebuild !== false) await this.rebuildDerivedData({ roots: [originalRoot, desired] });
    };
    const next = `${desired}/Map.md`;
    let moved = false;
    try {
      if (desired !== originalRoot) {
        await this.relocate(root, desired);
        moved = true;
        if (!(this.app.vault.getAbstractFileByPath(desired) instanceof TFolder))
          throw new Error(this.message("error.move_not_applied"));
      }
      const map = await this.readMap(next);
      map.title = title;
      const rebasePath = (path: string): string =>
        path.startsWith(`${originalRoot}/`) ? `${desired}/${path.slice(originalRoot.length + 1)}` : path;
      rebaseMapNotePaths(map, rebasePath);
      await this.saveMap(next, map);
      await rebuild();
      return next;
    } catch (error) {
      if (moved) {
        try {
          const movedRoot = this.app.vault.getAbstractFileByPath(desired);
          if (!(movedRoot instanceof TFolder)) throw new Error("Renamed topic folder was not found for rollback.");
          await this.relocate(movedRoot, originalRoot);
          const restoredMap = this.app.vault.getAbstractFileByPath(originalMapPath);
          if (!(restoredMap instanceof TFile))
            throw new Error("Original Map.md was not found after restoring the topic folder.");
          await this.app.vault.modify(restoredMap, originalContent);
          await rebuild();
        } catch (rollbackError) {
          const originalMessage = error instanceof Error ? error.message : String(error);
          throw new Error(
            `Topic rename failed (${originalMessage}); rollback also failed (${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}).`
          );
        }
      } else if (this.app.vault.getAbstractFileByPath(originalMapPath) instanceof TFile) {
        // A same-folder rename can still fail after the Map.md update; restore its exact source.
        await this.app.vault.modify(this.file(originalMapPath), originalContent);
        await rebuild();
      }
      throw error;
    }
  }

  async migrate(): Promise<void> {
    /* v0.2 import remains intentionally disabled; the pre-0.4 workspace migration was removed in 0.19. */
  }
}
