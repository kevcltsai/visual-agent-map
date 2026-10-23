import type { AiTaskServiceOptions } from "../../core/ai-task-service";
import { providerStepRunner, type ProviderStepRunner } from "../../core/provider-step-runner";
import { prepareStep, type StepDefinition } from "../../core/step-runner";
import {
  parseShareTranslation,
  SHARE_TRANSLATE_SCHEMA,
  shareTranslateLabelsStep,
  shareTranslateStep,
  ShareTranslateParseError,
  type ShareTranslateItem,
  type ShareTranslateOutput,
  type ShareTranslateRequest
} from "../../core/steps/share-translate/step";
import type { ReasoningLevel } from "../../ai/types";
import { countLocalReferences, scrubMermaidSvg } from "./share-dom";
import { leakCategoriesInTranslation } from "./share-build";
import type {
  ShareDiagramTranslation,
  ShareMapTranslation,
  ShareNodeTranslation,
  ShareOriginalLanguage,
  ShareTranslationLanguage
} from "./share-format";
import type { ForbiddenString, LeakCategory } from "./share-leak-scan";
import {
  estimateMinutes,
  isIncomplete,
  planBatches,
  segmentHash,
  ShareTranslationCache,
  TRANSLATE_BATCH_CHARS,
  TRANSLATE_CONCURRENCY,
  TRANSLATE_FIELD_BATCH_CHARS,
  TRANSLATE_LABEL_BATCH_CHARS,
  TRANSLATE_RETRIES,
  type TranslateItem
} from "./share-translate-plan";
import { prepareMermaidTranslation, type MermaidPrepared } from "./share-translate-mermaid";
import { placeholdersMatch, PLACEHOLDER_OPEN, type SegmentExtraction } from "./share-translate-segments";
import {
  canonicalChildren,
  detailCheckOf,
  diagramEntryFor,
  normalizeSvgId,
  prepareDetail,
  reconstructTranslatedDetail,
  type CompactDetailEntry
} from "./share-translate-compact";

export { parseShareTranslation, SHARE_TRANSLATE_SCHEMA, ShareTranslateParseError };
export type { ShareTranslateItem, ShareTranslateOutput, ShareTranslateRequest };

/** `stopped`: the user cancelled (or closed the dialog); `failed`: nothing could be translated at all. */
export class ShareTranslateError extends Error {
  constructor(
    readonly code: "stopped" | "failed",
    message: string
  ) {
    super(message);
    this.name = "ShareTranslateError";
  }
}

export type ShareTranslateRunner = ProviderStepRunner<ShareTranslateRequest, ShareTranslateOutput>;

export function buildShareTranslatePrompt(request: ShareTranslateRequest): string {
  return shareTranslateStep.render(request);
}
export function buildShareTranslateLabelsPrompt(request: ShareTranslateRequest): string {
  return shareTranslateLabelsStep.render(request);
}
export function providerShareTranslateRunner(
  options: AiTaskServiceOptions,
  activeTasks: Map<string, AbortController>
): ShareTranslateRunner {
  return providerStepRunner<ShareTranslateRequest, ShareTranslateOutput>(options, activeTasks, {
    name: "share-translate",
    topic: request => `Share translation · ${request.targetLanguage}`,
    stopped: () => new ShareTranslateError("stopped", "Share translation stopped")
  });
}

