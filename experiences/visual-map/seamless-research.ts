/**
 * Seamless research orchestrator (one topic = one attempt). Phase 1 writes a filtered draft without the web; phase 2 runs the
 * web verify step and the images step side by side, then writes the result in place (or below the user's text), holds it while
 * the note is open, and never reports success for a failure. Obsidian and the AI runtime come in through `SeamlessDeps`.
 * Nothing here runs unless `deps.enabled()` is true.
 */
import { t, type ContentLanguage } from "../../i18n";
import {
  applyCorrections,
  detailHash,
  eligibleImages,
  planPhase2Write,
  renderFootnoteDefinitions,
  sanitizePhase2Markdown,
  type Phase2Image
} from "../../core/seamless-research/apply";
import {
  classifyFailure,
  seamlessOutcome,
  type FailureClass,
  type SeamlessAction,
  type SeamlessStatus
} from "../../core/seamless-research/outcome";
import { skeletonFilter } from "../../core/seamless-research/skeleton-filter";
import type { ReasoningLevel } from "../../ai/types";
import type { ResearchImagesResult } from "../../core/steps/research-verify/images";
import type { ResearchVerifyResult } from "../../core/steps/research-verify/step";

/** The part of a topic note the orchestrator reads and writes. */
export interface SeamlessNote {
  title: string;
  summary: string;
  detail: string;
  model: string;
  modelSource?: "workspace" | "inherited" | "manual";
  reasoning?: ReasoningLevel;
  status: SeamlessStatus;
  researchWrittenHash?: string;
}
export type SeamlessNotePatch = Partial<SeamlessNote>;

export interface SeamlessPhase1Input {
  path: string;
  title: string;
  /** Parent context (ancestor text); may be empty. */
  context: string;
  language: ContentLanguage;
  model: string;
  reasoning?: ReasoningLevel;
  /** The conservative-skeleton task text for the model. */
  instruction: string;
  signal: AbortSignal;
}
export interface SeamlessVerifyInput {
  path: string;
  title: string;
  context: string;
  skeleton: string;
  language: ContentLanguage;
  model: string;
  reasoning?: ReasoningLevel;
  signal: AbortSignal;
}
export interface SeamlessImagesInput {
  path: string;
  title: string;
  context: string;
  model: string;
  reasoning?: ReasoningLevel;
  signal: AbortSignal;
}

export interface SeamlessDeps {
  /** `settings.seamlessResearch`. Every entry point refuses when this is false. */
  enabled(): boolean;
  repo: {
    readNote(path: string): Promise<SeamlessNote>;
    updateNote(path: string, patch: SeamlessNotePatch): Promise<void>;
  };
  /** The plugin's serialized write queue. */
  mutate(work: () => Promise<void>): Promise<void>;
  /** Phase 1: one Quick call without the web. */
  askModel(input: SeamlessPhase1Input): Promise<{ summary: string; detail: string }>;
  /** Phase 2 text: web search only, parsed. May throw (network, SearchNotPerformed, parse). */
  runVerify(input: SeamlessVerifyInput): Promise<ResearchVerifyResult>;
  /** Phase 2 images: a separate web call run beside runVerify. */
  runImages(input: SeamlessImagesInput): Promise<ResearchImagesResult>;
  /** Downloads one eligible image into the Vault; returns its Vault path, or throws / returns undefined to drop it. */
  saveImage(image: Phase2Image, notePath: string, signal: AbortSignal): Promise<string | undefined>;
  /** The note is open in a visible Markdown leaf. */
  isShown(path: string): boolean;
  capabilitiesFor(model: string): { webSearch: boolean };
  /** `settings.cliModel`. */
  defaultModel(): string;
  /** The topic's note path is in `running` for every other flow while an attempt (or a held result) owns it. */
  running: Set<string>;
  /** Another flow (Quick expansion, a research run) is working on this topic. */
  busyElsewhere(path: string): boolean;
  /** The conservative-skeleton task text (`skeletonInstruction`). */
  skeletonInstruction(language: ContentLanguage): string;
  log?(message: string): void;
  uuid?(): string;
  /** Whether a summary is only the empty-note placeholder. Default: blank. */
  isPlaceholderSummary?(summary: string): boolean;
  /** Phase-2 calls that may run at once. Default 3. */
  phase2Concurrency?: number;
}

