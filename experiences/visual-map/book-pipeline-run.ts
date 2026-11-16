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
import { isBudgetExhausted } from "../../core/admission";
import { createBudgetAdmission, createStoreBudgetPort } from "../../core/book-pipeline/budget";
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
  beginStep,
  cardRevision,
  confirmGate1,
  isCurrent,
  newBookPipeline,
  nextActions,
  recoverInterrupted,
  resumeRun,
  retryGlobalPlan,
  stopRun,
  failRun,
  type PipelineAction,
  type StepToken
} from "../../core/book-pipeline/machine";
import {
  attemptsOf,
  readBookPipeline,
  type BookPipelineData,
  type BookRole,
  type BookSettings,
  type PipelineFields,
  type PipelineFieldsPatch,
  type PipelineStage,
  type PipelineStep
} from "../../core/book-pipeline/model";
import {
  appendResearchNote,
  findStoredProof,
  replaceBookPlanSection,
  chapterBody
} from "../../core/book-pipeline/note-sections";
import {
  composeBookPlan,
  composeCardPrompt,
  parseBookPlanBody,
  parseBookPlanDecisions,
  parseChecklist
} from "../../core/book-pipeline/plan-text";
import {
  composeProofRecord,
  failedProofKey,
  isProofFailure,
  proofKey,
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
import { cardPlanStep, type CardPlanRequest, type CardPlanResult } from "../../core/steps/book-pipeline/card-plan";
import {
  globalPlanStep,
  type GlobalPlanRequest,
  type GlobalPlanResult
} from "../../core/steps/book-pipeline/global-plan";
import type { ProofreadRequest, ProofreadRun } from "../../core/steps/book-pipeline/proofread";
import type { StepDefinition } from "../../core/step-runner";
import { untilAborted } from "./argument-run";
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
  | "not_gate1";
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
  language: ContentLanguage;
  model: string;
  reasoning: ReasoningLevel;
  signal: AbortSignal;
  /** The call budget gate: the author's own `AiCalls` must carry it. */
  admission: AdmissionContext;
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
export type GuardOptions = { expectedContent?: string; authorize?: () => boolean };

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
  backupNote(path: string, raw: string): Promise<{ ok: true; path: string } | { ok: false }>;
  /** True while a conversation chain, a multi-select research or an argument run holds this map. */
  blocked(mapPath: string): boolean;
  config(mapPath: string): BookRunConfig;
  now(): string;
  newId(): string;
  log(line: string): void;
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
}

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
  stages: Map<string, PipelineStage | undefined>;
  backedUp: Set<string>;
  reasons: Map<string, string>;
  busy: Set<string>;
  stopRequested: boolean;
  disposed: boolean;
  fatal?: unknown;
  /** A neutral code of why the run ended by itself (see failRun). */
  failure?: string;
  done: Promise<void>;
}

const code = (value: string): string => value.replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 60) || "failed";
const reasonOf = (error: unknown): string =>
  isProofFailure(error) ? error.code : isBookStepError(error) ? "invalid_reply" : "failed";
/** An unexpected error's code: only its class name, never its message (which could carry a path or a title). */
const internalCode = (error: unknown): string =>
  `internal_${(typeof (error as { name?: unknown } | null)?.name === "string" ? (error as { name: string }).name : "unknown").replace(/[^A-Za-z0-9_]/g, "_").slice(0, 40)}`;
const STEP_OF = { card_plan: "plan", card_write: "write", card_proof: "proof" } as const;

const DEFINITION = /^ {0,3}\[([^\]\n]+)\]:[ \t]*(?:<([^>\n]*)>|(\S+))[^\n]*(?:\n|$)/gm;
const WIKI_TARGET = /^[^[\]()!<>\r\n\\]+$/;
const SCHEME = /^\s*(?:[a-z][a-z0-9+.-]*:|\/\/)/i;
const frontmatterLength = (content: string): number =>
  /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.exec(content)?.[0].length ?? 0;
