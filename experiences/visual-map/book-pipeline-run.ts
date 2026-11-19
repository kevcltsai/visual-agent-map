/**
 * Picture-book pipeline runner. Executes what `core/book-pipeline/machine.ts` allows and nothing else: every gate (retries,
 * needs-review, budget pause, stale results) lives in the machine; this file moves data between it, the model ports and the
 * notes. Everything it touches is an injected port, so it is tested with fakes (no main.ts, no view).
 *
 * Rules kept here: the state is saved through one `PipelineStore` (one commit queue; the budget gate shares it) before a step's
 * call; a step's note write is a guarded commit (the file must still be the text the step started from, and the run must still
 * be current, checked inside the write itself); a card's frontmatter is only written before and after a step, never while its
 * author runs; Stop aborts every call (a provider that ignores abort cannot hang it); after dispose nothing is written, not even
 * the map file. Only ids, counts and codes are logged.
 */
import type { AdmissionContext } from "../../core/admission";
import type { FindImagesRequest, FoundImages } from "../../core/steps/book-pipeline/find-images";
import { isBudgetExhausted } from "../../core/admission";
import { createBudgetAdmission, createStoreBudgetPort } from "../../core/book-pipeline/budget";
import { imageKey } from "../../core/book-pipeline/image-dedupe";
import { formatPipelineLog } from "../../core/book-pipeline/log";
import {
  PipelineStore,
  addBudget,
  advancePhase,
  applyBudgetExhausted,
  applyCancelled,
  applyFailure,
  applyReset,
  applySuccess,
  autoFixesOf,
  beginStep,
  cardRevision,
  confirmGate1,
  finishRun,
  isCurrent,
  newBookPipeline,
  nextActions,
  recoverInterrupted,
  requestAutoFix,
  resetCard,
  resumeRun,
  retryGlobalPlan,
  retryTrial,
  stopRun,
  failRun,
  type PipelineAction,
  type PipelineStepKind,
  type StepToken
} from "../../core/book-pipeline/machine";
import {
  MAX_STEP_ATTEMPTS,
  attemptsOf,
  readBookPipeline,
  type BookPipelineData,
  type BookRole,
  type BookSettings,
  type PipelineFields,
  type PipelineFieldsPatch,
  type PipelinePhase,
  type PipelineStage,
  type PipelineStep
} from "../../core/book-pipeline/model";
import {
  appendResearchNote,
  carryWorkLog,
  neutralizeDetail,
  quoteAll,
  hidePipelineLog,
  findStoredProof,
  findStoredProofModels,
  extractProofRecords,
  carryImageSection,
  dropPlaceholderSections,
  replaceBookPlanSection,
  fencedLines,
  normalizeWorkRecords,
  workLogLines,
  replaceProofSection,
  replaceResearchRecord,
  chapterBody,
  detailBlockOf
} from "../../core/book-pipeline/note-sections";
import {
  composeBookPlan,
  composeCardPrompt,
  parseBookPlanBody,
  parseBookPlanDecisions,
  parseChecklist,
  parseImageSlots
} from "../../core/book-pipeline/plan-text";
import {
  composeProofRecord,
  composeProofSection,
  failedProofKey,
  isProofFailure,
  proofKey,
  proofSectionHeading,
  safeHref as safeLinkHref,
  type ProofCounts,
  type ProofResult
} from "../../core/book-pipeline/proof";
import { effectiveSettings } from "../../core/book-pipeline/settings";
import { escapeMarkdownText, unescapeMarkdownText } from "../../core/book-pipeline/text";
import type { ReasoningLevel } from "../../ai/types";
import type { ContentLanguage } from "../../i18n";
import type { MapDocument } from "../../map-model";
import type { NotePatch } from "../../repository";
import { isBookStepError, type BookStepBase } from "../../core/steps/book-pipeline/base";
import {
  checkImageText,
  choosePictures,
  composeImageTextLine,
  composeSlotsRecord,
  imageIssueTokens,
  latestSlotsRecord,
  stripImageLines,
  fillSlotMarkers,
  residualMarkerLines,
  scanSlotMarkers,
  verifyFill,
  type FillResult,
  type ImageSlot,
  type ProbedCandidate,
  type SlotOutcome
} from "../../core/book-pipeline/image-slots";
import { cardPlanStep, type CardPlanRequest, type CardPlanResult } from "../../core/steps/book-pipeline/card-plan";
import {
  globalPlanStep,
  type GlobalPlanRequest,
  type GlobalPlanResult
} from "../../core/steps/book-pipeline/global-plan";
import type { ProofreadRequest, ProofreadRun } from "../../core/steps/book-pipeline/proofread";
import type { StepDefinition } from "../../core/step-runner";
import { untilAborted } from "./argument-run";
import {
  avoidSourcesInstruction,
  cardResultSnapshot,
  proofFixInstruction,
  sameReviewResult,
  type CardResultSnapshot
} from "./book-pipeline-rerun";
import { readingOrder } from "./presentation-order";

/** At most this many cards are in a step at once (the whole-book plan runs alone before them). */
export const BOOK_POOL = 5;

export type BookRunRefusal =
  | "busy"
  | "blocked"
  | "root"
  | "exists"
  | "unusable"
  | "missing"
  | "finished"
  | "budget"
  | "disposed"
  | "unreadable"
  | "not_gate1"
  | "not_gate"
  | "instruction";
export class BookPipelineRunError extends Error {
  constructor(readonly code: BookRunRefusal) {
    super(`book pipeline refused: ${code}`);
    this.name = "BookPipelineRunError";
  }
}

/** One card as the runner reads it: the parsed note, its pipeline fields and the whole file text (the guard's expected text). */
export interface PipelineCard {
  path: string;
  title: string;
  summary: string;
  prompt: string;
  detail: string;
  raw: string;
  fields: PipelineFields;
  /** The six `book-*` values the note holds (the root's are the owner's current values). */
  settings: BookSettings;
}
export interface BookRunConfig {
  planModel: string;
  authorModel: string;
  /** The picture search (and the start card's suggestions) run on this model. */
  imageModel: string;
  proofModel: string;
  reasoning: ReasoningLevel;
  language: ContentLanguage;
}
export interface AuthorInput {
  /** The map the run belongs to (the plugin finds the open view by it). */
  mapPath: string;
  nodeId: string;
  path: string;
  /** The effective whole-book settings; the port turns them into the research requirements. */
  settings: BookSettings;
  /** The card's planned picture slots (from its `## Prompt`); empty when the plan has none or the Prompt has no image plan: the author then leaves no marker. */
  slots: readonly ImageSlot[];
  language: ContentLanguage;
  model: string;
  reasoning: ReasoningLevel;
  signal: AbortSignal;
  /** The call budget gate: the author's own `AiCalls` must carry it. */
  admission: AdmissionContext;
  /** The program's one-line request to use other sources (a source swap); absent for a normal write. Never carries untrusted text. */
  instruction?: string;
  /** Checked synchronously inside the write: false (a stop, a replaced run, a removed card) means nothing is written. */
  authorize: () => boolean;
  /** Runs inside the author's write on the text about to be saved: the cleaned text, or null (nothing is written). Pass it to the guarded write. */
  finalize: (content: string) => string | null;
}
export type AuthorOutcome =
  | { outcome: "written" }
  | { outcome: "budget-exhausted" }
  | { outcome: "failed"; reason: string }
  | { outcome: "cancelled" }
  | { outcome: "discarded" };
export type GuardOptions = {
  expectedContent?: string;
  authorize?: () => boolean;
  /** Runs inside the same write on the text the patch produced; null refuses the write. */
  finalize?: (content: string) => string | null;
};

/** Everything the runner touches. `mutate` is the plugin's serialized write queue; the others are repository/model/network seams. */
export interface BookPipelinePorts {
  mutate(work: () => Promise<void>): Promise<void>;
  readMap(path: string): Promise<MapDocument>;
  updateMap(path: string, change: (map: MapDocument) => void): Promise<MapDocument>;
  readCard(path: string): Promise<PipelineCard>;
  writePipelineFields(path: string, patch: PipelineFieldsPatch): Promise<void>;
  updateNoteGuarded(path: string, patch: NotePatch, options: GuardOptions): Promise<"written" | "discarded">;
  updateNoteRawGuarded(
    path: string,
    transform: (content: string) => string,
    options: GuardOptions
  ): Promise<"written" | "discarded">;
  /** Production: `runPlanStep(aiCalls, step, request, run)`. */
  runPlan<Request extends BookStepBase, Output>(
    step: StepDefinition<Request, Output>,
    request: Request,
    run: { signal: AbortSignal; admission?: AdmissionContext }
  ): Promise<Output>;
  /** Production: `runProofread(aiCalls, request, run)`. */
  runProofread(request: ProofreadRequest, run: ProofreadRun): Promise<ProofResult>;
  /** The author step: the card's single-card research (charts off, fresh write-back). Never writes the card's frontmatter. */
  author(input: AuthorInput): Promise<AuthorOutcome>;
  probeImage(url: string, signal: AbortSignal): Promise<{ ok: true } | { ok: false; reason: string }>;
  /** Production: `runFindImages(aiCalls, request, run)`: one web search for the picture slots of a chapter. Absent: no picture search (every marked slot ends as not found). */
  findImages?(
    request: FindImagesRequest,
    run: { signal: AbortSignal; admission?: AdmissionContext }
  ): Promise<FoundImages>;
  backupNote(path: string, raw: string): Promise<{ ok: true; path: string } | { ok: false }>;
  /** True while a conversation chain, a multi-select research or an argument run holds this map. */
  blocked(mapPath: string): boolean;
  config(mapPath: string): BookRunConfig;
  /** A stored model id as the owner reads it (the plugin's display name); absent: the id itself. */
  modelLabel?(model: string): string;
  now(): string;
  newId(): string;
  log(line: string): void;
  /** Called when the sub-step changes without a saved state change (the card is now finding pictures), so the screen can repaint. */
  progressed?(mapPath: string): void;
}

export interface BookPipelineProgress {
  runId: string;
  phase: BookPipelineData["phase"];
  status: BookPipelineData["status"];
  pauseReason?: "budget" | "failed";
  failureCode?: string;
  /** True while a drive is executing steps. */
  active: boolean;
  total: number;
  /** Exact counts by stage; `pending` has none yet. */
  counts: Record<PipelineStage | "pending", number>;
  budget: { used: number; limit: number };
  startedAt: string;
  phaseStartedAt: string;
  /** Cards a step (or a single-card rerun) is working on right now. */
  busyCards: string[];
  /** About how many seconds the planning/writing phase has left; only while a drive runs and at least {@link ETA_MIN_CARDS} cards of this phase finished. */
  etaSeconds?: number;
  /**
   * Memory only (never saved to the map file): the sub-step each busy card is in right now (`global` is the whole-book plan), with
   * when it began (ms). Finding pictures is part of the write step, so it only shows here.
   */
  current?: { nodeId: string; step: BookSubStep; startedAt: number }[];
  /** Memory only: how many cards finished each of the steps the bar lists. */
  steps?: BookStepCounts;
  /** Memory only: the single-card rerun running now and when it began (ms); gone when it ends, whatever way it ended. */
  rerun?: { nodeId: string; startedAt: number };
}
/** What a single-card rerun tells its caller: a card that needed a person before and still does with the same result. */
export interface BookRerunResult {
  unchanged: boolean;
}
export type BookSubStep = "plan" | "write" | "images" | "proof";
export type BookStepCounts = Record<BookSubStep, number>;
/**
 * The cards done per step from the stage counts: planned or beyond has its plan, written or checked has its text (and pictures:
 * they are found inside the write step), checked has its proofread. `imagesDone` adds cards whose pictures are in but whose write has not ended.
 */