export interface SeamlessRequest {
  path: string;
  title: string;
  /** Parent context for the topic (ancestors); may be empty. */
  context: string;
  language: ContentLanguage;
  /** Extra words the phase-1 filter may keep, for example ancestor titles. The topic's own title is always allowed. */
  allow?: readonly string[];
  /** The chat asked for images. Only then is "no image found" a problem. */
  imagesRequested?: boolean;
  /** The batch's stop signal. */
  signal?: AbortSignal;
  /** Called once the topic is registered and its status is `running` (the coordinator's `accepted`). */
  accepted?: () => void;
}

export type SeamlessProblemReason = Exclude<FailureClass, "stopped">;
/** One sentence plus at most one button for the view to show. Sentence keys: see `problemMessageKey`. */
export interface SeamlessProblem {
  path: string;
  title: string;
  reason: SeamlessProblemReason;
  action?: SeamlessAction;
}
export type SeamlessEvent =
  { type: "change" } | { type: "written"; path: string; before: SeamlessNote; after: SeamlessNote };

/** i18n key of the problem's one sentence. */
export function problemMessageKey(
  reason: SeamlessProblemReason
):
  | "ui.seamless_problem_no_images_0"
  | "ui.seamless_problem_network"
  | "ui.seamless_problem_no_web_model"
  | "ui.seamless_problem_other" {
  return reason === "no-images"
    ? "ui.seamless_problem_no_images_0"
    : reason === "network"
      ? "ui.seamless_problem_network"
      : reason === "no-web-model"
        ? "ui.seamless_problem_no_web_model"
        : "ui.seamless_problem_other";
}
/** i18n key of the problem's button. */
export function problemActionKey(
  action: SeamlessAction
): "ui.seamless_action_retry" | "ui.seamless_action_switch_model" | "ui.seamless_action_dismiss" {
  return action === "retry"
    ? "ui.seamless_action_retry"
    : action === "switch-model"
      ? "ui.seamless_action_switch_model"
      : "ui.seamless_action_dismiss";
}

/** Model used by "switch to a model that can go online": the default model when it can, else `claude:sonnet`. */
export const FALLBACK_WEB_MODEL = "claude:sonnet";

