/**
 * Argument map runner, methodology 6 (packet V5). Executes what `core/argument-map/machine-v2.ts` allows, one checkpoint (one `mutate`)
 * per step. The v1 runner (`argument-run.ts`) stays for legacy maps and is not changed; this file is written fresh beside it.
 *
 * Public API (stage 1: signatures only, bodies are filled in by the next commits):
 * - `frame(original, { note, attempt, signal })`: one AI call (`framingStep`) before any map exists. Writes nothing. A failure is thrown
 *   and counts as the caller's attempt (`MAX_FRAMING_CALLS`); the usage confirmation is the caller's (the start window), not the runner's.
 * - `start(path, locked)`: `locked` is `lockFraming(...)`'s output. Creates the cards and `newArgumentMap(...)` in ONE mutate (the framing is
 *   locked by construction: there is no operation that edits it afterwards), then runs to the end or a pause. Resolves when the run is over.
 *   A legacy, existing or unusable map is refused as a result, nothing is written.
 * - `resume(path)`, `stop(path)` (aborts and pauses, resumable), `isRunning(path)`, `recover(path)` (open-map recovery: a run left
 *   `running` by a reload is paused as `interrupted`; legacy or other maps are never written; no provider call), `dispose()`.
 */
import type { TranslationKey } from "../../i18n";
import { neutralizeUnsafeMermaid } from "../../ai/mermaid-safety";
import type { AiResult } from "../../ai/types";
import {
  GateError,
  applyAlternativeHypotheses,
  applyComparison,
  applyConclusion,
  applyEvidence,
  applyEvidenceAssessment,
  applyHypotheses,
  applyInferenceCheck,
  applyNeeds,
  applyNoHypotheses,
  applyPause,
  applyPremiseAssessments,
  applyPremiseEvidence,
  applyPremiseMissing,
  applyPremiseResult,
  applyProgramVerdict,
  applyResume,
  applyVerdict,
  beginPremiseResearch,
  beginResearch,
  newArgumentMap,
  nextActions,
  prepareComparison,
  prepareConclusion,
  prepareInferenceCheck,
  prepareVerdict,
  releaseNeedResearch,
  releasePremiseResearch,
  startNextRound,
  type ArgumentAction,
  type ClaimDraft,
  type EvidenceResult
} from "../../core/argument-map/machine-v2";
import type { ArgumentMapData, ArgumentRoles, Framing } from "../../core/argument-map/model";
import {
  MAX_FRAMING_CALLS,
  MAX_HYPOTHESES,
  MAX_ROUND_NEEDS,
  WORST_CASE_AI_CALLS,
  readArgumentMap
} from "../../core/argument-map/model";
import { unverifiedQuoteLog, verifySourceV2 } from "../../core/argument-map/source-proof";
import {
  ARGUMENT_STEPS_V2,
  ArgumentStepError,
  hypothesesParts,
  lockedFraming,
  needAssessmentItems,
  needAssessmentParts,
  needsParts,
  premiseAssessmentItems,
  premiseAssessmentParts,
  premiseVerdictData,
  type ArgumentStepBase,
  type FramingClaim,
  type FramingResult
} from "../../core/steps/argument-map/runner";
import type { StepDefinition } from "../../core/step-runner";
import type { MapDocument, MapNode } from "../../map-model";
import { plainLine, type ArgumentRunPorts, type BusyHandle, type NoteInput } from "./argument-run";

export { WORST_CASE_AI_CALLS, MAX_FRAMING_CALLS };
export type { ArgumentRunPorts as ArgumentRunV2Ports };
export type { TranslationKey };

/** Why a start, resume or frame call was refused. Nothing was written when one is returned. */
export type ArgumentRunV2Refusal =
  | "busy"
  | "unusable"
  | "legacy"
  | "exists"
  | "missing"
  | "finished"
  | "not_paused"
  | "disposed"
  | "framing_limit"
  | "not_locked";
export class ArgumentRunV2Error extends Error {
  constructor(readonly code: ArgumentRunV2Refusal) {
    super(`argument run refused: ${code}`);
    this.name = "ArgumentRunV2Error";
  }
}
/** The result of `start` and `resume`: the run ended (finished, paused or stopped) or the call was refused without writing anything. */
export type ArgumentRunOutcome = { ok: true } | { ok: false; refusal: ArgumentRunV2Refusal };

export interface FrameOptions {
  /** What the user said about the earlier restatement; empty on the first call. */
  note?: string;
  /** This call's number. Must be within `MAX_FRAMING_CALLS`, else the call is refused (`framing_limit`) and no provider call is made. */
  attempt: 1 | 2 | 3;
  /** The window's own signal: closing the window or Esc aborts; a late result is the caller's to drop. */
  signal: AbortSignal;
}

/** What the user confirmed: the locked framing plus the claim breakdown it came with (labels c1, c2; the runner assigns card ids). */
export interface LockedFraming {
  framing: Framing;
  claims: FramingClaim[];
}

/**
 * The locked framing of a confirmed `FramingResult` (the user may have changed `chosen`, answered the ambiguity questions in `settings`,
 * and edited `definitions` before this call; the result passed here already carries those edits). `now` stamps `lockedAt`.
 */
export function lockFraming(
  original: string,
  result: FramingResult,
  attempts: number,
  now: string,
  chosen: string = result.chosen
): LockedFraming {
  return {
    framing: lockedFraming(original, result, attempts, now, chosen),
    claims: result.claims.map(c => ({
      ...c,
      dependsOn: [...c.dependsOn],
      definitions: c.definitions.map(d => ({ ...d })),
      dataNeeds: [...c.dataNeeds]
    }))
  };
}