/** A diagram's source: `svgIndex` is the diagram's place among the note's top-level `<svg>` elements, in document order. */
export interface ShareTranslateDiagram {
  svgIndex: number;
  source: string;
}
export interface ShareTranslateNodeInput {
  id: string;
  title: string;
  summary: string;
  reason?: string;
  /** The cleaned `detailHtml` exactly as the original payload carries it. */
  detailHtml?: string;
  diagrams?: ShareTranslateDiagram[];
  /** Drawn diagrams with no captured source: they keep their original drawing and count as kept (D-2026-10-116 DP8). */
  diagramsUnsourced?: number;
}
export interface ShareTranslateSource {
  /** Keys the session cache. */
  mapId: string;
  title: string;
  goal?: string;
  sourceLanguage: ShareOriginalLanguage;
  nodes: ShareTranslateNodeInput[];
}
/** The DOM the service needs, supplied by the Obsidian side (and by a small stand-in in tests). */
export interface ShareTranslateDom {
  /** A detached container holding the parsed fragment. */
  parse(html: string): Element;
  /** The container's inner HTML. */
  serialize(root: Element): string;
  /** Replaces the container's children with their sanitized form (Obsidian: `sanitizeHTMLToDom`). */
  sanitize(root: Element): void;
  createSpan(): Element;
  /** An empty block element; it holds a diagram's place while the rest of the note is cleaned. */
  createDiv(): Element;
}
export interface ShareTranslateProgress {
  language: ShareTranslationLanguage;
  /** 1-based position of the language and how many languages there are. */
  languageIndex: number;
  languageCount: number;
  batchDone: number;
  batchTotal: number;
  phase: "translate" | "assemble";
}
export interface ShareTranslateOptions {
  dom: ShareTranslateDom;
  signal: AbortSignal;
  cache: ShareTranslationCache;
  model: string;
  reasoning: ReasoningLevel;
  /** From `forbiddenStringsFor`: every translated language is scanned against it. */
  forbidden: readonly ForbiddenString[];
  /**
   * Draws a diagram source and returns the SVG (null when it did not draw). Without it diagrams are not translated
   * and keep their original drawing.
   */
  renderMermaid?: (source: string) => Promise<Element | null>;
  onProgress?: (progress: ShareTranslateProgress) => void;
}
export type ShareLanguageStatus = "complete" | "incomplete" | "failed" | "blocked";
export interface ShareLanguageResult {
  language: ShareTranslationLanguage;
  model: string;
  status: ShareLanguageStatus;
  /** Distinct body and field texts, and how many of them stayed in the original language. */
  totalSegments: number;
  failedSegments: number;
  /** Diagrams that keep their original labels. */
  diagramsKept: number;
  /** Notes whose rebuilt text did not survive the sanitizer unchanged and so show the original text (D-2026-10-122). */
  fallbackNodes: number;
  /** Set for `blocked`: categories only, never the matched text. */
  leakCategories: LeakCategory[];
  /** The first error message a call raised, when anything failed; for a log, not for the file. */
  firstError?: string;
  /** Absent for `blocked` (nothing of a blocked translation may travel on). */
  top?: ShareMapTranslation;
  nodes?: Record<string, ShareNodeTranslation>;
  calls: number;
  cacheHits: number;
}
export interface ShareTranslateResult {
  languages: ShareLanguageResult[];
  calls: number;
  cacheHits: number;
}
export interface ShareTranslateEstimate {
  /** AI calls needed now, cache taken into account. */
  calls: number;
  minutes: number;
  perLanguage: Array<{ language: ShareTranslationLanguage; calls: number }>;
}

interface PreparedNode {
  input: ShareTranslateNodeInput;
  root: Element | null;
  extraction: SegmentExtraction | null;
  svgs: Element[];
  plans: Array<MermaidPrepared | null>;
}
interface Prepared {
  nodes: PreparedNode[];
  bodyTexts: string[];
  fieldTexts: string[];
  labelTexts: string[];
}
interface Group {
  kind: "body" | "field" | "label";
  step: StepDefinition<ShareTranslateRequest, ShareTranslateOutput>;
  texts: string[];
  validate: (source: string, translated: string) => boolean;
  results: Map<string, string>;
  failed: Set<string>;
  batches: TranslateItem[][];
}

const unique = (texts: Iterable<string>): string[] => [...new Set(texts)];

function prepareSource(
  source: ShareTranslateSource,
  options: Pick<ShareTranslateOptions, "dom" | "renderMermaid">
): Prepared {
  const fieldTexts: string[] = [source.title, ...(source.goal ? [source.goal] : [])];
  const body: string[] = [];
  const labels: string[] = [];
  const nodes: PreparedNode[] = source.nodes.map(input => {
    for (const text of [input.title, input.summary, input.reason]) if (text?.trim()) fieldTexts.push(text);
    const prepared: PreparedNode = { input, root: null, extraction: null, svgs: [], plans: [] };
    if (!input.detailHtml?.trim()) return prepared;
    const root = options.dom.parse(input.detailHtml);
    prepared.root = root;
    // Diagrams leave the tree while its text is cut (the sanitizer would strip their labels) and are never changed here.
    const detail = prepareDetail(root, () => options.dom.createDiv());
    prepared.svgs = detail.svgs;
    prepared.extraction = detail.extraction;
    for (const unit of prepared.extraction.units) body.push(unit.text);
    if (options.renderMermaid)
      for (const diagram of input.diagrams ?? []) {
        if (diagram.svgIndex < 0 || diagram.svgIndex >= prepared.svgs.length) continue;
        const plan = prepareMermaidTranslation(diagram.source);
        prepared.plans[diagram.svgIndex] = plan;
        if (plan.ok) labels.push(...plan.labels);
      }
    return prepared;
  });
  return {
    nodes,
    bodyTexts: unique(body),
    fieldTexts: unique(fieldTexts.filter(text => text.trim())),
    labelTexts: unique(labels)
  };
}

