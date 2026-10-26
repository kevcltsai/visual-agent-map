import { randomUUID } from "node:crypto";
import type { AiExchangeLog, AiMilestones } from "../ai-exchange-log";
import { t } from "../i18n";
import type { AiRuntime, AiRuntimeCapabilities } from "./ai-runtime";
import type { RuntimeTaskControls } from "./runtime-step-provider";
import { StepRunner, stepLabel, type PreparedStep, type StepProvider } from "./step-runner";

/** The part of the exchange log a call writes. */
export type AiCallExchangeSink = Pick<
  AiExchangeLog,
  "begin" | "sent" | "received" | "parsed" | "completed" | "failed" | "milestones"
>;

export interface AiCallsOptions {
  /** The runtime that serves `model`. Called per call, after the call is registered. */
  runtimeFor(model: string): AiRuntime;
  /** The exchange log, or null when logging is off. Read per call and before every write. */
  exchanges(): AiCallExchangeSink | null;
  /** The shared registry of running calls; a Stop button aborts what it holds. A new Map when absent. */
  activeTasks?: Map<string, AbortController>;
}

export interface AiCallOptions {
  /** Model id as stored in settings. */
  model: string;
  effort: string;
  /** Exchange log title. */
  topic: string;
  /** Prefix of the registry key, `<taskName>:<uuid>`. */
  taskName: string;
  /** The caller's signal. AiCalls links its own controller to it and never aborts it. */
  signal: AbortSignal;
  /** Codex only: use the runtime without web search. */
  localCodex: boolean;
  mode?: string;
  /** What the exchange log stores as the sent request; "request" is the runtime's request object alone. */
  requestLog?: "request-and-prompt" | "request";
  /** The error thrown for a reply that arrives after a stop. */
  stopped?: () => Error;
  /** Runs once the runtime is chosen, before the call; throw to refuse the model. */
  validate?: (runtime: AiRuntime) => void;
  /** Runs when the reply arrives, before it is logged as received; throw to refuse it. */
  afterReply?: () => void;
  /** Use this id for the exchange log entry (a re-send names the attempt it replaces). */
  exchangeId?: string;
  /** Facts the caller knows about this call; the runtime's own measurements win. */
  extraMilestones?: () => AiMilestones;
  /** Controls forwarded to the runtime; `onMilestones` and `onRequest` are chained, not replaced. */
  task?: Omit<RuntimeTaskControls, "signal">;
}

/** What the finishing callback may use to end the call's exchange log entry. */
export interface AiCallExchange {
  /** The log entry id; undefined when logging was off at the start. */
  readonly id: string | undefined;
  /** Aborts on a Stop of this call, whoever pressed it. */
  readonly signal: AbortSignal;
  /** Writes `parsed`; ignored after {@link fail}. */
  parsed(): void;
  /** Ends the entry as failed with `message`; the later `completed` is not written. */
  fail(message: string): void;
}

export interface AiCallInput {
  stepId: string;
  version: number;
  prompt: string;
  schema?: unknown;
}

/**
 * Every model call of the plugin that goes through a Step: registers it in `activeTasks`, runs it on the right
 * runtime, writes the exchange log entry, and refuses a reply that arrives after a Stop.
 */
export class AiCalls {
  readonly activeTasks: Map<string, AbortController>;

  constructor(private readonly options: AiCallsOptions) {
    this.activeTasks = options.activeTasks ?? new Map<string, AbortController>();
  }

  /** Aborts every running call, including keys other code registered. Entries stay until their owner removes them. */
  stopAll(): void {
    for (const controller of this.activeTasks.values()) controller.abort();
  }

  /**
   * What the runtime serving `model` can do, without starting it. Throws when `needs` asks for something it cannot do.
   */
  capabilitiesFor(model: string, needs: { imageGeneration?: boolean } = {}): AiRuntimeCapabilities {
    const { capabilities } = this.options.runtimeFor(model);
    if (needs.imageGeneration && !capabilities.imageGeneration)
      throw new Error(t("ui.context_ai_image_generation_codex"));
    return capabilities;
  }