/** Read-only snapshot for a view or modal. */
export interface ArgumentRunV2Status {
  running: boolean;
}

/** The runner as the start window and the map view see it. */
export interface ArgumentRunV2Api {
  frame(original: string, options: FrameOptions): Promise<FramingResult>;
  start(path: string, locked: LockedFraming): Promise<ArgumentRunOutcome>;
  resume(path: string): Promise<ArgumentRunOutcome>;
  stop(path: string): Promise<void>;
  isRunning(path: string): boolean;
  recover(path: string): Promise<boolean>;
  dispose(): void;
}

export const MAX_RESEARCH_CONCURRENCY = 3;
const X_STEP = 320;
const Y_STEP = 160;

/** Raised (never returned) for a `nextActions` action this runner does not know. The run pauses as `error`, resumable. */
export class ArgumentRunV2Pending extends Error {
  constructor(readonly action: ArgumentAction["type"]) {
    super(`argument run: action ${action} is not implemented yet (TODO V5b)`);
    this.name = "ArgumentRunV2Pending";
  }
}

/** The actions this runner executes (every `nextActions` action; an unknown one pauses the run as `error` through `ArgumentRunV2Pending`). */
const IMPLEMENTED: ReadonlySet<ArgumentAction["type"]> = new Set<ArgumentAction["type"]>([
  "research_premise",
  "premise_missing",
  "assess_premise",
  "judge_premise",
  "propose_hypotheses",
  "add_needs",
  "research_need",
  "assess_evidence",
  "next_round",
  "program_verdict",
  "no_hypotheses",
  "propose_alternatives",
  "verdict",
  "compare",
  "conclude",
  "inference_check"
]);
const isResearch = (a: ArgumentAction): boolean => a.type === "research_premise" || a.type === "research_need";

interface Drive {
  mapPath: string;
  controller: AbortController;
  stopRequested: boolean;
  disposed: boolean;
  done: Promise<void>;
  /** The run this drive owns; a checkpoint on any other run id writes nothing. */
  runId: string;
  /** Consecutive provider failures per research item (memory only, per drive; reset by an answer). */
  failures: Map<string, number>;
}
interface Plan {
  next: ArgumentMapData;
  /** Nodes to add with their parent. */
  nodes?: { node: MapNode; parentId: string | null }[];
  /** Note writes after the map write. */
  notes?: () => Promise<void>;
}
type Kind = "proposition" | "datum" | "conclusion" | "group" | "hypothesis" | "need";

const shorten = (text: string, max: number): string => Array.from(text.trim()).slice(0, max).join("");
const domainOf = (url: string | undefined): string => {
  try {
    return new URL(url ?? "").hostname;
  } catch {
    return "-";
  }
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
function untilAborted<T>(signal: AbortSignal, work: Promise<T>): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error("aborted"));
  return new Promise<T>((resolve, reject) => {
    signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    work.then(resolve, reject);
  });
}
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const TERMINAL = ["concluded", "stopped_premise"];

export class ArgumentRunsV2 implements ArgumentRunV2Api {
  private readonly drives = new Map<string, Drive>();
  private readonly frames = new Set<AbortController>();
  private waiting: (() => void)[] = [];
  private inFlight = 0;
  private disposed = false;

  constructor(private readonly ports: ArgumentRunPorts) {}

  // ---- note writes: every model/web-derived string passes here before it reaches a Markdown note ----------------------------------
  private t(key: TranslationKey, ...values: unknown[]): string {
    return this.ports.t(key, ...values.map(v => (typeof v === "string" ? plainLine(v) : v)));
  }
  private makeNote(
    kind: Kind,
    title: string,
    summary: string | undefined,
    map: MapDocument,
    mapPath: string,
    id?: string
  ): Promise<MapNode> {
    const input: NoteInput = { kind, title: plainLine(title) };
    if (summary !== undefined) input.summary = plainLine(summary);
    return this.ports.createNote(input, map, mapPath).then(node => {
      if (id !== undefined) node.id = id; // the id the state already names
      return node;
    });
  }
  private writeNote(path: string, patch: { summary?: string; detail?: string }): Promise<void> {
    const safe: { summary?: string; detail?: string } = {};
    if (patch.summary !== undefined) safe.summary = plainLine(patch.summary);
    if (patch.detail !== undefined) safe.detail = neutralizeUnsafeMermaid(plainLine(patch.detail));
    return this.ports.updateNote(path, safe);
  }

  isRunning(mapPath: string): boolean {
    return this.drives.has(mapPath);
  }

  // ---- framing (before any map exists) -----------------------------------------------------------------------------------------
  async frame(original: string, options: FrameOptions): Promise<FramingResult> {
    if (this.disposed) throw new ArgumentRunV2Error("disposed");
    const attempt = options.attempt;
    if (!Number.isInteger(attempt) || attempt < 1 || attempt > MAX_FRAMING_CALLS)
      throw new ArgumentRunV2Error("framing_limit");
    // No map exists yet: the port is asked for the global configuration with an empty path, and no usage path is sent.
    const config = this.ports.config("");
    const controller = new AbortController();
    this.frames.add(controller);
    const signal = linked(options.signal, controller.signal);
    try {
      return await this.ports.runStep(
        ARGUMENT_STEPS_V2.frame,
        {
          language: config.language,
          model: config.model,
          reasoning: config.reasoning,
          original,
          note: options.note ?? "",
          attempt
        },
        signal
      );
    } finally {
      this.frames.delete(controller);
    }
  }