/** Texts of a prepared source by kind; used by the estimate and the run alike. */
function groupsFor(
  prepared: Prepared,
  language: ShareTranslationLanguage,
  mapId: string,
  model: string,
  cache: ShareTranslationCache
): { groups: Group[]; hits: number } {
  let hits = 0;
  const make = (
    kind: Group["kind"],
    step: Group["step"],
    texts: string[],
    validate: Group["validate"],
    limit: number
  ): Group => {
    const group: Group = { kind, step, texts, validate, results: new Map(), failed: new Set(), batches: [] };
    const pending: TranslateItem[] = [];
    for (const text of texts) {
      const cached = cache.get(mapId, language, model, segmentHash(text));
      if (cached !== undefined) {
        group.results.set(text, cached);
        hits++;
      } else pending.push({ id: String(pending.length + 1), text });
    }
    group.batches = planBatches(pending, limit);
    return group;
  };
  const plainField = (source: string, translated: string): boolean =>
    !!translated.trim() && !translated.includes(PLACEHOLDER_OPEN) && source.trim().length > 0;
  const label = (_source: string, translated: string): boolean => !!translated.trim() && !/[\r\n]/.test(translated);
  const groups = [
    make("body", shareTranslateStep, prepared.bodyTexts, placeholdersMatch, TRANSLATE_BATCH_CHARS),
    make("field", shareTranslateStep, prepared.fieldTexts, plainField, TRANSLATE_FIELD_BATCH_CHARS),
    make("label", shareTranslateLabelsStep, prepared.labelTexts, label, TRANSLATE_LABEL_BATCH_CHARS)
  ];
  return { groups, hits };
}

async function runPool(tasks: ReadonlyArray<() => Promise<void>>, limit: number, signal: AbortSignal): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < tasks.length && !signal.aborted) await tasks[next++]();
  };
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
}

const flatten = (text: string): string => text.replace(/\s*[\r\n]+\s*/g, " ").trim();

/**
 * Translates a map's share text into other languages (D-2026-10-116). One run goes language by language; inside a
 * language the batches (body text, short fields, diagram labels) go out at most {@link TRANSLATE_CONCURRENCY} at a time.
 *
 * - Cancelling (the signal) stops new calls at once and throws `ShareTranslateError("stopped")`; what finished is
 *   already in the cache, so running again only translates the rest.
 * - A batch that fails is sent once more (only its unfinished items); items still unfinished keep the original text.
 * - A language is stored compactly (D-2026-10-122): the translated text units and diagram patches, not the whole note.
 *   Each note is rebuilt from the cleaned HTML with the viewer's own function; the sanitizer must leave the rebuilt
 *   text unchanged (else the note shows its original text), the rebuilt note is checked for local links, and it is
 *   scanned against the forbidden strings together with the stored fields; a hit blocks the whole language.
 */
export class ShareTranslateService {
  constructor(private readonly run: ShareTranslateRunner) {}

  /** Calls and minutes the given languages need right now (cache taken into account). Translates nothing. */
  estimate(
    source: ShareTranslateSource,
    languages: readonly ShareTranslationLanguage[],
    options: Pick<ShareTranslateOptions, "dom" | "cache" | "model" | "renderMermaid">
  ): ShareTranslateEstimate {
    const prepared = prepareSource(source, options);
    const perLanguage = languages.map(language => {
      const { groups } = groupsFor(prepared, language, source.mapId, options.model, options.cache);
      return { language, calls: groups.reduce((sum, group) => sum + group.batches.length, 0) };
    });
    const calls = perLanguage.reduce((sum, item) => sum + item.calls, 0);
    return { calls, minutes: estimateMinutes(calls), perLanguage };
  }

