import type { AiCalls } from "../../core/ai-calls";
import { allowedUrl, openedUrlsFromEvents, searchQueriesFromEvents } from "../../core/argument-map/source-proof";
import { stepEffort } from "../../core/provider-step-runner";
import { prepareStep, renderTemplate, type StepDefinition } from "../../core/step-runner";
import type { ModelChoice } from "../../ai/model-resolution";
import {
  applyLivingChanges,
  livingAppendSuppressed,
  livingSupersedeMismatch,
  type LivingChangeContext,
  type LivingEvidence,
  type LivingKnowledge
} from "./living-node-changes";
import { livingSnapshotRevision } from "./living-node-markdown";
import { buildLivingPrompt, LIVING_PROMPT_BUDGET } from "./living-node-retrieval";
import { livingNodeRepairTemplate } from "./steps/fragments";

export interface LivingProviderInput extends ModelChoice {
  prompt: string;
  language: string;
  base: LivingKnowledge;
  context: string;
  evidence: readonly LivingEvidence[];
  mapPath: string;
}

const MAX_PROMPT_CHARS = LIVING_PROMPT_BUDGET;

const projectionFor = (input: LivingProviderInput) => buildLivingPrompt(input);

/** Evidence rejections the model can fix by citing an allowed id. Everything else (an unknown record, bad JSON, a web
 * policy refusal, a stop) stays final and is never re-sent. */
const REPAIRABLE = new Set(["unauthorized-evidence", "missing-evidence", "missing-new-evidence"]);

/** What a repair re-send tells the model: the rejection code, the 1-based operation and the ids it may cite. Never the
 * rejected reply or any source text. */
interface LivingRepair {
  code: string;
  operation?: number;
  allowed: readonly string[];
}

type LivingStepInput = LivingProviderInput & { repair?: LivingRepair };

const repairNote = (repair: LivingRepair): string =>
  "\n\n" +
  renderTemplate(livingNodeRepairTemplate, {
    code: repair.code,
    operation: repair.operation ? " at operation " + repair.operation : "",
    allowed: JSON.stringify(repair.allowed)
  });

const step: StepDefinition<LivingStepInput, unknown> = {
  id: "living-node-change-set",
  version: 8,
  render: input => projectionFor(input).prompt + (input.repair ? repairNote(input.repair) : ""),
  policy: text => {
    if (text.length > MAX_PROMPT_CHARS) throw new Error("living-node-context-too-large");
  },
  parse: raw => JSON.parse(raw.trim()) as unknown
};

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid-proposal");
  return value as Record<string, unknown>;
}

/** Explicit current-data wording is a conservative requirement floor; broader task semantics
 * still require the model's declared decision and semantic acceptance fixtures. */
export type LivingWebPolicy = "forbidden" | "optional" | "required";

export function livingWebPolicy(prompt: string): LivingWebPolicy {
  // Date words alone do not require the web: a task can analyze today's local notes.
  const explicitSearch =
    /(?:上網|上网|網路搜尋|网络搜索|搜尋網路|搜索网络|\bsearch the web\b|\bweb research\b|\bbrowse the web\b)/i.test(
      prompt
    );
  const currentPublicData =
    /(?:即時|即时|最新|今天|今日|現在|现在|當前|当前|today|latest|live|current)[\s\S]{0,16}(?:股價|股价|行情|新聞|新闻|市場價格|市场价格|stock price|market data|market quote|news headlines)/i.test(
      prompt
    );
  const offline =
    /(?:不要上網|不要上网|禁止上網|禁止上网|只(?:用|讀|读)本地|only (?:use|read) local|do not (?:browse|search the web)|no web search)/i.test(
      prompt
    );
  return offline ? "forbidden" : explicitSearch || currentPublicData ? "required" : "optional";
}

export function explicitlyRequiresLivingWeb(prompt: string): boolean {
  return livingWebPolicy(prompt) === "required";
}

const MAX_EXCERPT = 300;