const labelOf = (value: string): string => value.trim().replace(/\s+/g, " ").toLowerCase();
/** Every tag or comment start (also a `<` ending a chunk, which an image follows) becomes `&lt;`; only the note's own section markers (an exact comment with no payload) stay. */
const neutralize = (text: string): string =>
  text.replace(/<(?=[A-Za-z/!?]|$)(?!!-- visual-agent-map:(?:detail|references):(?:start|end) -->)/g, "&lt;");
const NO_PICTURE = "無圖：";
const PICTURE_REASONS: Record<string, [string, string]> = {
  unsafe: ["網址不安全", "unsafe address"],
  load_failed: ["無法載入", "could not load"],
  empty: ["空圖", "empty image"],
  timeout: ["逾時", "timed out"],
  aborted: ["已中止", "aborted"],
  none_found: ["未找到可驗證的公開圖片", "no verifiable public image found"]
};
/** The "no picture" line for a probe reason code (a known code in the output language; anything else is escaped text). */
function noPicture(language: string, reason: string): string {
  const known = Object.prototype.hasOwnProperty.call(PICTURE_REASONS, reason) ? PICTURE_REASONS[reason] : undefined;
  const zh = /^zh/i.test(language);
  const text = known ? known[zh ? 0 : 1] : escapeMarkdownText(reason, 60) || (zh ? "載入失敗" : "load failed");
  return zh ? `${NO_PICTURE}${text}` : `No picture: ${text}`;
}
const isHttps = (url: string): boolean => /^https:\/\//i.test(url);