  /**
   * Sends a prepared step. A value that is not a `PreparedStep` throws before anything is registered or logged.
   * `finish` gets the raw reply and ends the entry (parse, `exchange.parsed()`); returning writes `completed`.
   */
  async run<Input, Output, Result>(
    prepared: PreparedStep<Input, Output>,
    options: AiCallOptions,
    finish: (raw: string, exchange: AiCallExchange) => Result | Promise<Result>
  ): Promise<Result> {
    let result: { value: Result } | undefined;
    const provider: StepProvider<null> = {
      complete: async call => {
        result = { value: await this.runCall(call, options, finish) };
        return "";
      }
    };
    await new StepRunner(provider).send(prepared, null);
    if (!result) throw new Error("AiCalls.run finished without a result");
    return result.value;
  }

  private async runCall<Result>(
    call: AiCallInput,
    options: AiCallOptions,
    finish: (raw: string, exchange: AiCallExchange) => Result | Promise<Result>
  ): Promise<Result> {
    if (options.task?.generateImage) this.capabilitiesFor(options.model, { imageGeneration: true });
    const {
      mode = "task",
      requestLog = "request-and-prompt",
      stopped = () => new Error(t("ui.ai_task_cancelled"))
    } = options;
    const key = `${options.taskName}:${randomUUID()}`;
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    options.signal.addEventListener("abort", abort, { once: true });
    if (options.signal.aborted) controller.abort();
    this.activeTasks.set(key, controller);
    // Log only when logging was on at the start, and re-check before every later write.
    const started = this.options.exchanges();
    const log = (): AiCallExchangeSink | null | undefined => (started ? this.options.exchanges() : undefined);
    const id = options.exchangeId ?? randomUUID();
    const milestones: AiMilestones = {};
    let milestonesWritten = false;
    const writeMilestones = (): void => {
      if (milestonesWritten) return;
      milestonesWritten = true;
      try {
        // The runtime's own measurements win over the caller's.
        Object.assign(milestones, { ...options.extraMilestones?.(), ...milestones });
      } catch {
        /* Diagnostics are best effort. */
      }
      if (Object.keys(milestones).length) log()?.milestones(id, milestones);
    };
    let finished = false;
    let parsedWritten = false;
    const exchange: AiCallExchange = {
      id: started ? id : undefined,
      signal: controller.signal,
      parsed: () => {
        if (finished || parsedWritten) return;
        parsedWritten = true;
        log()?.parsed(id);
      },
      fail: message => {
        if (finished) return;
        finished = true;
        log()?.failed(id, message);
      }
    };
    try {
      started?.begin({
        id,
        startedAt: new Date().toISOString(),
        topic: options.topic,
        mode,
        model: options.model,
        effort: options.effort,
        step: stepLabel({ id: call.stepId, version: call.version })
      });
      const runtime = this.options.runtimeFor(options.model);
      options.validate?.(runtime);
      const task = options.task ?? {};
      const controls: RuntimeTaskControls = {
        ...task,
        signal: controller.signal,
        onMilestones: (data: AiMilestones): void => {
          task.onMilestones?.(data);
          Object.assign(milestones, data);
        },
        onRequest: (data: unknown): void => {
          task.onRequest?.(data);
          log()?.sent(
            id,
            JSON.stringify(requestLog === "request" ? data : { request: data, prompt: call.prompt }, null, 2),
            call.prompt
          );
        }
      };
      const raw = await runtime.run({
        prompt: call.prompt,
        model: options.model,
        effort: options.effort,
        ...(call.schema === undefined ? {} : { schema: call.schema }),
        controls,
        localCodex: options.localCodex
      });
      if (controller.signal.aborted) throw stopped();
      options.afterReply?.();
      milestones.receivedAt = new Date().toISOString();
      log()?.received(id, raw);
      writeMilestones();
      const value = await finish(raw, exchange);
      if (!finished) {
        finished = true;
        log()?.completed(id);
      }
      return value;
    } catch (error) {
      writeMilestones();
      exchange.fail(error instanceof Error ? error.message : String(error));
      throw error;
    } finally {
      options.signal.removeEventListener("abort", abort);
      if (this.activeTasks.get(key) === controller) this.activeTasks.delete(key);
    }
  }
}