const LABEL_UNSAFE = /[[\]()<>|`*_~\n\r]/g;
function label(value: string, limit: number): string {
  return value
    .replace(/\b(?:javascript|vbscript|data|file):\S*/gi, " ")
    .replace(LABEL_UNSAFE, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit);
}

/** The images part of the note: each saved copy as a local embed with a source line (page and license). */
export function renderImageBlock(saved: readonly { path: string; image: Phase2Image }[]): string {
  return saved
    .map(({ path, image }) => {
      const title = label(image.title, 120) || image.sourceUrl;
      const link = `[${title}](${image.sourceUrl})`;
      return `![[${path}]]\n${t("ui.seamless_image_source_0_1", link, label(image.license, 80))}`;
    })
    .join("\n\n");
}

export interface Phase2Composition {
  detail: string;
}
/** Phase-2 markdown ready for the write plan: cleaned, corrected in place, footnote definitions and saved images added. */
export function composePhase2Detail(
  verify: ResearchVerifyResult,
  saved: readonly { path: string; image: Phase2Image }[]
): Phase2Composition {
  const clean = sanitizePhase2Markdown(verify.detail).markdown;
  if (!clean.trim()) throw new Error(t("ui.seamless_phase2_empty"));
  const corrected = applyCorrections(clean, verify.verdicts).detail.trimEnd();
  const parts = [corrected, renderFootnoteDefinitions(verify.footnotes), renderImageBlock(saved)].filter(Boolean);
  return { detail: `${parts.join("\n\n")}\n` };
}

class Semaphore {
  private waiting: { grant: () => void; reject: (error: unknown) => void }[] = [];
  private free: number;
  constructor(size: number) {
    this.free = Math.max(1, size);
  }
  acquire(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(abortError());
    if (this.free > 0) {
      this.free--;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const entry = {
        grant: () => {
          signal.removeEventListener("abort", onAbort);
          resolve();
        },
        reject
      };
      const onAbort = (): void => {
        this.waiting = this.waiting.filter(item => item !== entry);
        reject(abortError());
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.waiting.push(entry);
    });
  }
  release(): void {
    const next = this.waiting.shift();
    if (next) next.grant();
    else this.free++;
  }
}

function abortError(): Error {
  const error = new Error("aborted");
  error.name = "AbortError";
  return error;
}

interface Topic {
  path: string;
  title: string;
  context: string;
  language: ContentLanguage;
  allow: readonly string[];
  imagesRequested: boolean;
  /** Status the note had before the first attempt; restored when a stop comes before anything was written. */
  status0: SeamlessStatus;
  phase1Written: boolean;
  /** Filtered phase-1 text (or filtered existing detail): the phase-2 input, kept for retries. */
  skeleton: string;
}
interface Attempt {
  id: string;
  controller: AbortController;
  topic: Topic;
  /** Phase 2 result is waiting for the note to be closed (or a flush is applying it); the flow has returned. */
  handedOff: boolean;
  detach: () => void;
}
interface Phase2Result {
  verify: ResearchVerifyResult;
  images: Phase2Image[];
  imagesFailed: boolean;
}
interface Held {
  attempt: Attempt;
  result: Phase2Result;
  /** Images already downloaded for this result (so a second apply does not download again). */
  saved?: { path: string; image: Phase2Image }[];
}

export class SeamlessResearch {
  private readonly current = new Map<string, Attempt>();
  private readonly topics = new Map<string, Topic>();
  private readonly held = new Map<string, Held>();
  private readonly problemMap = new Map<string, SeamlessProblem>();
  private readonly applying = new Set<string>();
  private readonly listeners = new Set<(event: SeamlessEvent) => void>();
  private readonly phase2Slots: Semaphore;
  private disposed = false;

  constructor(private readonly deps: SeamlessDeps) {
    this.phase2Slots = new Semaphore(deps.phase2Concurrency ?? 3);
  }

  // ---------- what the view reads ----------

  /** The topic is being researched or its result is held: show the slow "growing" signal, never "done". */
  isGrowing(path: string): boolean {
    return this.current.has(path) || this.held.has(path);
  }
  isHeld(path: string): boolean {
    return this.held.has(path);
  }
  growingPaths(): string[] {
    return [...new Set([...this.current.keys(), ...this.held.keys()])];
  }
  problems(): SeamlessProblem[] {
    return [...this.problemMap.values()];
  }
  problemFor(path: string): SeamlessProblem | undefined {
    return this.problemMap.get(path);
  }
  subscribe(listener: (event: SeamlessEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // ---------- actions ----------

  /**
   * Researches one topic: phase 1, then phase 2. Resolves when phase 2 has been written, held for a note that is open, failed
   * into a problem, or stopped. Throws only when the topic cannot start (flag off, busy) or phase 1 fails; the caller's batch
   * counts that as a failed topic. The caller has already asked for the AI usage notice.
   */
  async research(request: SeamlessRequest): Promise<void> {
    this.requireEnabled();
    const topic: Topic = {
      path: request.path,
      title: request.title,
      context: request.context,
      language: request.language,
      allow: [request.title, ...(request.allow ?? [])],
      imagesRequested: request.imagesRequested === true,
      status0: "idea",
      phase1Written: false,
      skeleton: ""
    };
    await this.run(topic, request.signal, request.accepted, false);
  }

  /** "Try again": phase 2 only, with the skeleton of the last run. */
  async retry(path: string, signal?: AbortSignal): Promise<void> {
    this.requireEnabled();
    const topic = this.topics.get(path);
    const problem = this.problemMap.get(path);
    if (!topic || !problem || problem.action !== "retry") throw new Error(t("ui.seamless_nothing_to_retry"));
    await this.run(topic, signal, undefined, true);
  }

  /** "Switch to a model that can go online": changes only this topic's model, then runs phase 2 again. */
  async switchModelAndRetry(path: string, signal?: AbortSignal): Promise<void> {
    this.requireEnabled();
    const topic = this.topics.get(path);
    const problem = this.problemMap.get(path);
    if (!topic || !problem || problem.action !== "switch-model") throw new Error(t("ui.seamless_nothing_to_retry"));
    this.requireIdle(path);
    const preferred = this.deps.defaultModel();
    let model = FALLBACK_WEB_MODEL;
    try {
      if (preferred && this.deps.capabilitiesFor(preferred).webSearch) model = preferred;
    } catch {
      /* An unknown default model falls back to the known web model. */
    }
    await this.deps.mutate(async () => {
      await this.deps.repo.updateNote(path, { model, modelSource: "manual" });
    });
    await this.run(topic, signal, undefined, true);
  }

  /** The image problem has a single button: dismiss. */
  dismiss(path: string): void {
    if (this.problemMap.delete(path)) this.changed();
  }

  /** Stop one topic (running or held). Phase-1 text stays; the status is never `completed`. */
  abort(path: string): void {
    const attempt = this.current.get(path);
    if (!attempt) return;
    attempt.controller.abort();
  }

  /** Stop every topic that is running or held (the plugin-wide stop). */
  abortAll(): void {
    for (const attempt of [...this.current.values()]) attempt.controller.abort();
  }

  /** The plugin is unloading: abort everything, forget held results, write nothing more. */
  dispose(): void {
    this.disposed = true;
    for (const attempt of this.current.values()) {
      attempt.controller.abort();
      attempt.detach();
    }
    this.current.clear();
    this.held.clear();
    this.problemMap.clear();
    this.applying.clear();
    this.listeners.clear();
  }

  /** Applies every held result whose note is no longer shown. Called on `layout-change` and `active-leaf-change`. */
  async flushHeld(): Promise<void> {
    if (this.disposed || !this.held.size) return;
    for (const [path, entry] of [...this.held]) {
      if (this.applying.has(path) || this.deps.isShown(path)) continue;
      this.applying.add(path);
      try {
        await this.applyHeld(path, entry);
      } finally {
        this.applying.delete(path);
      }
    }
  }

  // ---------- pipeline ----------

  private requireEnabled(): void {
    if (!this.deps.enabled()) throw new Error(t("ui.seamless_off"));
  }
  private requireIdle(path: string): void {
    const busy =
      this.current.has(path) || this.held.has(path) || this.deps.running.has(path) || this.deps.busyElsewhere(path);
    if (busy) throw new Error(t("ui.ai_running_ai"));
  }
  private changed(): void {
    for (const listener of [...this.listeners]) listener({ type: "change" });
  }
  private log(message: string): void {
    this.deps.log?.(message);
  }
  private isCurrent(attempt: Attempt): boolean {
    return !this.disposed && !attempt.controller.signal.aborted && this.current.get(attempt.topic.path) === attempt;
  }

  private begin(topic: Topic, batchSignal: AbortSignal | undefined): Attempt {
    const controller = new AbortController();
    const onBatchAbort = (): void => controller.abort();
    const attempt: Attempt = {
      id: this.deps.uuid?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
      controller,
      topic,
      handedOff: false,
      detach: () => batchSignal?.removeEventListener("abort", onBatchAbort)
    };
    // Any stop (batch, Stop on the topic, plugin-wide stop) drops a result that is waiting for its note to be closed.
    controller.signal.addEventListener(
      "abort",
      () => {
        if (this.held.get(topic.path)?.attempt === attempt) void this.discardHeld(topic.path, attempt);
      },
      { once: true }
    );
    if (batchSignal?.aborted) controller.abort();
    else batchSignal?.addEventListener("abort", onBatchAbort, { once: true });
    this.current.set(topic.path, attempt);
    this.deps.running.add(topic.path);
    this.topics.set(topic.path, topic);
    this.problemMap.delete(topic.path);
    this.changed();
    return attempt;
  }

  /** Removes the attempt's registrations (only those it owns). */
  private release(attempt: Attempt): void {
    const path = attempt.topic.path;
    attempt.detach();
    if (this.current.get(path) === attempt) this.current.delete(path);
    if (!this.current.has(path)) this.deps.running.delete(path);
    this.changed();
  }

  private async run(
    topic: Topic,
    batchSignal: AbortSignal | undefined,
    accepted: (() => void) | undefined,
    phase2Only: boolean
  ): Promise<void> {
    this.requireIdle(topic.path);
    const attempt = this.begin(topic, batchSignal);
    const signal = attempt.controller.signal;
    try {
      const note = await this.deps.repo.readNote(topic.path);
      if (!phase2Only) topic.status0 = note.status;
      topic.title = phase2Only ? topic.title : note.title || topic.title;
      if (signal.aborted) return await this.stopped(attempt);
      await this.setStatus(attempt, "running");
      if (signal.aborted) return await this.stopped(attempt);
      accepted?.();

      if (!phase2Only) {
        const emptyDetail = !note.detail.trim();
        if (emptyDetail) {
          if (!(await this.phase1(attempt, note))) return await this.dropStale(attempt);
        } else topic.skeleton = skeletonFilter(note.detail, { allow: topic.allow });
        if (!this.isCurrent(attempt)) return await this.dropStale(attempt);
      }
      await this.phase2(attempt);
    } catch (error) {
      if (this.disposed) return;
      if (signal.aborted || classifyFailure(error) === "stopped") return await this.stopped(attempt);
      // Phase 1 failed (phase 2 failures are handled inside phase2()).
      await this.setStatus(attempt, "error");
      throw error;
    } finally {
      if (!attempt.handedOff) this.release(attempt);
    }
  }

  private async setStatus(attempt: Attempt, status: SeamlessStatus): Promise<void> {
    if (this.disposed) return;
    const path = attempt.topic.path;
    await this.deps.mutate(async () => {
      // Another attempt may own the topic by now: leave its status alone.
      const owner = this.current.get(path);
      if (owner && owner !== attempt) return;
      await this.deps.repo.updateNote(path, { status });
    });
  }

  /** Stop: phase-1 text stays, status goes back (nothing written) or to `idea` (never `completed`), held result is dropped. */
  private async stopped(attempt: Attempt): Promise<void> {
    const topic = attempt.topic;
    if (this.held.get(topic.path)?.attempt === attempt) this.held.delete(topic.path);
    const outcome = seamlessOutcome({
      stopped: true,
      phase1Written: topic.phase1Written,
      phase2: "none",
      imagesRequested: topic.imagesRequested,
      imagesSaved: 0
    });
    this.log(t("log.seamless_ended_0_1", topic.title, "stopped"));
    if (!this.disposed) await this.setStatus(attempt, outcome.status === "restore" ? topic.status0 : outcome.status);
  }

  private async discardHeld(path: string, attempt: Attempt): Promise<void> {
    if (this.held.get(path)?.attempt !== attempt) return;
    try {
      await this.stopped(attempt);
    } finally {
      this.release(attempt);
    }
  }

  // ---------- phase 1 ----------

  /** Returns false when nothing was written because the attempt is no longer the topic's (stopped, retitled, or the detail is no longer empty). */
  private async phase1(attempt: Attempt, note: SeamlessNote): Promise<boolean> {
    const topic = attempt.topic;
    const reply = await this.deps.askModel({
      path: topic.path,
      title: topic.title,
      context: topic.context,
      language: topic.language,
      model: note.model,
      reasoning: note.reasoning,
      instruction: this.deps.skeletonInstruction(topic.language),
      signal: attempt.controller.signal
    });
    if (!this.isCurrent(attempt)) return false;
    const skeleton = skeletonFilter(reply.detail, { allow: topic.allow });
    if (!skeleton.trim()) throw new Error(t("ui.seamless_phase1_empty"));
    const summary = skeletonFilter(reply.summary, { allow: topic.allow }).trim();
    let written = false;
    await this.deps.mutate(async () => {
      if (!this.isCurrent(attempt)) return;
      const latest = await this.deps.repo.readNote(topic.path);
      if (latest.title !== topic.title || latest.detail.trim()) return;
      const placeholder = (value: string): boolean =>
        this.deps.isPlaceholderSummary ? this.deps.isPlaceholderSummary(value) : !value.trim();
      await this.deps.repo.updateNote(topic.path, {
        detail: skeleton,
        researchWrittenHash: detailHash(skeleton),
        ...(summary && placeholder(latest.summary) ? { summary } : {})
      });
      written = true;
    });
    if (!written) return false;
    topic.phase1Written = true;
    topic.skeleton = skeleton;
    return true;
  }

  // ---------- phase 2 ----------

  private async phase2(attempt: Attempt): Promise<void> {
    const topic = attempt.topic;
    const signal = attempt.controller.signal;
    const note = await this.deps.repo.readNote(topic.path);
    if (signal.aborted) return await this.stopped(attempt);
    let webSearch = true;
    try {
      webSearch = this.deps.capabilitiesFor(note.model).webSearch !== false;
    } catch {
      webSearch = true;
    }
    if (!webSearch) return await this.fail(attempt, "no-web-model");

    let result: Phase2Result;
    try {
      await this.phase2Slots.acquire(signal);
    } catch {
      return await this.stopped(attempt);
    }
    try {
      const base = {
        path: topic.path,
        title: topic.title,
        context: topic.context,
        model: note.model,
        reasoning: note.reasoning,
        signal
      };
      // Two independent web calls; each outcome is judged on its own.
      const verifyCall = this.deps.runVerify({ ...base, skeleton: topic.skeleton, language: topic.language });
      const imagesCall = this.deps.runImages(base);
      const [verify, images] = await Promise.allSettled([verifyCall, imagesCall]);
      if (signal.aborted) return await this.dropStale(attempt);
      if (verify.status === "rejected") return await this.fail(attempt, classifyFailure(verify.reason), verify.reason);
      result = {
        verify: verify.value,
        images: [...verify.value.images, ...(images.status === "fulfilled" ? images.value.images : [])],
        imagesFailed: images.status === "rejected"
      };
    } finally {
      this.phase2Slots.release();
    }
    await this.deliver(attempt, result);
  }

  private async fail(attempt: Attempt, failure: FailureClass, cause?: unknown): Promise<void> {
    const topic = attempt.topic;
    if (failure === "stopped") return await this.stopped(attempt);
    const outcome = seamlessOutcome({
      failure,
      phase1Written: topic.phase1Written,
      phase2: "none",
      imagesRequested: topic.imagesRequested,
      imagesSaved: 0
    });
    this.log(
      t(
        "log.seamless_ended_0_1",
        topic.title,
        cause instanceof Error && failure === "other" ? `${failure}: ${cause.name}` : failure
      )
    );
    if (this.disposed) return;
    this.problemMap.set(topic.path, {
      path: topic.path,
      title: topic.title,
      reason: (outcome.reason ?? "other") as SeamlessProblemReason,
      ...(outcome.action ? { action: outcome.action } : {})
    });
    await this.setStatus(attempt, outcome.status === "restore" ? "error" : outcome.status);
    this.changed();
  }

  /** Phase-2 result arrived: fence, then hold (note open) or apply. */
  private async deliver(attempt: Attempt, result: Phase2Result): Promise<void> {
    const topic = attempt.topic;
    if (!(await this.fenceOk(attempt))) return await this.dropStale(attempt);
    if (this.deps.isShown(topic.path)) {
      this.held.set(topic.path, { attempt, result });
      attempt.handedOff = true;
      this.changed();
      return;
    }
    await this.apply(attempt, { attempt, result });
  }

  private async fenceOk(attempt: Attempt): Promise<boolean> {
    if (!this.isCurrent(attempt)) return false;
    try {
      const note = await this.deps.repo.readNote(attempt.topic.path);
      return note.title === attempt.topic.title && this.isCurrent(attempt);
    } catch {
      return false;
    }
  }

  private async dropStale(attempt: Attempt): Promise<void> {
    this.log(t("log.stale_result_not_written"));
    // Aborted, superseded or retitled: the note keeps what it has, and the topic is not marked as success.
    await this.stopped(attempt);
  }

  private async applyHeld(path: string, entry: Held): Promise<void> {
    const attempt = entry.attempt;
    if (this.held.get(path) !== entry) return;
    if (!(await this.fenceOk(attempt))) {
      this.held.delete(path);
      try {
        await this.dropStale(attempt);
      } finally {
        this.release(attempt);
      }
      return;
    }
    this.held.delete(path);
    try {
      await this.apply(attempt, entry);
    } finally {
      if (!this.held.has(path)) this.release(attempt);
    }
  }

  private async saveImages(attempt: Attempt, images: readonly Phase2Image[]) {
    const saved: { path: string; image: Phase2Image }[] = [];
    for (const image of eligibleImages(images).eligible) {
      if (!this.isCurrent(attempt)) break;
      try {
        const path = await this.deps.saveImage(image, attempt.topic.path, attempt.controller.signal);
        if (path) saved.push({ path, image });
      } catch (error) {
        this.log(t("log.seamless_image_skipped_0", error instanceof Error ? error.message : "download"));
      }
    }
    return saved;
  }

  /** Redo the fence, save images, then write inside the mutation queue: replace when the AI still owns the detail, else append. */
  private async apply(attempt: Attempt, entry: Held): Promise<void> {
    const topic = attempt.topic;
    const path = topic.path;
    entry.saved ??= await this.saveImages(attempt, entry.result.images);
    const saved = entry.saved;
    if (!this.isCurrent(attempt)) return await this.dropStale(attempt);
    const box: {
      problem?: SeamlessProblemReason;
      reheld?: boolean;
      stale?: boolean;
      failure?: unknown;
      written?: { before: SeamlessNote; after: SeamlessNote };
    } = {};
    await this.deps.mutate(async () => {
      if (!this.isCurrent(attempt)) {
        box.stale = true;
        return;
      }
      // The note may have been opened while images downloaded: hold again, keep the downloaded copies.
      if (this.deps.isShown(path)) {
        this.held.set(path, entry);
        attempt.handedOff = true;
        box.reheld = true;
        return;
      }
      const latest = await this.deps.repo.readNote(path);
      if (latest.title !== topic.title) {
        box.stale = true;
        return;
      }
      let composition: Phase2Composition;
      try {
        composition = composePhase2Detail(entry.result.verify, saved);
      } catch (error) {
        box.failure = error;
        return;
      }
      const plan = planPhase2Write({
        currentDetail: latest.detail,
        writtenHash: latest.researchWrittenHash,
        phase2Detail: composition.detail
      });
      const outcome = seamlessOutcome({
        phase1Written: topic.phase1Written,
        phase2: "applied",
        imagesRequested: topic.imagesRequested,
        imagesSaved: saved.length
      });
      if (outcome.reason === "no-images") box.problem = "no-images";
      await this.deps.repo.updateNote(path, {
        ...(plan.mode === "noop" ? {} : { detail: plan.detail }),
        researchWrittenHash: plan.mode === "append" ? "" : (plan.writtenHash ?? latest.researchWrittenHash ?? ""),
        status: outcome.status as SeamlessStatus
      });
      const after = await this.deps.repo.readNote(path);
      // What the note stores can differ in whitespace from what was planned: the hash follows what is stored.
      if (plan.mode === "replace" && detailHash(after.detail) !== plan.writtenHash)
        await this.deps.repo.updateNote(path, { researchWrittenHash: detailHash(after.detail) });
      box.written = { before: latest, after };
    });
    if (box.reheld) {
      this.changed();
      return;
    }
    if (box.stale) return await this.dropStale(attempt);
    if (box.failure !== undefined) return await this.fail(attempt, "other", box.failure);
    if (box.written) for (const listener of [...this.listeners]) listener({ type: "written", path, ...box.written });
    if (box.problem) {
      this.problemMap.set(path, { path, title: topic.title, reason: box.problem, action: "dismiss" });
      this.log(t("log.seamless_ended_0_1", topic.title, box.problem));
    }
    this.changed();
  }
}
