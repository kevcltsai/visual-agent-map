/**
 * Argument map runner (hypothesis research). Executes what `core/argument-map/machine.ts` allows, one checkpoint (one `mutate`) per
 * step, and nothing else: every gate lives in the machine and in `verifySource`; this file only moves data between them, the model
 * and the map. It has no dependency on main.ts or the view: everything it touches is an injected port, so it is tested with fakes.
 *
 * Rules kept here: `researchCalls` is written (begin) before a research dispatch; a result is committed only while the run id, the
 * item's `searching` state and the unchanged argument map still match (stale fence); a user-deleted node is skipped; Stop and
 * dispose abort everything and nothing is written after dispose; a failed step gets one corrective retry, then the run pauses.
 */
import type { TranslationKey } from "../../i18n";
import { neutralizeUnsafeMermaid } from "../../ai/mermaid-safety";
import type { AiResult, TaskContext } from "../../ai/types";
import {
  GateError,
  addNeeds,
  applyConclusion,
  applyEvidence,
  applyGateMissing,
  applyHypotheses,
  applyLimitStop,
  applyPause,
  applyResume,
  applySituationData,
  applySituationEvidence,
  applySituationGate,
  applyVerdict,
  beginResearch,
  beginSituationResearch,
  eliminateAtLimit,
  newArgumentMap,
  nextActions,
  prepareConclusion,
  prepareVerdict,
  startNextRound,
  type ArgumentAction,
  type EvidenceResult
} from "../../core/argument-map/machine";
import {
  MAX_HYPOTHESES,
  MAX_RESEARCH_CALLS,
  MAX_ROUND,
  MAX_SITUATION_DATA,
  MIN_VERIFIED,
  foundNeeds,
  readArgumentMap,
  type ArgumentMapData,
  type ArgumentRoles,
  type Hypothesis,
  type RoleKey
} from "../../core/argument-map/model";
import { arrangeArgumentMap } from "../../core/argument-map/layout";
import { verifySource, type FetchPage } from "../../core/argument-map/source-proof";
import {
  ARGUMENT_STEPS,
  ArgumentStepError,
  gateData,
  needsAllowed,
  type ArgumentStepBase,
  type ConclusionRequest,
  type ConclusionResult,
  type GateRequest,
  type GateVerdict,
  type HypothesesRequest,
  type HypothesesResult,
  type NeedsRequest,
  type NeedsResult,
  type PlanSituationRequest,
  type PlanSituationResult,
  type VerdictRequest,
  type VerdictResult
} from "../../core/steps/argument-map/runner";
import type { StepDefinition } from "../../core/step-runner";
import type { MapDocument, MapNode } from "../../map-model";

export const MAX_RESEARCH_CONCURRENCY = 3;
/**
 * The most AI calls one run can make, shown before it starts (corrections and retries not counted): the research calls, plan_situation,
 * judge_gate, propose (up to MAX_HYPOTHESES - MIN_VERIFIED + 1), a needs step and a verdict step per hypothesis per round, and conclude.
 */
export const WORST_CASE_AI_CALLS =
  MAX_RESEARCH_CALLS + 1 + 1 + (MAX_HYPOTHESES - MIN_VERIFIED + 1) + MAX_HYPOTHESES * MAX_ROUND * 2 + 1;
const X_STEP = 320;
const Y_STEP = 160;

export type ArgumentRunRefusal = "busy" | "unusable" | "exists" | "missing" | "finished" | "not_paused" | "disposed";
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

