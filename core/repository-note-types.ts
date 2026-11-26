import type { NoteLanguage } from "../i18n";
import type { ReasoningLevel, ResearchMode, VisualMode } from "../ai/types";
import type { BookSettings, PipelineFields } from "./book-pipeline/model";
import type { HypothesisStrength, HypothesisLeaning, TopicKind, NoteRelevance } from "../note-values";
import type { TopicColor, TopicStyle } from "../topic-colors";
import type { TopicMarker } from "../topic-markers";

export type Status = "idea" | "running" | "completed" | "error";
export type ModelSource = "workspace" | "inherited" | "manual";
export type TopicState = "active" | "unassigned" | "archived" | "inbox";
export type TopicCollection = "Notes" | "Unassigned" | "Archive";
export interface Note extends PipelineFields {
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
  /** `""` = no `preview-auto-hash` key; `"manual"` = the user owns the preview; `"v1:<hex>"` = hash of the last auto-written text. */
  previewAutoHash: string;
  model: string;
  modelSource: ModelSource;
  /** True when the topic runs on its own model: a manual choice, or one inherited from a manual ancestor (the card shows a tag). */
  modelOverride?: boolean;
  reasoning?: ReasoningLevel;
  researchMode: ResearchMode;
  visualMode: VisualMode;
  detailTemplateId?: string;
  /** Per-topic tone preset id (frontmatter `tone`); absent = use the map default. */
  toneId?: string;
  /** From `note-style` frontmatter (a style ref, `builtin:<id>` or `file:<name>`); absent = none or empty. */
  noteStyle?: string;
  detailFormatIssues: string[];
  /** Why the last AI task on this note failed (frontmatter `last-error`); empty when none. */
  lastError: string;
  status: Status;
  mapId: string;
  topicId: string;
  topicState: TopicState;
  sourcePaths: string[];
  referencePaths?: string[];
  /** Read-only grading from frontmatter (see readRelevance); absent when missing or invalid. */
  relevance?: NoteRelevance;
  /** From `ai-locked: true` (see readAiLocked): AI may not change this topic or its relations. Absent = unlocked. */
  aiLocked?: true;
  /** From `reuse-last-result: true` (see readReuseLastResult): a Prompt topic that "run all" skips, its last returned summary standing in. Absent = off. */
  reuseLastResult?: true;
  /** The root topic's `book-*` settings; absent when none is set. */
  bookSettings?: BookSettings;
  /** From `topic-kind` frontmatter; set only for a hypothesis (absent = ordinary topic). */
  topicKind?: Exclude<TopicKind, "topic">;
  /** From `hypothesis-leaning`; set only for a hypothesis (missing or invalid reads as undecided). */
  hypothesisLeaning?: HypothesisLeaning;
  /** From `hypothesis-strength`; set only for a hypothesis (missing or invalid reads as none; weak when the leaning is supported or refuted and the stored strength is none). */
  hypothesisStrength?: HypothesisStrength;
  /** From `topic-markers` frontmatter, whitelisted ids only; absent when there are none. */
  markers?: TopicMarker[];
  /** From `topic-links` frontmatter, valid http(s) hrefs only; absent when there are none. */
  links?: string[];
  /** From `topic-color` frontmatter, a whitelisted id only; absent when there is none. */
  color?: TopicColor;
  /** From `topic-style` frontmatter, whitelisted tokens only (one text size at most); absent when there are none. */
  style?: TopicStyle[];
}
export type NotePatch = Partial<Note>;