/** Documented normalization for an excerpt: Unicode NFC, then whitespace collapsed. */
const normalizeExcerpt = (value: string): string => value.normalize("NFC").trim().replace(/\s+/g, " ");

/** Web URLs only become authorized evidence if the runtime reports opening them during this call.
 *
 * Trust: the provider stream reports only the URL (or query) of a page it opened, never the fetched text (the Claude
 * WebFetch result is a model summary and its tool_result body is not forwarded). So a web excerpt is the model's own
 * summary: its version stays unknown and it is NOT verified page text, and web evidence alone
 * can never correct or invalidate a claim (enforced in applyLivingChanges). */
export function normalizeLivingProposal(
  raw: unknown,
  opened: readonly string[],
  local: readonly LivingEvidence[],
  at: string,
  requiresWeb = false,
  forbidWeb = false,
  searched = false
) {
  const envelope = object(raw);
  if (
    Object.keys(envelope).some(
      key => !["baseRevision", "operations", "requiresWeb", "checkedWeb", "webExcerpts"].includes(key)
    )
  )
    throw new Error("invalid-proposal-field");
  if (typeof envelope.requiresWeb !== "boolean") throw new Error("missing-search-decision");
  if (forbidWeb && (envelope.requiresWeb || opened.length)) throw new Error("forbidden-web-search");
  const openedUrls = new Set<string>();
  for (const url of opened) {
    const parsed = allowedUrl(url);
    if (!parsed) continue;
    parsed.hash = "";
    openedUrls.add(parsed.toString());
  }
  // A scoped no-match (an output-only proposal) is honest when the run really searched, even if no page was opened.
  const noMatch =
    searched &&
    Array.isArray(envelope.operations) &&
    envelope.operations.length > 0 &&
    (envelope.operations as unknown[]).every(
      value => !!value && typeof value === "object" && (value as { kind?: unknown }).kind === "output"
    );
  if ((requiresWeb || envelope.requiresWeb) && !openedUrls.size && !noMatch)
    throw new Error("required-web-unavailable");
  // Evidence exists per opened URL only once the model supplied an excerpt for it. The excerpt is validated model text
  // and never part of the id (id = hash(URL), as before), so a re-check with different wording adds no duplicate.
  const byUrl = new Map<string, LivingEvidence>();
  const rawExcerpts = envelope.webExcerpts === undefined ? [] : envelope.webExcerpts;
  if (!Array.isArray(rawExcerpts) || rawExcerpts.length > 100) throw new Error("invalid-web-excerpt");
  for (const value of rawExcerpts as unknown[]) {
    const entry = object(value);
    if (Object.keys(entry).some(key => key !== "url" && key !== "excerpt")) throw new Error("invalid-web-excerpt");
    const parsed = typeof entry.url === "string" ? allowedUrl(entry.url) : undefined;
    if (!parsed || typeof entry.excerpt !== "string") throw new Error("invalid-web-excerpt");
    parsed.hash = "";
    const source = parsed.toString();
    // Excerpts are validation-only and never persisted, so an over-long one is cut instead of failing the round.
    const excerpt = normalizeExcerpt(entry.excerpt).slice(0, MAX_EXCERPT).trim();
    if (!excerpt) throw new Error("invalid-web-excerpt");
    if (!openedUrls.has(source)) throw new Error("unauthorized-web-excerpt");
    byUrl.set(source, {
      id: "web:" + livingSnapshotRevision(source),
      source,
      retrievedAt: at
    });
  }
  if (requiresWeb && !envelope.requiresWeb) throw new Error("required-web-decision-conflict");
  if (!Array.isArray(envelope.operations)) throw new Error("invalid-operations");
  const operations = (envelope.operations as unknown[]).map(
    (value): Record<string, unknown> & { evidence: string[] } => {
      const operation = object(value);
      if (!Array.isArray(operation.evidence)) throw new Error("invalid-evidence");
      const evidence = (operation.evidence as unknown[]).map(item => {
        if (typeof item !== "string") throw new Error("invalid-evidence");
        const url = allowedUrl(item);
        if (!url) return item;
        url.hash = "";
        const source = url.toString();
        if (!openedUrls.has(source)) throw new Error("unauthorized-evidence");
        const known = byUrl.get(source);
        if (!known) throw new Error("web-excerpt-missing");
        return known.id;
      });
      return { ...operation, evidence };
    }
  );
  // A changed answer requiring current web information must cite at least
  // one actually opened source. A genuine no-change check can have no operations.
  const checkedUrls: string[] = [];
  if (envelope.requiresWeb) {
    if (
      !Array.isArray(envelope.checkedWeb) ||
      (!envelope.checkedWeb.length && !(noMatch && !openedUrls.size)) ||
      envelope.checkedWeb.length > 100
    )
      throw new Error("required-web-check-missing");
    const checked = new Set<string>();
    for (const value of envelope.checkedWeb as unknown[]) {
      if (typeof value !== "string") throw new Error("invalid-web-check");
      const url = allowedUrl(value);
      if (!url) throw new Error("invalid-web-check");
      url.hash = "";
      const source = url.toString();
      if (!openedUrls.has(source)) throw new Error("unauthorized-web-check");
      checkedUrls.push(source);
      const entry = byUrl.get(source);
      if (entry) checked.add(entry.id);
    }
    if (noMatch && !checked.size) {
      // No page was cited: the observed search itself is the basis (the caller verified a query was seen).
    } else if (operations.length && !operations.some(operation => operation.evidence.some(id => checked.has(id))))
      throw new Error("required-web-evidence-missing");
    // A mixed proposal may include independent local observations, but any replaced
    // current result of a live research task must itself cite a checked web source.
    if (
      !(noMatch && !checked.size) &&
      operations.some(operation => operation.kind === "output" && !operation.evidence.some(id => checked.has(id)))
    )
      throw new Error("required-web-output-evidence-missing");
  } else if (envelope.checkedWeb !== undefined && (!Array.isArray(envelope.checkedWeb) || envelope.checkedWeb.length)) {
    throw new Error("unexpected-web-check");
  }
  return {
    proposal: { baseRevision: envelope.baseRevision, operations },
    context: { at, evidence: [...local, ...byUrl.values()] },
    /** What this run actually checked and when (a no-change or no-match result is only valid with this). */
    checked: checkedUrls.map(url => ({ url, at }))
  };
}

