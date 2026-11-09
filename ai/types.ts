import type { CountIssue, DetailTemplate } from "./detail-templates";
import type { StyleSelection } from "../core/steps/task/assemble";
import type { AimContract } from "./aim-contracts";
import type { ContentLanguage } from "../i18n";
import type { ReferenceGroup } from "./reference-materials";
import type { UpdateMode } from "./note-style-recipe";

export type ReasoningLevel = "auto" | "low" | "medium" | "high";
export type ResearchMode = "local" | "research";
export type ResearchDepth = "fast" | "normal" | "deep";
export type VisualMode = "auto" | "on" | "off";
/** The map's two AI modes: Quick (no web, the model's own knowledge) and Standard (web, images). The helpers live next to the map view's dialogs. */
export type MapAiMode = "quick" | "standard";
export interface VisualReference {
  title: string;
  imageUrl: string;
  sourceUrl: string;
  description: string;
  palette: string[];
  formula: string;
}

export interface Suggestion {
  title: string;
  task: string;
  contribution: string;
  parentTitle?: string;
  thinkingOriginBaseline?: string;
}
export type AiTaskKind = "task" | "decompose" | "synthesize" | "merge";
export type PromptProfile = "aim";
export type AiResponseContract = "aim-gap-audit" | "aim-delivery-acceptance" | "argument-evidence";
/** One evidence need the argument map asks a research call to look up; `id` is the key the reply must cite. */
export interface ArgumentEvidenceNeed {
  id: string;
  text: string;
}
/**
 * One reply entry of the argument-evidence contract, parsed and shape-checked only: a found entry has a claim, a quote of 12 to
 * 200 characters and an http(s) url, which the program must still prove with `verifySource`; a not-found entry carries nothing else.
 */
export type ArgumentEvidenceItem =
  | {
      need: string;
      status: "found";
      stance: "supports" | "contradicts" | "uncertain";
      claim: string;
      quote: string;
      url: string;
    }
  | { need: string; status: "not_found" };