  // ---- start / resume / stop / recover ---------------------------------------------------------------------------------------------
  /** Creates the cards and the state in one mutate, then runs to the end (or a pause). Refusals are returned and write nothing. */
  async start(mapPath: string, locked: LockedFraming): Promise<ArgumentRunOutcome> {
    const refused = this.guard(mapPath);
    if (refused) return { ok: false, refusal: refused };
    if (!locked?.framing || typeof locked.framing.lockedAt !== "string" || locked.framing.lockedAt.trim() === "")
      return { ok: false, refusal: "not_locked" };
    const runId = this.ports.newId();
    const drive = this.open(mapPath, runId);
    let refusal: ArgumentRunV2Refusal | undefined;
    drive.done = this.go(drive, async () => {
      await this.ports.mutate(async () => {
        if (this.dead(drive)) return;
        const map = await this.ports.readMap(mapPath);
        const read = readArgumentMap(map);
        if (read.kind !== "absent") {
          refusal = read.kind === "legacy" ? "legacy" : read.kind === "usable" ? "exists" : "unusable";
          return;
        }
        // Dry run with the reply's labels: an illegal breakdown writes no card.
        try {
          newArgumentMap(locked.framing, {
            runId,
            roles: { proposition: "r-p", premises: "r-r", conclusion: "r-c" },
            claims: this.drafts(
              locked,
              label => label,
              (label, i) => `${label}-d${i}`,
              label => `${label}-cmp`
            )
          });
        } catch (error) {
          if (!(error instanceof GateError)) throw error;
          refusal = "not_locked";
          return;
        }
        const p = this.ports;
        const proposition = await this.makeNote(
          "proposition",
          shorten(locked.framing.restatement, 80),
          locked.framing.restatement,
          map,
          mapPath
        );
        const premises = await this.makeNote("group", p.t("ui.argument_situation"), undefined, map, mapPath);
        const conclusion = await this.makeNote(
          "conclusion",
          p.t("ui.argument_conclusion"),
          p.t("ui.argument_in_progress"),
          map,
          mapPath
        );
        const roles: ArgumentRoles = { proposition: proposition.id, premises: premises.id, conclusion: conclusion.id };
        const parents: [MapNode, string | null][] = [
          [proposition, null],
          [premises, proposition.id],
          [conclusion, proposition.id]
        ];
        const labels = new Map(locked.claims.map(c => [c.id, p.newId()]));
        const drafts = this.drafts(
          locked,
          label => labels.get(label) ?? label,
          () => p.newId(),
          () => p.newId()
        );
        for (const claim of drafts) {
          const premise = claim.role === "premise";
          const card = await this.makeNote("group", shorten(claim.text, 80), claim.text, map, mapPath, claim.id);
          parents.push([card, premise ? premises.id : proposition.id]);
          for (const datum of claim.data ?? [])
            parents.push([
              await this.makeNote("datum", shorten(datum.need, 80), datum.need, map, mapPath, datum.id),
              claim.id
            ]);
          if (claim.comparisonNodeId !== undefined)
            parents.push([
              await this.makeNote(
                "group",
                `${p.t("ui.argument_conclusion")} · ${shorten(claim.text, 60)}`,
                undefined,
                map,
                mapPath,
                claim.comparisonNodeId
              ),
              claim.id
            ]);
        }
        if (this.dead(drive)) return;
        await p.updateMap(mapPath, doc => {
          if (doc.argumentMap !== undefined) throw new ArgumentRunV2Error("exists");
          for (const [node, parentId] of parents) this.attach(doc, node, parentId);
          doc.argumentMap = newArgumentMap(locked.framing, { runId, roles, claims: drafts });
        });
        p.clearUndo(mapPath);
        this.ports.log(
          `argument-run start runId=${runId} phase=${drafts.some(d => d.role === "premise") ? "premises" : "analysis"}`
        );
      });
    });
    await drive.done;
    return refusal ? { ok: false, refusal } : { ok: true };
  }

  /** `newArgumentMap` claim drafts for the locked breakdown; `id`, `datum` and `node` choose the ids (labels for a dry run, reserved ids for real). */
  private drafts(
    locked: LockedFraming,
    id: (label: string) => string,
    datum: (label: string, index: number) => string,
    node: (label: string) => string
  ): ClaimDraft[] {
    return locked.claims.map(c => ({
      id: id(c.id),
      text: c.text,
      type: c.type,
      role: c.role,
      dependsOn: c.dependsOn.map(id),
      definitions: c.definitions.map(d => ({ ...d })),
      ...(c.role === "premise"
        ? { data: c.dataNeeds.map((need, index) => ({ id: datum(c.id, index), need })) }
        : { comparisonNodeId: node(c.id) })
    }));
  }

  /** Continues a paused v2 run: only unfinished items are redone. Refused (nothing written) for legacy, unusable, missing, finished or running maps. */
  async resume(mapPath: string): Promise<ArgumentRunOutcome> {
    const refused = this.guard(mapPath);
    if (refused) return { ok: false, refusal: refused };
    const read = readArgumentMap(await this.ports.readMap(mapPath));
    if (read.kind === "legacy") return { ok: false, refusal: "legacy" };
    if (read.kind === "unusable") return { ok: false, refusal: "unusable" };
    if (read.kind === "absent") return { ok: false, refusal: "missing" };
    if (TERMINAL.includes(read.data.run.phase) || read.data.run.status === "finished")
      return { ok: false, refusal: "finished" };
    if (read.data.run.status !== "paused") return { ok: false, refusal: "not_paused" };
    const drive = this.open(mapPath, read.data.run.runId);
    drive.done = this.go(drive, async () => {
      await this.checkpoint(drive, async state => ({ next: applyResume(state) }));
    });
    await drive.done;
    return { ok: true };
  }

