import { packReferenceChunks, referenceBatches, referenceCatalog, resolveReferenceLinks } from "../ai/reference-materials";
import { buildPreparedTaskContext } from "../ai/context-builder";
import { effectiveReasoningLevel, normalizeReasoningLevel, researchGuidance, researchLimits } from "../ai/task-policy";
import type { AiResult, ReasoningLevel, TaskContext } from "../ai/types";
import { translate, t, type TranslationKey, type UiLanguage } from "../i18n";
import responseSchema from "../response-schema.json";
import { CLAUDE_MODEL_CHOICES, providerForModel, providerModelId } from "../ai/providers/provider";
import type { CodexAppServerRuntime } from "../ai/runtime/codex-app-server";
import type { ClaudeCodeCliRuntime } from "../ai/runtime/claude-code-cli";
import type { AiExchangeLog } from "../ai-exchange-log";
import { visualGuidance } from "../ai/visual-guidance";
import { randomUUID } from "node:crypto";

export function extractJsonObject(raw: string): string {
  const candidates: string[] = [];
  let start = -1, depth = 0, quoted = false, escaped = false;
  for (let index = 0; index < raw.length; index++) {
    const character = raw[index];
    if (start < 0) {
      if (character === "{") { start = index; depth = 1; quoted = false; escaped = false; }
      continue;
    }
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === "{") depth++;
    else if (character === "}" && --depth === 0) { candidates.push(raw.slice(start, index + 1)); start = -1; }
  }
  for (const candidate of candidates.reverse()) {
    try { JSON.parse(candidate); return candidate; }
    catch { /* Continue to an earlier balanced object. */ }
  }
  throw new SyntaxError("Codex 回應中找不到完整 JSON object");
}

export interface AiTaskServiceOptions {
  pluginDirectory: () => string;
  language: () => UiLanguage;
  defaultReasoning: () => ReasoningLevel;
  exchangeLoggingEnabled: () => boolean;
  exchanges: () => AiExchangeLog | null;
  codexRuntime: (directory: string, local: boolean) => CodexAppServerRuntime;
  claudeRuntime: (directory: string) => ClaudeCodeCliRuntime;
}

export class AiTaskService {
  constructor(private readonly options: AiTaskServiceOptions) {}