/** An address that may be probed and written back: no whitespace, backslash, `<` or `>`; `new URL()` parses it as https with balanced parentheses. */
function safeHref(raw: string): string | undefined {
  if (!raw || /[\s\\<>\p{Cc}]/u.test(raw)) return undefined;
  let href: string;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:") return undefined;
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
  async start(mapPath: string): Promise<void> {
    return this.enter(mapPath, async drive => {
      if (this.ports.blocked(mapPath)) throw new BookPipelineRunError("blocked");
      const runId = this.ports.newId();
      let initial: BookPipelineData | undefined;
      await this.ports.mutate(async () => {
        if (this.dead(drive)) return;
        const map = await this.ports.readMap(mapPath);
        const read = readBookPipeline(map);
        if (read.kind === "unusable") throw new BookPipelineRunError("unusable");
        if (read.kind === "usable" && read.data.phase !== "done") throw new BookPipelineRunError("exists");
        const order = this.orderOf(map);
        await this.load(drive, map, order);
        const stale = order.filter(id => drive.stages.get(id) !== undefined);
        const state = newBookPipeline({ runId, order, now: this.ports.now(), staleStages: stale });
        if (this.dead(drive)) return;
        await this.ports.updateMap(mapPath, doc => {
          const found = readBookPipeline(doc);
          if (found.kind === "unusable" || (found.kind === "usable" && found.data.phase !== "done"))
            throw new BookPipelineRunError("exists");
          doc.bookPipeline = state;
        });
        initial = state;
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
      this.log(drive, "resume", "-", "plan", data.status === "running" ? "recovered" : "ok");
    });
  }

  /** The owner confirmed gate 1: writing starts (or a stopped run at gate 1 continues into it). */
  async confirmGate1(mapPath: string): Promise<void> {
    return this.enter(mapPath, async drive => {
      await this.openSaved(drive, mapPath);
      let moved = false;
      await drive.store.commit(state => {
        const next = confirmGate1(resumeRun(state) ?? state, this.ports.now());
        moved = next.phase !== state.phase;
        return { state: moved ? next : state, accepted: true };
      });
      if (!moved) throw new BookPipelineRunError("not_gate1");
      this.log(drive, "gate1", "-", "write", "confirmed");
    });
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
  private enter(mapPath: string, setup: (drive: Drive) => Promise<void>): Promise<void> {
    if (this.disposed) return Promise.reject(new BookPipelineRunError("disposed"));
    if (this.drives.has(mapPath)) return Promise.reject(new BookPipelineRunError("busy"));
    const drive = {
      mapPath,
      controller: new AbortController(),
      config: this.ports.config(mapPath),
      cards: new Map(),
      stages: new Map(),
      backedUp: new Set(),
      reasons: new Map(),
      busy: new Set(),
      stopRequested: false,
      disposed: false,
      rootId: "",
      done: Promise.resolve()
    } as unknown as Drive;
    this.drives.set(mapPath, drive);
    drive.done = this.go(drive, setup);
    return drive.done;
  }
  private async go(drive: Drive, setup: (drive: Drive) => Promise<void>): Promise<void> {
    let refusal: BookPipelineRunError | undefined;
    try {
      await setup(drive);
      if (drive.store && !this.dead(drive) && !drive.stopRequested) await this.loop(drive);
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
        if (drive.store && !this.dead(drive)) {
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
  private async openSaved(drive: Drive, mapPath: string): Promise<BookPipelineData> {
    if (this.ports.blocked(mapPath)) throw new BookPipelineRunError("blocked");
    const map = await this.ports.readMap(mapPath);
    const read = readBookPipeline(map);
    if (read.kind === "absent") throw new BookPipelineRunError("missing");
    if (read.kind === "unusable") throw new BookPipelineRunError("unusable");
    if (read.data.phase === "done") throw new BookPipelineRunError("finished");
    await this.load(drive, map, read.data.order);
    if (this.dead(drive)) throw new BookPipelineRunError("disposed");
    this.attachStore(drive, read.data);
    return read.data;
  }
  /** Reads every card of the run: its path, title, summary, role and stage (kept in memory, updated after each write). */
  private async load(drive: Drive, map: MapDocument, order: readonly string[]): Promise<void> {
    drive.rootId = map.nodes.find(node => !node.parentId)?.id ?? "";
    if (map.nodes.filter(node => !node.parentId).length !== 1) throw new BookPipelineRunError("root");
    for (const id of order) {
      const node = map.nodes.find(item => item.id === id);
      if (!node) {
        drive.stages.set(id, undefined);
        continue;
      }
      try {
        const card = await this.ports.readCard(node.path);
        drive.cards.set(id, {
          path: node.path,
          title: card.title,
          summary: card.summary,
          role: card.fields.bookRole ?? "body"
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
            this.step(drive, action).finally(() => {
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
  ): Promise<void> {
    const nodeId = action.type === "global_plan" ? undefined : action.nodeId;
    const kind = action.type === "global_plan" ? "global" : STEP_OF[action.type];
    const key = nodeId ?? "global";
    const logStep: PipelineStep = kind === "global" ? "plan" : kind;
    const startedAt = Date.parse(this.ports.now());
    try {
      const begun = await drive.store.commit(state => {
        const dispatched = beginStep(state, kind, nodeId);
        return dispatched
          ? { state: dispatched.state, accepted: true, token: dispatched.token }
          : { state, accepted: false as const, token: undefined };
      });
      if (!begun || !begun.accepted || !begun.token) return;
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
      if (this.dead(drive)) return;
      const ms = Math.max(0, Date.parse(this.ports.now()) - startedAt || 0);
      const report = async (result: string): Promise<void> => {
        const attempt = attemptsOf(drive.store.state, key)[logStep];
        this.ports.log(
          formatPipelineLog({ event: "step", runId: token.runId, card: key, step: logStep, attempt, result, ms })
        );
      };
      if (outcome.kind === "ok") {
        const done = await drive.store.commit(state => applySuccess(state, token));
        if (!done) return;
        if (!done.accepted) {
          await drive.store.commit(state => applyCancelled(state, token));
          await report("dropped");
          return;
        }
        await outcome.after?.();
        await report("ok");
      } else if (outcome.kind === "cancelled") {
        await drive.store.commit(state => applyCancelled(state, token));
        await report("cancelled");
      } else if (outcome.kind === "budget") {
        await drive.store.commit(state => applyBudgetExhausted(state, token));
        drive.controller.abort();
        await report("budget");
      } else {
        const failed = await drive.store.commit(state => applyFailure(state, token));
        if (!failed) return;
        if (!failed.accepted) {
          await drive.store.commit(state => applyCancelled(state, token));
          await report("dropped");
          return;
        }
        drive.reasons.set(key, outcome.reason);
        if (nodeId && kind !== "global" && (failed.needsReview || outcome.forceReview))
          await this.markReview(drive, nodeId, kind, outcome.reason);
        await report(`failed:${code(outcome.reason)}`);
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
    if (saved.ok) drive.backedUp.add(nodeId);
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
    await this.writeFields(drive, nodeId, {
      pipelineStage: "needs-review",
      pipelineIssue: `${step} failed: ${code(reason)}`
    });
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
          if (!info) continue;
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
      ...(next ? { next } : {})
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
        checklist: result.checklist
      },
      drive.config.language
    );
    const written = await this.ports.updateNoteGuarded(
      path,
      { prompt, summary: result.covers },
      { expectedContent: card.raw, authorize: this.authorize(drive, token) }
    );
    if (written === "discarded") return { kind: "failed", reason: "discarded" };
    return { kind: "ok", after: () => this.setStage(drive, nodeId, "planned", null) };
  }

  private async execWrite(drive: Drive, token: StepToken, nodeId: string): Promise<Outcome> {
    const signal = drive.controller.signal;
    const info = drive.cards.get(nodeId);
    const rootInfo = drive.cards.get(drive.rootId);
    if (!info || !rootInfo) return { kind: "failed", reason: "missing" };
    const card = await this.ports.readCard(info.path);
    const root = await this.ports.readCard(rootInfo.path);
    if (!(await this.ensureBackup(drive, nodeId, info.path, card.raw)))
      return { kind: "failed", reason: "backup_failed", forceReview: true };
    const authorize = this.authorize(drive, token);
    // The body is cleaned inside the author's own write (same `vault.process`): only standard https pictures are ever saved, and
    // an unsafe body is refused whole, so the card keeps its text from before this step.
    let unsafe = false;
    const finalize = (content: string): string | null => {
      const urls = bodyImageUrls(content);
      const unsafeUrls = new Map(
        urls.filter(url => !isHttps(url)).map(url => [url, noPicture(drive.config.language, "unsafe")])
      );
      const cleaned = replaceBodyImages(content, unsafeUrls);
      if (this.exitCheck(cleaned, new Set(urls.filter(isHttps)))) {
        unsafe = true;
        return null;
      }
      return cleaned;
    };
    // Nothing of this card's frontmatter is written while the author runs: the research write compares the whole file.
    const done = await untilAborted(
      signal,
      this.ports.author({
        mapPath: drive.mapPath,
        nodeId,
        path: info.path,
        settings: effectiveSettings(root.settings, parseBookPlanDecisions(root.raw)),
        language: drive.config.language,
        model: drive.config.authorModel,
        reasoning: drive.config.reasoning,
        signal,
        admission: drive.admission,
        authorize,
        finalize
      })
    );
    if (unsafe) return { kind: "failed", reason: "unsafe_body", forceReview: true };
    if (done.outcome === "budget-exhausted") return { kind: "budget" };
    if (done.outcome === "cancelled") return { kind: "cancelled" };
    if (done.outcome === "failed") return { kind: "failed", reason: done.reason };
    if (done.outcome === "discarded") return { kind: "failed", reason: "discarded" };
    // What is saved holds only standard https pictures. The program (not the model) probes them; a failed one becomes a plain "no picture" line.
    const path = await this.stillOnMap(drive, nodeId);
    if (!path) return { kind: "failed", reason: "card_removed" };
    const written = await this.ports.readCard(path);
    const replacements = new Map<string, string>();
    for (const url of bodyImageUrls(written.raw)) {
      const probed = await untilAborted(signal, this.ports.probeImage(url, signal)).catch((error: unknown) => {
        if (signal.aborted) throw error;
        return { ok: false as const, reason: "探測失敗" };
      });
      if (!probed.ok) replacements.set(url, noPicture(drive.config.language, probed.reason));
    }
    if (replacements.size) {
      const cleaned = replaceBodyImages(written.raw, replacements);
      const outcome = await this.ports.updateNoteRawGuarded(path, () => cleaned, {
        expectedContent: written.raw,
        authorize
      });
      if (outcome === "discarded") return { kind: "failed", reason: "discarded" };
    }
    // Q13: a chapter with no picture and no "no picture" line gets one line in the research notes saying so (the body is not touched).
    const urls = bodyImageUrls(written.raw);
    this.ports.log(
      formatPipelineLog({
        event: "pictures",
        runId: token.runId,
        card: nodeId,
        step: "write",
        attempt: attemptsOf(drive.store.state, nodeId).write,
        result: "ok",
        ms: 0,
        counts: { pictures: urls.length }
      })
    );
    if (!urls.length) {
      const latest = await this.ports.readCard(path);
      const line = noPicture(drive.config.language, "none_found");
      if (!/無圖：|No picture:/.test(chapterBody(latest.detail)) && !latest.detail.includes(line)) {
        const added = appendResearchNote(latest.detail, line);
        if (added.appended) {
          const outcome = await this.ports.updateNoteGuarded(
            path,
            { detail: added.text },
            { expectedContent: latest.raw, authorize }
          );
          if (outcome === "discarded") return { kind: "failed", reason: "discarded" };
        }
      }
    }
    return { kind: "ok", after: () => this.setStage(drive, nodeId, "written", null) };
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
    const body = chapterBody(card.detail);
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
      const added = appendResearchNote(card.detail, composeProofRecord(key, result));
      if (added.appended) {
        const written = await this.ports.updateNoteGuarded(
          path,
          { detail: added.text },
          { expectedContent: card.raw, authorize: this.authorize(drive, token) }
        );
        if (written === "discarded") return { kind: "failed", reason: "discarded" };
      }
    }
    const verdict = result;
    // Unmet structure items do not stop the card: it stays checked, and the count is kept in its issue field for the card's small note.
    const structureUnmet = verdict.items
      .filter(item => item.type !== "fact" && item.status === "unmet")
      .map(item => code(item.id));
    return {
      kind: "ok",
      after: () =>
        this.setStage(
          drive,
          nodeId,
          verdict.aggregate,
          verdict.aggregate === "needs-review"
            ? `proof unmet: ${verdict.items
                .filter(item => item.type === "fact" && item.status === "unmet")
                .map(item => code(item.id))
                .join(" ")}`
            : structureUnmet.length
              ? `structure unmet: ${structureUnmet.join(" ")}`
              : null
        )
    };
  }

  /** Best effort: appends the failed proof's partial record once (its own key), under the same guards as every card write. Never throws. */
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
      const added = appendResearchNote(card.detail, record);
      if (added.appended)
        await this.ports.updateNoteGuarded(
          path,
          { detail: added.text },
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
      phaseStartedAt: state.phaseStartedAt
    };
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
        counts: { ...counts }
      })
    );
  }
  private log(drive: Drive, event: string, card: string, step: PipelineStep, result: string): void {
    this.ports.log(
      formatPipelineLog({ event, runId: drive.store?.state.runId ?? "-", card, step, attempt: 0, result, ms: 0 })
    );
  }
}