export function stepCounts(
  counts: BookPipelineProgress["counts"],
  imagesDone = 0,
  review: { settled?: boolean; proofFailed?: number } = {}
): BookStepCounts {
  const written = counts.written + counts.checked;
  // From gate 2 on, a needs-review card is a finished card the owner must look at: every step counts. While writing, a card whose
  // proofread was the failing step has its text and pictures; any other needs-review card only has what came before the failure.
  const reviewed = counts["needs-review"];
  const textual = written + (review.settled ? reviewed : (review.proofFailed ?? 0));
  return {
    plan: counts.planned + written + reviewed,
    write: textual,
    images: textual + imagesDone,
    proof: counts.checked + (review.settled ? reviewed : 0)
  };
}
/** At least this many finished cards before the estimate is shown. */
export const ETA_MIN_CARDS = 5;
type StepResult = "ok" | "failed" | "cancelled" | "budget" | "dropped" | "none";

type Outcome =
  | { kind: "ok"; after?: () => Promise<void> }
  | { kind: "failed"; reason: string; forceReview?: boolean }
  | { kind: "cancelled" }
  | { kind: "budget" };

interface CardInfo {
  path: string;
  title: string;
  summary: string;
  role: BookRole;
}
interface Drive {
  mapPath: string;
  controller: AbortController;
  store: PipelineStore;
  admission: AdmissionContext;
  config: BookRunConfig;
  rootId: string;
  cards: Map<string, CardInfo>;
  /** Cards that already had a `book-role` when loaded (the owner's choice; the global plan does not overwrite it), and the missing ones with their default. */
  ownerRoles: Set<string>;
  missingRoles: Map<string, BookRole>;
  stages: Map<string, PipelineStage | undefined>;
  backedUp: Set<string>;
  backupPaths: Map<string, string>;
  reasons: Map<string, string>;
  busy: Set<string>;
  stopRequested: boolean;
  disposed: boolean;
  /** Set by a single-card rerun: runs instead of the loop, and a stop or error does not pause the run's phase. */
  job?: () => Promise<void>;
  /** The program's extra request line for a card (source swap or automatic redo). */
  extra: Map<string, string>;
  /** Cards whose `extra` line is a source swap: the author gets it too. */
  avoid: Set<string>;
  /** Cards whose proofread named unmet points, waiting for the one automatic redo once every card has had its first round: the program-built request line. */
  fixable: Map<string, string>;
  /** In memory only: the single-card rerun in progress. */
  rerun?: { nodeId: string; startedAt: number };
  /** The plan a card's plan step wrote in this drive. */
  plans: Map<string, CardPlanResult>;
  /** The model id each card's author step was dispatched with in this drive (the proof result section shows it). */
  authorModels: Map<string, string>;
  /** When each card's first step started in this drive, and the durations (ms) of the cards that finished their phase. */
  started: Map<string, number>;
  durations: { plan: number[]; write: number[] };
  /** In memory only: the sub-step each running card (or `global`) is in, and the cards whose pictures are in but whose write step has not ended. */
  sub: Map<string, { step: BookSubStep; startedAt: number }>;
  imagesDone: Set<string>;
  /** In memory only: the step that marked each card needs-review in this drive. */
  reviewStep: Map<string, PipelineStep>;
  fatal?: unknown;
  /** A neutral code of why the run ended by itself (see failRun). */
  failure?: string;
  /** Keys (see imageKey) of the pictures this run already embedded: one picture is used once in a book. */
  usedImages: Set<string>;
  /** The drive-wide gate of picture probes in flight (see {@link PROBE_PARALLEL}). */
  probeGate: { active: number; waiters: Array<() => void> };
  done: Promise<void>;
}

const code = (value: string): string => value.replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 60) || "failed";
const reasonOf = (error: unknown): string =>
  isProofFailure(error) ? error.code : isBookStepError(error) ? "invalid_reply" : "failed";
/** An unexpected error's code: only its class name, never its message (which could carry a path or a title). */
const internalCode = (error: unknown): string =>
  `internal_${(typeof (error as { name?: unknown } | null)?.name === "string" ? (error as { name: string }).name : "unknown").replace(/[^A-Za-z0-9_]/g, "_").slice(0, 40)}`;
/** Failure reasons after which the card's proof-result section is not written (the write never reached the card, or the card is gone). */
const NO_FAILURE_SECTION: ReadonlySet<string> = new Set(["discarded", "card_removed", "backup_failed", "missing"]);
const STEP_OF = { card_plan: "plan", card_write: "write", card_proof: "proof" } as const;
const ACTION_OF = { plan: "card_plan", write: "card_write", proof: "card_proof" } as const;
const singleLineText = (value: string, max: number): string =>
  Array.from(value.replace(/\s+/g, " ").trim()).slice(0, max).join("");

const DEFINITION = /^ {0,3}\[([^\]\n]+)\]:[ \t]*(?:<([^>\n]*)>|(\S+))[^\n]*(?:\n|$)/gm;
const WIKI_TARGET = /^[^[\]()!<>\r\n\\]+$/;
const SCHEME = /^\s*(?:[a-z][a-z0-9+.-]*:|\/\/)/i;
const frontmatterLength = (content: string): number =>
  /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.exec(content)?.[0].length ?? 0;
const labelOf = (value: string): string => value.trim().replace(/\s+/g, " ").toLowerCase();
/** Every tag or comment start (also a `<` ending a chunk, which an image follows) becomes `&lt;`; only the note's own section markers (an exact comment with no payload) stay. */
const neutralize = (text: string): string =>
  text.replace(/<(?=[A-Za-z/!?]|$)(?!!-- visual-agent-map:(?:detail|references):(?:start|end) -->)/g, "&lt;");
/**
 * The machine line of a stored proof record (`<!-- book-proof:v1 {json} -->`, also as a `> ` quote line of the callout) must pass the
 * body cleaning byte for byte: a rerun's author step keeps the old records, and neutralize would turn their `<` into `&lt;`.
 * Only a line that is one comment with a JSON payload holding no `<` and no `-->` is held back; any other `<!--` is cleaned as before.
 */
const PROOF_LINE = /^(?:[ \t]{0,3}>[ \t]?)?<!-- book-proof:v1 (\{[^<]*\}) -->$/;
function holdProofLines(
  content: string,
  known: ReadonlySet<string>
): { text: string; restore: (cleaned: string) => string } {
  const held: string[] = [];
  const token = `VAMPROOFLINE${Math.random().toString(36).slice(2)}X`;
  const text = content
    .split("\n")
    .map(line => {
      const m = PROOF_LINE.exec(line.replace(/\r$/, ""));
      // Only a line that was already in the card before the author ran: a record the author wrote is model text, never a stored proof.
      if (!m || m[1].includes("-->") || !known.has(line)) return line;
      try {
        JSON.parse(m[1]);
      } catch {
        return line;
      }
      held.push(line);
      return `${token}${held.length - 1}X`;
    })
    .join("\n");
  return {
    text,
    restore: cleaned => cleaned.replace(new RegExp(`${token}(\\d+)X`, "g"), (_, i: string) => held[Number(i)])
  };
}
/**
 * A strict source anchor `<a href="https://…">text</a>` (each `<`, `>` and `"` also as its entity, decoded one level only), with
 * `href` as the only attribute, one line, no tag inside. Anything else (another attribute, a nested or unclosed tag, `javascript:`,
 * `http:`, a doubled entity) does not match and stays plain text for the cleaning that follows.
 */
const ANCHOR =
  /(?:<|&lt;)a[ \t]+href=(?:"|&quot;)([^"<>\n]*?)(?:"|&quot;)[ \t]*(?:>|&gt;)([^<>\n]*?)(?:<|&lt;)\/a[ \t]*(?:>|&gt;)/gi;
/**
 * R1-6: the body (after the frontmatter) with every strict https anchor written as the markdown link `[text](href)`: the address
 * must pass {@link safeLinkHref}, the text is escaped plain text, and a space goes before the link when a `!` or `\` precedes it (so
 * it can never become an image or an escape). The caller runs the picture scan and the tag cleaning on the result.
 */
export function convertSourceAnchors(content: string): string {
  const at = frontmatterLength(content);
  const lines = content.slice(at).split("\n");
  const fenced = fencedLines(lines);
  return (
    content.slice(0, at) +
    lines
      .map((line, index) => {
        if (fenced[index]) return line;
        // Inline code spans (a backtick run to the same run) are shown as written, so an anchor inside one stays.
        const spans: Array<[number, number]> = [];
        for (const m of line.matchAll(/(`+)(?!`).+?(?<!`)\1(?!`)/g)) spans.push([m.index, m.index + m[0].length]);
        return line.replace(ANCHOR, (whole: string, rawHref: string, rawText: string, offset: number, all: string) => {
          if (spans.some(([from, to]) => offset >= from && offset < to)) return whole;
          if (/&(?:lt|gt|quot);/i.test(rawText) || /&(?:lt|gt|quot);/i.test(rawHref.replace(/&amp;/g, "")))
            return whole;
          const href = safeLinkHref(rawHref.replace(/&amp;/g, "&"));
          const text = escapeMarkdownText(rawText.replace(/&amp;/g, "&"), 200);
          if (!href || !text) return whole;
          // Nested: an earlier anchor on this line is still open, so this one sits inside it.
          const prefix = all.slice(0, offset);
          if ((prefix.match(/(?:<|&lt;)a[ \t]/gi)?.length ?? 0) > (prefix.match(/(?:<|&lt;)\/a/gi)?.length ?? 0))
            return whole;
          const before = all[offset - 1];
          return `${before === "!" || before === "\\" ? " " : ""}[${text}](${href})`;
        });
      })
      .join("\n")
  );
}
const NO_PICTURE = "無圖：";
const PICTURE_REASONS: Record<string, [string, string]> = {
  unsafe: ["網址不安全", "unsafe address"],
  load_failed: ["無法載入", "could not load"],
  empty: ["空圖", "empty image"],
  timeout: ["逾時", "timed out"],
  aborted: ["已中止", "aborted"]
};
/** The "no picture" line for a probe reason code (a known code in the output language; anything else is escaped text). */
function noPicture(language: string, reason: string): string {
  const known = Object.prototype.hasOwnProperty.call(PICTURE_REASONS, reason) ? PICTURE_REASONS[reason] : undefined;
  const zh = /^zh/i.test(language);
  const text = known ? known[zh ? 0 : 1] : escapeMarkdownText(reason, 60) || (zh ? "載入失敗" : "load failed");
  return zh ? `${NO_PICTURE}${text}` : `No picture: ${text}`;
}
/** Picture probes of one chapter (at most 24 distinct addresses: 8 slots of 3 candidates) and probes in flight in the whole run. */
export const PROBE_PER_CHAPTER = 24;
export const PROBE_PARALLEL = 4;
const SEARCH_TEXT_MAX = 400;
/** The chapter's search text: its title, summary and (at most five) `《work》` names from the text, one line with no address in it. */
function imageSearchText(card: PipelineCard): string {
  const works = [...new Set([...chapterBody(card.detail).matchAll(/《([^《》\n]{1,40})》/g)].map(m => m[1]))].slice(
    0,
    5
  );
  return singleLineText(
    [card.title, card.summary, ...works.map(work => `《${work}》`)]
      .filter(Boolean)
      .join(" / ")
      .replace(/\S*:\/\/\S*/g, " "),
    SEARCH_TEXT_MAX
  );
}
const isHttps = (url: string): boolean => /^https:\/\//i.test(url);

/**
 * A public web host only (a front guard: an `<img>` that follows a redirect to an inner address is not stopped here). Refuses IP literals
 * (WHATWG parsing has already turned decimal / octal / hex forms into dotted IPv4), localhost, hosts ending in local, internal or lan, a one-label host,
 * credentials and a port other than 443.
 */
function isPublicHost(url: URL): boolean {
  if (url.username || url.password || (url.port && url.port !== "443")) return false;
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!host || host.includes("@") || host.startsWith("[") || /^[\d.]+$/.test(host) || !host.includes(".")) return false;
  if (/^(0x[0-9a-f]*|\d+)(\.(0x[0-9a-f]*|\d+))*$/.test(host)) return false;
  return !/(^|[.])(localhost|local|internal|lan)$/.test(host);
}