  async askModel(
    input: TaskContext,
    model: string,
    reasoning?: unknown,
    signal?: AbortSignal,
    onExchange?: (id: string) => void
  ): Promise<AiResult> {
    const provider = providerForModel(model);
    if (provider === "claude" && !CLAUDE_MODEL_CHOICES.some(choice => choice.id === model)) {
      throw new Error(t("ui.claude_model_is_not_supported_0", model));
    }

    let context = input;
    const referenceGroups = context.referenceGroups ?? [];
    if (referenceGroups.some(group => group.documents.length)) {
      const findings = await this.extractReferenceFindings(context, model, reasoning, signal);
      context = {
        ...context,
        sourceContext: [
          context.sourceContext,
          findings,
          `Source registry (retain these identities in citations):\n${referenceCatalog(referenceGroups)}`
        ].filter(Boolean).join("\n\n"),
        referenceGroups: undefined
      };
    }

    const totalStarted = Date.now();
    const prepared = buildPreparedTaskContext(context, model, 32_000, provider);
    if (prepared.context.sourceContext !== context.sourceContext) {
      throw new Error(t("ui.reference_too_large", t("ui.reference_materials")));
    }
    context = prepared.context;
    const pluginDirectory = this.options.pluginDirectory();
    const outputLanguage = context.outputLanguage ?? this.options.language();
    const instructions = [
      translate(outputLanguage, "prompt.output_language"),
      translate(outputLanguage, "prompt.role"),
      translate(outputLanguage, "prompt.source_safety"),
      context.sourceContext ? translate(outputLanguage, "prompt.reference_citations") : "",
      context.sourceContext && context.researchMode !== "local" ? translate(outputLanguage, "prompt.local_first") : "",
      translate(outputLanguage, "prompt.json"),
      translate(outputLanguage, context.mode === "task" ? "prompt.general_task" : context.mode === "decompose" ? "prompt.decompose" : context.mode === "synthesize" ? "prompt.synthesize" : "prompt.default_task"),
      context.mode !== "decompose"
        ? translate(outputLanguage, "prompt.detail_structure", ["detail.core_conclusions", "detail.key_knowledge", "detail.evidence_and_sources", "detail.tradeoffs_and_limitations", "detail.open_questions", "detail.update_log"].map(key => `### ${translate(outputLanguage, key as TranslationKey)}`).join(", "))
        : "",
      researchGuidance(context, outputLanguage),
      ...visualGuidance(context, outputLanguage),
      `${translate(outputLanguage, "prompt.label_topic")}:\n${context.title}`,
      `${translate(outputLanguage, "prompt.label_summary")}:\n${context.summary}`,
      context.mode !== "decompose" ? `${translate(outputLanguage, "prompt.label_detail")}:\n${context.detail || translate(outputLanguage, "prompt.none")}` : "",
      `${translate(outputLanguage, "prompt.label_rules")}:\n${context.rules || translate(outputLanguage, "prompt.none")}`,
      context.workingFindings ? `${translate(outputLanguage, "prompt.label_findings")}:\n${context.workingFindings}` : "",
      context.sourceContext ? `${translate(outputLanguage, "prompt.label_sources")}:\n${context.sourceContext}` : "",
      `${translate(outputLanguage, "prompt.label_ancestors")}:\n${context.ancestors || translate(outputLanguage, "prompt.none")}`,
      `${translate(outputLanguage, "prompt.label_task")}:\n${context.task}`
    ].join("\n\n");

    console.debug("Visual Agent Map AI metrics", prepared.metrics);
    const providerStarted = Date.now();
    const effort = effectiveReasoningLevel(context, normalizeReasoningLevel(reasoning ?? this.options.defaultReasoning()));
    const exchanges = this.options.exchangeLoggingEnabled() ? this.options.exchanges() : null;
    const exchangeId = exchanges ? randomUUID() : "";
    if (exchanges) {
      exchanges.begin({ id: exchangeId, startedAt: new Date().toISOString(), topic: context.title, mode: context.mode ?? "task", model, effort });
      onExchange?.(exchangeId);
    }

    let stage = "啟動 AI";
    try {
      const controls = {
        signal,
        searchBudget: context.researchMode === "local" ? 0 : researchLimits(context.researchDepth).searches,
        onRequest: (request: unknown): void => {
          stage = "等待 AI 回覆";
          if (this.options.exchangeLoggingEnabled()) exchanges?.sent(exchangeId, JSON.stringify(request, null, 2));
        }
      };
      const raw = provider === "claude"
        ? await this.options.claudeRuntime(pluginDirectory).runTask(instructions, providerModelId(model), effort, responseSchema, controls)
        : await this.options.codexRuntime(pluginDirectory, context.researchMode === "local").runTask(instructions, model, effort, responseSchema, controls);
      stage = "解析 AI 回覆";
      if (this.options.exchangeLoggingEnabled()) exchanges?.received(exchangeId, raw);
      const result = this.parseAiResult(raw, provider === "claude" ? "Claude Code" : "Codex App Server", outputLanguage);
      if (referenceGroups.length) {
        result.summary = resolveReferenceLinks(result.summary, referenceGroups);
        result.detail = resolveReferenceLinks(result.detail, referenceGroups);
      }
      if (this.options.exchangeLoggingEnabled()) exchanges?.parsed(exchangeId);
      console.debug("Visual Agent Map AI metrics", { ...prepared.metrics, providerMs: Date.now() - providerStarted, totalMs: Date.now() - totalStarted });
      return result;
    } catch (error) {
      if (this.options.exchangeLoggingEnabled()) exchanges?.failed(exchangeId, `${stage}：${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }

  private async extractReferenceFindings(context: TaskContext, model: string, reasoning: unknown, signal?: AbortSignal): Promise<string> {
    let working = referenceBatches(context.referenceGroups ?? []);
    let round = 0;
    while (true) {
      round++;
      const batches = round === 1 ? working : packReferenceChunks(working);
      const findings: string[] = [];
      for (let index = 0; index < batches.length; index++) {
        if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
        context.onProgress?.(t("ui.reference_processing_progress", index + 1, batches.length));
        const result = await this.askModel({
          title: context.title,
          summary: "",
          rules: "",
          detail: "",
          task: round === 1 ? translate(this.options.language(), "prompt.reference_extract") : translate(this.options.language(), "prompt.reference_reduce"),
          ancestors: "",
          sourceContext: batches[index],
          mode: "task",
          researchMode: "local",
          researchDepth: "fast",
          visualMode: "off"
        }, model, reasoning, signal);
        if (!result.detail.trim()) throw new Error(t("ui.reference_processing_empty_result"));
        findings.push(result.detail.trim());
      }
      const joined = findings.map(value => `Evidence:\n${value}`).join("\n\n");
      if (joined.length <= 18_000) { context.onProgress?.(""); return joined; }
      if (joined.length >= working.reduce((sum, value) => sum + value.length, 0)) {
        throw new Error(t("ui.reference_processing_could_not_reduce"));
      }
      working = findings;
    }
  }

  private parseAiResult(raw: string, label: string, language: UiLanguage): AiResult {
    const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
    const parsed: { summary?: unknown; detail?: unknown; suggestions?: unknown; visualReferences?: unknown } =
      JSON.parse(extractJsonObject(cleaned)) as { summary?: unknown; detail?: unknown; suggestions?: unknown; visualReferences?: unknown };
    if (typeof parsed.summary !== "string" || typeof parsed.detail !== "string") throw new Error(`${label} 沒有回傳 summary 與 detail`);
    const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
    const suggestions = Array.isArray(parsed.suggestions)
      ? parsed.suggestions
        .filter((item): item is Record<string, unknown> => isRecord(item) && typeof item.title === "string" && typeof item.task === "string")
        .map(item => ({
          title: String(item.title).trim(),
          task: String(item.task).trim(),
          contribution: typeof item.contribution === "string" ? item.contribution.trim() : "",
          parentTitle: typeof item.parentTitle === "string" ? item.parentTitle.trim() : ""
        }))
        .filter(item => item.title)
      : [];
    const visualReferences = Array.isArray(parsed.visualReferences)
      ? parsed.visualReferences
        .filter((item): item is Record<string, unknown> => isRecord(item) && typeof item.imageUrl === "string" && typeof item.sourceUrl === "string")
        .map(item => ({
          title: typeof item.title === "string" ? item.title.trim() : language === "en" ? "Visual reference" : "視覺參考",
          imageUrl: String(item.imageUrl).trim(),
          sourceUrl: String(item.sourceUrl).trim(),
          description: typeof item.description === "string" ? item.description.trim() : "",
          palette: Array.isArray(item.palette) ? item.palette.map(String).map(color => color.trim()).filter(Boolean).slice(0, 8) : [],
          formula: typeof item.formula === "string" ? item.formula.trim() : ""
        }))
        .filter(item => /^https?:\/\//i.test(item.imageUrl) && /^https?:\/\//i.test(item.sourceUrl))
        .slice(0, 6)
      : [];
    return {
      summary: Array.from(parsed.summary.trim()).slice(0, 80).join(""),
      detail: parsed.detail.trim(),
      suggestions,
      visualReferences
    };
  }
}