  async translate(
    source: ShareTranslateSource,
    languages: readonly ShareTranslationLanguage[],
    options: ShareTranslateOptions
  ): Promise<ShareTranslateResult> {
    const stopped = (): ShareTranslateError => new ShareTranslateError("stopped", "Share translation stopped");
    const results: ShareLanguageResult[] = [];
    let calls = 0;
    let cacheHits = 0;
    for (const [position, language] of languages.entries()) {
      if (options.signal.aborted) throw stopped();
      const result = await this.translateLanguage(source, language, position + 1, languages.length, options);
      results.push(result);
      calls += result.calls;
      cacheHits += result.cacheHits;
    }
    return { languages: results, calls, cacheHits };
  }

  private async translateLanguage(
    source: ShareTranslateSource,
    language: ShareTranslationLanguage,
    languageIndex: number,
    languageCount: number,
    options: ShareTranslateOptions
  ): Promise<ShareLanguageResult> {
    const { signal, cache, model } = options;
    const stopped = (): ShareTranslateError => new ShareTranslateError("stopped", "Share translation stopped");
    const prepared = prepareSource(source, options);
    const { groups, hits } = groupsFor(prepared, language, source.mapId, model, cache);
    let languageCalls = 0;
    let firstError: string | undefined;
    const batchTotal = groups.reduce((sum, group) => sum + group.batches.length, 0);
    let batchDone = 0;
    const progress = (phase: ShareTranslateProgress["phase"]): void =>
      options.onProgress?.({ language, languageIndex, languageCount, batchDone, batchTotal, phase });
    progress("translate");

    const send = async (group: Group, items: TranslateItem[]): Promise<ShareTranslateOutput> => {
      const request: ShareTranslateRequest = {
        items: items.map(item => ({ id: item.id, text: item.text })),
        sourceLanguage: source.sourceLanguage,
        targetLanguage: language,
        model,
        reasoning: options.reasoning
      };
      const preparedStep = prepareStep(group.step, request);
      languageCalls++;
      const raw = await this.run(request, signal, preparedStep);
      return preparedStep.parse(raw);
    };
    const batchTask =
      (group: Group, batch: TranslateItem[]): (() => Promise<void>) =>
      async () => {
        let remaining = batch;
        for (let attempt = 0; attempt <= TRANSLATE_RETRIES && remaining.length; attempt++) {
          if (signal.aborted) throw stopped();
          try {
            const output = await send(group, remaining);
            const byId = new Map(output.segments.map(item => [item.id, item.text]));
            remaining = remaining.filter(item => {
              const translated = byId.get(item.id);
              if (translated === undefined || !group.validate(item.text, translated)) return true;
              const value = group.kind === "field" ? translated.trim() : translated;
              group.results.set(item.text, value);
              cache.set(source.mapId, language, model, segmentHash(item.text), value);
              return false;
            });
          } catch (error) {
            if (signal.aborted || (error instanceof ShareTranslateError && error.code === "stopped")) throw stopped();
            firstError ??= (error as { message?: string } | null)?.message ?? String(error);
          }
        }
        for (const item of remaining) group.failed.add(item.text);
        batchDone++;
        progress("translate");
      };
    const tasks = groups.flatMap(group => group.batches.map(batch => batchTask(group, batch)));
    await runPool(tasks, TRANSLATE_CONCURRENCY, signal);
    if (signal.aborted) throw stopped();

    progress("assemble");
    const body = groups[0];
    const fields = groups[1];
    const labels = groups[2];
    const field = (text: string | undefined, flat: boolean): string | undefined => {
      if (text === undefined || !text.trim()) return text;
      const translated = fields.results.get(text);
      return translated === undefined ? text : flat ? flatten(translated) : translated;
    };

    let localRefs = 0;
    let fallbackNodes = 0;
    // Diagrams that could not be redrawn at all (no source) keep their original labels too.
    let diagramsKept = prepared.nodes.reduce(
      (sum, node) => sum + (node.root ? (node.input.diagramsUnsourced ?? 0) : 0),
      0
    );
    const nodes: Record<string, ShareNodeTranslation> = {};
    // What a viewer will show for each note once it has rebuilt it; this, not the work above, is what the gates scan.
    const rebuilt: Record<string, string> = {};
    const { dom } = options;
    const serializeSvg = (svg: Element): string => {
      const holder = dom.createDiv();
      holder.appendChild(svg.cloneNode(true));
      return dom.serialize(holder);
    };
    // The sanitizer must leave the rebuilt text exactly as it is (compared without attribute order); otherwise the
    // note keeps its original text. Diagrams are still empty slots here: the sanitizer would strip their labels.
    const untouchedBySanitizer = (root: Element): boolean => {
      const reference = dom.parse(dom.serialize(root));
      const copy = dom.parse(dom.serialize(root));
      dom.sanitize(copy);
      return canonicalChildren(copy) === canonicalChildren(reference);
    };
    for (const node of prepared.nodes) {
      const { input } = node;
      const entry: ShareNodeTranslation = {
        title: field(input.title, true) ?? input.title,
        summary: field(input.summary, false) ?? input.summary
      };
      const reason = field(input.reason, false);
      if (reason !== undefined) entry.reason = reason;
      if (node.root && node.extraction && input.detailHtml) {
        const segments = node.extraction.units.map(unit => {
          const translated = body.results.get(unit.text);
          return translated !== undefined && translated !== unit.text && placeholdersMatch(unit.text, translated)
            ? translated
            : null;
        });
        const compact: CompactDetailEntry = {};
        if (segments.some(text => text !== null)) {
          compact.detailSegments = segments;
          compact.detailCheck = detailCheckOf(node.extraction);
        }
        const diagrams: ShareDiagramTranslation[] = [];
        for (const [index, original] of node.svgs.entries()) {
          if (signal.aborted) throw stopped();
          let stored: ShareDiagramTranslation = null;
          const plan = node.plans[index];
          let replaced = false;
          if (plan?.ok && options.renderMermaid) {
            const rebuiltSource = plan.rebuild(plan.labels.map(text => labels.results.get(text)));
            if (rebuiltSource.applied > 0) {
              try {
                const drawn = await options.renderMermaid(rebuiltSource.source);
                if (drawn && scrubMermaidSvg(drawn)) {
                  normalizeSvgId(drawn, original.getAttribute("id"));
                  stored = diagramEntryFor(original, drawn, serializeSvg);
                  replaced = true;
                }
              } catch {
                replaced = false;
                stored = null;
              }
            }
          }
          if (!replaced && plan !== undefined) diagramsKept++;
          diagrams.push(stored);
        }
        if (diagrams.some(item => item !== null)) compact.detailDiagrams = diagrams;
        // The note as a viewer rebuilds it, with the same function; a sanitizer change sends the text back to the original.
        const parse = (html: string): Element => dom.parse(html);
        let root = dom.parse(input.detailHtml);
        const first = reconstructTranslatedDetail(root, compact, {
          parse,
          createSlot: () => dom.createDiv(),
          afterText: untouchedBySanitizer
        });
        if (first.fallback && compact.detailSegments) {
          fallbackNodes++;
          delete compact.detailSegments;
          delete compact.detailCheck;
          root = dom.parse(input.detailHtml);
          reconstructTranslatedDetail(root, compact, { parse, createSlot: () => dom.createDiv() });
        }
        // The privacy decision on links, taken on the tree that is displayed (D-2026-10-110, D-2026-10-122).
        localRefs += countLocalReferences(root);
        rebuilt[input.id] = dom.serialize(root);
        Object.assign(entry, compact);
      }
      nodes[input.id] = entry;
    }
    const top: ShareMapTranslation = { title: field(source.title, true) ?? source.title };
    const goal = field(source.goal, false);
    if (goal !== undefined) top.goal = goal;

    const totalSegments = body.texts.length + fields.texts.length;
    const failedSegments = body.failed.size + fields.failed.size;
    const base = {
      language,
      model,
      totalSegments,
      failedSegments,
      diagramsKept,
      fallbackNodes,
      calls: languageCalls,
      cacheHits: hits,
      ...(firstError ? { firstError } : {})
    };
    const leakCategories: LeakCategory[] = leakCategoriesInTranslation(
      language,
      { top, nodes },
      options.forbidden,
      rebuilt
    );
    if (localRefs > 0 && !leakCategories.includes("wikilink")) leakCategories.push("wikilink");
    if (leakCategories.length) return { ...base, status: "blocked", leakCategories };
    const status: ShareLanguageStatus =
      totalSegments > 0 && failedSegments === totalSegments
        ? "failed"
        : isIncomplete(failedSegments, totalSegments) || fallbackNodes > 0
          ? "incomplete"
          : "complete";
    return { ...base, status, leakCategories: [], top, nodes };
  }
}