/** An address that may be probed and written back: no whitespace, backslash, `<` or `>`; `new URL()` parses it as https with balanced parentheses. */
function safeHref(raw: string): string | undefined {
  if (!raw || /[\s\\<>\p{Cc}]/u.test(raw)) return undefined;
  let href: string;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || !isPublicHost(url)) return undefined;
    href = url.href;
  } catch {
    return undefined;
  }
  let depth = 0;
  for (const c of href) {
    if (c === "(") depth++;
    else if (c === ")" && --depth < 0) return undefined;
  }
  return depth === 0 ? href : undefined;
}

type Resolve = (href: string) => string | undefined;
/** Parses an inline destination starting right after `(`; undefined when the form is not the plain `url "title"` shape. */
function inlineTarget(text: string, from: number): { raw: string; end: number } | undefined {
  let p = from;
  while (text[p] === " " || text[p] === "\t") p++;
  let raw: string;
  if (text[p] === "<") {
    const q = text.indexOf(">", p + 1);
    if (q < 0) return undefined;
    raw = text.slice(p + 1, q);
    if (/[\n<]/.test(raw)) return undefined;
    p = q + 1;
  } else {
    const start = p;
    let depth = 0;
    while (p < text.length && !/\s/.test(text[p])) {
      if (text[p] === "\\") p++;
      else if (text[p] === "(") depth++;
      else if (text[p] === ")" && depth-- === 0) {
        depth = 0;
        break;
      }
      p++;
    }
    raw = text.slice(start, p);
  }
  while (text[p] === " " || text[p] === "\t") p++;
  const quote = text[p] === '"' ? '"' : text[p] === "'" ? "'" : text[p] === "(" ? ")" : "";
  if (quote) {
    const q = text.indexOf(quote, p + 1);
    if (q < 0 || /\n/.test(text.slice(p, q))) return undefined;
    p = q + 1;
    while (text[p] === " " || text[p] === "\t") p++;
  }
  return text[p] === ")" ? { raw, end: p + 1 } : undefined;
}

