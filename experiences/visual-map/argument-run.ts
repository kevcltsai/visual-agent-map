/**
 * Argument map runner (hypothesis research). Executes what `core/argument-map/machine.ts` allows, one checkpoint (one `mutate`) per
 * step, and nothing else: every gate lives in the machine and in `verifySource`; this file only moves data between them, the model
 * and the map. It has no dependency on main.ts or the view: everything it touches is an injected port, so it is tested with fakes.
 *
 * Rules kept here: `researchCalls` is written (begin) before a research dispatch; a result is committed only while the run id, the
 * item's `searching` state and the unchanged argument map still match (stale fence); a user-deleted node is skipped; Stop and
 * dispose abort everything and nothing is written after dispose; a failed step gets one corrective retry, then the run pauses.
 * A provider failure on a research item (the model never answered, e.g. the 3-minute limit) is not a try and never a miss: the item
 * goes back to pending, it is retried once, and a second consecutive failure pauses the run with 'error' (resumable). Only an
 * answer that arrived can become a miss (no_answer, not_found, a refused source).
 */
import type { TranslationKey } from "../../i18n";
import { neutralizeUnsafeMermaid } from "../../ai/mermaid-safety";
import {
  conclusionDetail,
  datumDetail,
  definitionsDetail,
  eliminatedWhy,
  facetDetail,
  hypothesisDetail,
  notFoundDetail,
  plainLine,
  situationDetail,
  sourceNote,
  type Translate
} from "./argument-notes";
import type { AiResult, TaskContext } from "../../ai/types";
import {
  GateError,
  addNeeds,
  addRetryNeeds,
  applyConclusion,
  applyEvidence,
  applyFacetVerdicts,
  applyGateMissing,
  applyHypotheses,
  applyLimitStop,
  applyPause,
  applyResume,
  applyQuickCausal,
  applyQuickRun,
  applySituationBudgetOut,
  applySituationEvidence,
  applySituationGate,
  applySituationPlan,
  applyVerdict,
  beginResearch,
  beginSituationResearch,
  eliminateAtLimit,
  applyFactConclusion,
  hasFacets,
  isSituationUnconfirmed,
  newArgumentMap,
  nextActions,
  prepareConclusion,
  prepareVerdict,
  releaseNeedResearch,
  releaseSituationResearch,
  startNextRound,
  type ArgumentAction,
  type EvidenceResult
} from "../../core/argument-map/machine";
import {
  MAX_HYPOTHESES,
  INSIGHT_MAX_TEXT,
  MAX_RESEARCH_CALLS,
  MAX_ROUND,
  MIN_VERIFIED,
  QUICK_CAUSAL_RUN,
  RESEARCH_DEADLINE_MS,
  foundNeeds,
  isLimitCut,
  composeFacets,
  isLegacyFacetMap,
  isUncertainSource,
  isVerified,
  liveCore,
  readArgumentMap,
  isStanceLocked,
  type ArgumentMapData,
  type ArgumentRoles,
  type QuestionType,
  type AssumptionItem,
  type Hypothesis,
  type SituationDatum,
  type RoleKey,
  type SearchLog,
  type SecondSource,
  type SourceTier,
  SEARCH_LOG_MAX_ITEMS,
  SEARCH_LOG_MAX_TEXT
} from "../../core/argument-map/model";
import { arrangeArgumentMap } from "../../core/argument-map/layout";
import { verifySource, type FetchPage } from "../../core/argument-map/source-proof";
import {
  ARGUMENT_STEPS,
  withRetryReason,
  ArgumentStepError,
  facetVerdictStep,
  gateData,
  isCausal,
  needsAllowed,
  type ArgumentStepBase,
  type ConclusionRequest,
  type ConclusionFactRequest,
  type ConclusionFactResult,
  type ConclusionResult,
  type FacetHypothesesRequest,
  type FacetHypothesesResult,
  type FacetJudgeRequest,
  type FacetJudgeResult,
  type FacetPlanRequest,
  type FacetPlanResult,
  type QuickCausalResult,
  type FacetVerdictResult,
  type GateDatum,
  type GateRequest,
  type GateVerdict,
  type HypothesesRequest,
  type HypothesesResult,
  type NeedsRequest,
  type NeedsResult,
  type VerdictRequest,
  type VerdictResult
} from "../../core/steps/argument-map/runner";
import type { StepDefinition } from "../../core/step-runner";
import type { MapDocument, MapNode } from "../../map-model";

export const MAX_RESEARCH_CONCURRENCY = 9;
/**
 * The most AI calls one run can make, shown before it starts (corrections and retries not counted): the research calls, plan_facets,
 * the facet judgement (at most two: round 1 and the retry round), propose (up to MAX_HYPOTHESES - MIN_VERIFIED + 1), a needs step and
 * a verdict step per hypothesis per round, and conclude.
 */
const FACET_JUDGEMENTS = 2;
export const WORST_CASE_AI_CALLS =
  MAX_RESEARCH_CALLS + 1 + FACET_JUDGEMENTS + (MAX_HYPOTHESES - MIN_VERIFIED + 1) + MAX_HYPOTHESES * MAX_ROUND * 2 + 1;
const X_STEP = 320;
const Y_STEP = 160;

export type ArgumentRunRefusal =
  "busy" | "unusable" | "exists" | "missing" | "finished" | "not_paused" | "legacy" | "disposed";
export class ArgumentRunError extends Error {
  constructor(readonly code: ArgumentRunRefusal) {
    super(`argument run refused: ${code}`);
    this.name = "ArgumentRunError";
  }
}

export type NoteKind = "proposition" | "situation" | "datum" | "conclusion" | "group" | "hypothesis" | "need";
/** The `topic-kind` a managed note is created with: a hypothesis, evidence (needs and situation data) or the conclusion; the rest are ordinary. */
export function topicKindOfNote(kind: NoteKind): "hypothesis" | "evidence" | "conclusion" | "topic" {
  return kind === "hypothesis"
    ? "hypothesis"
    : kind === "need" || kind === "datum"
      ? "evidence"
      : kind === "conclusion"
        ? "conclusion"
        : "topic";
}
export interface NoteInput {
  title: string;
  summary?: string;
  detail?: string;
  kind: NoteKind;
}
export interface BusyHandle {
  signal: AbortSignal;
  release: () => void;
}
export interface RunConfig {
  model: string;
  reasoning: ArgumentStepBase["reasoning"];
  language: ArgumentStepBase["language"];
}

export { plainLine };

/** Everything the runner touches. `mutate` is the plugin's serialized write queue; the others are repository/model/network seams. */
export interface ArgumentRunPorts {
  mutate(work: () => Promise<void>): Promise<void>;
  readMap(path: string): Promise<MapDocument>;
  updateMap(path: string, change: (map: MapDocument) => void): Promise<MapDocument>;
  /** Creates a note file and returns its node (not yet in the map). */
  createNote(input: NoteInput, map: MapDocument, mapPath: string): Promise<MapNode>;
  readNote(path: string): Promise<{ title: string; summary: string }>;
  updateNote(path: string, patch: { summary?: string; detail?: string }): Promise<void>;
  askModel(context: TaskContext, model: string, reasoning: unknown, signal: AbortSignal): Promise<AiResult>;
  /** Runs one of the six text-only steps (no web, no tools). Production: `askArgumentStep` over `providerArgumentRunner`. */
  runStep<Request extends ArgumentStepBase, Output>(
    step: StepDefinition<Request, Output>,
    request: Request,
    signal: AbortSignal
  ): Promise<Output>;
  fetch: FetchPage;
  parseHtml: (html: string) => string;
  now: () => string;
  newId: () => string;
  config(mapPath: string): RunConfig;
  /** Marks a note busy and gives its Stop signal (TopicRuns.begin); null when the note is already busy. */
  begin(notePath: string): BusyHandle | null;
  /** Drops the map's undo history after a runner commit. */
  clearUndo(mapPath: string): void;
  log(line: string): void;
  t(key: TranslationKey, ...values: unknown[]): string;
  /** Asks the usage confirmation before the first provider call of a run; false pauses it. Absent means allowed. */
  confirmUsage?(mapPath: string): Promise<boolean>;
  /** Test seam: the model time limit of one research call (default RESEARCH_DEADLINE_MS). */
  researchDeadlineMs?: number;
  /** Test seam: the timer behind that limit; returns its cancel (default: window.setTimeout). */
  setTimer?(handler: () => void, ms: number): () => void;
  /** Test seam: the quick run of a causal question (default QUICK_CAUSAL_RUN). */
  quickCausalRun?: boolean;
}

interface Drive {
  mapPath: string;
  controller: AbortController;
  /**
   * Wind-down of the calls still out (research and concurrent text steps) once the run only has its conclusion left. Separate from
   * `controller` (Stop) so it never pauses the run as 'user'; replaced by a fresh one after the calls have drained.
   */
  wind: AbortController;
  /** Set only on the per-task view of a concurrent text step: the wind-down signal that task was started under. */
  windSignal?: AbortSignal;
  stopRequested: boolean;
  disposed: boolean;
  done: Promise<void>;
  /** Consecutive provider failures per research item (memory only, per drive; reset by an answer). */
  failures: Map<string, number>;
  /** Set only while a corrective retry of a text step runs: why the previous attempt was refused. */
  retryReason?: string;
  /** A re-run's assumption items (from the owner's edited definitions); the facet plan overrides the AI's assumption card with them. */
  preset?: AssumptionItem[];
  /** A re-run's question type (the definitions card's 題型 line); it wins over the AI's. */
  presetQuestionType?: QuestionType;
  /** The single quick call came back as a fact question: the ordinary plan step runs instead (memory only, per drive). */
  quickDeclined?: boolean;
}
interface Plan {
  next: ArgumentMapData;
  /** Nodes to add with their parent. */
  nodes?: { node: MapNode; parentId: string | null }[];
  reparent?: { id: string; parentId: string }[];
  /** Note writes after the map write. */
  notes?: () => Promise<void>;
}