  /** Aborts the run's provider calls; unfinished items go back to pending and the run is paused (resumable). */
  async stop(mapPath: string): Promise<void> {
    const drive = this.drives.get(mapPath);
    if (!drive) return;
    drive.stopRequested = true;
    drive.controller.abort();
    await drive.done.catch(() => undefined);
  }

  /**
   * Open-map recovery: a v2 run left `running` by a reload is paused as `interrupted`. Never calls a provider. A legacy, unusable, absent,
   * finished or already paused map (or one this runner is driving) is not written. Returns whether a pause was written.
   */
  async recover(mapPath: string): Promise<boolean> {
    if (this.disposed || this.drives.has(mapPath)) return false;
    let wrote = false;
    await this.ports.mutate(async () => {
      if (this.disposed) return;
      const read = readArgumentMap(await this.ports.readMap(mapPath));
      if (read.kind !== "usable" || read.data.run.status !== "running" || TERMINAL.includes(read.data.run.phase))
        return;
      const before = read.data;
      await this.ports.updateMap(mapPath, doc => {
        const now = readArgumentMap(doc);
        if (now.kind !== "usable" || !same(now.data, before)) return;
        doc.argumentMap = applyPause(now.data, "interrupted");
        wrote = true;
      });
      if (wrote) this.ports.clearUndo(mapPath);
    });
    if (wrote) this.ports.log("argument-run paused stopReason=interrupted");
    return wrote;
  }

  /** Plugin unload: abort everything; nothing is written afterwards. */
  dispose(): void {
    this.disposed = true;
    for (const drive of this.drives.values()) {
      drive.disposed = true;
      drive.controller.abort();
    }
    for (const controller of this.frames) controller.abort();
  }

  // ---- lifecycle ---------------------------------------------------------------------------------------------------------------
  private guard(mapPath: string): ArgumentRunV2Refusal | null {
    if (this.disposed) return "disposed";
    if (this.drives.has(mapPath)) return "busy";
    return null;
  }
  private open(mapPath: string, runId: string): Drive {
    const drive: Drive = {
      mapPath,
      controller: new AbortController(),
      stopRequested: false,
      disposed: false,
      done: Promise.resolve(),
      runId,
      failures: new Map()
    };
    this.drives.set(mapPath, drive);
    return drive;
  }
  private dead(drive: Drive): boolean {
    return drive.disposed || this.disposed || drive.controller.signal.aborted;
  }

  /** Setup, then the loop, then the stop/pause write, then release. Never rejects: refusals are the caller's variables. */
  private go(drive: Drive, setup: () => Promise<void>): Promise<void> {
    const run = async (): Promise<void> => {
      try {
        await setup();
        if (!this.dead(drive) && (await this.usageAllowed(drive))) await this.loop(drive);
      } catch (error) {
        if (!this.dead(drive)) await this.fail(drive, error);
      } finally {
        try {
          await this.settle(drive);
        } finally {
          this.drives.delete(drive.mapPath);
        }
      }
    };
    return run();
  }
  private async usageAllowed(drive: Drive): Promise<boolean> {
    if (!this.ports.confirmUsage || (await this.ports.confirmUsage(drive.mapPath))) return true;
    drive.stopRequested = true;
    return false;
  }
  /** Last write of a drive: a requested Stop pauses the run ('user'). Never after dispose. */
  private async settle(drive: Drive): Promise<void> {
    if (drive.disposed || this.disposed || !drive.stopRequested) return;
    await this.pause(drive, "user", true);
  }
  private async fail(drive: Drive, error: unknown): Promise<void> {
    if (error instanceof ArgumentRunV2Pending) this.ports.log(`argument-run pending action=${error.action} `);
    else this.ports.log(`argument-run error message=${error instanceof Error ? error.name : "unknown"}`);
    await this.pause(drive, "error", false).catch(() => undefined);
  }
  private async pause(drive: Drive, reason: "user" | "interrupted" | "error", force: boolean): Promise<void> {
    let phase = "-";
    const wrote = await this.checkpoint(
      drive,
      async state => {
        if (state.run.status !== "running" || TERMINAL.includes(state.run.phase)) return null;
        phase = state.run.phase;
        return { next: applyPause(state, reason) };
      },
      force
    );
    if (wrote) this.ports.log(`argument-run paused runId=${drive.runId} phase=${phase} stopReason=${reason}`);
  }

  // ---- the loop ----------------------------------------------------------------------------------------------------------------
  private async loop(drive: Drive): Promise<void> {
    let idle = 0;
    let last = "";
    for (;;) {
      if (this.dead(drive)) return;
      const state = await this.state(drive);
      if (!state) return;
      const actions = nextActions(state);
      if (!actions.length) return;
      const key = JSON.stringify(state);
      idle = key === last ? idle + 1 : 0;
      last = key;
      if (idle >= 3) {
        await this.pause(drive, "error", false);
        return;
      }
      const research = actions.filter(isResearch);
      const ready = actions.find(a => !isResearch(a) && IMPLEMENTED.has(a.type));
      if (research.length) {
        await Promise.all(research.slice(0, MAX_RESEARCH_CONCURRENCY).map(a => this.research(drive, state, a)));
        // Two consecutive provider failures on one item: the one automatic retry is spent, so the run pauses (resumable).
        if (!this.dead(drive) && [...drive.failures.values()].some(n => n >= 2)) {
          await this.pause(drive, "error", false);
          return;
        }
      } else if (ready) await this.guarded(drive, () => this.textStep(drive, state, ready));
      else throw new ArgumentRunV2Pending(actions[0].type);
      if (drive.stopRequested) return;
    }
  }
  private async state(drive: Drive): Promise<ArgumentMapData | null> {
    const read = readArgumentMap(await this.ports.readMap(drive.mapPath));
    return read.kind === "usable" && read.data.run.runId === drive.runId ? read.data : null;
  }