/** Rebuilds every image of one stretch of plain text: whatever is understood is rewritten to the standard form (or a "no picture" line), whatever is not loses its `!`. */
function rebuildImages(text: string, defs: Map<string, string>, used: Set<string>, resolve: Resolve): string {
  let out = "";
  let plain = 0;
  let i = 0;
  const unsupported = (at: number): void => {
    out += neutralize(text.slice(plain, at)) + `${NO_PICTURE}形式不支援`;
    i = at + 1;
    plain = i;
  };
  for (let at = text.indexOf("![", i); at >= 0; at = text.indexOf("![", i)) {
    if (text[at + 2] === "[") {
      const end = text.indexOf("]]", at + 3);
      const target = end < 0 ? "" : text.slice(at + 3, end);
      if (end < 0 || !WIKI_TARGET.test(target) || SCHEME.test(target)) {
        unsupported(at);
        continue;
      }
      out += neutralize(text.slice(plain, at)) + `![[${target}]]`;
      i = end + 2;
      plain = i;
      continue;
    }
    let j = at + 2;
    while (j < text.length && text[j] !== "]" && text[j] !== "[" && text[j] !== "\n") j += text[j] === "\\" ? 2 : 1;
    if (text[j] !== "]") {
      unsupported(at);
      continue;
    }
    const alt = text.slice(at + 2, j);
    let raw: string | undefined;
    let end = j + 1;
    if (text[end] === "(") {
      const target = inlineTarget(text, end + 1);
      raw = target?.raw;
      end = target?.end ?? -1;
    } else {
      let label = alt;
      if (text[end] === "[") {
        const q = text.indexOf("]", end + 1);
        const inner = q < 0 ? "" : text.slice(end + 1, q);
        if (q < 0 || /[[\n]/.test(inner)) end = -1;
        else {
          if (inner.trim()) label = inner;
          end = q + 1;
        }
      }
      if (end >= 0) {
        const key = labelOf(label);
        raw = defs.get(key);
        if (raw !== undefined) used.add(key);
      }
    }
    if (end < 0 || raw === undefined) {
      unsupported(at);
      continue;
    }
    const href = safeHref(raw);
    const failure = href ? resolve(href) : `${NO_PICTURE}網址不安全`;
    out += neutralize(text.slice(plain, at));
    out += failure ?? `![${escapeMarkdownText(unescapeMarkdownText(alt), 200)}](${href})`;
    i = end;
    plain = i;
  }
  return out + neutralize(text.slice(plain));
}

/**
 * Allow-list rebuild of a note's body (the frontmatter stays as it is). Code is not exempt: in the whole body
 * every image (inline, reference or `![[...]]`) is parsed conservatively and written again in the standard form `![alt](href)`
 * (https only, address from `new URL()`, title dropped), or becomes a "no picture" line when `resolve(href)` gives a reason, the
 * address is not https or the form is not understood; the definition lines that reference images used are removed; every HTML tag
 * or comment start `<` becomes `&lt;` (only the app's own section markers stay). Nothing of the original image text is kept.
 * {@link unsafeBody} then checks the result.
 */
function rebuildBody(content: string, resolve: Resolve): string {
  const at = frontmatterLength(content);
  const body = content.slice(at);
  const defs = new Map<string, string>();
  for (const m of body.matchAll(DEFINITION)) {
    const label = labelOf(m[1]);
    if (!defs.has(label)) defs.set(label, m[2] ?? m[3] ?? "");
  }
  const used = new Set<string>();
  rebuildImages(body, defs, used, resolve);
  const text = body.replace(DEFINITION, (line, label: string) => (used.has(labelOf(label)) ? "" : line));
  return content.slice(0, at) + rebuildImages(text, defs, used, resolve);
}

const MARKERS = /<!-- visual-agent-map:(?:detail|references):(?:start|end) -->/g;
/**
 * Exit check, independent of the rebuild: true when the body of `content` still has an HTML tag start (the app's markers aside),
 * an `![alt](url)` whose url is not one of `allowed` (the https addresses that were probed), any other `![` form, or an `![[...]]`
 * that is not plain safe text without a scheme.
 */
export function unsafeBody(content: string, allowed: ReadonlySet<string>): boolean {
  const body = content.slice(frontmatterLength(content)).replace(MARKERS, " ");
  if (/<[A-Za-z/!?]/.test(body)) return true;
  for (let at = body.indexOf("!["); at >= 0; at = body.indexOf("![", at + 2)) {
    if (body[at + 2] === "[") {
      const end = body.indexOf("]]", at + 3);
      const target = end < 0 ? "" : body.slice(at + 3, end);
      if (end < 0 || !WIKI_TARGET.test(target) || SCHEME.test(target)) return true;
      continue;
    }
    const head = /^!\[(?:\\.|[^\\[\]\n])*\]\(/.exec(body.slice(at, at + 4000));
    if (!head) return true;
    let p = at + head[0].length;
    let depth = 0;
    while (p < body.length && !/\s/.test(body[p]) && (body[p] !== ")" || depth > 0)) {
      if (body[p] === "(") depth++;
      else if (body[p] === ")") depth--;
      p++;
    }
    if (body[p] !== ")" || !allowed.has(body.slice(at + head[0].length, p))) return true;
  }
  return false;
}

/** The distinct addresses (standard form) of a note's body that an image would load and that may be probed: https only; never the frontmatter. */
export function bodyImageUrls(content: string): string[] {
  const urls = new Set<string>();
  rebuildBody(content, href => {
    urls.add(href);
    return undefined;
  });
  return [...urls];
}
/** The allow-list rebuild of a note's body: `replacements` maps an address (as {@link bodyImageUrls} gave it) to the "no picture" line that replaces its image. */
export function replaceBodyImages(content: string, replacements: ReadonlyMap<string, string>): string {
  return rebuildBody(content, href => replacements.get(href));
}

export class BookPipelineRuns {
  private readonly drives = new Map<string, Drive>();
  private readonly last = new Map<string, BookPipelineProgress>();
  private disposed = false;

  constructor(private readonly ports: BookPipelinePorts) {}

  isRunning(mapPath: string): boolean {
    return this.drives.has(mapPath);
  }

  /** The live drive's numbers, or what the last drive left; undefined when this plugin session never ran the map. */
  getProgress(mapPath: string): BookPipelineProgress | undefined {
    const drive = this.drives.get(mapPath);
    // A drive whose first write is still in progress has no store yet (a repaint during that write asks): nothing to report yet.
    if (drive) return drive.store ? this.progressOf(drive, true) : undefined;
    return this.last.get(mapPath);
  }

  /** Starts a new run (writes `bookPipeline` to the map file) and drives it until it ends, pauses or reaches a gate. */
  async start(mapPath: string, options: { restart?: boolean } = {}): Promise<void> {
    // A restart (the stopped bar's "reconfigure and start over") may replace a run that is stopped before its first gate; nothing else.
    const replaceable = (data: BookPipelineData): boolean =>
      data.phase === "done" ||
      (options.restart === true &&
        data.status === "stopped" &&
        (data.phase === "planning" || data.phase === "writing"));
    return this.enter(mapPath, async drive => {
      if (this.ports.blocked(mapPath)) throw new BookPipelineRunError("blocked");
      const runId = this.ports.newId();
      let initial: BookPipelineData | undefined;
      await this.ports.mutate(async () => {
        if (this.dead(drive)) return;
        const map = await this.ports.readMap(mapPath);
        const read = readBookPipeline(map);
        if (read.kind === "unusable") throw new BookPipelineRunError("unusable");
        if (read.kind === "usable" && !replaceable(read.data)) throw new BookPipelineRunError("exists");
        const order = this.orderOf(map);
        // Roles the previous run's pipeline wrote (defaults and plan choices) are not the owner's; only roles written outside the pipeline are.
        const prior = read.kind === "usable" ? (read.data.autoRoles ?? []) : [];
        await this.load(drive, map, order, new Set(prior));
        const stale = order.filter(id => drive.stages.get(id) !== undefined);
        const state = newBookPipeline({
          runId,
          order,
          now: this.ports.now(),
          staleStages: stale,
          autoRoles: [...new Set([...prior.filter(id => order.includes(id)), ...drive.missingRoles.keys()])]
        });
        if (this.dead(drive)) return;
        await this.ports.updateMap(mapPath, doc => {
          const found = readBookPipeline(doc);
          if (found.kind === "unusable" || (found.kind === "usable" && !replaceable(found.data)))
            throw new BookPipelineRunError("exists");
          doc.bookPipeline = state;
        });
        initial = state;
        // First start: a missing role gets its default (root and first-level topics intro, the rest body); an existing one is kept.
        for (const [id, role] of drive.missingRoles) await this.writeFields(drive, id, { bookRole: role });
        drive.missingRoles.clear();
        // Attach right after the write: the repaint that follows it (main.mutate reads the views back) already asks for progress.
        this.attachStore(drive, state);
      });
      if (!initial || this.dead(drive)) return;
      this.log(drive, "start", "-", "plan", "ok");
    });
  }

  /** Continues a stopped (or interrupted) run from the cards' stages; `addBudget` first raises the call limit (the "add 100" button). */
  async resume(mapPath: string, options: { addBudget?: number } = {}): Promise<void> {
    return this.enter(mapPath, async drive => {
      const data = await this.openSaved(drive, mapPath);
      const extra = options.addBudget ?? 0;
      let refused = false;
      await drive.store.commit(state => {
        let next = retryGlobalPlan(recoverInterrupted(state));
        if (extra) next = addBudget(next, extra);
        const resumed = resumeRun(next);
        refused = resumed === null;
        return { state: resumed ?? next, accepted: true };
      });
      if (refused) throw new BookPipelineRunError("budget");
      // The fix instruction lived only in memory: a card still waiting for its one rewrite goes back to needs-review (its fix is spent).
      for (const id of drive.store.state.order)
        if (drive.stages.get(id) === "planned" && autoFixesOf(drive.store.state, id) > 0 && !drive.extra.has(id)) {
          drive.stages.set(id, "needs-review");
          await this.writeFields(drive, id, {
            pipelineStage: "needs-review",
            pipelineIssue: "proof unmet: fix interrupted"
          });
        }
      this.log(drive, "resume", "-", "plan", data.status === "running" ? "recovered" : "ok");
    });
  }

  /** The owner confirmed gate 1: writing starts (or a stopped run at gate 1 continues into it). */
  async confirmGate1(mapPath: string): Promise<void> {
    return this.enter(
      mapPath,
      async drive => {
        await this.openSaved(drive, mapPath);
        let moved = false;
        await drive.store.commit(state => {
          const next = confirmGate1(resumeRun(state) ?? state, this.ports.now());
          moved = next.phase !== state.phase;
          return { state: moved ? next : state, accepted: true };
        });
        if (!moved) throw new BookPipelineRunError("not_gate1");
        this.log(drive, "gate1", "-", "write", "confirmed");
      },
      true
    );
  }

  /**
   * The owner accepted gate 2: the run is done. Only at gate 2; a run that is already done answers as if nothing happened (a second
   * press is harmless), any other phase is refused. Cards are not touched.
   */
  async finishRun(mapPath: string): Promise<void> {
    return this.enter(mapPath, async drive => {
      const data = await this.openSaved(drive, mapPath, { allowDone: true });
      if (data.phase === "done") return;
      if (data.phase !== "gate2") throw new BookPipelineRunError("not_gate");
      let refusal: BookRunRefusal | undefined;
      await drive.store.commit(state => {
        const running = resumeRun(state);
        if (!running) {
          refusal = "budget";
          return { state, accepted: true };
        }
        const next = finishRun(running, this.ports.now());
        if (next.phase === state.phase) refusal = "not_gate";
        return { state: refusal ? state : next, accepted: true };
      });
      if (refusal) throw new BookPipelineRunError(refusal);
      this.log(drive, "gate2", "-", "proof", "finished");
    });
  }

  /**
   * Gate 1 of a run with a trial: the owner changed the settings or models and wants the trial cards again. The run goes back to
   * planning, only the trial cards start over (stage, attempts, automatic redo, their own pictures are free to use again), and the
   * drive runs them through plan, write, pictures and proofread to gate 1 again. Refused (not_gate1) at any other phase or for a run
   * without a trial.
   */
  async retryTrial(mapPath: string): Promise<void> {
    return this.enter(
      mapPath,
      async drive => {
        await this.openSaved(drive, mapPath);
        let moved = false;
        await drive.store.commit(state => {
          const next = retryTrial(resumeRun(state) ?? state, this.ports.now());
          moved = next.phase !== state.phase;
          return { state: moved ? next : state, accepted: true };
        });
        if (!moved) throw new BookPipelineRunError("not_gate1");
        for (const id of drive.store.state.trial ?? []) {
          const own = drive.cards.get(id);
          const current = own ? await this.ports.readCard(own.path).catch(() => undefined) : undefined;
          if (current) for (const url of bodyImageUrls(current.detail)) drive.usedImages.delete(imageKey(url));
        }
        this.log(drive, "gate1", "-", "plan", "trial_retry");
      },
      true
    );
  }

  /**
   * One card again (gate 2 or done): plan, author, proofread with the usual per-step retries, fence, backup and
   * budget rules; the card gets a new revision (so a new proof record; older records stay, marked old). The cards on both sides are
   * not touched except for the seam mark. The run's phase does not change, and it cannot run beside another drive of the map.
   */
  async rerunCard(
    mapPath: string,
    nodeId: string,
    options: { avoidSources?: readonly string[] } = {}
  ): Promise<BookRerunResult> {
    const swap = options.avoidSources !== undefined;
    let result: BookRerunResult = { unchanged: false };
    await this.cardJob(
      mapPath,
      nodeId,
      ["gate2", "done"],
      "not_gate",
      () => ["plan", "write", "proof"],
      swap ? avoidSourcesInstruction(options.avoidSources ?? []) : undefined,
      (drive, snapshots) => {
        // A stopped, replaced or removed run says nothing about the result.
        const settled = !drive.controller.signal.aborted && !this.dead(drive) && drive.fatal === undefined;
        result = { unchanged: settled && sameReviewResult(snapshots?.before, snapshots?.after) };
      },
      true,
      swap
    );
    return result;
  }

  /** The owner's "seam checked": the only thing that clears `pipeline-seam` (a proofread or any automatic step never does). */
  async confirmSeam(mapPath: string, nodeId: string): Promise<void> {
    return this.enter(mapPath, async drive => {
      const map = await this.ports.readMap(mapPath);
      const read = readBookPipeline(map);
      if (read.kind === "absent") throw new BookPipelineRunError("missing");
      if (read.kind === "unusable") throw new BookPipelineRunError("unusable");
      const node = map.nodes.find(item => item.id === nodeId);
      if (!node || !read.data.order.includes(nodeId)) throw new BookPipelineRunError("missing");
      if (this.dead(drive)) throw new BookPipelineRunError("disposed");
      const card = await this.ports.readCard(node.path).catch(() => undefined);
      if (!card) throw new BookPipelineRunError("unreadable");
      if (card.fields.pipelineSeam === undefined) return;
      await this.ports.writePipelineFields(node.path, { pipelineSeam: null });
      this.ports.log(
        formatPipelineLog({
          event: "seam_confirmed",
          runId: read.data.runId,
          card: nodeId,
          step: "proof",
          attempt: 0,
          result: "ok",
          ms: 0
        })
      );
    });
  }

  private cardJob(
    mapPath: string,
    nodeId: string,
    phases: readonly PipelinePhase[],
    refusal: BookRunRefusal,
    steps: (phase: PipelinePhase) => PipelineStep[],
    extra?: string,
    finish?: (drive: Drive, snapshots?: { before?: CardResultSnapshot; after?: CardResultSnapshot }) => void,
    /** A rerun: its time is shown, and the card's result is compared before and after. */
    track = false,
    /** The extra line is the program's source swap: the author gets it too. */
    swap = false
  ): Promise<void> {
    return this.enter(mapPath, async drive => {
      const data = await this.openSaved(drive, mapPath, { allowDone: true });
      if (!data.order.includes(nodeId)) throw new BookPipelineRunError("missing");
      if (!phases.includes(data.phase)) throw new BookPipelineRunError(refusal);
      let refused = false;
      await drive.store.commit(state => {
        const next = resumeRun(state);
        refused = next === null;
        return { state: next ?? state, accepted: true };
      });
      if (refused) throw new BookPipelineRunError("budget");
      if (extra) drive.extra.set(nodeId, extra);
      if (extra && swap) drive.avoid.add(nodeId);
      const kinds = steps(data.phase);
      drive.job = async () => {
        const before = track ? await this.cardSnapshot(drive, nodeId) : undefined;
        if (track) drive.rerun = { nodeId, startedAt: Date.parse(this.ports.now()) };
        try {
          await this.runCardJob(drive, nodeId, kinds);
        } finally {
          drive.rerun = undefined;
        }
        finish?.(drive, track ? { before, after: await this.cardSnapshot(drive, nodeId) } : undefined);
      };
      this.log(drive, "rerun", nodeId, kinds[0], kinds.length === 1 ? "plan_only" : "full");
    });
  }

  /** The card's result as the rerun compares it (memory only); undefined when the card cannot be read. */
  private async cardSnapshot(drive: Drive, nodeId: string): Promise<CardResultSnapshot | undefined> {
    const path = drive.cards.get(nodeId)?.path;
    if (!path) return undefined;
    try {
      const card = await this.ports.readCard(path);
      return cardResultSnapshot(card.fields.pipelineStage, card.fields.pipelineIssue, card.detail);
    } catch {
      return undefined;
    }
  }

  /** Runs the given steps of one card in order, each with its own attempts (the third failure marks the card needs-review). */
  private async runCardJob(drive: Drive, nodeId: string, kinds: readonly PipelineStep[]): Promise<void> {
    drive.busy.add(nodeId);
    let base = 0;
    try {
      await drive.store.commit(state => ({ state: resetCard(state, nodeId), accepted: true }));
      base = cardRevision(drive.store.state, nodeId);
      for (const kind of kinds) {
        for (;;) {
          if (this.dead(drive) || drive.controller.signal.aborted || drive.fatal !== undefined) return;
          if (drive.store.state.status !== "running") return;
          if (attemptsOf(drive.store.state, nodeId)[kind] >= MAX_STEP_ATTEMPTS) {
            await this.markReview(drive, nodeId, kind, drive.reasons.get(nodeId) ?? "failed");
            return;
          }
          const action = { type: ACTION_OF[kind], nodeId } as const;
          const done = await this.step(drive, action);
          if (done === "ok") break;
          if (done !== "failed") return;
          // The third failure already marked the card (see step): nothing more to do for it.
          if (drive.stages.get(nodeId) === "needs-review") return;
        }
      }
    } finally {
      drive.busy.delete(nodeId);
      // Whatever changed this card's plan or text (even a rerun that stopped half way) makes its neighbours' joins worth a look.
      const revision = cardRevision(drive.store.state, nodeId);
      if (!this.dead(drive) && revision > base) await this.markSeams(drive, nodeId, revision);
    }
  }

  private async markSeams(drive: Drive, nodeId: string, revision: number): Promise<void> {
    const order = drive.store.state.order;
    const at = order.indexOf(nodeId);
    const zh = /^zh/i.test(drive.config.language);
    for (const other of [order[at - 1], order[at + 1]]) {
      if (!other || !drive.cards.has(other)) continue;
      await this.writeFields(drive, other, {
        pipelineSeam: zh
          ? `鄰卡企劃或正文已變更，尚未人工核對（第 ${at + 1} 張，版本 ${revision}）`
          : `Neighbouring card's plan or text changed; not yet checked by a person (card ${at + 1}, revision ${revision})`
      });
    }
  }

  /**
   * Aborts every call and pauses the run (resumable). Resolves when the drive is over. With no drive, `saved` (the owner's Stop
   * button) writes the stop into the saved state, so a budget pause or a state left "running" ends as a plain stop; refusals
   * (no run, finished, unreadable) leave the file as it is.
   */
  async stop(mapPath: string, options: { saved?: boolean } = {}): Promise<void> {
    const drive = this.drives.get(mapPath);
    if (!drive) {
      if (!options.saved) return;
      await this.enter(mapPath, async fresh => {
        await this.openSaved(fresh, mapPath);
        fresh.stopRequested = true;
      }).catch((error: unknown) => {
        if (!(error instanceof BookPipelineRunError)) throw error;
      });
      return;
    }
    drive.stopRequested = true;
    drive.controller.abort();
    await drive.done.catch(() => undefined);
  }

  /** Plugin unload: abort everything; nothing is written afterwards. */
  dispose(): void {
    this.disposed = true;
    for (const drive of this.drives.values()) {
      drive.disposed = true;
      drive.controller.abort();
      drive.store?.dispose();
    }
  }

  // ---- lifecycle ---------------------------------------------------------------------------------------------------------------
  private dead(drive: Drive): boolean {
    return drive.disposed || this.disposed;
  }
  /**
   * `early`: the returned promise settles once `setup` succeeded (the run's new phase is written) or refused; the drive keeps running in
   * the background and its unexpected errors are handled by {@link go} (failure code, log), never as a rejection.
   */
  private enter(mapPath: string, setup: (drive: Drive) => Promise<void>, early = false): Promise<void> {
    if (this.disposed) return Promise.reject(new BookPipelineRunError("disposed"));
    if (this.drives.has(mapPath)) return Promise.reject(new BookPipelineRunError("busy"));
    const drive = {
      mapPath,
      controller: new AbortController(),
      config: this.ports.config(mapPath),
      cards: new Map(),
      ownerRoles: new Set(),
      missingRoles: new Map(),
      stages: new Map(),
      backedUp: new Set(),
      backupPaths: new Map(),
      reasons: new Map(),
      busy: new Set(),
      extra: new Map(),
      avoid: new Set(),
      fixable: new Map(),
      plans: new Map(),
      authorModels: new Map(),
      started: new Map(),
      durations: { plan: [], write: [] },
      sub: new Map(),
      imagesDone: new Set(),
      reviewStep: new Map(),
      stopRequested: false,
      disposed: false,
      rootId: "",
      usedImages: new Set<string>(),
      probeGate: { active: 0, waiters: [] },
      done: Promise.resolve()
    } as unknown as Drive;
    this.drives.set(mapPath, drive);
    let ready: () => void = () => undefined;
    drive.done = this.go(drive, setup, () => ready());
    if (!early) return drive.done;
    return new Promise<void>((resolve, reject) => {
      ready = resolve;
      drive.done.then(resolve, reject);
    });
  }
  private async go(drive: Drive, setup: (drive: Drive) => Promise<void>, onSetup: () => void): Promise<void> {
    let refusal: BookPipelineRunError | undefined;
    try {
      await setup(drive);
      onSetup();
      if (drive.store && !this.dead(drive) && !drive.stopRequested) await (drive.job ? drive.job() : this.loop(drive));
    } catch (error) {
      if (error instanceof BookPipelineRunError) refusal = error;
      else if (!this.dead(drive)) {
        drive.fatal = error;
        drive.failure = internalCode(error);
        this.ports.log(
          formatPipelineLog({
            event: "error",
            runId: drive.store?.state.runId ?? "-",
            card: "-",
            step: "plan",
            attempt: 0,
            result: drive.failure,
            ms: 0
          })
        );
      }
    } finally {
      try {
        // A stop (or an unexpected error) is the run's last write: status "stopped", resumable. Never after dispose.
        if (drive.store && !this.dead(drive) && !drive.job) {
          // The owner's stop stays a plain stop; a run that ended by itself (whole-book plan failed, unexpected error) keeps its code.
          const code = drive.failure ?? (drive.fatal !== undefined ? "failed" : undefined);
          if (drive.stopRequested)
            await drive.store.commit(state => ({ state: stopRun(state), accepted: true })).catch(() => undefined);
          else if (code !== undefined)
            await drive.store.commit(state => ({ state: failRun(state, code), accepted: true })).catch(() => undefined);
        }
        if (drive.store) {
          this.last.set(drive.mapPath, this.progressOf(drive, false));
          drive.store.dispose();
        }
      } finally {
        this.drives.delete(drive.mapPath);
      }
    }
    if (refusal) throw refusal;
  }

  private orderOf(map: MapDocument): string[] {
    const roots = map.nodes.filter(node => !node.parentId);
    if (roots.length !== 1) throw new BookPipelineRunError("root");
    return readingOrder(map.nodes, { includeHidden: true });
  }
  private attachStore(drive: Drive, state: BookPipelineData): void {
    drive.store = new PipelineStore(state, next => this.persist(drive, next));
    drive.admission = createBudgetAdmission(createStoreBudgetPort(drive.store));
  }
  /** The state goes to the map file through the plugin's write queue (never from inside a `mutate` callback). */
  private persist(drive: Drive, state: BookPipelineData): Promise<void> {
    return this.ports.mutate(async () => {
      if (this.dead(drive) || drive.store.isDisposed) return;
      await this.ports.updateMap(drive.mapPath, doc => {
        doc.bookPipeline = state;
      });
    });
  }
  /** Reads the saved state of a map for resume and gate confirmation, and loads the cards. */
  private async openSaved(
    drive: Drive,
    mapPath: string,
    options: { allowDone?: boolean } = {}
  ): Promise<BookPipelineData> {
    if (this.ports.blocked(mapPath)) throw new BookPipelineRunError("blocked");
    const map = await this.ports.readMap(mapPath);
    const read = readBookPipeline(map);
    if (read.kind === "absent") throw new BookPipelineRunError("missing");
    if (read.kind === "unusable") throw new BookPipelineRunError("unusable");
    // A finished run is closed, except for a single-card rerun and for the budget pause such a rerun can end in.
    if (
      read.data.phase === "done" &&
      !options.allowDone &&
      !(read.data.status === "stopped" && read.data.pauseReason === "budget")
    )
      throw new BookPipelineRunError("finished");
    await this.load(drive, map, read.data.order, new Set(read.data.autoRoles));
    if (this.dead(drive)) throw new BookPipelineRunError("disposed");
    this.attachStore(drive, read.data);
    return read.data;
  }
  /** Reads every card of the run: its path, title, summary, role and stage (kept in memory, updated after each write). */
  private async load(
    drive: Drive,
    map: MapDocument,
    order: readonly string[],
    autoRoles: ReadonlySet<string>
  ): Promise<void> {
    drive.rootId = map.nodes.find(node => !node.parentId)?.id ?? "";
    if (map.nodes.filter(node => !node.parentId).length !== 1) throw new BookPipelineRunError("root");
    drive.ownerRoles.clear();
    drive.missingRoles.clear();
    for (const id of order) {
      const node = map.nodes.find(item => item.id === id);
      if (!node) {
        drive.stages.set(id, undefined);
        continue;
      }
      try {
        const card = await this.ports.readCard(node.path);
        if (card.fields.bookRole) {
          if (!autoRoles.has(id)) drive.ownerRoles.add(id);
        } else drive.missingRoles.set(id, !node.parentId || node.parentId === drive.rootId ? "intro" : "body");
        drive.cards.set(id, {
          path: node.path,
          title: card.title,
          summary: card.summary,
          role: card.fields.bookRole ?? drive.missingRoles.get(id) ?? "body"
        });
        drive.stages.set(id, card.fields.pipelineStage);
      } catch {
        throw new BookPipelineRunError("unreadable");
      }
    }
  }

  // ---- the loop ----------------------------------------------------------------------------------------------------------------
  private stagesOf(drive: Drive): Record<string, PipelineStage | undefined> {
    return Object.fromEntries(drive.stages);
  }
  private async loop(drive: Drive): Promise<void> {
    const inflight = new Map<string, Promise<void>>();
    while (!this.dead(drive) && drive.fatal === undefined) {
      const plan = nextActions(drive.store.state, this.stagesOf(drive), drive.busy);
      if (plan.hold === "global_failed") drive.failure = drive.reasons.get("global") ?? "failed";
      if (plan.hold) break;
      let started = 0;
      let changed = false;
      for (const action of plan.actions) {
        if (this.dead(drive) || drive.controller.signal.aborted) break;
        if (action.type === "reset_stage") {
          await this.reset(drive, action.nodeId);
          changed = true;
        } else if (action.type === "mark_needs_review") {
          await this.markReview(drive, action.nodeId, action.step, drive.reasons.get(action.nodeId) ?? "failed");
          changed = true;
        } else if (action.type === "advance_phase") {
          if (await this.startFixes(drive)) {
            changed = true;
            continue;
          }
          const before = drive.store.state;
          await drive.store.commit(state => ({
            state: advancePhase(state, this.stagesOf(drive), this.ports.now()),
            accepted: true
          }));
          if (drive.store.state !== before) changed = true;
        } else {
          const key = action.type === "global_plan" ? "global" : action.nodeId;
          if (action.type !== "global_plan" && inflight.size >= BOOK_POOL) continue;
          drive.busy.add(key);
          started++;
          inflight.set(
            key,
            this.step(drive, action)
              .then(() => undefined)
              .finally(() => {
                drive.busy.delete(key);
                inflight.delete(key);
              })
          );
        }
      }
      if (changed && !started) continue;
      if (inflight.size) await Promise.race(inflight.values());
      else if (!started && !changed) break;
    }
    await Promise.all(inflight.values());
  }

  // ---- one step ----------------------------------------------------------------------------------------------------------------
  private async step(
    drive: Drive,
    action: Extract<PipelineAction, { type: "global_plan" | "card_plan" | "card_write" | "card_proof" }>
  ): Promise<StepResult> {
    try {
      return await this.stepOnce(drive, action);
    } finally {
      // The in-memory sub-step ends with the step, whatever way it ended.
      drive.sub.delete(action.type === "global_plan" ? "global" : action.nodeId);
    }
  }
  private async stepOnce(
    drive: Drive,
    action: Extract<PipelineAction, { type: "global_plan" | "card_plan" | "card_write" | "card_proof" }>
  ): Promise<StepResult> {
    const nodeId = action.type === "global_plan" ? undefined : action.nodeId;
    const kind = action.type === "global_plan" ? "global" : STEP_OF[action.type];
    const key = nodeId ?? "global";
    const logStep: PipelineStep = kind === "global" ? "plan" : kind;
    const startedAt = Date.parse(this.ports.now());
    if (nodeId && !drive.started.has(nodeId)) drive.started.set(nodeId, startedAt);
    drive.sub.set(key, { step: logStep, startedAt });
    try {
      const begun = await drive.store.commit(state => {
        const dispatched = beginStep(state, kind, nodeId);
        return dispatched
          ? { state: dispatched.state, accepted: true, token: dispatched.token }
          : { state, accepted: false as const, token: undefined };
      });
      if (!begun || !begun.accepted || !begun.token) return "none";
      const token = begun.token;
      let outcome: Outcome;
      try {
        outcome =
          action.type === "global_plan"
            ? await this.execGlobal(drive, token)
            : action.type === "card_plan"
              ? await this.execPlan(drive, token, action.nodeId)
              : action.type === "card_write"
                ? await this.execWrite(drive, token, action.nodeId)
                : await this.execProof(drive, token, action.nodeId);
      } catch (error) {
        outcome = this.classify(drive, error);
      }
      if (this.dead(drive)) return "none";
      const ms = Math.max(0, Date.parse(this.ports.now()) - startedAt || 0);
      const report = async (result: string): Promise<void> => {
        const attempt = attemptsOf(drive.store.state, key)[logStep];
        this.ports.log(
          formatPipelineLog({ event: "step", runId: token.runId, card: key, step: logStep, attempt, result, ms })
        );
      };
      if (outcome.kind === "ok") {
        const done = await drive.store.commit(state => applySuccess(state, token));
        if (!done) return "none";
        if (!done.accepted) {
          await drive.store.commit(state => applyCancelled(state, token));
          await report("dropped");
          return "dropped";
        }
        await outcome.after?.();
        this.recordDuration(drive, kind, nodeId, Date.parse(this.ports.now()), drive.store.state.phase);
        await report("ok");
        return "ok";
      } else if (outcome.kind === "cancelled") {
        await drive.store.commit(state => applyCancelled(state, token));
        await report("cancelled");
        return "cancelled";
      } else if (outcome.kind === "budget") {
        await drive.store.commit(state => applyBudgetExhausted(state, token));
        drive.controller.abort();
        await report("budget");
        return "budget";
      } else {
        const failed = await drive.store.commit(state => applyFailure(state, token));
        if (!failed) return "none";
        if (!failed.accepted) {
          await drive.store.commit(state => applyCancelled(state, token));
          await report("dropped");
          return "dropped";
        }
        drive.reasons.set(key, outcome.reason);
        if (nodeId && kind !== "global" && (failed.needsReview || outcome.forceReview))
          await this.markReview(drive, nodeId, kind, outcome.reason);
        await report(`failed:${code(outcome.reason)}`);
        return "failed";
      }
    } catch (error) {
      if (!this.dead(drive)) {
        drive.fatal = error;
        drive.failure = internalCode(error);
        this.ports.log(
          formatPipelineLog({
            event: "error",
            runId: drive.store?.state.runId ?? "-",
            card: key,
            step: logStep,
            attempt: 0,
            result: drive.failure,
            ms: 0
          })
        );
      }
    }
    return "none";
  }

  /** A card that finished its phase's last step (planned in planning, proofread in writing) adds its wall time to the estimate. */
  private recordDuration(
    drive: Drive,
    kind: PipelineStepKind,
    nodeId: string | undefined,
    now: number,
    phase: BookPipelineData["phase"]
  ): void {
    const begun = nodeId ? drive.started.get(nodeId) : undefined;
    if (begun === undefined || !nodeId) return;
    const list =
      phase === "planning" && kind === "plan"
        ? drive.durations.plan
        : phase === "writing" && kind === "proof"
          ? drive.durations.write
          : undefined;
    if (!list) return;
    list.push(Math.max(0, now - begun));
    drive.started.delete(nodeId);
  }

  private classify(drive: Drive, error: unknown): Outcome {
    if (isBudgetExhausted(error)) return { kind: "budget" };
    if (drive.controller.signal.aborted || (error instanceof Error && error.name === "AbortError"))
      return { kind: "cancelled" };
    return { kind: "failed", reason: reasonOf(error) };
  }
  private authorize(drive: Drive, token: StepToken): () => boolean {
    return () => !this.dead(drive) && !drive.controller.signal.aborted && isCurrent(drive.store.state, token);
  }
  private base(drive: Drive, model: string): BookStepBase {
    return { language: drive.config.language, model, reasoning: drive.config.reasoning, usageMapPath: drive.mapPath };
  }
  /** The card's current path when it is still on the map, else undefined (checked after the call, before any write). */
  private async stillOnMap(drive: Drive, nodeId: string): Promise<string | undefined> {
    const map = await this.ports.readMap(drive.mapPath);
    return map.nodes.find(node => node.id === nodeId)?.path;
  }
  private async ensureBackup(drive: Drive, nodeId: string, path: string, raw: string): Promise<boolean> {
    if (drive.backedUp.has(nodeId)) return true;
    const saved = await this.ports.backupNote(path, raw).catch(() => ({ ok: false as const }));
    if (saved.ok) {
      drive.backedUp.add(nodeId);
      drive.backupPaths.set(nodeId, saved.path);
    }
    return saved.ok;
  }
  private async writeFields(drive: Drive, nodeId: string, patch: PipelineFieldsPatch): Promise<void> {
    const info = drive.cards.get(nodeId);
    if (!info || this.dead(drive)) return;
    try {
      await this.ports.writePipelineFields(info.path, patch);
    } catch {
      // the card is gone or unreadable: the in-memory stage still leads the run
    }
  }
  private async setStage(drive: Drive, nodeId: string, stage: PipelineStage, issue: string | null): Promise<void> {
    drive.stages.set(nodeId, stage);
    await this.writeFields(drive, nodeId, { pipelineStage: stage, pipelineIssue: issue });
  }
  private async markReview(drive: Drive, nodeId: string, step: PipelineStep, reason: string): Promise<void> {
    drive.stages.set(nodeId, "needs-review");
    drive.reviewStep.set(nodeId, step);
    await this.writeFields(drive, nodeId, {
      pipelineStage: "needs-review",
      pipelineIssue: `${step} failed: ${code(reason)}`
    });
    if (step !== "plan" && !NO_FAILURE_SECTION.has(reason)) await this.writeFailureSection(drive, nodeId, reason);
  }
  /**
   * The one automatic redo (plan 2026 flow v3, E), after every card has had its first round: a card whose proofread named unmet points
   * gets its text written again by the author alone (the plan and the checklist stay, attempts are not reset), then proofread once more.
   * The real points go to the author only (never to the proofread). A refused or no longer allowed request leaves the card needs-review.
   * Returns how many cards were sent back; only cards queued by this drive's own proofreads are considered.
   */
  private async startFixes(drive: Drive): Promise<number> {
    let started = 0;
    const queued = [...drive.fixable];
    drive.fixable.clear();
    for (const [nodeId, instruction] of queued) {
      if (this.dead(drive) || drive.controller.signal.aborted) break;
      if (drive.stages.get(nodeId) !== "needs-review") continue;
      const done = await drive.store.commit(state => requestAutoFix(state, nodeId));
      if (!done?.accepted) continue;
      // The rewrite may pick this card's own pictures again.
      const own = drive.cards.get(nodeId);
      const current = own ? await this.ports.readCard(own.path).catch(() => undefined) : undefined;
      if (current) for (const url of bodyImageUrls(current.detail)) drive.usedImages.delete(imageKey(url));
      drive.extra.set(nodeId, instruction);
      drive.avoid.add(nodeId);
      drive.reasons.delete(nodeId);
      drive.reviewStep.delete(nodeId);
      drive.imagesDone.delete(nodeId);
      drive.stages.set(nodeId, "planned");
      await this.writeFields(drive, nodeId, { pipelineStage: "planned", pipelineIssue: null });
      this.ports.log(
        formatPipelineLog({
          event: "auto_fix",
          runId: drive.store.state.runId,
          card: nodeId,
          step: "proof",
          attempt: 0,
          result: "unmet",
          ms: 0,
          counts: { round: autoFixesOf(drive.store.state, nodeId) }
        })
      );
      started++;
    }
    if (started) this.ports.progressed?.(drive.mapPath);
    return started;
  }
  /** The proof-result section of a card as `finalize`/`transform` text: the result with the models, or the failure line (never a model). */
  private proofSectionOf(
    drive: Drive,
    outcome: { result: ProofResult } | { failure: string },
    models: { model?: string; authorModel?: string },
    imageLine?: string
  ): (content: string) => string {
    const language = drive.config.language;
    const label = this.ports.modelLabel ? (id: string) => this.ports.modelLabel?.(id) ?? id : undefined;
    return content =>
      replaceProofSection(
        content,
        proofSectionHeading(language),
        composeProofSection(language, outcome, models, label, imageLine)
      );
  }
  /** Best effort: the card's proof-result section says "failed: reason" (no model). Never throws; skipped when nothing is known to be safe to write. */
  private async writeFailureSection(drive: Drive, nodeId: string, reason: string): Promise<void> {
    try {
      if (this.dead(drive) || drive.controller.signal.aborted) return;
      const path = await this.stillOnMap(drive, nodeId);
      if (!path) return;
      const card = await this.ports.readCard(path);
      const next = this.proofSectionOf(drive, { failure: code(reason) }, {})(card.raw);
      if (next === card.raw || !(await this.ensureBackup(drive, nodeId, path, card.raw))) return;
      await this.ports.updateNoteRawGuarded(path, () => next, {
        expectedContent: card.raw,
        authorize: () => !this.dead(drive) && !drive.controller.signal.aborted
      });
    } catch {
      // the card still shows its issue field; the section is only a help for the reader
    }
  }
  private async reset(drive: Drive, nodeId: string): Promise<void> {
    drive.stages.set(nodeId, undefined);
    await this.writeFields(drive, nodeId, { pipelineStage: null, pipelineIssue: null });
    await drive.store.commit(state => ({ state: applyReset(state, nodeId), accepted: true }));
  }

  private async execGlobal(drive: Drive, token: StepToken): Promise<Outcome> {
    const signal = drive.controller.signal;
    const root = drive.cards.get(drive.rootId);
    const order = drive.store.state.order;
    if (!root || order.some(id => !drive.cards.has(id))) return { kind: "failed", reason: "missing" };
    const before = await this.ports.readCard(root.path);
    const request: GlobalPlanRequest = {
      ...this.base(drive, drive.config.planModel),
      bookTitle: before.title,
      settings: before.settings,
      cards: order.map(id => {
        const info = drive.cards.get(id) as CardInfo;
        return { id, title: info.title, summary: info.summary };
      })
    };
    const result: GlobalPlanResult = await untilAborted(
      signal,
      this.ports.runPlan(globalPlanStep, request, { signal, admission: drive.admission })
    );
    const path = await this.stillOnMap(drive, drive.rootId);
    if (!path) return { kind: "failed", reason: "card_removed" };
    if (!(await this.ensureBackup(drive, drive.rootId, path, before.raw)))
      return { kind: "failed", reason: "backup_failed" };
    // The section's own heading is added by replaceBookPlanSection; its body (the ### parts) is the composed text after it.
    const section = composeBookPlan(
      { thread: result.thread, decisions: result.decisions, materials: result.materials },
      drive.config.language
    ).replace(/^## .*\n\n?/, "");
    const written = await this.ports.updateNoteRawGuarded(path, content => replaceBookPlanSection(content, section), {
      expectedContent: before.raw,
      authorize: this.authorize(drive, token)
    });
    if (written === "discarded") return { kind: "failed", reason: "discarded" };
    return {
      kind: "ok",
      after: async () => {
        for (const { id, role } of result.cards) {
          const info = drive.cards.get(id);
          if (!info || drive.ownerRoles.has(id)) continue;
          info.role = role;
          await this.writeFields(drive, id, { bookRole: role });
        }
      }
    };
  }

  private async execPlan(drive: Drive, token: StepToken, nodeId: string): Promise<Outcome> {
    const signal = drive.controller.signal;
    const info = drive.cards.get(nodeId);
    const rootInfo = drive.cards.get(drive.rootId);
    if (!info || !rootInfo) return { kind: "failed", reason: "missing" };
    const card = await this.ports.readCard(info.path);
    const root = await this.ports.readCard(rootInfo.path);
    const book = parseBookPlanBody(root.raw);
    const settings = effectiveSettings(root.settings, parseBookPlanDecisions(root.raw));
    const order = drive.store.state.order;
    const index = order.indexOf(nodeId);
    const side = (at: number): { position: number; title: string; summary: string } | undefined => {
      const other = order[at] === undefined ? undefined : drive.cards.get(order[at]);
      return other ? { position: at + 1, title: other.title, summary: other.summary } : undefined;
    };
    const previous = side(index - 1);
    const next = side(index + 1);
    const request: CardPlanRequest = {
      ...this.base(drive, drive.config.planModel),
      thread: book.thread,
      settings,
      materials: book.materials,
      card: {
        id: nodeId,
        position: index + 1,
        total: order.length,
        role: info.role,
        title: card.title,
        summary: card.summary
      },
      ...(previous ? { previous } : {}),
      ...(next ? { next } : {}),
      ...(drive.extra.has(nodeId) ? { instruction: drive.extra.get(nodeId) } : {})
    };
    const result: CardPlanResult = await untilAborted(
      signal,
      this.ports.runPlan(cardPlanStep, request, { signal, admission: drive.admission })
    );
    const path = await this.stillOnMap(drive, nodeId);
    if (!path) return { kind: "failed", reason: "card_removed" };
    if (!(await this.ensureBackup(drive, nodeId, path, card.raw)))
      return { kind: "failed", reason: "backup_failed", forceReview: true };
    // Always one line per accepted plan (also when nothing was dropped), so a run's log shows the filters did run: counts only.
    this.ports.log(
      formatPipelineLog({
        event: "checklist_dropped",
        runId: token.runId,
        card: nodeId,
        step: "plan",
        attempt: attemptsOf(drive.store.state, nodeId).plan,
        result: "ok",
        ms: 0,
        counts: {
          subjective: result.droppedSubjective ?? 0,
          picture: result.droppedPicture ?? 0,
          kept: result.checklist.length
        }
      })
    );
    const prompt = composeCardPrompt(
      {
        role: info.role,
        covers: result.covers,
        entry: result.entry,
        handoff: result.handoff,
        ...(previous ? { previous: { ...previous, summary: result.previous } } : {}),
        ...(next ? { next: { ...next, summary: result.next } } : {}),
        checklist: result.checklist,
        images: result.images
      },
      drive.config.language
    );
    const written = await this.ports.updateNoteGuarded(
      path,
      { prompt, summary: result.covers },
      { expectedContent: card.raw, authorize: this.authorize(drive, token) }
    );
    if (written === "discarded") return { kind: "failed", reason: "discarded" };
    drive.plans.set(nodeId, result);
    return { kind: "ok", after: () => this.setStage(drive, nodeId, "planned", null) };
  }

  private async execWrite(drive: Drive, token: StepToken, nodeId: string): Promise<Outcome> {
    const signal = drive.controller.signal;
    const info = drive.cards.get(nodeId);
    const rootInfo = drive.cards.get(drive.rootId);
    if (!info || !rootInfo) return { kind: "failed", reason: "missing" };
    drive.imagesDone.delete(nodeId);
    const card = await this.ports.readCard(info.path);
    const root = await this.ports.readCard(rootInfo.path);
    if (!(await this.ensureBackup(drive, nodeId, info.path, card.raw)))
      return { kind: "failed", reason: "backup_failed", forceReview: true };
    const authorize = this.authorize(drive, token);
    const slots = parseImageSlots(card.prompt);
    // The body is cleaned inside the author's own write (same `vault.process`): only standard https pictures are ever saved, and
    // an unsafe body is refused whole, so the card keeps its text from before this step.
    const knownLines: ReadonlySet<string> = new Set(card.raw.split("\n"));
    const ownRecords = extractProofRecords(normalizeWorkRecords(card.detail)).map(quoteAll);
    let unsafe = false;
    let emptyBody = false;
    const finalize = (original: string): string | null => {
      // The card's own stored records come back from the card (carried below), never from what the author kept of them: an exact copy is cut out first.
      const cut = ownRecords.reduce((text, record) => text.split(record).join(""), original);
      const held = holdProofLines(cut, knownLines);
      const restore = held.restore;
      // R1-6: anchors become markdown links first; the picture scan and the cleaning then run on the final text. Placeholder sections go.
      const content = neutralizeDetail(dropPlaceholderSections(convertSourceAnchors(held.text)));
      if (content === null) {
        emptyBody = true;
        return null;
      }
      const urls = bodyImageUrls(content);
      const unsafeUrls = new Map(
        urls.filter(url => !isHttps(url)).map(url => [url, noPicture(drive.config.language, "unsafe")])
      );
      const cleaned = replaceBodyImages(content, unsafeUrls);
      if (this.exitCheck(cleaned, new Set(urls.filter(isHttps)))) {
        unsafe = true;
        return null;
      }
      // An author result whose Detail holds no chapter text (only sources and notes) is refused: the card keeps its text.
      const detail = detailBlockOf(cleaned);
      if (detail !== undefined && !chapterBody(detail).trim()) {
        emptyBody = true;
        return null;
      }
      return restore(cleaned);
    };
    // Nothing of this card's frontmatter is written while the author runs: the research write compares the whole file.
    const done = await untilAborted(
      signal,
      this.ports.author({
        mapPath: drive.mapPath,
        nodeId,
        path: info.path,
        settings: effectiveSettings(root.settings, parseBookPlanDecisions(root.raw)),
        slots: slots ?? [],
        language: drive.config.language,
        model: drive.config.authorModel,
        reasoning: drive.config.reasoning,
        ...(drive.avoid.has(nodeId) ? { instruction: drive.extra.get(nodeId) } : {}),
        signal,
        admission: drive.admission,
        authorize,
        finalize
      })
    );
    if (unsafe) return { kind: "failed", reason: "unsafe_body", forceReview: true };
    if (emptyBody) return { kind: "failed", reason: "no_body" };
    if (done.outcome === "budget-exhausted") return { kind: "budget" };
    if (done.outcome === "cancelled") return { kind: "cancelled" };
    if (done.outcome === "failed") return { kind: "failed", reason: done.reason };
    if (done.outcome === "discarded") return { kind: "failed", reason: "discarded" };
    drive.authorModels.set(nodeId, drive.config.authorModel);
    // What is saved holds only standard https pictures. The program (not the model) probes them; a failed one becomes a plain "no picture" line.
    const path = await this.stillOnMap(drive, nodeId);
    if (!path) return { kind: "failed", reason: "card_removed" };
    let written = await this.ports.readCard(path);
    // A rewrite that replaced the whole Detail drops the work records and the picture section: the card's earlier log lines, its latest proof record
    // (its lines are in `knownLines` by construction) and its `### 圖像` section come back; the next proof replaces the record.
    // The write-back's own log section (or an older Research notes section) is turned into the hidden callout first, the card's first write in the new form.
    // Only the card's own earlier content (never what the author wrote this time) is turned into the hidden form.
    const earlier = normalizeWorkRecords(card.detail);
    let carried = carryWorkLog(
      earlier,
      hidePipelineLog(written.detail, new Set(workLogLines(earlier)), drive.backupPaths.get(nodeId))
    );
    for (const record of extractProofRecords(earlier).slice(-1)) carried = appendResearchNote(carried, record).text;
    // #12: an old Prompt (no picture plan) keeps the card's picture section; a card with a plan gets its pictures from the slots.
    if (slots === undefined) carried = carryImageSection(card.detail, carried);
    if (carried !== written.detail) {
      const outcome = await this.ports.updateNoteGuarded(
        path,
        { detail: carried },
        { expectedContent: written.raw, authorize }
      );
      if (outcome === "discarded") return { kind: "failed", reason: "discarded" };
      written = await this.ports.readCard(path);
    }
    const replacements = new Map<string, string>();
    for (const url of bodyImageUrls(written.raw)) {
      const probed = await untilAborted(signal, this.ports.probeImage(url, signal)).catch((error: unknown) => {
        if (signal.aborted) throw error;
        return { ok: false as const, reason: "探測失敗" };
      });
      if (!probed.ok) replacements.set(url, noPicture(drive.config.language, probed.reason));
    }
    if (replacements.size) {
      const held = holdProofLines(written.raw, knownLines);
      const cleaned = held.restore(replaceBodyImages(held.text, replacements));
      const outcome = await this.ports.updateNoteRawGuarded(path, () => cleaned, {
        expectedContent: written.raw,
        authorize
      });
      if (outcome === "discarded") return { kind: "failed", reason: "discarded" };
    }
    // The picture slots (T2): the author's markers become verified pictures in one guarded write, or the stage does not advance.
    drive.sub.set(nodeId, { step: "images", startedAt: Date.parse(this.ports.now()) });
    this.ports.progressed?.(drive.mapPath);
    const filled = await this.fillSlots(drive, token, nodeId, path, slots, authorize);
    if (filled) return filled;
    drive.imagesDone.add(nodeId);
    return { kind: "ok", after: () => this.setStage(drive, nodeId, "written", null) };
  }

  /**
   * The picture slots of one written card. No picture plan in the Prompt (`slots` undefined, #12): no search, no record, only a stray
   * marker line is deleted. With a plan: scan the markers, one search call for the slots that have a marker (an optional gain: a
   * failed or empty search leaves those slots `not_found`), probe the candidates (at most {@link PROBE_PER_CHAPTER} a chapter, at most
   * {@link PROBE_PARALLEL} in flight in the run), re-read the card, choose and claim the pictures in one synchronous turn, swap the
   * markers, verify, and write the text and the `book-slots:v1` record in one guarded write. Returns an outcome only when the step
   * ends (budget, a refused or discarded write); undefined means the markers are settled and the card may advance to written.
   */
  private async fillSlots(
    drive: Drive,
    token: StepToken,
    nodeId: string,
    path: string,
    slots: ImageSlot[] | undefined,
    authorize: () => boolean
  ): Promise<Outcome | undefined> {
    const signal = drive.controller.signal;
    const language = drive.config.language;
    const attempt = attemptsOf(drive.store.state, nodeId).write;
    if (!slots) return this.settleStrayMarkers(path, authorize);
    const first = await this.ports.readCard(path);
    const marked = slots.length ? scanSlotMarkers(first.detail, slots).found : new Map<number, number>();
    const others = new Set<string>();
    if (slots.length) {
      // What the other chapters already show (not this card's own old pictures: a rerun may pick again).
      for (const info of drive.cards.values())
        if (info.path !== path) {
          // A card deleted meanwhile is skipped: it must not fail this chapter.
          const other = await this.ports.readCard(info.path).catch(() => undefined);
          if (other) for (const url of bodyImageUrls(other.detail)) others.add(imageKey(url));
        }
    }
    const wanted = slots.filter(slot => marked.has(slot.index));
    const exclude = [...new Set([...drive.usedImages, ...others])];
    // One search call for `list`; a failed or timed-out call is an optional gain lost (undefined), never a failure of the chapter.
    const search = async (
      list: ImageSlot[],
      again: boolean,
      avoid: readonly string[]
    ): Promise<FoundImages | undefined> => {
      if (!list.length || !this.ports.findImages) return undefined;
      try {
        return await untilAborted(
          signal,
          this.ports.findImages(
            {
              ...this.base(drive, drive.config.imageModel),
              chapter: imageSearchText(first),
              slots: list.map(({ index, kind, explains }) => ({ index, kind, explains })),
              exclude: [...avoid],
              ...(again ? { again: true } : {})
            },
            { signal, admission: drive.admission }
          )
        );
      } catch (error) {
        if (isBudgetExhausted(error)) throw error;
        if (signal.aborted) throw error;
        return undefined;
      }
    };
    // Probe each distinct safe address once (the first PROBE_PER_CHAPTER in slot order, the limit covers both searches); the gate limits how many run at once.
    const probes = new Map<string, Promise<boolean>>();
    const loadedHref = new Map<string, boolean>();
    const probeFound = async (
      list: ImageSlot[],
      from: FoundImages | undefined
    ): Promise<Map<number, ProbedCandidate[]>> => {
      const listed = list.map(slot => ({
        index: slot.index,
        items: (from?.bySlot.get(slot.index) ?? []).map(candidate => {
          const href = safeHref(candidate.url);
          if (href && !probes.has(href) && probes.size < PROBE_PER_CHAPTER)
            probes.set(href, this.probeGated(drive, href));
          return { candidate, href };
        })
      }));
      await Promise.all(
        [...probes]
          .filter(([href]) => !loadedHref.has(href))
          .map(async ([href, work]) => loadedHref.set(href, await work))
      );
      return new Map(
        listed.map(({ index, items }) => [
          index,
          items.map(({ candidate, href }) => ({
            candidate: {
              imageUrl: candidate.url,
              sourceUrl: candidate.source,
              title: candidate.title,
              caption: candidate.caption
            },
            href,
            loaded: href ? (loadedHref.get(href) ?? false) : false,
            ...(href && !loadedHref.has(href) ? { skipped: true } : {})
          }))
        ])
      );
    };
    const perSlot = new Map<number, ProbedCandidate[]>();
    const taken = (key: string): boolean => drive.usedImages.has(key) || others.has(key);
    try {
      const round1 = await search(wanted, false, exclude);
      for (const [index, list] of await probeFound(wanted, round1)) perSlot.set(index, list);
      // A second search (once) for the slots the first one left without a usable picture: another direction, the tried addresses excluded.
      if (round1) {
        const provisional = choosePictures({ id: nodeId, title: first.title }, slots, perSlot, taken, language);
        const lacking = wanted.filter(slot => !("figure" in (provisional.get(slot.index) ?? {})));
        const tried = [
          ...new Set([...perSlot.values()].flatMap(list => list.map(item => imageKey(item.candidate.imageUrl))))
        ];
        const second = await search(lacking, true, [...tried, ...exclude]);
        if (second) {
          for (const [index, list] of await probeFound(lacking, second))
            perSlot.set(index, [...(perSlot.get(index) ?? []), ...list]);
        }
      }
    } catch (error) {
      if (isBudgetExhausted(error)) return { kind: "budget" };
      throw error;
    }
    // Re-read the latest text: the search and the probes took time, and the owner may have edited the card.
    const latest = await this.ports.readCard(path);
    // The card may have left the map while the search and the probes ran: nothing is claimed or written for it.
    if (!(await this.stillOnMap(drive, nodeId))) return { kind: "failed", reason: "card_removed" };
    const outcomes = choosePictures({ id: nodeId, title: latest.title }, slots, perSlot, taken, language);
    // Claim in the same synchronous turn as the choice: chapters run side by side, so the exclude list alone cannot stop a repeat.
    const claimed = [...outcomes.values()].flatMap(outcome =>
      "figure" in outcome ? [imageKey(outcome.figure.href)] : []
    );
    for (const key of claimed) drive.usedImages.add(key);
    const release = (): void => {
      for (const key of claimed) drive.usedImages.delete(key);
    };
    try {
      const result = await this.writeFilled(latest, slots, outcomes, authorize);
      if (typeof result === "string") {
        release();
        return { kind: "failed", reason: result };
      }
      this.ports.log(
        formatPipelineLog({
          event: "slots",
          runId: token.runId,
          card: nodeId,
          step: "write",
          attempt,
          result: "ok",
          ms: 0,
          counts: { placed: result.placed.length, missing: result.missing.length },
          hosts: { name: "reason", list: [...new Set(result.missing.map(item => item.reasonCode))] }
        })
      );
      return undefined;
    } catch (error) {
      release();
      throw error;
    }
  }

  /** One probe through the run-wide gate: true when the picture loads. A probe that throws (not a Stop) counts as not loaded. */
  private async probeGated(drive: Drive, href: string): Promise<boolean> {
    const signal = drive.controller.signal;
    const gate = drive.probeGate;
    if (signal.aborted) throw new Error("aborted");
    if (gate.active < PROBE_PARALLEL) gate.active++;
    else
      await new Promise<void>((resolve, reject) => {
        const grant = (): void => {
          signal.removeEventListener("abort", onAbort);
          resolve();
        };
        const onAbort = (): void => {
          const at = gate.waiters.indexOf(grant);
          if (at >= 0) gate.waiters.splice(at, 1);
          reject(new Error("aborted"));
        };
        signal.addEventListener("abort", onAbort, { once: true });
        gate.waiters.push(grant);
      });
    try {
      const probed = await untilAborted(signal, this.ports.probeImage(href, signal)).catch((error: unknown) => {
        if (signal.aborted) throw error;
        return { ok: false as const };
      });
      return probed.ok;
    } finally {
      const next = gate.waiters.shift();
      if (next) next();
      else gate.active--;
    }
  }

  /**
   * Swaps the markers of `latest` for the chosen pictures and writes text plus record in one guarded write (the write is refused when
   * the card changed since `latest`, or a marker is left outside fences and quotes). Returns the fill result, or a failure reason
   * (nothing was written): the three checks, the exit check, or a discarded write.
   */
  private async writeFilled(
    latest: PipelineCard,
    slots: readonly ImageSlot[],
    outcomes: ReadonlyMap<number, SlotOutcome>,
    authorize: () => boolean
  ): Promise<FillResult | string> {
    const result = fillSlotMarkers(latest.detail, slots, outcomes);
    const bad = verifyFill(latest.detail, result, slots);
    if (bad) return `slots_${bad}`;
    // The exit check: nothing but the placed addresses may be an image in what this write adds.
    if (this.exitCheck(result.added.join("\n"), new Set(result.placed.map(item => item.href)))) return "slots_unsafe";
    const detail = slots.length ? replaceResearchRecord(result.text, composeSlotsRecord(result)) : result.text;
    if (detail === latest.detail) return result;
    const outside = residualMarkerLines(latest.raw).length - residualMarkerLines(latest.detail).length;
    const outcome = await this.ports.updateNoteGuarded(
      latest.path,
      { detail },
      {
        expectedContent: latest.raw,
        authorize,
        finalize: content => (residualMarkerLines(content).length > Math.max(0, outside) ? null : content)
      }
    );
    return outcome === "discarded" ? "discarded" : result;
  }

  /** An old Prompt has no picture plan: nothing is searched or recorded; a marker line the author left anyway is deleted (the card's own pictures stay). */
  private async settleStrayMarkers(path: string, authorize: () => boolean): Promise<Outcome | undefined> {
    const latest = await this.ports.readCard(path);
    if (!residualMarkerLines(latest.detail).length) return undefined;
    const result = await this.writeFilled(latest, [], new Map(), authorize);
    return typeof result === "string" ? { kind: "failed", reason: result } : undefined;
  }

  /** The independent exit check of an author result (a method so a test can force it to fail). */
  private exitCheck(cleaned: string, allowed: ReadonlySet<string>): boolean {
    return unsafeBody(cleaned, allowed);
  }

  private async execProof(drive: Drive, token: StepToken, nodeId: string): Promise<Outcome> {
    const signal = drive.controller.signal;
    const info = drive.cards.get(nodeId);
    if (!info) return { kind: "failed", reason: "missing" };
    const card = await this.ports.readCard(info.path);
    const checklist = parseChecklist(card.prompt);
    const chapter = chapterBody(card.detail);
    const body = stripImageLines(chapter);
    const imageCheck = checkImageText(chapter, parseImageSlots(card.prompt), latestSlotsRecord(card.detail));
    const imageLine = composeImageTextLine(drive.config.language, imageCheck);
    if (!checklist.length) return { kind: "failed", reason: "empty_list" };
    if (!body.trim()) return { kind: "failed", reason: "no_body" };
    const key = proofKey({
      runId: token.runId,
      nodeId,
      revision: cardRevision(drive.store.state, nodeId),
      body,
      checklist
    });
    let result: ProofResult | undefined = findStoredProof(card.detail, key);
    if (!result) {
      // A whole-card failure keeps the judgments already made (the structure items) in the research notes; the card still needs a human.
      const call = this.ports
        .runProofread(
          { ...this.base(drive, drive.config.proofModel), body, checklist },
          { signal, admission: drive.admission }
        )
        .catch(async (error: unknown) => {
          if (isProofFailure(error) && error.counts)
            this.logProofCounts(drive, token.runId, nodeId, error.counts, "failed");
          if (isProofFailure(error) && error.partial && !signal.aborted)
            await this.keepPartialProof(
              drive,
              token,
              nodeId,
              card,
              composeProofRecord(failedProofKey(key), error.partial, error.code)
            );
          throw error;
        });
      result = await untilAborted(signal, call);
      if (result.counts) this.logProofCounts(drive, token.runId, nodeId, result.counts, "ok");
      const path = await this.stillOnMap(drive, nodeId);
      if (!path) return { kind: "failed", reason: "card_removed" };
      if (!(await this.ensureBackup(drive, nodeId, path, card.raw)))
        return { kind: "failed", reason: "backup_failed", forceReview: true };
      const models = { model: drive.config.proofModel, authorModel: drive.authorModels.get(nodeId) };
      const written = await this.ports.updateNoteGuarded(
        path,
        { detail: replaceResearchRecord(card.detail, composeProofRecord(key, result, undefined, models)) },
        {
          expectedContent: card.raw,
          authorize: this.authorize(drive, token),
          finalize: this.proofSectionOf(drive, { result }, models, imageLine)
        }
      );
      if (written === "discarded") return { kind: "failed", reason: "discarded" };
    } else {
      // R1-5: a stored result is reused, and the section still follows it: the model shown is the one stored with the result (never
      // today's setting); a record from before models were kept shows "not recorded".
      const stored = findStoredProofModels(card.detail, key);
      const models = {
        ...(stored?.model ? { model: stored.model } : {}),
        authorModel: drive.authorModels.get(nodeId) ?? stored?.authorModel
      };
      const next = this.proofSectionOf(drive, { result }, models, imageLine)(card.raw);
      if (next !== card.raw) {
        const path = await this.stillOnMap(drive, nodeId);
        if (!path) return { kind: "failed", reason: "card_removed" };
        if (!(await this.ensureBackup(drive, nodeId, path, card.raw)))
          return { kind: "failed", reason: "backup_failed", forceReview: true };
        const written = await this.ports.updateNoteRawGuarded(path, () => next, {
          expectedContent: card.raw,
          authorize: this.authorize(drive, token)
        });
        if (written === "discarded") return { kind: "failed", reason: "discarded" };
      }
    }
    const verdict = result;
    // Unmet structure items do not stop the card: it stays checked, and the count is kept in its issue field for the card's small note.
    const structureUnmet = verdict.items
      .filter(item => item.type !== "fact" && item.status === "unmet")
      .map(item => code(item.id));
    const noticed = [...structureUnmet, ...imageIssueTokens(imageCheck)];
    return {
      kind: "ok",
      after: async () => {
        if (verdict.aggregate === "needs-review" && !drive.job && autoFixesOf(drive.store.state, nodeId) === 0)
          drive.fixable.set(nodeId, proofFixInstruction(verdict.items, checklist));
        else if (!drive.job) {
          drive.extra.delete(nodeId);
          drive.avoid.delete(nodeId);
        }
        await this.setStage(
          drive,
          nodeId,
          verdict.aggregate,
          verdict.aggregate === "needs-review"
            ? verdict.factsUnverified
              ? "proof unmet: facts_unverified"
              : `proof unmet: ${verdict.items
                  .filter(item => item.type === "fact" && item.status === "unmet")
                  .map(item => code(item.id))
                  .join(" ")}`
            : noticed.length
              ? `structure unmet: ${noticed.join(" ")}`
              : null
        );
      }
    };
  }

  /** Best effort: replaces the proof records in the research notes with the failed proof's partial record (its own key), under the same guards as every card write. Never throws. */
  private async keepPartialProof(
    drive: Drive,
    token: StepToken,
    nodeId: string,
    card: { raw: string; detail: string },
    record: string
  ): Promise<void> {
    try {
      const path = await this.stillOnMap(drive, nodeId);
      if (!path || !(await this.ensureBackup(drive, nodeId, path, card.raw))) return;
      await this.ports.updateNoteGuarded(
        path,
        { detail: replaceResearchRecord(card.detail, record) },
        { expectedContent: card.raw, authorize: this.authorize(drive, token) }
      );
    } catch {
      // The failure itself is still reported; the partial record is only a help for the reader.
    }
  }

  // ---- progress and log --------------------------------------------------------------------------------------------------------
  private progressOf(drive: Drive, active: boolean): BookPipelineProgress {
    const state = drive.store.state;
    const counts: BookPipelineProgress["counts"] = {
      pending: 0,
      planned: 0,
      written: 0,
      checked: 0,
      "needs-review": 0
    };
    for (const id of state.order) counts[drive.stages.get(id) ?? "pending"]++;
    const eta = this.etaOf(drive, active);
    const imagesDone = [...drive.imagesDone].filter(id => {
      const stage = drive.stages.get(id);
      return state.order.includes(id) && stage !== "written" && stage !== "checked";
    }).length;
    return {
      runId: state.runId,
      phase: state.phase,
      status: state.status,
      ...(state.pauseReason ? { pauseReason: state.pauseReason } : {}),
      ...(state.failureCode ? { failureCode: state.failureCode } : {}),
      active,
      total: state.order.length,
      counts,
      budget: { ...state.budget },
      startedAt: state.startedAt,
      phaseStartedAt: state.phaseStartedAt,
      busyCards: [...drive.busy].filter(id => id !== "global"),
      ...(eta === undefined ? {} : { etaSeconds: eta }),
      ...(active && drive.rerun ? { rerun: { ...drive.rerun } } : {}),
      ...(active && drive.sub.size
        ? { current: [...drive.sub].map(([nodeId, sub]) => ({ nodeId, step: sub.step, startedAt: sub.startedAt })) }
        : {}),
      steps: stepCounts(counts, imagesDone, {
        settled: state.phase === "gate2" || state.phase === "done",
        proofFailed: state.order.filter(
          id => drive.stages.get(id) === "needs-review" && drive.reviewStep.get(id) === "proof"
        ).length
      })
    };
  }
  /** Average wall time of the cards that finished this phase in this drive × cards left ÷ pool; undefined below {@link ETA_MIN_CARDS} finished cards. */
  private etaOf(drive: Drive, active: boolean): number | undefined {
    const state = drive.store.state;
    if (!active || state.status !== "running") return undefined;
    const planning = state.phase === "planning";
    if (!planning && state.phase !== "writing") return undefined;
    const list = planning ? drive.durations.plan : drive.durations.write;
    if (list.length < ETA_MIN_CARDS) return undefined;
    const left = state.order.filter(id => {
      const stage = drive.stages.get(id);
      return planning ? stage === undefined : stage !== "checked" && stage !== "needs-review";
    }).length;
    const average = list.reduce((sum, ms) => sum + ms, 0) / list.length;
    return Math.max(0, Math.round((average * left) / BOOK_POOL / 1000));
  }
  /** One line per proofread call: the numbers only (the call has no content log, so this is the trace of what it did). */
  private logProofCounts(drive: Drive, runId: string, nodeId: string, counts: ProofCounts, result: string): void {
    this.ports.log(
      formatPipelineLog({
        event: "proof_calls",
        runId,
        card: nodeId,
        step: "proof",
        attempt: attemptsOf(drive.store.state, nodeId).proof,
        result,
        ms: 0,
        counts: {
          openedPages: counts.openedPages,
          searches: counts.searches,
          ...(counts.sources
            ? {
                sourcesCited: counts.sources.sourcesCited,
                sourcesMatched: counts.sources.sourcesMatched,
                eventUrls: counts.sources.eventUrls
              }
            : {})
        },
        ...(counts.sources ? { hosts: { name: "unmatchedHosts", list: counts.sources.unmatchedHosts } } : {})
      })
    );
  }
  private log(drive: Drive, event: string, card: string, step: PipelineStep, result: string): void {
    this.ports.log(
      formatPipelineLog({ event, runId: drive.store?.state.runId ?? "-", card, step, attempt: 0, result, ms: 0 })
    );
  }
}