const shorten = (text: string, max: number): string => Array.from(text.trim()).slice(0, max).join("");
/** At most `max` UTF-16 units of the text, never splitting a character. */
const capText = (text: string, max: number): string => {
  let out = "";
  for (const ch of text.trim()) {
    if (out.length + ch.length > max) break;
    out += ch;
  }
  return out;
};
const domainOf = (url: string | undefined): string => {
  try {
    return new URL(url ?? "").hostname;
  } catch {
    return "-";
  }
};
/** The period and definitions the facet plan assumed, as one line for situation research; undefined when the map has none (old maps). */
export function assumptionScope(state: Pick<ArgumentMapData, "situation">): string | undefined {
  const items = state.situation.assumptions?.items ?? [];
  return items.length ? items.map(i => `${i.label}: ${i.value}`).join("; ") : undefined;
}
const scopeOf = (isNeed: boolean, state: Pick<ArgumentMapData, "situation">): { context?: string } => {
  const context = isNeed ? undefined : assumptionScope(state);
  return context ? { context } : {};
};
/** A signal that aborts when either input does (no `AbortSignal.any`, which older runtimes lack). */
function linked(a: AbortSignal, b: AbortSignal): AbortSignal {
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  if (a.aborted || b.aborted) abort();
  a.addEventListener("abort", abort, { once: true });
  b.addEventListener("abort", abort, { once: true });
  return controller.signal;
}
/** The call's result, or a rejection the moment `signal` aborts: a provider that ignores abort must not hang Stop. */
export function untilAborted<T>(signal: AbortSignal, work: Promise<T>): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error("aborted"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new Error("aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    const settle = (): void => signal.removeEventListener("abort", onAbort);
    work.then(
      value => {
        settle();
        resolve(value);
      },
      (error: unknown) => {
        settle();
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    );
  });
}
/** The item a research action works on (a need or a situation datum). */
const researchItem = (action: ArgumentAction): string =>
  action.type === "research_need" ? action.needId : action.type === "research_situation" ? action.dataId : "";
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** `gateData` refuses an empty list; an unconfirmed situation (decision #58) may have no usable datum at all, so only there an empty list passes. */
const dataOrNone = (state: ArgumentMapData, data: readonly SituationDatum[]): GateDatum[] =>
  data.length === 0 && isSituationUnconfirmed(state) ? [] : gateData(data);

/** Decision #61: the premise data a facet map hands to the hypothesis steps, the found data with a stance from the facets that support the
 * premise (an unconfirmed premise has none, so it sends what was found). Hypotheses cite no data (#62), so their needs get this too. */
const premiseData = (state: ArgumentMapData): SituationDatum[] => {
  const supporting = new Set((state.situation.facets ?? []).filter(f => f.verdict === "supports").map(f => f.id));
  return state.situation.data.filter(
    d =>
      d.state === "found" &&
      d.propStance !== undefined &&
      d.propStance !== "irrelevant" &&
      (isSituationUnconfirmed(state) || supporting.has(d.facetId ?? ""))
  );
};

export class ArgumentRuns {
  private readonly drives = new Map<string, Drive>();
  private waiting: (() => void)[] = [];
  private inFlight = 0;
  private disposed = false;

  constructor(private readonly ports: ArgumentRunPorts) {}

  // ---- note writes: every model/web-derived string passes here before it reaches a Markdown note ----------------------------------
  /** Translation with every string argument treated as plain single-line text. */
  private t(key: TranslationKey, ...values: unknown[]): string {
    return this.ports.t(key, ...values.map(v => (typeof v === "string" ? plainLine(v) : v)));
  }
  /** Raw translation for the note builders: they escape every model/web string themselves. */
  private readonly tr: Translate = (key, ...values) => this.ports.t(key, ...values);
  private makeNote(input: NoteInput, map: MapDocument, mapPath: string): Promise<MapNode> {
    const safe: NoteInput = { ...input, title: plainLine(input.title) };
    if (input.summary !== undefined) safe.summary = plainLine(input.summary);
    if (input.detail !== undefined) safe.detail = neutralizeUnsafeMermaid(input.detail);
    return this.ports.createNote(safe, map, mapPath);
  }
  private writeNote(path: string, patch: { summary?: string; detail?: string }): Promise<void> {
    const safe: { summary?: string; detail?: string } = {};
    if (patch.summary !== undefined) safe.summary = plainLine(patch.summary);
    if (patch.detail !== undefined) safe.detail = neutralizeUnsafeMermaid(patch.detail);
    return this.ports.updateNote(path, safe);
  }

  isRunning(mapPath: string): boolean {
    return this.drives.has(mapPath);
  }

  /** Creates the fixed nodes and the state, then runs to the end (or a pause). Resolves when the run is over. */
  async start(
    mapPath: string,
    proposition: string,
    options: { presetAssumptions?: AssumptionItem[]; presetQuestionType?: QuestionType } = {}
  ): Promise<void> {
    this.guard(mapPath);
    const text = proposition.trim();
    if (!text) throw new ArgumentRunError("missing");
    const drive = this.open(mapPath);
    if (options.presetAssumptions?.length) drive.preset = options.presetAssumptions.map(item => ({ ...item }));
    drive.presetQuestionType = options.presetQuestionType;
    drive.done = this.go(drive, async () => {
      const runId = this.ports.newId();
      await this.ports.mutate(async () => {
        if (this.dead(drive)) return;
        const map = await this.ports.readMap(mapPath);
        const read = readArgumentMap(map);
        if (read.kind !== "absent") throw new ArgumentRunError(read.kind === "usable" ? "exists" : "unusable");
        const p = this.ports;
        const make = (kind: NoteKind, title: string, summary?: string) =>
          this.makeNote({ kind, title, summary }, map, mapPath);
        const proposed = await make("proposition", shorten(text, 80), text);
        const situation = await make("situation", p.t("ui.argument_situation"));
        const conclusion = await make("conclusion", p.t("ui.argument_conclusion"), p.t("ui.argument_in_progress"));
        // Decision #66: a new map starts with these three; a causal plan makes the three groups at its checkpoint.
        const roles: ArgumentRoles = { proposition: proposed.id, situation: situation.id, conclusion: conclusion.id };
        const parents: [MapNode, string | null][] = [
          [proposed, null],
          [situation, proposed.id],
          [conclusion, proposed.id]
        ];
        if (this.dead(drive)) return;
        await p.updateMap(mapPath, doc => {
          if (doc.argumentMap !== undefined) throw new ArgumentRunError("exists");
          for (const [node, parentId] of parents) this.attach(doc, node, parentId);
          doc.argumentMap = newArgumentMap(roles, runId, drive.preset, drive.presetQuestionType);
        });
        p.clearUndo(mapPath);
      });
      this.ports.log(
        `argument-run start runId=${runId} phase=situation${drive.presetQuestionType ? ` questionType=${drive.presetQuestionType}` : ""}`
      );
    });
    return this.finish(drive);
  }

  /** Continues a paused run: only unfinished items are redone. Refused for a finished (terminal) or unusable run. */
  async resume(mapPath: string): Promise<void> {
    this.guard(mapPath);
    const map = await this.ports.readMap(mapPath);
    const read = readArgumentMap(map);
    if (read.kind !== "usable") throw new ArgumentRunError("unusable");
    if (["concluded", "stopped_mismatch", "stopped_limit"].includes(read.data.run.phase))
      throw new ArgumentRunError("finished");
    // Decision #66: a facet map made before question types is never run again; refused before anything is written.
    if (isLegacyFacetMap(read.data)) throw new ArgumentRunError("legacy");
    if (read.data.run.status !== "paused") throw new ArgumentRunError("not_paused");
    const drive = this.open(mapPath);
    drive.done = this.go(drive, async () => {
      await this.checkpoint(drive, async state => ({ next: applyResume(state) }));
    });
    return this.finish(drive);
  }

  /** Aborts the run's provider calls; the unfinished items go back to pending and the run is paused (resumable). */
  async stop(mapPath: string): Promise<void> {
    const drive = this.drives.get(mapPath);
    if (!drive) return;
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
    }
  }

  // ---- lifecycle ---------------------------------------------------------------------------------------------------------------
  private guard(mapPath: string): void {
    if (this.disposed) throw new ArgumentRunError("disposed");
    if (this.drives.has(mapPath)) throw new ArgumentRunError("busy");
  }
  private open(mapPath: string): Drive {
    const drive: Drive = {
      mapPath,
      controller: new AbortController(),
      wind: new AbortController(),
      stopRequested: false,
      disposed: false,
      done: Promise.resolve(),
      failures: new Map()
    };
    this.drives.set(mapPath, drive);
    return drive;
  }
  private async finish(drive: Drive): Promise<void> {
    await drive.done;
  }
  private dead(drive: Drive): boolean {
    return drive.disposed || this.disposed || drive.controller.signal.aborted;
  }

  /** Setup, then the loop, then the stop/pause write, then release. Setup refusals reject the returned promise. */
  private go(drive: Drive, setup: () => Promise<void>): Promise<void> {
    const run = async (): Promise<void> => {
      let refusal: ArgumentRunError | undefined;
      try {
        await setup();
        if (!this.dead(drive) && (await this.usageAllowed(drive))) await this.loop(drive);
      } catch (error) {
        if (error instanceof ArgumentRunError) refusal = error;
        else if (!this.dead(drive)) await this.fail(drive, error);
      } finally {
        try {
          await this.settle(drive);
        } finally {
          this.drives.delete(drive.mapPath);
        }
      }
      if (refusal) throw refusal;
    };
    return run();
  }
  private async usageAllowed(drive: Drive): Promise<boolean> {
    // The usage notice can sit open for good: Stop must not wait for an answer nobody gives.
    const answered = await untilAborted(
      drive.controller.signal,
      this.ports.confirmUsage?.(drive.mapPath) ?? Promise.resolve(true)
    ).catch(() => false);
    if (answered) return true;
    drive.stopRequested = true;
    return false;
  }
  /** Last write of a drive: a requested Stop pauses the run ('user'). Never after dispose. */
  private async settle(drive: Drive): Promise<void> {
    if (drive.disposed || this.disposed || !drive.stopRequested) return;
    await this.pause(drive, "user", true);
  }
  private async fail(drive: Drive, error: unknown): Promise<void> {
    this.ports.log(`argument-run error mapPath=- message=${error instanceof Error ? error.name : "unknown"}`);
    await this.pause(drive, "error", false).catch(() => undefined);
  }
  private async pause(drive: Drive, reason: "user" | "interrupted" | "error", force: boolean): Promise<void> {
    await this.checkpoint(
      drive,
      async state => {
        if (
          state.run.status !== "running" ||
          ["concluded", "stopped_mismatch", "stopped_limit"].includes(state.run.phase)
        )
          return null;
        return { next: applyPause(state, reason) };
      },
      force
    );
    this.ports.log(`argument-run paused stopReason=${reason}`);
  }

  // ---- the loop ----------------------------------------------------------------------------------------------------------------
  /**
   * Research runs as a pool: up to MAX_RESEARCH_CONCURRENCY calls are out, and a finished one frees its slot for the next pending item
   * at once. Each dispatch waits for its begin write (researchCalls, `searching`) before the next state read, so the budget and the
   * pending list are never read stale. The independent text steps (a hypothesis's needs, a hypothesis's verdict) run beside the pool and
   * each other, at most one per hypothesis; every other text step (whole-map steps) runs alone, with nothing out. When only the
   * conclusion is left the calls still out are wound down (aborted, their late results dropped) instead of waited for.
   */
  private async loop(drive: Drive): Promise<void> {
    const pool = new Set<Promise<void>>();
    const texts = new Map<string, Promise<void>>();
    let thrown: { error: unknown } | undefined;
    let textFailed = false;
    let idle = 0;
    let last = "";
    // Items whose begin wrote nothing (note busy, stale): skipped until a call out lands, so they never hold the others back.
    const refused = new Set<string>();
    const failedTwice = (): boolean => [...drive.failures.values()].some(n => n >= 2);
    const out = (): Promise<void>[] => [...pool, ...texts.values()];
    // A run whose state stops changing ends (pause 'error'); counted only when nothing is out and no new item is tried.
    const stuck = (state: ArgumentMapData): boolean => {
      const key = JSON.stringify(state);
      idle = key === last ? idle + 1 : 0;
      last = key;
      return idle >= 3;
    };
    try {
      for (;;) {
        if (this.dead(drive) || thrown) break;
        // Two consecutive provider failures on one item, or a text step out of its retry: let the calls out land, then pause.
        if (failedTwice() || textFailed) {
          if (out().length) {
            await Promise.race(out());
            continue;
          }
          await this.pause(drive, "error", false);
          return;
        }
        const state = await this.state(drive);
        if (!state || thrown) break;
        const actions = nextActions(state);
        if (!actions.length && !out().length) break;
        if (out().length && actions.length === 1 && actions[0].type === "conclude") {
          // Enough verified: nothing still out can change the conclusion. Abort it all (not a Stop) and conclude once it has drained.
          this.ports.log("argument-run wind-down");
          drive.wind.abort();
          await Promise.all(out());
          drive.wind = new AbortController();
          refused.clear();
          continue;
        }
        const startable = actions.filter(
          (a): a is Extract<ArgumentAction, { type: "add_needs" | "verdict" }> =>
            (a.type === "add_needs" || a.type === "verdict") && !texts.has(a.hypothesisId)
        );
        if (startable.length) {
          for (const action of startable) {
            // A per-task view: the corrective-retry reason and the wind-down signal belong to this step only.
            const view = Object.create(drive) as Drive;
            view.windSignal = drive.wind.signal;
            view.retryReason = undefined;
            let task: Promise<void>;
            task = this.guarded(
              view,
              () => this.textStep(view, state, action),
              () => {
                textFailed = true;
              }
            )
              .catch((error: unknown) => {
                thrown ??= { error };
              })
              .finally(() => texts.delete(action.hypothesisId));
            texts.set(action.hypothesisId, task);
          }
          continue;
        }
        const research = actions.filter(a => a.type === "research_situation" || a.type === "research_need");
        const next = research.find(a => !refused.has(researchItem(a)));
        if (next && pool.size < MAX_RESEARCH_CONCURRENCY) {
          let begun = (): void => undefined;
          const started = new Promise<boolean>(resolve => (begun = () => resolve(true)));
          let task: Promise<void>;
          task = this.research(drive, state, next, begun)
            .catch((error: unknown) => {
              thrown ??= { error };
            })
            .finally(() => pool.delete(task));
          pool.add(task);
          // The call is out once its begin is written; a research that ended without one wrote nothing.
          if (!(await Promise.race([started, task.then(() => false)]))) refused.add(researchItem(next));
          continue;
        }
        if (out().length) {
          await Promise.race(out());
          refused.clear();
          continue;
        }
        if (stuck(state)) {
          await this.pause(drive, "error", false);
          return;
        }
        if (research.length) {
          refused.clear(); // every pending item was refused and nothing is out: try them again (the idle count ends a run that cannot move)
          continue;
        }
        await this.guarded(drive, () => this.textStep(drive, state, actions[0]));
        if (drive.stopRequested) return;
      }
    } finally {
      await Promise.all(out());
    }
    if (thrown) throw thrown.error;
  }
  private async state(drive: Drive): Promise<ArgumentMapData | null> {
    const read = readArgumentMap(await this.ports.readMap(drive.mapPath));
    return read.kind === "usable" ? read.data : null;
  }

  /** One corrective retry for a text step (parse refusal, gate refusal or provider error); a second failure pauses with 'error'. */
  private async guarded(drive: Drive, work: () => Promise<void>, onFinalFailure?: () => void): Promise<void> {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        await work();
        return;
      } catch (error) {
        if (this.dead(drive) || drive.windSignal?.aborted) return;
        const known = error instanceof ArgumentStepError || error instanceof GateError;
        // Only a refusal the model can correct is passed on, as a short plain line; a provider error says nothing it could fix.
        drive.retryReason = known ? error.message.replace(/\s+/g, " ").trim().slice(0, 200) : undefined;
        this.ports.log(`argument-run step failed attempt=${attempt} kind=${known ? error.name : "other"}`);
        if (attempt === 2) {
          // A concurrent text step leaves the pause to the loop, which first waits for the calls still out.
          if (onFinalFailure) onFinalFailure();
          else await this.pause(drive, "error", false);
          return;
        }
      } finally {
        if (attempt === 2) drive.retryReason = undefined;
      }
    }
  }

  // ---- checkpoint --------------------------------------------------------------------------------------------------------------
  /**
   * One mutate: re-read, fence (run id; the map unchanged since `build` read it), write nodes and state in a single updateMap, then
   * the note texts. `force` is only for the Stop pause, which is allowed after an abort.
   */
  private async checkpoint(
    drive: Drive,
    build: (state: ArgumentMapData, map: MapDocument) => Promise<Plan | null>,
    force = false
  ): Promise<boolean> {
    let wrote = false;
    await this.ports.mutate(async () => {
      const gone = (): boolean => drive.disposed || this.disposed || (!force && drive.controller.signal.aborted);
      if (gone()) return;
      const map = await this.ports.readMap(drive.mapPath);
      const read = readArgumentMap(map);
      if (read.kind !== "usable") return;
      const before = read.data;
      const plan = await build(before, map);
      if (!plan || gone()) return;
      await this.ports.updateMap(drive.mapPath, doc => {
        const now = readArgumentMap(doc);
        if (now.kind !== "usable" || !same(now.data, before)) return; // stale: someone else changed the state
        for (const entry of plan.nodes ?? []) this.attach(doc, entry.node, entry.parentId);
        for (const move of plan.reparent ?? []) {
          const node = doc.nodes.find(n => n.id === move.id);
          if (node) this.place(doc, node, move.parentId);
        }
        doc.argumentMap = plan.next;
        // Every checkpoint that adds or moves cards leaves the map arranged (same write), so opening it never shows a stack.
        const arranged = readArgumentMap(doc);
        if (arranged.kind === "usable") doc.nodes = arrangeArgumentMap(doc.nodes, arranged.data);
        wrote = true;
      });
      if (!wrote) return;
      this.ports.clearUndo(drive.mapPath);
      if (plan.notes && !gone()) await plan.notes();
    });
    return wrote;
  }
  /**
   * The write of a concurrent text step. `build` re-reads the fresh state on every call, so when another write made the fence stale the
   * write is built again onto the fresh state: the model result is kept, no second AI call, and no other step's write is overwritten or lost.
   */
  private async checkpointFresh(
    drive: Drive,
    build: (state: ArgumentMapData, map: MapDocument) => Promise<Plan | null>
  ): Promise<void> {
    for (let attempt = 1; attempt <= 3; attempt++) {
      if (await this.checkpoint(drive, build)) return;
      if (this.dead(drive) || drive.windSignal?.aborted) return;
      this.ports.log(`argument-run rebuilt n=${attempt}`);
    }
    throw new GateError("the map kept changing under the write");
  }
  private place(doc: MapDocument, node: MapNode, parentId: string | null): void {
    const parent = parentId ? doc.nodes.find(n => n.id === parentId) : undefined;
    const siblings = doc.nodes.filter(n => n.parentId === parentId && n.id !== node.id).length;
    node.parentId = parentId;
    node.x = parent ? parent.x + X_STEP : 80;
    node.y = siblings * Y_STEP;
  }
  private attach(doc: MapDocument, node: MapNode, parentId: string | null): void {
    this.place(doc, node, parentId);
    doc.nodes.push(node);
  }

  // ---- text steps --------------------------------------------------------------------------------------------------------------
  private base(drive: Drive): ArgumentStepBase {
    const config = this.ports.config(drive.mapPath);
    return { language: config.language, model: config.model, reasoning: config.reasoning, usageMapPath: drive.mapPath };
  }
  private async notePath(drive: Drive, id: string): Promise<string | null> {
    const node = (await this.ports.readMap(drive.mapPath)).nodes.find(n => n.id === id);
    return node ? node.path : null;
  }
  private async text(drive: Drive, id: string): Promise<{ title: string; summary: string }> {
    const path = await this.notePath(drive, id);
    return path ? this.ports.readNote(path) : { title: "", summary: "" };
  }
  /** What the hypothesis says for every reasoning step: the statement stored at creation. The note is only a view the user may edit; an edit never reaches the model. Maps made before the statement was stored fall back to the note. */
  private async statementOf(drive: Drive, h: Hypothesis): Promise<string> {
    const note = await this.text(drive, h.id);
    if (h.statement === undefined) return note.summary;
    if (note.summary.trim() !== plainLine(h.statement).trim())
      this.ports.log(`argument-run hypothesis note edited id=${h.id}; the stored statement is used`);
    return h.statement;
  }
  private async proposition(drive: Drive, state: ArgumentMapData): Promise<string> {
    return (await this.text(drive, state.roles.proposition)).summary;
  }
  private ask<Request extends ArgumentStepBase, Output>(
    drive: Drive,
    step: StepDefinition<Request, Output>,
    request: Request
  ): Promise<Output> {
    const sent = drive.retryReason ? withRetryReason(step, drive.retryReason) : step;
    const signal = drive.windSignal ? linked(drive.controller.signal, drive.windSignal) : drive.controller.signal;
    return untilAborted(signal, this.ports.runStep(sent, request, signal));
  }

  private async textStep(drive: Drive, state: ArgumentMapData, action: ArgumentAction): Promise<void> {
    const proposition = await this.proposition(drive, state);
    const base = this.base(drive);
    switch (action.type) {
      case "plan_situation":
        // A map with no data yet is always planned by facets (a new map; old maps are already past this step).
        return this.quickEligible(drive, proposition) ? this.planQuick(drive, state, proposition) : this.planFacets(drive, state, proposition);
      case "judge_facets":
        return this.judgeFacets(drive, state, proposition);
      case "situation_budget": {
        await this.checkpoint(drive, async (s, map) => {
          const next = applySituationBudgetOut(s);
          const spent = next.situation.data.filter(
            d => d.reason === "budget" && s.situation.data.some(o => o.id === d.id && o.state === "pending")
          );
          return {
            next,
            notes: async () => {
              for (const d of spent)
                await this.noteDetail(map, d.id, drive, notFoundDetail(this.tr, undefined, "budget"));
            }
          };
        });
        return;
      }
      case "add_retry_needs": {
        // Only an old checkpoint (judged before the retry batch was written with it) lands here: nothing to search, so the run stops.
        await this.checkpoint(drive, async s => this.stopPlan(drive, addRetryNeeds(s, [])));
        return;
      }
      case "gate_missing": {
        await this.checkpoint(drive, async s => this.stopPlan(drive, applyGateMissing(s)));
        return;
      }
      case "judge_gate": {
        const request: GateRequest = { ...base, proposition, data: gateData(state.situation.data) };
        const verdict: GateVerdict = await this.ask(drive, ARGUMENT_STEPS.judge_gate, request);
        await this.checkpoint(drive, async s => {
          const next = applySituationGate(s, verdict);
          return next.run.phase === "stopped_mismatch" ? this.stopPlan(drive, next) : { next };
        });
        return;
      }
      case "propose_hypotheses":
        return this.propose(drive, state, proposition, action.count);
      case "add_needs":
      case "revise":
        return this.needs(drive, state, proposition, action.hypothesisId, action.type === "revise");
      case "verdict":
        return this.verdict(drive, state, action.hypothesisId);
      case "eliminate_limit": {
        await this.checkpoint(drive, async (s, map) => {
          const next = eliminateAtLimit(s, action.hypothesisId);
          const h = next.hypotheses.find(x => x.id === action.hypothesisId)!;
          return {
            next,
            reparent: [
              { id: h.id, parentId: next.roles.unconfirmed ?? next.roles.eliminated ?? next.roles.conclusion }
            ],
            notes: () =>
              this.noteDetail(
                map,
                h.id,
                drive,
                // Cut by the research limit, not refuted: the note says so in plain words, never the stored code.
                isLimitCut(h)
                  ? this.t("ui.argument_unverified_limit")
                  : this.t("ui.argument_eliminated_0", eliminatedWhy(this.tr, h))
              )
          };
        });
        return;
      }
      case "conclude":
        return this.conclude(drive, state, proposition);
      case "conclude_facts":
        return this.concludeFacts(drive, state, proposition);
      case "stop_limit": {
        await this.checkpoint(drive, async s => this.stopPlan(drive, applyLimitStop(s)));
        return;
      }
      default:
        throw new GateError(`no text step for ${action.type}`);
    }
  }

  /** The facet plan: dry-run with placeholder ids, then one card per assumption card, facet and need (card id == state id), all under the situation card. */
  private async planFacets(drive: Drive, state: ArgumentMapData, proposition: string): Promise<void> {
    const request: FacetPlanRequest = {
      ...this.base(drive),
      proposition,
      today: this.ports.now().slice(0, 10),
      ...(state.run.presetAssumptions?.length
        ? { presetAssumptions: state.run.presetAssumptions.map(item => ({ ...item })) }
        : {}),
      ...(state.run.presetQuestionType ? { presetQuestionType: state.run.presetQuestionType } : {})
    };
    const result: FacetPlanResult = await this.ask(drive, ARGUMENT_STEPS.plan_facets, request);
    await this.writePlan(drive, result);
  }

  /** The quick causal run asks one call for the plan and the first hypotheses with their needs, but only for a question that reads as causal. */
  private quickEligible(drive: Drive, proposition: string): boolean {
    if (!(this.ports.quickCausalRun ?? QUICK_CAUSAL_RUN) || drive.quickDeclined || drive.presetQuestionType === "fact")
      return false;
    return !drive.presetQuestionType && isCausal(proposition); // a preset type (the owner re-ran with a chosen one) keeps the ordinary plan: the quick prompt does not carry it
  }

  /**
   * Plan, quick run, hypotheses and their needs in one call and one checkpoint, so the map shows the situation, the three groups, the
   * hypothesis cards and their need cards at once. A call that judged the question a fact one is dropped; the ordinary plan step runs next.
   */
  private async planQuick(drive: Drive, state: ArgumentMapData, proposition: string): Promise<void> {
    const request: FacetPlanRequest = {
      ...this.base(drive),
      proposition,
      today: this.ports.now().slice(0, 10),
      ...(state.run.presetAssumptions?.length
        ? { presetAssumptions: state.run.presetAssumptions.map(item => ({ ...item })) }
        : {}),
      ...(state.run.presetQuestionType ? { presetQuestionType: state.run.presetQuestionType } : {})
    };
    const result: QuickCausalResult = await this.ask(drive, ARGUMENT_STEPS.quick_causal, request);
    if (result.questionType !== "causal") {
      this.ports.log(`argument-run quick call declined runId=${state.run.runId} questionType=${result.questionType}`);
      drive.quickDeclined = true;
      return;
    }
    await this.writePlan(drive, result, result.hypotheses);
  }

  private async writePlan(drive: Drive, result: FacetPlanResult, quick?: QuickCausalResult["hypotheses"]): Promise<void> {
    await this.checkpoint(drive, async (s, map) => {
      const items = result.assumptions.items;
      const definitionNeeds = result.definitionNeeds ?? [];
      const plan = (id: (name: string) => string): Parameters<typeof applySituationPlan>[1] => ({
        ...(items.length || definitionNeeds.length ? { assumptions: { id: id("as"), items }, definitionNeeds } : {}),
        facets: result.facets.map((f, i) => ({
          id: id(`f${i}`),
          title: f.title,
          criterion: f.criterion,
          baseline: f.baseline,
          needs: f.needs.map((n, j) => ({ id: id(`f${i}-${j}`), need: n.need }))
        })),
        causalQuestions: result.causalQuestions,
        questionType: result.questionType,
        ...(result.questionType === "causal"
          ? { groups: { verified: id("g-ok"), eliminated: id("g-out"), unconfirmed: id("g-open") } }
          : {})
      });
      const hypothesesFor = (id: (name: string) => string): Parameters<typeof applyQuickCausal>[2] =>
        (quick ?? []).map((h, i) => ({
          id: id(`h${i}`),
          statement: h.statement,
          alternative: h.alternative,
          needs: h.needs.map((n, j) => ({ id: id(`h${i}-${j}`), text: n.text, ...(n.core ? { core: true } : {}) }))
        }));
      // Dry run first: a refused plan must not leave notes behind.
      if (quick) applyQuickCausal(s, plan(name => `dry-${name}`), hypothesesFor(name => `dry-${name}`));
      else
        applySituationPlan(
          s,
          plan(name => `dry-${name}`)
        );
      const nodes: Plan["nodes"] = [];
      const make = async (kind: NoteKind, title: string, summary: string | undefined, detail?: string) => {
        const node = await this.makeNote({ kind, title: shorten(title, 80), summary, detail }, map, drive.mapPath);
        nodes.push({ node, parentId: s.roles.situation });
        return node;
      };
      const ids = new Map<string, string>();
      if (items.length || definitionNeeds.length) {
        const detail = definitionsDetail(this.tr, items, undefined, definitionNeeds, result.questionType);
        ids.set("as", (await make("group", this.ports.t("ui.argument_definitions"), undefined, detail)).id);
      }
      for (const [i, f] of result.facets.entries()) {
        ids.set(`f${i}`, (await make("group", f.title, f.title)).id);
      }
      if (result.questionType === "causal") {
        // Same mutation as the question type (decision #66): the three groups sit under the conclusion card.
        for (const [key, title] of [
          ["g-ok", "ui.argument_group_verified"],
          ["g-out", "ui.argument_group_eliminated"],
          ["g-open", "ui.argument_group_unconfirmed"]
        ] as const) {
          const node = await this.makeNote({ kind: "group", title: this.ports.t(title) }, map, drive.mapPath);
          nodes.push({ node, parentId: s.roles.conclusion });
          ids.set(key, node.id);
        }
      }
      for (const [i, f] of result.facets.entries())
        for (const [j, n] of f.needs.entries()) {
          const node = await this.makeNote(
            { kind: "datum", title: shorten(n.need, 80), summary: n.need },
            map,
            drive.mapPath
          );
          nodes.push({ node, parentId: ids.get(`f${i}`)! });
          ids.set(`f${i}-${j}`, node.id);
        }
      for (const [i, h] of (quick ?? []).entries()) {
        const node = await this.makeNote(
          { kind: "hypothesis", title: h.title, summary: h.statement },
          map,
          drive.mapPath
        );
        nodes.push({ node, parentId: ids.get("g-ok")! });
        ids.set(`h${i}`, node.id);
        for (const [j, n] of h.needs.entries()) {
          const need = await this.makeNote(
            { kind: "need", title: shorten(n.text, 80), summary: n.text },
            map,
            drive.mapPath
          );
          nodes.push({ node: need, parentId: node.id });
          ids.set(`h${i}-${j}`, need.id);
        }
      }
      if (quick) {
        const done = applyQuickCausal(s, plan(name => ids.get(name)!), hypothesesFor(name => ids.get(name)!));
        done.situation.question = result.question;
        this.ports.log(`argument-run planned runId=${s.run.runId} questionType=${result.questionType}`);
        this.ports.log(`argument-run quick run runId=${s.run.runId} hypotheses=${quick.length}`);
        return { next: done, nodes };
      }
      const next = applySituationPlan(
        s,
        plan(name => ids.get(name)!)
      );
      next.situation.question = result.question;
      this.ports.log(`argument-run planned runId=${s.run.runId} questionType=${result.questionType}`);
      // Quick run (causal only): no situation research and no revise rounds; the analysis begins in this same write.
      if (result.questionType === "causal" && (this.ports.quickCausalRun ?? QUICK_CAUSAL_RUN)) {
        this.ports.log(`argument-run quick run runId=${s.run.runId}`);
        return { next: applyQuickRun(next), nodes };
      }
      return { next, nodes };
    });
  }

  /**
   * The facet judgement and, in the same checkpoint, the one retry batch: a refused batch (the machine's caps) writes nothing, and a
   * run paused between the call and the write has neither the verdicts nor half of the retry needs; it asks again on resume.
   */
  private async judgeFacets(drive: Drive, state: ArgumentMapData, proposition: string): Promise<void> {
    const { situation } = state;
    const round = situation.gate.round === 2 ? 2 : 1;
    const request: FacetJudgeRequest = {
      ...this.base(drive),
      proposition,
      round,
      facets: (situation.facets ?? [])
        .filter(f => f.verdict === "pending")
        .map(f => {
          const own = situation.data.filter(d => d.facetId === f.id);
          const notFound = own.filter(d => d.state === "not_found").map(d => d.need);
          return {
            id: f.id,
            title: f.title,
            criterion: f.criterion ?? f.title,
            ...(f.baseline ? { baseline: f.baseline } : {}),
            data: own
              .filter(d => d.state === "found" && d.proof)
              .map(d => ({
                id: d.id,
                need: d.need,
                claim: d.proof!.claim,
                quote: d.proof!.quote,
                url: d.proof!.url,
                stance: d.stance ?? "uncertain",
                ...(isUncertainSource(d.proof) ? { uncertainSource: true as const } : {}),
                ...(d.propStance
                  ? isStanceLocked(d)
                    ? { fixedStance: d.propStance }
                    : { priorStance: d.propStance }
                  : {})
              })),
            ...(notFound.length ? { notFoundNeeds: notFound } : {})
          };
        }),
      ...(situation.assumptions?.items.length
        ? { assumptions: situation.assumptions.items.map(i => ({ label: i.label, value: i.value, reason: i.reason })) }
        : {})
    };
    const result: FacetJudgeResult = await this.ask(drive, ARGUMENT_STEPS.judge_facets, request);
    await this.checkpoint(drive, async (s, map) => {
      let next = applyFacetVerdicts(s, {
        data: result.data,
        facets: result.facets.map(f => ({
          id: f.id,
          verdict: f.verdict,
          reason: f.reason,
          citedData: f.citedData,
          summary: f.summary
        }))
      });
      // The last judgement wins: the insights about the assumption card are replaced (and dropped when the judge had none).
      if (next.situation.assumptions) {
        const insights = result.assumptionInsights.map(t => capText(t, INSIGHT_MAX_TEXT)).filter(Boolean);
        if (insights.length) next.situation.assumptions.insights = insights;
        else delete next.situation.assumptions.insights;
      }
      const nodes: Plan["nodes"] = [];
      if (next.run.phase === "situation") {
        // Facets still insufficient after round 1: their retry needs (none at all means data_insufficient).
        const wanted = result.facets
          .filter(f => next.situation.facets!.some(x => x.id === f.id && x.verdict === "insufficient"))
          .flatMap(f => f.retryNeeds.map(need => ({ facetId: f.id, need })));
        addRetryNeeds(
          next,
          wanted.map((w, i) => ({ ...w, id: `dry-${i}` }))
        );
        const items: { facetId: string; id: string; need: string }[] = [];
        for (const w of wanted) {
          const node = await this.makeNote(
            { kind: "datum", title: shorten(w.need, 80), summary: w.need },
            map,
            drive.mapPath
          );
          nodes.push({ node, parentId: w.facetId });
          items.push({ ...w, id: node.id });
        }
        next = addRetryNeeds(next, items);
      }
      const stopped = next.run.phase === "stopped_mismatch";
      const plan: Plan = stopped ? await this.stopPlan(drive, next) : { next, nodes };
      const judged = result.facets;
      const inner = plan.notes;
      plan.notes = async () => {
        const final = plan.next;
        for (const f of judged) {
          const facet = final.situation.facets?.find(x => x.id === f.id);
          if (!facet) continue;
          const own = final.situation.data.filter(d => d.facetId === f.id);
          await this.noteById(map, f.id, drive, { summary: f.summary, detail: facetDetail(this.tr, facet, own) });
          for (const d of own.filter(x => x.state === "found" && x.proof))
            await this.noteById(map, d.id, drive, { detail: datumDetail(this.tr, d) });
        }
        await this.noteById(map, final.roles.situation, drive, { detail: situationDetail(this.tr, final) });
        const as = final.situation.assumptions;
        if (as?.items.length || as?.definitionNeeds?.length)
          await this.noteById(map, as.id, drive, {
            detail: definitionsDetail(this.tr, as.items, as.insights, as.definitionNeeds, final.situation.questionType)
          });
        if (inner) await inner();
      };
      return plan;
    });
  }
  private async noteById(
    map: MapDocument,
    id: string,
    drive: Drive,
    patch: { summary?: string; detail?: string }
  ): Promise<void> {
    const path = map.nodes.find(n => n.id === id)?.path ?? (await this.notePath(drive, id));
    if (path) await this.writeNote(path, patch);
  }

  private async propose(drive: Drive, state: ArgumentMapData, proposition: string, count: number): Promise<void> {
    const existing: string[] = [];
    for (const h of state.hypotheses) existing.push((await this.text(drive, h.id)).title);
    const found = state.situation.data.filter(d => d.state === "found");
    let result: HypothesesResult | FacetHypothesesResult;
    if (hasFacets(state)) {
      // A facet map: the data with a stance toward the proposition and the causal questions. Decision #61: only the data of the facets that
      // support the premise are sent (an unconfirmed premise has none, so it sends what was found); the hypotheses come back with no basis.
      const stanced = premiseData(state);
      const request: FacetHypothesesRequest = {
        ...this.base(drive),
        proposition,
        data: dataOrNone(state, stanced).map((d, i) => ({ ...d, propStance: stanced[i].propStance! })),
        count,
        existing,
        causalQuestions: state.situation.causalQuestions ?? [],
        ...(isSituationUnconfirmed(state) ? { unconfirmed: true } : {})
      };
      result = await this.ask(drive, ARGUMENT_STEPS.propose_facet_hypotheses, request);
    } else {
      const request: HypothesesRequest = {
        ...this.base(drive),
        proposition,
        data: gateData(found),
        count,
        existing
      };
      result = await this.ask(drive, ARGUMENT_STEPS.propose_hypotheses, request);
    }
    const proposed: { title: string; statement: string; citedData?: string[]; alternative?: boolean }[] =
      result.hypotheses;
    await this.checkpoint(drive, async (s, map) => {
      // Dry run with placeholder ids first: a refused batch (the gate) must not leave notes behind.
      applyHypotheses(
        s,
        proposed.map((h, i) => ({ id: `dry-${i}`, citedData: h.citedData, alternative: h.alternative }))
      );
      const nodes: Plan["nodes"] = [];
      const items: {
        id: string;
        citedData?: string[];
        alternative?: boolean;
        statement?: string;
      }[] = [];
      for (const h of proposed) {
        const node = await this.makeNote(
          { kind: "hypothesis", title: h.title, summary: h.statement },
          map,
          drive.mapPath
        );
        nodes.push({ node, parentId: s.roles.verified ?? s.roles.conclusion });
        items.push({
          id: node.id,
          citedData: h.citedData,
          alternative: h.alternative,
          statement: h.statement
        });
      }
      return { next: applyHypotheses(s, items), nodes };
    });
  }

  private async needs(
    drive: Drive,
    state: ArgumentMapData,
    proposition: string,
    hypothesisId: string,
    revise: boolean
  ): Promise<void> {
    const h = state.hypotheses.find(x => x.id === hypothesisId)!;
    const text = await this.text(drive, h.id);
    const round = revise ? h.round + 1 : h.round;
    const request: NeedsRequest = {
      ...this.base(drive),
      proposition,
      hypothesis: { title: text.title, statement: await this.statementOf(drive, h), round },
      data: dataOrNone(
        state,
        hasFacets(state) ? premiseData(state) : state.situation.data.filter(d => h.citedData.includes(d.id))
      ),
      existing: h.needs.map(n => ({
        text: n.text,
        state: n.state,
        // A facet map shows the earlier needs' claim, period and why nothing was found, so a new need does not repeat the old search.
        ...(hasFacets(state)
          ? {
              ...(n.proof?.claim ? { claim: n.proof.claim } : {}),
              ...(n.proof?.figure?.period ? { period: n.proof.figure.period } : {}),
              ...(n.state === "not_found" && (n.searchLog?.why ?? n.reason)
                ? { reason: n.searchLog?.why ?? n.reason }
                : {})
            }
          : {})
      })),
      // Decision #62: the first round names one core need; a later round may name one only when the core was not found.
      ...(hasFacets(state) && (!revise || liveCore(h)?.state === "not_found")
        ? { core: revise ? ("replace" as const) : ("first" as const) }
        : {}),
      max: needsAllowed({ ...h, round })
    };
    const result: NeedsResult = await this.ask(drive, ARGUMENT_STEPS[revise ? "revise" : "add_needs"], request);
    await this.checkpointFresh(drive, async (s, map) => {
      const dry = result.needs.map((n, i) => ({ id: `dry-${i}`, text: n.text, ...(n.core ? { core: true } : {}) }));
      if (revise) startNextRound(s, hypothesisId, dry);
      else addNeeds(s, hypothesisId, dry);
      const nodes: Plan["nodes"] = [];
      const items: { id: string; text: string; core?: boolean }[] = [];
      for (const n of result.needs) {
        const node = await this.makeNote(
          { kind: "need", title: shorten(n.text, 80), summary: n.text },
          map,
          drive.mapPath
        );
        nodes.push({ node, parentId: hypothesisId });
        items.push({ id: node.id, text: n.text, ...(n.core ? { core: true } : {}) });
      }
      return { next: revise ? startNextRound(s, hypothesisId, items) : addNeeds(s, hypothesisId, items), nodes };
    });
  }

  private async verdict(drive: Drive, state: ArgumentMapData, hypothesisId: string): Promise<void> {
    const request: VerdictRequest = {
      ...this.base(drive),
      hypothesis: await this.statementOf(
        drive,
        state.hypotheses.find(h => h.id === hypothesisId)!
      ),
      input: prepareVerdict(state, hypothesisId)
    };
    // A facet map's verdict also returns insights, kept on the hypothesis so its note can be rewritten; an old map keeps the V1 step.
    const facet: FacetVerdictResult | undefined = hasFacets(state)
      ? await this.ask(drive, facetVerdictStep, request)
      : undefined;
    let result: VerdictResult = facet ?? (await this.ask(drive, ARGUMENT_STEPS.verdict, request));
    await this.checkpointFresh(drive, async (s, map) => {
      const next = applyVerdict(s, hypothesisId, result);
      // The program kept a "supported" verdict as undecided because the stances do not clearly back it: the model's reason would argue
      // the opposite of the card, so the note says what the program decided.
      const held =
        result.verdict === "supported" && next.hypotheses.find(h => h.id === hypothesisId)!.aiVerdict !== "supported";
      if (held) result = { ...result, reason: this.t("ui.argument_verdict_held") };
      if (facet)
        next.hypotheses.find(h => h.id === hypothesisId)!.insights = facet.insights.map(i => ({
          kind: i.kind,
          text: capText(i.text, INSIGHT_MAX_TEXT)
        }));
      const refuted = next.hypotheses.find(h => h.id === hypothesisId)!.location === "eliminated";
      return {
        next,
        // Decision #62: a refuted hypothesis was eliminated in this same write, so its card moves to the eliminated group with it.
        ...(refuted
          ? { reparent: [{ id: hypothesisId, parentId: next.roles.eliminated ?? next.roles.conclusion }] }
          : {}),
        notes: () =>
          this.noteDetail(
            map,
            hypothesisId,
            drive,
            facet
              ? hypothesisDetail(
                  this.tr,
                  next.hypotheses.find(h => h.id === hypothesisId)!,
                  result.reason
                )
              : `${this.t("ui.argument_reason")}: ${plainLine(result.reason)}`
          )
      };
    });
  }

  private async conclude(drive: Drive, state: ArgumentMapData, proposition: string): Promise<void> {
    const input = prepareConclusion(state);
    const statements: Record<string, string> = {};
    for (const h of input.hypotheses)
      statements[h.id] = await this.statementOf(
        drive,
        state.hypotheses.find(x => x.id === h.id)!
      );
    const unconfirmed = isSituationUnconfirmed(state);
    // Fewer verified hypotheses than the target (decision #59): the conclusion is written on those and the program says so.
    const verifiedCount = input.hypotheses.filter(h => h.status === "verified").length;
    const partial = verifiedCount < MIN_VERIFIED;
    const request: ConclusionRequest = {
      ...this.base(drive),
      proposition,
      input,
      statements,
      ...(unconfirmed ? { unconfirmed } : {}),
      ...(partial ? { partial } : {})
    };
    const result: ConclusionResult = await this.ask(drive, ARGUMENT_STEPS.conclude, request);
    await this.checkpoint(drive, async (s, map) => {
      const next = applyConclusion(s, result);
      const pointLines = result.points.map(p => `- ${plainLine(p.text)}`);
      const detail = hasFacets(next)
        ? conclusionDetail(
            this.tr,
            next,
            await this.hypothesisTitles(drive, next),
            {
              summary: result.summary,
              points: result.points.map(p => p.text)
            },
            "",
            unconfirmed ? this.t("ui.argument_premise_unconfirmed") : undefined,
            partial ? this.t("ui.argument_partial_conclusion_0_1", verifiedCount, MIN_VERIFIED) : undefined
          )
        : [
            ...pointLines,
            "",
            ...this.dataSection(next, next.conclusion.basedOn),
            "",
            ...this.sourceSection(next, next.conclusion.basedOn)
          ].join("\n");
      const path = map.nodes.find(n => n.id === next.roles.conclusion)?.path;
      this.ports.log(`argument-run concluded runId=${s.run.runId} phase=concluded`);
      return {
        next,
        notes: async () => {
          if (path) await this.writeNote(path, { summary: result.summary, detail });
        }
      };
    });
  }

  /** A fact question (decision #60): the program composes the outcome from the facets; the model writes the summary and points over facets only. */
  private async concludeFacts(drive: Drive, state: ArgumentMapData, proposition: string): Promise<void> {
    const facets = state.situation.facets ?? [];
    const { outcome } = composeFacets(facets);
    const request: ConclusionFactRequest = {
      ...this.base(drive),
      proposition,
      outcome,
      facets: facets.map(f => ({
        id: f.id,
        title: f.title,
        verdict: f.verdict,
        summary: f.summary,
        reason: f.reason,
        data: state.situation.data
          .filter(d => d.facetId === f.id && d.state === "found" && d.proof && d.propStance !== "irrelevant")
          .map(d => ({
            claim: d.proof!.claim,
            quote: d.proof!.quote,
            url: d.proof!.url,
            stance: d.propStance ?? "uncertain"
          }))
      })),
      ...(isSituationUnconfirmed(state) ? { unconfirmed: true } : {})
    };
    const result: ConclusionFactResult = await this.ask(drive, ARGUMENT_STEPS.conclude_facts, request);
    await this.checkpoint(drive, async (s, map) => {
      const next = applyFactConclusion(s, result);
      const detail = conclusionDetail(
        this.tr,
        next,
        new Map(),
        { summary: result.summary, points: result.points.map(p => p.text) },
        "",
        isSituationUnconfirmed(next) ? this.t("ui.argument_premise_unconfirmed") : undefined
      );
      const path = map.nodes.find(n => n.id === next.roles.conclusion)?.path;
      this.ports.log(
        `argument-run concluded runId=${s.run.runId} phase=concluded questionType=fact outcome=${outcome}`
      );
      return {
        next,
        notes: async () => {
          if (path) await this.writeNote(path, { summary: result.summary, detail });
        }
      };
    });
  }

  // ---- program-written text ----------------------------------------------------------------------------------------------------
  private dataSection(state: ArgumentMapData, hypothesisIds: string[]): string[] {
    const cited = new Set(state.hypotheses.filter(h => hypothesisIds.includes(h.id)).flatMap(h => h.citedData));
    const lines = state.situation.data
      .filter(d => cited.has(d.id) && d.proof)
      .map(d => this.t("ui.argument_source_0_1_2", d.proof!.claim, d.proof!.quote, d.proof!.url));
    return [`## ${this.t("ui.argument_situation_data")}`, ...lines];
  }
  private sourceSection(state: ArgumentMapData, hypothesisIds: string[]): string[] {
    const lines = state.hypotheses
      .filter(h => hypothesisIds.includes(h.id))
      .flatMap(h => foundNeeds(h))
      .map(n => this.t("ui.argument_source_0_1_2", n.proof!.claim, n.proof!.quote, n.proof!.url));
    return [`## ${this.t("ui.argument_sources")}`, ...lines];
  }
  /** The terminal conclusion card of a stopped run: a fixed sentence, never a model answer. */
  private async stopPlan(drive: Drive, next: ArgumentMapData): Promise<Plan> {
    const t = (key: TranslationKey, ...values: unknown[]): string => this.t(key, ...values);
    const { gate } = next.situation;
    let summary: string;
    const titles = await this.hypothesisTitles(drive, next);
    if (next.run.phase === "stopped_limit")
      summary = next.hypotheses.length
        ? t("ui.argument_stopped_limit_0", this.limitLists(next, titles))
        : t(
            "ui.argument_stopped_limit_data_0",
            next.situation.data
              .filter(d => d.state !== "found")
              .map(d => plainLine(d.need))
              .join(t("ui.argument_list_sep"))
          );
    else
      summary =
        gate.kind === "data_insufficient"
          ? t("ui.argument_stopped_insufficient")
          : gate.kind === "data_missing"
            ? t("ui.argument_stopped_missing")
            : t("ui.argument_stopped_mismatch");
    const detail = hasFacets(next)
      ? conclusionDetail(
          this.tr,
          next,
          titles,
          undefined,
          summary,
          next.run.phase === "stopped_limit" && isSituationUnconfirmed(next)
            ? this.t("ui.argument_premise_unconfirmed")
            : undefined
        )
      : next.run.phase === "stopped_mismatch"
        ? [`${t("ui.argument_reason")}: ${plainLine(gate.reason ?? "")}`, "", ...this.dataSection(next, [])].join("\n")
        : "";
    const path = (await this.ports.readMap(drive.mapPath)).nodes.find(n => n.id === next.roles.conclusion)?.path;
    this.ports.log(
      `argument-run stopped runId=${next.run.runId} phase=${next.run.phase} stopReason=${next.run.stopReason ?? "-"} gateKind=${gate.kind ?? "-"}`
    );
    return {
      next,
      notes: async () => {
        if (path) await this.writeNote(path, { summary, detail });
      }
    };
  }
  /** A hypothesis title; one with no readable title is named by its place in the list, never by its id. */
  private async hypothesisTitles(drive: Drive, state: ArgumentMapData): Promise<Map<string, string>> {
    const titles = new Map<string, string>();
    for (const [i, h] of state.hypotheses.entries())
      titles.set(h.id, (await this.text(drive, h.id)).title.trim() || this.t("ui.argument_hypothesis_0", i + 1));
    return titles;
  }
  /** The stopped summary in plain words: what was verified, what ran out of research (never refuted) and what the evidence refuted. */
  private limitLists(state: ArgumentMapData, titles: ReadonlyMap<string, string>): string {
    const sep = this.t("ui.argument_list_sep");
    const name = (h: Hypothesis): string => titles.get(h.id) ?? "";
    const refutedHyps = state.hypotheses.filter(h => h.location === "eliminated" && !isLimitCut(h));
    const verified = state.hypotheses.filter(isVerified).map(name);
    const unverified = state.hypotheses.filter(h => !isVerified(h) && !refutedHyps.includes(h)).map(name);
    const refuted = refutedHyps.map(name);
    return [
      this.t("ui.argument_stopped_verified_0", verified.length ? verified.join(sep) : this.t("ui.argument_none")),
      ...(unverified.length
        ? [
            this.t(
              "ui.argument_stopped_unverified_0",
              unverified.map(n => `${n}${this.t("ui.argument_limit_suffix")}`).join(sep)
            )
          ]
        : []),
      ...(refuted.length ? [this.t("ui.argument_stopped_refuted_0", refuted.join(sep))] : [])
    ].join(this.t("ui.argument_clause_sep"));
  }
  private async noteDetail(map: MapDocument, id: string, drive: Drive, line: string): Promise<void> {
    const path = map.nodes.find(n => n.id === id)?.path ?? (await this.notePath(drive, id));
    if (path) await this.writeNote(path, { detail: line });
  }

  // ---- research ----------------------------------------------------------------------------------------------------------------
  private async slot(): Promise<void> {
    if (this.inFlight < MAX_RESEARCH_CONCURRENCY) {
      this.inFlight++;
      return;
    }
    await new Promise<void>(resolve => this.waiting.push(resolve));
  }
  private free(): void {
    const next = this.waiting.shift();
    if (next) next();
    else this.inFlight--;
  }

  /**
   * begin (writes researchCalls; then `begun`) -> dispatch -> verify -> commit. Never throws. A reply that cannot be used becomes a miss; a provider
   * failure (askModel rejected) is released back to pending instead, never a miss.
   */
  private async research(
    drive: Drive,
    state: ArgumentMapData,
    action: ArgumentAction,
    begun: () => void
  ): Promise<void> {
    const isNeed = action.type === "research_need";
    if (action.type !== "research_need" && action.type !== "research_situation") return;
    const itemId = action.type === "research_need" ? action.needId : action.dataId;
    const hypothesisId = action.type === "research_need" ? action.hypothesisId : "";
    const map = await this.ports.readMap(drive.mapPath);
    const node = map.nodes.find(n => n.id === itemId);
    // Decision #65 (facet maps only; an older map keeps its V1 research request): the hypothesis a need tests.
    const hypothesis = isNeed && hasFacets(state) ? state.hypotheses.find(h => h.id === hypothesisId) : undefined;
    const needText = isNeed
      ? (state.hypotheses.find(h => h.id === hypothesisId)?.needs.find(n => n.id === itemId)?.text ?? "")
      : (state.situation.data.find(d => d.id === itemId)?.need ?? "");
    await this.slot();
    // The wind-down this call was started under (a later episode gets a new controller).
    const windSignal = drive.wind.signal;
    let busy: BusyHandle | null = null;
    try {
      if (this.dead(drive)) return;
      if (node) {
        busy = this.ports.begin(node.path);
        if (!busy) return;
      }
      const began = await this.checkpoint(drive, async s => ({
        next: isNeed ? beginResearch(s, hypothesisId, itemId) : beginSituationResearch(s, itemId)
      }));
      if (!began || this.dead(drive)) return;
      begun();
      const runSignal = busy ? linked(drive.controller.signal, busy.signal) : drive.controller.signal;
      // Stop, the card's busy signal and the wind-down. The deadline joins it for the model call only (not for verifySource).
      const signal = linked(runSignal, windSignal);
      const proposition = await this.proposition(drive, state);
      // A hypothesis need carries the claim it tests (the stance is relative to it) and the assumed period.
      const context = hypothesis
        ? [assumptionScope(state), `hypothesis claim: ${plainLine(await this.statementOf(drive, hypothesis))}`]
            .filter(Boolean)
            .join("; ")
        : scopeOf(false, state).context;
      let result: EvidenceResult;
      let openedUrls: string[] = [];
      let domain = "-";
      let tierLog = "-";
      let secondLog = "-";
      let code = "";
      let reply: AiResult | undefined;
      let note = "";
      let timedOut = false;
      const deadline = new AbortController();
      const startTimer = (handler: () => void, ms: number): (() => void) => {
        if (this.ports.setTimer) return this.ports.setTimer(handler, ms);
        const handle = window.setTimeout(handler, ms);
        return () => window.clearTimeout(handle);
      };
      const cancelTimer = startTimer(() => deadline.abort(), this.ports.researchDeadlineMs ?? RESEARCH_DEADLINE_MS);
      const callSignal = linked(signal, deadline.signal);
      try {
        reply = await untilAborted(
          callSignal,
          this.ports.askModel(
            {
              title: shorten(needText, 120),
              summary: "",
              rules: "",
              detail: "",
              task: needText,
              ancestors: proposition,
              mode: "task",
              researchMode: "research",
              responseContract: "argument-evidence",
              argumentEvidenceNeeds: [{ id: itemId, text: needText, ...(context ? { context } : {}) }],
              usageMapPath: drive.mapPath,
              outputLanguage: this.ports.config(drive.mapPath).language
            },
            this.ports.config(drive.mapPath).model,
            this.ports.config(drive.mapPath).reasoning,
            callSignal
          )
        );
      } catch (error) {
        if (this.dead(drive)) return;
        if (busy?.signal.aborted) {
          void this.stop(drive.mapPath);
          return;
        }
        if (windSignal.aborted) {
          await this.releaseWound(drive, state, isNeed, hypothesisId, itemId);
          return;
        }
        // The deadline passed with no answer: a miss (the model was too slow), not a provider failure and never a pause.
        if (!deadline.signal.aborted) {
          await this.releaseFailed(drive, state, isNeed, hypothesisId, itemId, error);
          return;
        }
        timedOut = true;
      } finally {
        cancelTimer();
      }
      try {
        openedUrls = reply?.evidence?.openedUrls ?? [];
        const entry = reply?.argumentEvidence?.find(e => e.need === itemId);
        note = entry?.note ?? "";
        const facetMap = !isNeed && hasFacets(state);
        if (timedOut) result = { found: false, reason: "not_found_in_time" };
        else if (!entry) result = { found: false, reason: "no_answer" };
        else if (entry.status !== "found") result = { found: false, reason: "not_found" };
        else {
          domain = domainOf(entry.url);
          const stance = !isNeed && entry.stance === "contradicts" ? "opposes" : entry.stance;
          // An old map cannot hold an uncertain datum; a facet map keeps it when the source verifies (the machine sets its stance).
          if (!isNeed && !facetMap && entry.stance === "uncertain")
            result = { found: false, reason: "stance_uncertain" };
          else {
            const check = await verifySource({
              url: entry.url,
              quote: entry.quote,
              claim: entry.claim,
              ...(entry.figure ? { figure: entry.figure } : {}),
              openedUrls,
              fetch: this.ports.fetch,
              parseHtml: this.ports.parseHtml,
              now: this.ports.now
            });
            code = check.ok ? check.proof.check : check.reason;
            if (!check.ok) result = { found: false, reason: `source_${check.reason}` };
            else if (!hasFacets(state)) result = { found: true, stance, proof: check.proof };
            else {
              // Decision #64: a missing tier counts as `other`; an `other` source needs a second, independent one that agrees and passes the same check.
              const tier: SourceTier = entry.tier ?? "other";
              const second = tier === "other" ? await this.secondSource(signal, entry, openedUrls) : undefined;
              tierLog = tier;
              if (tier === "other") secondLog = second?.log ?? "missing";
              const proof = { ...check.proof, tier, ...(second?.proof ? { second: second.proof } : {}) };
              // A hypothesis need whose source stays uncertain is itself uncertain: it can neither back nor refute the hypothesis.
              result = { found: true, stance: isNeed && isUncertainSource(proof) ? "uncertain" : stance, proof };
            }
          }
        }
      } catch (error) {
        if (this.dead(drive)) return;
        if (busy?.signal.aborted) {
          void this.stop(drive.mapPath);
          return;
        }
        result = { found: false, reason: "provider_error" };
        code = error instanceof Error ? error.name : "error";
      }
      if (this.dead(drive)) return;
      if (windSignal.aborted) {
        // The run is concluding: a result that lands now is dropped; the item goes back to pending like an aborted call.
        this.ports.log(`argument-run stale dropped runId=${state.run.runId}`);
        await this.releaseWound(drive, state, isNeed, hypothesisId, itemId);
        return;
      }
      this.ports.log(
        `argument-run proof runId=${state.run.runId} phase=${state.run.phase} result=${result.found ? "found" : result.reason} proof=${code || "-"} domain=${domain} tier=${tierLog} second=${secondLog}`
      );
      try {
        const searchLog: SearchLog | undefined = result.found
          ? undefined
          : {
              queries: (reply?.evidence?.searchQueries ?? [])
                .slice(0, SEARCH_LOG_MAX_ITEMS)
                .map(q => capText(q, SEARCH_LOG_MAX_TEXT)),
              opened: openedUrls.slice(0, SEARCH_LOG_MAX_ITEMS).map(u => capText(u, SEARCH_LOG_MAX_TEXT)),
              why: capText([result.reason, note].filter(Boolean).join(": "), SEARCH_LOG_MAX_TEXT)
            };
        await this.commitEvidence(drive, isNeed, hypothesisId, itemId, result, searchLog);
        drive.failures.delete(itemId);
      } catch (error) {
        // The item is no longer `searching` (someone paused or changed the run meanwhile): the late result is dropped.
        if (!(error instanceof GateError)) throw error;
        this.ports.log(`argument-run stale dropped runId=${state.run.runId}`);
      }
    } finally {
      busy?.release();
      this.free();
    }
  }

  /**
   * The second source of an `other`-tier answer (decision #64): it must agree, sit on another hostname than the first and pass the same
   * `verifySource` check. Anything else is no second source. Rejects when Stop aborts `signal`, so nothing is written for a stopped run.
   */
  private async secondSource(
    signal: AbortSignal,
    entry: { url: string; second?: { url: string; quote: string; claim: string; agrees: boolean } },
    openedUrls: readonly string[]
  ): Promise<{ proof?: SecondSource; log: string }> {
    const second = entry.second;
    if (!second) return { log: "missing" };
    const host = (url: string): string =>
      domainOf(url)
        .replace(/^www\./, "")
        .toLowerCase();
    if (!second.agrees || host(second.url) === host(entry.url)) return { log: "mismatch" };
    const check = await untilAborted(
      signal,
      verifySource({
        url: second.url,
        quote: second.quote,
        claim: second.claim,
        openedUrls,
        fetch: this.ports.fetch,
        parseHtml: this.ports.parseHtml,
        now: this.ports.now
      })
    );
    if (!check.ok) return { log: "failed" };
    return {
      proof: {
        url: check.proof.url,
        quote: check.proof.quote,
        check: check.proof.check,
        checkedAt: check.proof.checkedAt
      },
      log: "found"
    };
  }

  /** A call aborted by the wind-down (the run is concluding): the item goes back to pending, nothing else is written and no failure is counted. */
  private async releaseWound(
    drive: Drive,
    state: ArgumentMapData,
    isNeed: boolean,
    hypothesisId: string,
    itemId: string
  ): Promise<void> {
    try {
      await this.checkpoint(drive, async s => ({
        next: isNeed ? releaseNeedResearch(s, hypothesisId, itemId) : releaseSituationResearch(s, itemId)
      }));
    } catch (failure) {
      if (!(failure instanceof GateError)) throw failure;
      this.ports.log(`argument-run stale dropped runId=${state.run.runId}`);
    }
  }

  /** A provider failure is not a try: the item goes back to pending (no note, no card text) and the failure is counted for this drive. */
  private async releaseFailed(
    drive: Drive,
    state: ArgumentMapData,
    isNeed: boolean,
    hypothesisId: string,
    itemId: string,
    error: unknown
  ): Promise<void> {
    this.ports.log(
      `argument-run proof runId=${state.run.runId} phase=${state.run.phase} result=provider_failure proof=${error instanceof Error ? error.name : "error"} domain=-`
    );
    try {
      await this.checkpoint(drive, async s => ({
        next: isNeed ? releaseNeedResearch(s, hypothesisId, itemId) : releaseSituationResearch(s, itemId)
      }));
    } catch (failure) {
      if (!(failure instanceof GateError)) throw failure;
      this.ports.log(`argument-run stale dropped runId=${state.run.runId}`);
    }
    drive.failures.set(itemId, (drive.failures.get(itemId) ?? 0) + 1);
  }

  /** The stale fence: the run id (checkpoint) and the item still `searching` (the reducers throw otherwise); a deleted node gets no note. */
  private async commitEvidence(
    drive: Drive,
    isNeed: boolean,
    hypothesisId: string,
    itemId: string,
    result: EvidenceResult,
    searchLog?: SearchLog
  ): Promise<void> {
    await this.checkpoint(drive, async (s, map) => {
      const node = map.nodes.find(n => n.id === itemId);
      // A card the user deleted cannot hold a finding: the item closes as a miss instead of a found item with no card.
      const settled: EvidenceResult = node || !result.found ? result : { found: false, reason: "card_deleted" };
      const next = isNeed
        ? applyEvidence(s, hypothesisId, itemId, settled)
        : applySituationEvidence(s, itemId, settled);
      if (searchLog) {
        const item = isNeed
          ? next.hypotheses.find(h => h.id === hypothesisId)?.needs.find(n => n.id === itemId)
          : next.situation.data.find(d => d.id === itemId);
        if (item) item.searchLog = searchLog;
      }
      const proof = result.found ? result.proof : undefined;
      const lines = proof ? [this.t("ui.argument_source_0_1_2", proof.claim, proof.quote, proof.url)] : [];
      const datumInNext = isNeed ? undefined : next.situation.data.find(d => d.id === itemId);
      // A facet map writes the whole datum note now (stance shows as "judging" until the facet judge decides); needs keep the sources only.
      const sourcesDetail = (p: NonNullable<typeof proof>): string =>
        hasFacets(next)
          ? datumInNext
            ? datumDetail(this.tr, datumInNext)
            : sourceNote(this.tr, p)
          : [`## ${this.t("ui.argument_sources")}`, ...lines].join("\n");
      const notes = async (): Promise<void> => {
        if (!node) return; // the user deleted the card: skip it, keep the state consistent
        if (proof) {
          await this.writeNote(node.path, {
            summary: proof.claim,
            detail: sourcesDetail(proof)
          });
        } else if (!result.found)
          await this.writeNote(node.path, {
            detail: hasFacets(next)
              ? notFoundDetail(this.tr, searchLog, result.reason)
              : this.t("ui.argument_not_found_0", result.reason)
          });
      };
      return { next, notes };
    });
  }
}

export type { Hypothesis, RoleKey };