export async function generateLivingProposal(calls: AiCalls, input: LivingProviderInput, signal: AbortSignal) {
  const policy = livingWebPolicy(input.prompt);
  const events: unknown[] = [];
  // What the run actually did on the web, stamped when each event arrived (never taken from model text).
  const activity: { url?: string; query?: string; at: string }[] = [];
  const { omitted } = projectionFor(input);
  /** Every reply passes the same checks; a repair reply is still judged against pages the first call opened. */
  const check = (parsed: unknown) => {
    const normalized = normalizeLivingProposal(
      parsed,
      openedUrlsFromEvents(events),
      input.evidence,
      new Date().toISOString(),
      policy === "required",
      policy === "forbidden",
      activity.some(item => !!item.query)
    );
    // The model never saw omitted records: every non-append edit of one (supplement included) is refused and
    // counted, and the rest of the round still runs. These are safely omitted, unlike an unknown or unauthorised id,
    // which rejects the whole proposal in applyLivingChanges. A re-reported append is decided there too.
    const blind = (operation: Record<string, unknown>) =>
      operation.kind !== "append" && operation.kind !== "output" && omitted.has(String(operation.id));
    // A correction or invalidation stating another period than its target is a new observation, not a correction.
    const refuse = (operation: Record<string, unknown>) =>
      blind(operation) || livingSupersedeMismatch(input.base, operation);
    const droppedOperations = normalized.proposal.operations.filter(refuse).length;
    normalized.proposal.operations = normalized.proposal.operations.filter(operation => !refuse(operation));
    // Appends that deleted-observation holds reject are dropped locally and counted, not sent back or failed.
    const before = normalized.proposal.operations.length;
    normalized.proposal.operations = normalized.proposal.operations.filter(
      operation => !livingAppendSuppressed(input.base, operation)
    );
    const suppressedDropped = before - normalized.proposal.operations.length;
    // The model's echoed revision is not trusted: context documents carry their own revision fields and models
    // confuse them. Real staleness is fenced at commit by the expected file content and snapshot revision.
    normalized.proposal.baseRevision = input.base.revision;
    // An AI output the owner's edit or deletion blocks is dropped by applyLivingChanges; it is disclosed, not failed.
    const aiLatestDropped = applyLivingChanges(input.base, normalized.proposal, normalized.context).warnings[0];
    return { normalized, droppedOperations, suppressedDropped, aiLatestDropped };
  };
  /** The first operation (1-based) whose prefix fails with `code`: the same checks on fewer operations, no model call. */
  const locate = (parsed: unknown, code: string): number | undefined => {
    const operations = (parsed as { operations?: unknown } | null)?.operations;
    if (!Array.isArray(operations)) return undefined;
    for (let count = 1; count <= operations.length; count++) {
      try {
        check({ ...(parsed as object), operations: operations.slice(0, count) });
      } catch (error) {
        if (error instanceof Error && error.message === code) return count;
      }
    }
    return undefined;
  };
  // The first reply's parsed JSON, kept here and never on the error, so only locate() reads it.
  let lastParsed: unknown;
  const send = (stepInput: LivingStepInput, repairing: boolean) => {
    const prepared = prepareStep(step, stepInput);
    lastParsed = undefined;
    return calls.run(
      prepared,
      {
        model: input.model,
        effort: stepEffort(input.reasoning),
        topic: "Living Node",
        taskName: "living-node",
        signal,
        localCodex: false,
        noContentLog: true,
        usage: { mapPath: input.mapPath },
        // The repair only re-cites what the first call already saw: no new search.
        task: repairing
          ? {
              webSearch: false,
              webSearchOnly: false,
              textOnly: true,
              optionalWebSearch: false,
              searchBudget: 0,
              timeoutMs: 300_000
            }
          : {
              webSearch: policy !== "forbidden",
              webSearchOnly: policy !== "forbidden",
              textOnly: policy === "forbidden",
              optionalWebSearch: policy === "optional",
              searchBudget: policy === "forbidden" ? 0 : 8,
              timeoutMs: 300_000,
              onWebSearchEvent: event => {
                events.push(event);
                const at = new Date().toISOString();
                for (const url of openedUrlsFromEvents([event])) activity.push({ url, at });
                for (const query of searchQueriesFromEvents([event])) activity.push({ query, at });
              }
            }
      },
      (raw, exchange) => {
        if (exchange.signal.aborted) throw new Error("cancelled");
        const parsed = prepared.parse(raw);
        lastParsed = parsed;
        const { normalized, droppedOperations, suppressedDropped, aiLatestDropped } = check(parsed);
        exchange.parsed();
        // The checked artifact is what the provider was observed doing, deduplicated per URL or query (latest time).
        const seen = new Map<string, { url?: string; query?: string; at: string }>();
        for (const item of activity) seen.set((item.url ? "u:" : "q:") + (item.url ?? item.query), item);
        const observed = [...seen.values()].slice(-20);
        const context: LivingChangeContext = { ...normalized.context, checked: observed };
        return { ...normalized, context, checked: observed, droppedOperations, suppressedDropped, aiLatestDropped };
      }
    );
  };
  try {
    return await send(input, false);
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    if (!REPAIRABLE.has(code) || signal.aborted) throw error;
    const parsed = lastParsed;
    const allowed = [...input.evidence.map(item => item.id), ...openedUrlsFromEvents(events)];
    let repairInput: LivingStepInput;
    try {
      repairInput = { ...input, repair: { code, operation: locate(parsed, code), allowed } };
      prepareStep(step, repairInput);
    } catch {
      // A repair that no longer fits the prompt budget is not sent; the original rejection stands.
      throw error;
    }
    return send(repairInput, true);
  }
}