/** Model/web text as inert plain single-line text: line breaks become a space, 3+ backtick/tilde runs cannot form a fence, and Markdown inline constructs that load or link things (`![` images/embeds, `[[` `]]` wikilinks, `<` `>` raw HTML) are entity-encoded. Ordinary text is unchanged. */
export function plainLine(text: string): string {
  return text
    .replace(/[\r\n\u2028\u2029]+/g, " ")
    .replace(/`{3,}|~{3,}/g, m => [...m].join(" "))
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/!\[|\[(?=\[)/g, m => m.replace("[", "&#91;"))
    .replace(/\](?=\])/g, "&#93;");
}

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
}

interface Drive {
  mapPath: string;
  controller: AbortController;
  stopRequested: boolean;
  disposed: boolean;
  done: Promise<void>;
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
  async start(mapPath: string, proposition: string): Promise<void> {
    this.guard(mapPath);
    const text = proposition.trim();
    if (!text) throw new ArgumentRunError("missing");
    const drive = this.open(mapPath);
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
        const verified = await make("group", p.t("ui.argument_group_verified"));
        const eliminated = await make("group", p.t("ui.argument_group_eliminated"));
        const roles: ArgumentRoles = {
          proposition: proposed.id,
          situation: situation.id,
          conclusion: conclusion.id,
          verified: verified.id,
          eliminated: eliminated.id
        };
        const parents: [MapNode, string | null][] = [
          [proposed, null],
          [situation, proposed.id],
          [conclusion, proposed.id],
          [verified, conclusion.id],
          [eliminated, conclusion.id]
        ];
        if (this.dead(drive)) return;
        await p.updateMap(mapPath, doc => {
          if (doc.argumentMap !== undefined) throw new ArgumentRunError("exists");
          for (const [node, parentId] of parents) this.attach(doc, node, parentId);
          doc.argumentMap = newArgumentMap(roles, runId);
        });
        p.clearUndo(mapPath);
      });
      this.ports.log(`argument-run start runId=${runId} phase=situation`);
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
      stopRequested: false,
      disposed: false,
      done: Promise.resolve()
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
      const research = actions.filter(a => a.type === "research_situation" || a.type === "research_need");
      if (research.length) {
        await Promise.all(research.slice(0, MAX_RESEARCH_CONCURRENCY).map(a => this.research(drive, state, a)));
      } else await this.guarded(drive, () => this.textStep(drive, state, actions[0]));
      if (drive.stopRequested) return;
    }
  }
  private async state(drive: Drive): Promise<ArgumentMapData | null> {
    const read = readArgumentMap(await this.ports.readMap(drive.mapPath));
    return read.kind === "usable" ? read.data : null;
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
  private async proposition(drive: Drive, state: ArgumentMapData): Promise<string> {
    return (await this.text(drive, state.roles.proposition)).summary;
  }
  private ask<Request extends ArgumentStepBase, Output>(
    drive: Drive,
    step: StepDefinition<Request, Output>,
    request: Request
  ): Promise<Output> {
    return this.ports.runStep(step, request, drive.controller.signal);
  }

  private async textStep(drive: Drive, state: ArgumentMapData, action: ArgumentAction): Promise<void> {
    const proposition = await this.proposition(drive, state);
    const base = this.base(drive);
    switch (action.type) {
      case "plan_situation": {
        const request: PlanSituationRequest = { ...base, proposition, max: MAX_SITUATION_DATA };
        const result: PlanSituationResult = await this.ask(drive, ARGUMENT_STEPS.plan_situation, request);
        await this.checkpoint(drive, async (s, map) => {
          // Dry run with placeholder ids first: a refused batch must not leave notes behind.
          applySituationData(
            s,
            result.data.map((d, i) => ({ id: `dry-${i}`, need: d.need }))
          );
          // Each datum is a leaf card under the situation card; the card's id is the datum's id (like a need).
          const nodes: Plan["nodes"] = [];
          const items: { id: string; need: string }[] = [];
          for (const d of result.data) {
            const node = await this.makeNote(
              { kind: "datum", title: shorten(d.need, 80), summary: d.need },
              map,
              drive.mapPath
            );
            nodes.push({ node, parentId: s.roles.situation });
            items.push({ id: node.id, need: d.need });
          }
          return { next: applySituationData(s, items), nodes };
        });
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
            reparent: [{ id: h.id, parentId: next.roles.eliminated }],
            notes: () =>
              this.noteDetail(map, h.id, drive, this.t("ui.argument_eliminated_0", h.eliminationReason ?? ""))
          };
        });
        return;
      }
      case "conclude":
        return this.conclude(drive, state, proposition);
      case "stop_limit": {
        await this.checkpoint(drive, async s => this.stopPlan(drive, applyLimitStop(s)));
        return;
      }
      default:
        throw new GateError(`no text step for ${action.type}`);
    }
  }

  private async propose(drive: Drive, state: ArgumentMapData, proposition: string, count: number): Promise<void> {
    const existing: string[] = [];
    for (const h of state.hypotheses) existing.push((await this.text(drive, h.id)).title);
    const request: HypothesesRequest = {
      ...this.base(drive),
      proposition,
      data: gateData(state.situation.data.filter(d => d.state === "found")),
      count,
      existing
    };
    const result: HypothesesResult = await this.ask(drive, ARGUMENT_STEPS.propose_hypotheses, request);
    await this.checkpoint(drive, async (s, map) => {
      // Dry run with placeholder ids first: a refused batch (the gate) must not leave notes behind.
      applyHypotheses(
        s,
        result.hypotheses.map((h, i) => ({ id: `dry-${i}`, citedData: h.citedData }))
      );
      const nodes: Plan["nodes"] = [];
      const items: { id: string; citedData: string[] }[] = [];
      for (const h of result.hypotheses) {
        const node = await this.makeNote(
          { kind: "hypothesis", title: h.title, summary: h.statement },
          map,
          drive.mapPath
        );
        nodes.push({ node, parentId: s.roles.verified });
        items.push({ id: node.id, citedData: h.citedData });
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
      hypothesis: { title: text.title, statement: text.summary, round },
      data: gateData(state.situation.data.filter(d => h.citedData.includes(d.id))),
      existing: h.needs.map(n => ({ text: n.text, state: n.state })),
      max: needsAllowed({ ...h, round })
    };
    const result: NeedsResult = await this.ask(drive, ARGUMENT_STEPS[revise ? "revise" : "add_needs"], request);
    await this.checkpoint(drive, async (s, map) => {
      const dry = result.needs.map((n, i) => ({ id: `dry-${i}`, text: n.text }));
      if (revise) startNextRound(s, hypothesisId, dry);
      else addNeeds(s, hypothesisId, dry);
      const nodes: Plan["nodes"] = [];
      const items: { id: string; text: string }[] = [];
      for (const n of result.needs) {
        const node = await this.makeNote(
          { kind: "need", title: shorten(n.text, 80), summary: n.text },
          map,
          drive.mapPath
        );
        nodes.push({ node, parentId: hypothesisId });
        items.push({ id: node.id, text: n.text });
      }
      return { next: revise ? startNextRound(s, hypothesisId, items) : addNeeds(s, hypothesisId, items), nodes };
    });
  }

  private async verdict(drive: Drive, state: ArgumentMapData, hypothesisId: string): Promise<void> {
    const request: VerdictRequest = {
      ...this.base(drive),
      hypothesis: (await this.text(drive, hypothesisId)).summary,
      input: prepareVerdict(state, hypothesisId)
    };
    const result: VerdictResult = await this.ask(drive, ARGUMENT_STEPS.verdict, request);
    await this.checkpoint(drive, async (s, map) => ({
      next: applyVerdict(s, hypothesisId, result),
      notes: () =>
        this.noteDetail(map, hypothesisId, drive, `${this.t("ui.argument_reason")}: ${plainLine(result.reason)}`)
    }));
  }

  private async conclude(drive: Drive, state: ArgumentMapData, proposition: string): Promise<void> {
    const input = prepareConclusion(state);
    const statements: Record<string, string> = {};
    for (const h of input.hypotheses) statements[h.id] = (await this.text(drive, h.id)).summary;
    const request: ConclusionRequest = { ...this.base(drive), proposition, input, statements };
    const result: ConclusionResult = await this.ask(drive, ARGUMENT_STEPS.conclude, request);
    await this.checkpoint(drive, async (s, map) => {
      const next = applyConclusion(s, result);
      const pointLines = result.points.map(p => `- ${plainLine(p.text)}`);
      const detail = [
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
    if (next.run.phase === "stopped_limit")
      summary = t("ui.argument_stopped_limit_0", next.conclusion.missing.join("; "));
    else summary = gate.kind === "data_missing" ? t("ui.argument_stopped_missing") : t("ui.argument_stopped_mismatch");
    const detail =
      next.run.phase === "stopped_mismatch"
        ? [`${t("ui.argument_reason")}: ${plainLine(gate.reason ?? "")}`, "", ...this.dataSection(next, [])].join("\n")
        : "";
    const path = (await this.ports.readMap(drive.mapPath)).nodes.find(n => n.id === next.roles.conclusion)?.path;
    this.ports.log(
      `argument-run stopped runId=${next.run.runId} phase=${next.run.phase} stopReason=${next.run.stopReason ?? "-"}`
    );
    return {
      next,
      notes: async () => {
        if (path) await this.writeNote(path, { summary, detail });
      }
    };
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

  /** begin (writes researchCalls) -> dispatch -> verify -> commit. Never throws: a failed item becomes a miss. */
  private async research(drive: Drive, state: ArgumentMapData, action: ArgumentAction): Promise<void> {
    const isNeed = action.type === "research_need";
    if (action.type !== "research_need" && action.type !== "research_situation") return;
    const itemId = action.type === "research_need" ? action.needId : action.dataId;
    const hypothesisId = action.type === "research_need" ? action.hypothesisId : "";
    const map = await this.ports.readMap(drive.mapPath);
    const node = map.nodes.find(n => n.id === itemId);
    const needText = isNeed
      ? (state.hypotheses.find(h => h.id === hypothesisId)?.needs.find(n => n.id === itemId)?.text ?? "")
      : (state.situation.data.find(d => d.id === itemId)?.need ?? "");
    await this.slot();
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
      const signal = busy ? linked(drive.controller.signal, busy.signal) : drive.controller.signal;
      const proposition = await this.proposition(drive, state);
      let result: EvidenceResult;
      let openedUrls: string[] = [];
      let domain = "-";
      let code = "";
      try {
        const reply = await untilAborted(
          signal,
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
              argumentEvidenceNeeds: [{ id: itemId, text: needText }],
              usageMapPath: drive.mapPath,
              outputLanguage: this.ports.config(drive.mapPath).language
            },
            this.ports.config(drive.mapPath).model,
            this.ports.config(drive.mapPath).reasoning,
            signal
          )
        );
        openedUrls = reply.evidence?.openedUrls ?? [];
        const entry = reply.argumentEvidence?.find(e => e.need === itemId);
        if (!entry) result = { found: false, reason: "no_answer" };
        else if (entry.status !== "found") result = { found: false, reason: "not_found" };
        else {
          domain = domainOf(entry.url);
          const stance = !isNeed && entry.stance === "contradicts" ? "opposes" : entry.stance;
          if (!isNeed && entry.stance === "uncertain") result = { found: false, reason: "stance_uncertain" };
          else {
            const check = await verifySource({
              url: entry.url,
              quote: entry.quote,
              claim: entry.claim,
              openedUrls,
              fetch: this.ports.fetch,
              parseHtml: this.ports.parseHtml,
              now: this.ports.now
            });
            code = check.ok ? check.proof.check : check.reason;
            result = check.ok
              ? { found: true, stance, proof: check.proof }
              : { found: false, reason: `source_${check.reason}` };
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
      this.ports.log(
        `argument-run proof runId=${state.run.runId} phase=${state.run.phase} result=${result.found ? "found" : result.reason} proof=${code || "-"} domain=${domain}`
      );
      try {
        await this.commitEvidence(drive, isNeed, hypothesisId, itemId, result);
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

  /** The stale fence: the run id (checkpoint) and the item still `searching` (the reducers throw otherwise); a deleted node gets no note. */
  private async commitEvidence(
    drive: Drive,
    isNeed: boolean,
    hypothesisId: string,
    itemId: string,
    result: EvidenceResult
  ): Promise<void> {
    await this.checkpoint(drive, async (s, map) => {
      const node = map.nodes.find(n => n.id === itemId);
      // A card the user deleted cannot hold a finding: the item closes as a miss instead of a found item with no card.
      const settled: EvidenceResult = node || !result.found ? result : { found: false, reason: "card_deleted" };
      const next = isNeed
        ? applyEvidence(s, hypothesisId, itemId, settled)
        : applySituationEvidence(s, itemId, settled);
      const proof = result.found ? result.proof : undefined;
      const lines = proof ? [this.t("ui.argument_source_0_1_2", proof.claim, proof.quote, proof.url)] : [];
      const notes = async (): Promise<void> => {
        if (!node) return; // the user deleted the card: skip it, keep the state consistent
        if (proof) {
          await this.writeNote(node.path, {
            summary: proof.claim,
            detail: [`## ${this.t("ui.argument_sources")}`, ...lines].join("\n")
          });
        } else if (!result.found)
          await this.writeNote(node.path, { detail: this.t("ui.argument_not_found_0", result.reason) });
      };
      return { next, notes };
    });
  }
}

export type { Hypothesis, RoleKey };