  /** One corrective retry for a text step (parse refusal, gate refusal or provider error); a second failure pauses with 'error'. */
  private async guarded(drive: Drive, work: () => Promise<void>): Promise<void> {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        await work();
        return;
      } catch (error) {
        if (this.dead(drive)) return;
        const known = error instanceof ArgumentStepError || error instanceof GateError;
        this.ports.log(`argument-run step failed attempt=${attempt} kind=${known ? error.name : "other"}`);
        if (attempt === 2) {
          await this.pause(drive, "error", false);
          return;
        }
      }
    }
  }

  // ---- checkpoint --------------------------------------------------------------------------------------------------------------
  /**
   * One mutate: re-read, fence (run id; the map unchanged since `build` read it), write nodes and state in a single updateMap, then the note
   * texts. `force` is only for the Stop pause, which is allowed after an abort.
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
      if (read.kind !== "usable" || read.data.run.runId !== drive.runId) return;
      const before = read.data;
      const plan = await build(before, map);
      if (!plan || gone()) return;
      await this.ports.updateMap(drive.mapPath, doc => {
        const now = readArgumentMap(doc);
        if (now.kind !== "usable" || !same(now.data, before)) return; // stale: someone else changed the state
        for (const entry of plan.nodes ?? []) this.attach(doc, entry.node, entry.parentId);
        doc.argumentMap = plan.next;
        wrote = true;
      });
      if (!wrote) return;
      this.ports.clearUndo(drive.mapPath);
      if (plan.notes && !gone()) await plan.notes();
    });
    return wrote;
  }
  private attach(doc: MapDocument, node: MapNode, parentId: string | null): void {
    const parent = parentId ? doc.nodes.find(n => n.id === parentId) : undefined;
    const siblings = doc.nodes.filter(n => n.parentId === parentId && n.id !== node.id).length;
    node.parentId = parentId;
    node.x = parent ? parent.x + X_STEP : 80;
    node.y = siblings * Y_STEP;
    doc.nodes.push(node);
  }

  // ---- text steps --------------------------------------------------------------------------------------------------------------
  private base(drive: Drive): ArgumentStepBase {
    const config = this.ports.config(drive.mapPath);
    return { language: config.language, model: config.model, reasoning: config.reasoning, usageMapPath: drive.mapPath };
  }
  private ask<Request extends ArgumentStepBase, Output>(
    drive: Drive,
    step: StepDefinition<Request, Output>,
    request: Request
  ): Promise<Output> {
    // a provider that ignores abort must not hang Stop: the call is abandoned the moment the drive aborts
    return untilAborted(drive.controller.signal, this.ports.runStep(step, request, drive.controller.signal));
  }
  private claimOf(state: ArgumentMapData, id: string): ArgumentMapData["claims"][number] {
    const claim = state.claims.find(c => c.id === id);
    if (!claim) throw new GateError(`unknown claim ${id}`);
    return claim;
  }
  private pathOf(map: MapDocument, id: string): string | undefined {
    return map.nodes.find(n => n.id === id)?.path;
  }
  private async cardNote(map: MapDocument, id: string, patch: { summary?: string; detail?: string }): Promise<void> {
    const path = this.pathOf(map, id);
    if (path) await this.writeNote(path, patch);
  }

  private async textStep(drive: Drive, state: ArgumentMapData, action: ArgumentAction): Promise<void> {
    const base = this.base(drive);
    switch (action.type) {
      case "premise_missing":
        await this.checkpoint(drive, async (s, map) =>
          this.afterPremise(applyPremiseMissing(s, action.claimId), action.claimId, map)
        );
        return;
      case "assess_premise": {
        const claim = this.claimOf(state, action.claimId);
        const result = await this.ask(drive, ARGUMENT_STEPS_V2.assess_premise, {
          ...base,
          ...premiseAssessmentParts(claim)
        });
        await this.checkpoint(drive, async s => ({
          next: applyPremiseAssessments(s, action.claimId, premiseAssessmentItems(result))
        }));
        return;
      }
      case "judge_premise": {
        const claim = this.claimOf(state, action.claimId);
        const result = await this.ask(drive, ARGUMENT_STEPS_V2.judge_premise, {
          ...base,
          premise: {
            text: claim.text,
            definitions: claim.definitions.map(d => ({ term: d.term, meaning: d.meaning }))
          },
          data: premiseVerdictData(claim)
        });
        await this.checkpoint(drive, async (s, map) => {
          const plan = this.afterPremise(applyPremiseResult(s, action.claimId, result), action.claimId, map);
          const inner = plan.notes;
          plan.notes = async () => {
            await inner?.();
            await this.cardNote(map, action.claimId, { detail: `${this.t("ui.argument_reason")}: ${result.reason}` });
          };
          return plan;
        });
        return;
      }
      case "propose_hypotheses":
        return this.propose(drive, state, action.claimId, false);
      case "propose_alternatives":
        return this.propose(drive, state, action.claimId, true);
      case "verdict":
        return this.verdict(drive, state, action.hypothesisId);
      case "compare":
        return this.compare(drive, state, action.claimId);
      case "conclude":
        return this.conclude(drive, state);
      case "inference_check":
        return this.inferenceCheck(drive, state);
      case "add_needs":
      case "next_round":
        return this.needs(drive, state, action.hypothesisId, action.type === "next_round");
      case "assess_evidence": {
        const result = await this.ask(drive, ARGUMENT_STEPS_V2.assess_evidence, {
          ...base,
          ...needAssessmentParts(state, action.hypothesisId)
        });
        await this.checkpoint(drive, async s => ({
          next: applyEvidenceAssessment(s, action.hypothesisId, needAssessmentItems(result))
        }));
        return;
      }
      case "program_verdict":
        await this.checkpoint(drive, async (s, map) => {
          const next = applyProgramVerdict(s, action.hypothesisId);
          return this.verdictPlan(next, action.hypothesisId, map);
        });
        return;
      case "no_hypotheses":
        await this.checkpoint(drive, async s => ({ next: applyNoHypotheses(s, action.claimId) }));
        return;
      default:
        throw new ArgumentRunV2Pending(action.type);
    }
  }

  /** A premise closed: its card says why; a run that stopped on a premise says so on the conclusion card (fixed text, never a model answer). */
  private afterPremise(next: ArgumentMapData, claimId: string, map: MapDocument): Plan {
    const claim = this.claimOf(next, claimId);
    this.ports.log(
      `argument-run premise runId=${next.run.runId} phase=${next.run.phase} result=${claim.result ?? "-"}`
    );
    const stopped = next.run.phase === "stopped_premise";
    if (stopped)
      this.ports.log(
        `argument-run stopped runId=${next.run.runId} phase=${next.run.phase} stopReason=${next.run.stopReason ?? "-"}`
      );
    return {
      next,
      notes: async () => {
        if (stopped)
          await this.cardNote(map, next.roles.conclusion, {
            summary:
              next.run.stopReason === "data_missing"
                ? this.t("ui.argument_stopped_missing")
                : this.t("ui.argument_reason") + ": " + claim.text
          });
      }
    };
  }

  /** Room for this claim's first batch: the cap minus what the other live claims still need for their own floor. */
  private proposeIds(state: ArgumentMapData, claimId: string): string[] {
    const reserve = state.claims
      .filter(
        c =>
          c.role === "testable" &&
          c.id !== claimId &&
          c.status !== "not_evaluated" &&
          !state.hypotheses.some(h => h.claimId === c.id)
      )
      .reduce((sum, c) => sum + (c.type === "fact" ? 2 : 3), 0);
    const count = Math.max(1, MAX_HYPOTHESES - state.hypotheses.length - reserve);
    return Array.from({ length: count }, () => this.ports.newId());
  }

  private async propose(drive: Drive, state: ArgumentMapData, claimId: string, late: boolean): Promise<void> {
    const gap = this.claimOf(state, claimId).comparison?.vetoes.find(
      v => !v.resolved && v.kind === "missed_alternative"
    )?.detail;
    const ids = late
      ? Array.from({ length: Math.max(1, MAX_HYPOTHESES - state.hypotheses.length) }, () => this.ports.newId())
      : this.proposeIds(state, claimId);
    const request = {
      ...this.base(drive),
      restatement: state.framing.restatement,
      ...hypothesesParts(state, claimId, late ? "alternatives" : "first", ids, late ? (gap ?? "") : "")
    };
    const phase = state.run.phase;
    const result = await this.ask(
      drive,
      late ? ARGUMENT_STEPS_V2.propose_alternatives : ARGUMENT_STEPS_V2.propose_hypotheses,
      request
    );
    await this.checkpoint(drive, async (s, map) => {
      if (s.run.phase !== phase) return null; // a late reply of an earlier phase writes nothing
      const next = late
        ? applyAlternativeHypotheses(s, claimId, result.hypotheses)
        : applyHypotheses(s, claimId, result.hypotheses);
      const nodes: Plan["nodes"] = [];
      for (const h of result.hypotheses) {
        const text = h.predictions.map(p => p.text).join(" / ");
        nodes.push({
          node: await this.makeNote(
            "hypothesis",
            `${h.role}: ${shorten(h.predictions[0]?.text ?? "", 60)}`,
            text,
            map,
            drive.mapPath,
            h.id
          ),
          parentId: claimId
        });
      }
      return { next, nodes };
    });
  }

  private verdictPlan(next: ArgumentMapData, hypothesisId: string, map: MapDocument): Plan {
    const verdict = next.hypotheses.find(h => h.id === hypothesisId)?.verdict;
    this.ports.log(
      `argument-run verdict runId=${next.run.runId} phase=${next.run.phase} by=${verdict?.by ?? "-"} value=${verdict?.value ?? "-"}`
    );
    return {
      next,
      notes: () =>
        this.cardNote(map, hypothesisId, { detail: `${this.t("ui.argument_reason")}: ${verdict?.reason ?? ""}` })
    };
  }

  /** One AI verdict. The reply is applied only to the state it was asked about (same run phase and same prepared input), else nothing is written. */
  private async verdict(drive: Drive, state: ArgumentMapData, hypothesisId: string): Promise<void> {
    const input = prepareVerdict(state, hypothesisId);
    const result = await this.ask(drive, ARGUMENT_STEPS_V2.verdict, { ...this.base(drive), input });
    await this.checkpoint(drive, async (s, map) => {
      if (s.run.phase !== state.run.phase || !same(prepareVerdict(s, hypothesisId), input)) return null;
      return this.verdictPlan(applyVerdict(s, hypothesisId, result), hypothesisId, map);
    });
  }

  private async compare(drive: Drive, state: ArgumentMapData, claimId: string): Promise<void> {
    const input = prepareComparison(state, claimId);
    const result = await this.ask(drive, ARGUMENT_STEPS_V2.compare, { ...this.base(drive), input });
    await this.checkpoint(drive, async s => {
      if (s.run.phase !== state.run.phase || !same(prepareComparison(s, claimId), input)) return null;
      const next = applyComparison(s, claimId, result);
      const c = this.claimOf(next, claimId).comparison;
      this.ports.log(
        `argument-run compare runId=${next.run.runId} phase=${next.run.phase} claim=${claimId} state=${c?.state ?? "-"} attempts=${c?.attempts ?? 0} vetoes=${(c?.vetoes ?? []).map(v => v.kind).join(",") || "-"} answer=${c?.answer ?? "-"}`
      );
      return { next };
    });
  }

  /** The conclusion card: its summary says where the conclusion is and its text lists each answer's sentence (claim text from the state, sentences plain lines). */
  private conclusionNotes(map: MapDocument, next: ArgumentMapData): () => Promise<void> {
    return async () => {
      const path = this.pathOf(map, next.roles.conclusion);
      if (!path) return;
      const done = next.run.status === "finished";
      const summary = !done
        ? this.ports.t("ui.argument_in_progress")
        : next.conclusion.state === "concluded"
          ? this.ports.t("ui.argument_conclusion_state_concluded")
          : this.ports.t("ui.argument_conclusion_limit");
      const lines: string[] = [];
      for (const a of next.conclusion.answers) {
        const claim = next.claims.find(c => c.id === a.claimId);
        if (a.sentence) lines.push(`- ${plainLine(claim?.text ?? "")}: ${plainLine(a.sentence)}`);
      }
      if (next.conclusion.overall) lines.push(`- ${plainLine(next.conclusion.overall)}`);
      await this.ports.updateNote(path, {
        summary: plainLine(summary),
        detail: lines.map(l => neutralizeUnsafeMermaid(l)).join("\n")
      });
    };
  }

  private async conclude(drive: Drive, state: ArgumentMapData): Promise<void> {
    const input = prepareConclusion(state);
    const result = await this.ask(drive, ARGUMENT_STEPS_V2.conclude, { ...this.base(drive), input });
    await this.checkpoint(drive, async (s, map) => {
      if (s.run.phase !== state.run.phase || !same(prepareConclusion(s), input)) return null;
      const next = applyConclusion(s, result);
      this.ports.log(
        `argument-run conclusion runId=${next.run.runId} phase=${next.run.phase} state=${next.conclusion.state} answers=${next.conclusion.answers.map(a => a.answer).join(",") || "-"}`
      );
      return { next, notes: this.conclusionNotes(map, next) };
    });
  }

  private async inferenceCheck(drive: Drive, state: ArgumentMapData): Promise<void> {
    const input = prepareInferenceCheck(state);
    const result = await this.ask(drive, ARGUMENT_STEPS_V2.inference_check, { ...this.base(drive), input });
    await this.checkpoint(drive, async (s, map) => {
      if (s.run.phase !== state.run.phase || !same(prepareInferenceCheck(s), input)) return null;
      const next = applyInferenceCheck(s, result);
      this.ports.log(
        `argument-run inference runId=${next.run.runId} phase=${next.run.phase} check=${next.run.inferenceChecks ?? 0} deleted=${next.conclusion.deleted.length} state=${next.conclusion.state}`
      );
      return { next, notes: this.conclusionNotes(map, next) };
    });
  }

  private async needs(drive: Drive, state: ArgumentMapData, hypothesisId: string, round: boolean): Promise<void> {
    const ids = Array.from({ length: MAX_ROUND_NEEDS }, () => this.ports.newId());
    if (!state.hypotheses.some(h => h.id === hypothesisId)) throw new GateError(`unknown hypothesis ${hypothesisId}`);
    const request = { ...this.base(drive), ...needsParts(state, hypothesisId, round ? "round" : "first", ids) };
    const result = await this.ask(drive, round ? ARGUMENT_STEPS_V2.next_round : ARGUMENT_STEPS_V2.add_needs, request);
    await this.checkpoint(drive, async (s, map) => {
      const next = round ? startNextRound(s, hypothesisId, result.needs) : applyNeeds(s, hypothesisId, result.needs);
      const nodes: Plan["nodes"] = [];
      for (const n of result.needs)
        nodes.push({
          node: await this.makeNote("need", shorten(n.text, 80), n.text, map, drive.mapPath, n.id),
          parentId: hypothesisId
        });
      return { next, nodes };
    });
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
   * begin (writes researchCalls) -> dispatch -> verify -> commit. Never throws. A reply that cannot be used becomes a miss; a provider
   * failure is released back to pending instead, never a miss. The result is committed only while the run id and phase still match and the
   * item is still `searching` (stale fence); a stopped claim never reaches here (`nextActions` has no action for it).
   */
  private async research(drive: Drive, state: ArgumentMapData, action: ArgumentAction): Promise<void> {
    if (action.type !== "research_premise" && action.type !== "research_need") return;
    const isNeed = action.type === "research_need";
    const itemId = action.type === "research_need" ? action.needId : action.dataId;
    const owner = action.type === "research_need" ? action.hypothesisId : action.claimId;
    const needText = isNeed
      ? (state.hypotheses.find(h => h.id === owner)?.needs.find(n => n.id === itemId)?.text ?? "")
      : (state.claims.find(c => c.id === owner)?.data?.find(d => d.id === itemId)?.need ?? "");
    const phase = state.run.phase;
    const map = await this.ports.readMap(drive.mapPath);
    const node = map.nodes.find(n => n.id === itemId);
    await this.slot();
    let busy: BusyHandle | null = null;
    try {
      if (this.dead(drive)) return;
      if (node) {
        busy = this.ports.begin(node.path);
        if (!busy) return;
      }
      const began = await this.checkpoint(drive, async s => ({
        next: isNeed ? beginResearch(s, owner, itemId) : beginPremiseResearch(s, owner, itemId)
      }));
      if (!began || this.dead(drive)) return;
      const signal = busy ? linked(drive.controller.signal, busy.signal) : drive.controller.signal;
      const config = this.ports.config(drive.mapPath);
      let reply: AiResult;
      try {
        reply = await untilAborted(
          signal,
          this.ports.askModel(
            {
              title: shorten(needText, 120),
              summary: "",
              rules: "",
              detail: "",
              task: needText,
              ancestors: state.framing.restatement,
              mode: "task",
              researchMode: "research",
              responseContract: "argument-evidence",
              argumentEvidenceNeeds: [{ id: itemId, text: needText }],
              usageMapPath: drive.mapPath,
              outputLanguage: config.language
            },
            config.model,
            config.reasoning,
            signal
          )
        );
      } catch (error) {
        if (this.dead(drive)) return;
        if (busy?.signal.aborted) {
          void this.stop(drive.mapPath);
          return;
        }
        await this.releaseFailed(drive, state, isNeed, owner, itemId, error);
        return;
      }
      let result: EvidenceResult;
      let domain = "-";
      let code = "";
      try {
        const entry = reply.argumentEvidence?.find(e => e.need === itemId);
        if (!entry) result = { found: false, reason: "no_answer" };
        else if (entry.status !== "found") result = { found: false, reason: "not_found" };
        else {
          domain = domainOf(entry.url);
          const check = await verifySourceV2({
            url: entry.url,
            quote: entry.quote,
            claim: entry.claim,
            openedUrls: reply.evidence?.openedUrls ?? [],
            fetch: this.ports.fetch,
            parseHtml: this.ports.parseHtml,
            now: this.ports.now
          });
          code = check.ok ? check.proof.check : check.reason;
          const stance = entry.stance === "contradicts" ? "opposes" : entry.stance;
          result = check.ok
            ? { found: true, stance, proof: check.proof }
            : { found: false, reason: `source_${check.reason}` };
          if (check.ok && check.proof.check === "unverified_quote")
            this.ports.log(unverifiedQuoteLog(state.run.runId, [{ id: itemId, domain }]));
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
      this.ports.log(
        `argument-run proof runId=${state.run.runId} phase=${phase} result=${result.found ? "found" : result.reason} proof=${code || "-"} domain=${domain}`
      );
      try {
        await this.commitEvidence(drive, phase, isNeed, owner, itemId, result);
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

  /** A provider failure is not a try: the item goes back to pending (no note) and the failure is counted for this drive. */
  private async releaseFailed(
    drive: Drive,
    state: ArgumentMapData,
    isNeed: boolean,
    owner: string,
    itemId: string,
    error: unknown
  ): Promise<void> {
    this.ports.log(
      `argument-run proof runId=${state.run.runId} phase=${state.run.phase} result=provider_failure proof=${error instanceof Error ? error.name : "error"} domain=-`
    );
    try {
      await this.checkpoint(drive, async s => ({
        next: isNeed ? releaseNeedResearch(s, owner, itemId) : releasePremiseResearch(s, owner, itemId)
      }));
    } catch (failure) {
      if (!(failure instanceof GateError)) throw failure;
      this.ports.log(`argument-run stale dropped runId=${state.run.runId}`);
    }
    drive.failures.set(itemId, (drive.failures.get(itemId) ?? 0) + 1);
  }

  private async commitEvidence(
    drive: Drive,
    phase: string,
    isNeed: boolean,
    owner: string,
    itemId: string,
    result: EvidenceResult
  ): Promise<void> {
    await this.checkpoint(drive, async (s, map) => {
      if (s.run.phase !== phase) throw new GateError("the phase moved on"); // a late result of an earlier phase is dropped
      const node = map.nodes.find(n => n.id === itemId);
      // A card the user deleted cannot hold a finding: the item closes as a miss instead of a found item with no card.
      const settled: EvidenceResult = node || !result.found ? result : { found: false, reason: "card_deleted" };
      const next = isNeed ? applyEvidence(s, owner, itemId, settled) : applyPremiseEvidence(s, owner, itemId, settled);
      const proof = result.found ? result.proof : undefined;
      const notes = async (): Promise<void> => {
        if (!node) return;
        if (proof)
          await this.writeNote(node.path, {
            summary: proof.claim,
            detail: [
              `## ${this.t("ui.argument_sources")}`,
              this.t("ui.argument_source_0_1_2", proof.claim, proof.quote, proof.url)
            ].join("\n")
          });
        else if (!result.found)
          await this.writeNote(node.path, { detail: this.t("ui.argument_not_found_0", result.reason) });
      };
      return { next, notes };
    });
  }
}

export type { ArgumentMapData };