export interface TaskContext {
  title: string;
  summary: string;
  rules: string;
  detail: string;
  task: string;
  ancestors: string;
  /** Text nodes the user wrote under this topic (read-only context); empty or absent adds nothing to the prompt. */
  userTexts?: string;
  /** Summary brackets under this topic: framed child titles and the user's conclusion text, read-only; empty or absent adds nothing. */
  summaryDirections?: string;
  /**
   * Anchors of annotated images that relate to this topic (built by the map's anchor-context module): user-written, unverified,
   * read-only data, never a source to cite. Research and expand only; empty or absent adds nothing.
   */
  anchorContext?: string;
  workingFindings?: string;
  sourceContext?: string;
  referenceGroups?: ReferenceGroup[];
  /** "direct" (merge and synthesize): send the reference documents themselves when they fit one batch, instead of extracting findings first. */
  referenceDelivery?: "direct";
  onProgress?: (message: string) => void;
  /** Called once with the Working Findings text that was actually put in the prompt, after the context budget step (a count repair does not call it). */
  onWorkingFindingsSent?: (sent: string) => void;
  signal?: AbortSignal;
  /** The output content language (a `ContentLanguage`): names the language in prompts; the note language is `noteLanguageOf(...)` of it. */
  outputLanguage?: ContentLanguage;
  mode?: AiTaskKind;
  /** How a write-back treats the existing Detail (trusted, never serialized); absent means merge. */
  updateMode?: UpdateMode;
  /** Let a task choose its Markdown structure while retaining the structured result contract. */
  detailFormat?: "adaptive";
  /**
   * "AI suggested" note style (trusted, never serialized): the AI decides the sections of a first research ("decide"), keeps
   * the note's own ("follow"), or the general sections stand in because the note's cannot be used ("general"). Absent for every
   * other style.
   */
  aiSections?: "decide" | "follow" | "general";
  /** The detail is intermediate evidence for a later call, never shown to the reader: no Obsidian syntax rules. */
  intermediateDetail?: boolean;
  /** Content template for fixed-section details (trusted; Standard when absent). */
  detailTemplate?: DetailTemplate;
  /**
   * The template and tone the prompt assembler uses (trusted, never serialized). Absent: the assembler derives the
   * selection from `detailTemplate` and `toneText`.
   */
  styleSelection?: StyleSelection;
  /** Resolved writing-tone text (trusted). Absent for the default academic tone, so prompts stay unchanged. */
  toneText?: string;
  /** AIM final document only: the format rules of the user's note style, in place of the standard Obsidian format (trusted; never serialized). */
  aimNoteFormat?: string;
  /** Trusted flag: after the note is written, run the chart step once. Never serialized into a prompt. */
  addCharts?: boolean;
  /** internal: this request is the single count repair. */
  countRepair?: boolean;
  /** Select a phase-aware prompt builder for AIM requests. */
  promptProfile?: PromptProfile;
  /** Selects a narrow trusted response schema for the AIM gap audit only. */
  responseContract?: AiResponseContract;
  /**
   * Required with `responseContract: "argument-evidence"` (plus `researchMode: "research"`, no AIM profile): the needs this one
   * research call must answer, shown in the prompt as JSON; the reply may only cite these ids. Trusted, never serialized elsewhere.
   */
  argumentEvidenceNeeds?: readonly ArgumentEvidenceNeed[];
  /** Provider-enforced AIM control payload for this phase; folded back into the canonical marker form. */
  aimContract?: AimContract;
  /** Lets the AIM payload request full evidence reports by ID (trusted workflow flag; never serialized). */
  aimEvidenceLookup?: boolean;
  /** Trusted workflow lookup allowlist for AIM evidence retrieval; never serialize into prompts. */
  aimEvidenceIds?: readonly string[];
  /** Isolate independent research to supplied context and web tools. */
  aimIsolatedResearch?: boolean;
  /** Bounded timeout override for this task only. */
  timeoutMs?: number;
  researchMode?: ResearchMode;
  researchDepth?: ResearchDepth;
  /** Trusted: the map's AI mode for a research or expansion request. Quick (with local research) swaps in the Quick prompt text; never serialized. */
  mapAiMode?: MapAiMode;
  visualMode?: VisualMode;
  /** Trusted: the map file this request belongs to, for token-usage accounting only; never serialized into a prompt. */
  usageMapPath?: string;
}
/** Provider-neutral web activity event; Claude events are translated into the Codex App Server shape. */
export interface WebSearchEvent {
  method: "item/started" | "item/completed";
  params: unknown;
}
export type SearchStatus = "completed" | "failed" | "not_attempted";
export const SEARCH_STATUSES: readonly SearchStatus[] = ["completed", "failed", "not_attempted"];
/** searchStatus is present only for isolated web-research tasks, whose schema requires it. */
export interface AiResult {
  summary: string;
  detail: string;
  suggestions: Suggestion[];
  visualReferences: VisualReference[];
  searchStatus?: SearchStatus;
  /**
   * Web searches and page fetches the provider made for this answer. Set only on a standard research (Research mode, not AIM);
   * 0 means it answered without the web. Absent on every other result.
   */
  retrievals?: number;
  /**
   * Source-proof input for the argument map: the URLs the provider's tool log shows it opened successfully during this call
   * (from the web events' `action.url`). Additive and optional; no existing consumer reads it. Absent when not collected.
   */
  evidence?: { openedUrls: string[] };
  /** Argument-evidence contract only: the reply's per-need entries (ids already checked against the request). Absent otherwise. */
  argumentEvidence?: ArgumentEvidenceItem[];
  /** Sections still off their template count after the repair request; present only when the context had counts. */
  formatIssues?: CountIssue[];
  /**
   * "AI suggested" first research only: the template made from the sections the AI wrote (with a sources section), the one
   * the write-back, the note update and the chart job use. Absent otherwise.
   */
  decidedTemplate?: DetailTemplate;
  /** "AI suggested" first research only: the AI's sections were not usable and the Standard sections stand in. */
  aiSectionsFallback?: true;
}
export interface AiRunMetrics {
  provider: string;
  model: string;
  mode: AiTaskKind | "task";
  estimatedInputTokens: number;
  contextBreakdown: Record<string, number>;
  contextBuildMs: number;
  providerMs?: number;
  totalMs?: number;
  sessionStrategy: string;
}
export interface PreparedTaskContext {
  context: TaskContext;
  metrics: AiRunMetrics;
}
