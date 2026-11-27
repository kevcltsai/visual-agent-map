import type { AiCalls } from "../../core/ai-calls";
import { allowedUrl, openedUrlsFromEvents } from "../../core/argument-map/source-proof";
import { stepEffort } from "../../core/provider-step-runner";
import { prepareStep, renderTemplate, type StepDefinition } from "../../core/step-runner";
import type { ModelChoice } from "../../ai/model-resolution";
import { applyLivingChanges, type LivingEvidence, type LivingKnowledge } from "./living-node-changes";
import { livingSnapshotRevision } from "./living-node-markdown";
import promptTemplate from "./steps/living-node-change-set.md";

export interface LivingProviderInput extends ModelChoice {
  prompt: string;
  language: string;
  base: LivingKnowledge;
  context: string;
  evidence: readonly LivingEvidence[];
  mapPath: string;
}

const step: StepDefinition<LivingProviderInput, unknown> = {
  id: "living-node-change-set",
  version: 1,
  render: input =>
    renderTemplate(promptTemplate, {
      prompt: JSON.stringify(input.prompt),
      language: JSON.stringify(input.language),
      knowledge: JSON.stringify(input.base),
      context: input.context
    }),
  policy: text => {
    if (text.length > 100_000) throw new Error("living-node-context-too-large");
  },
  parse: raw => JSON.parse(raw.trim()) as unknown
};

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid-proposal");
  return value as Record<string, unknown>;
}

/** Web URLs only become authorized evidence if the runtime reports opening them during this call. */
/** Explicit current-data wording is a conservative requirement floor; broader task semantics
 * still require the model's declared decision and semantic acceptance fixtures. */
export function explicitlyRequiresLivingWeb(prompt: string): boolean {
  return /(?:即時|即时|最新|今天|今日|當前行情|当前行情|現在的(?:股價|價格|新聞)|现在的(?:股价|价格|新闻)|\blatest\b|\blive\s+(?:price|data|news)\b|\btoday(?:'s)?\b|\bcurrent\s+(?:price|quote|news|market data)\b)/i.test(prompt);
}

export function normalizeLivingProposal(raw: unknown, opened: readonly string[], local: readonly LivingEvidence[], at: string, requiresWeb = false) {
  const envelope = object(raw);
  if (Object.keys(envelope).some(key => !["baseRevision", "operations", "requiresWeb", "checkedWeb"].includes(key)))
    throw new Error("invalid-proposal-field");
  if (typeof envelope.requiresWeb !== "boolean") throw new Error("missing-search-decision");
  const byUrl = new Map<string, LivingEvidence>();
  for (const url of opened) {
    const parsed = allowedUrl(url);
    if (!parsed) continue;
    parsed.hash = "";
    const source = parsed.toString();
    byUrl.set(source, { id: "web:" + livingSnapshotRevision(source), source, retrievedAt: at });
  }
  if ((requiresWeb || envelope.requiresWeb) && !byUrl.size) throw new Error("required-web-unavailable");
  if (requiresWeb && !envelope.requiresWeb) throw new Error("required-web-decision-conflict");
  if (!Array.isArray(envelope.operations)) throw new Error("invalid-operations");
  const operations = (envelope.operations as unknown[]).map(value => {
    const operation = object(value);
    if (!Array.isArray(operation.evidence)) throw new Error("invalid-evidence");
    const evidence = (operation.evidence as unknown[]).map(item => {
      if (typeof item !== "string") throw new Error("invalid-evidence");
      const url = allowedUrl(item);
      if (!url) return item;
      url.hash = "";
      const known = byUrl.get(url.toString());
      if (!known) throw new Error("unauthorized-evidence");
      return known.id;
    });
    return { ...operation, evidence };
  });
  // A changed answer requiring current web information must cite at least
  // one actually opened source. A genuine no-change check can have no operations.
  if (envelope.requiresWeb) {
    if (!Array.isArray(envelope.checkedWeb) || !envelope.checkedWeb.length || envelope.checkedWeb.length > 100)
      throw new Error("required-web-check-missing");
    const checked = new Set<string>();
    for (const value of envelope.checkedWeb as unknown[]) {
      if (typeof value !== "string") throw new Error("invalid-web-check");
      const url = allowedUrl(value);
      if (!url) throw new Error("invalid-web-check");
      url.hash = "";
      const entry = byUrl.get(url.toString());
      if (!entry) throw new Error("unauthorized-web-check");
      checked.add(entry.id);
    }
    if (operations.length && !operations.some(operation => operation.evidence.some(id => checked.has(id))))
      throw new Error("required-web-evidence-missing");
    // A mixed proposal may include independent local observations, but any replaced
    // current result of a live research task must itself cite a checked web source.
    if (operations.some(operation => operation.kind === "output" &&
        !operation.evidence.some(id => checked.has(id))))
      throw new Error("required-web-output-evidence-missing");
  } else if (envelope.checkedWeb !== undefined && (!Array.isArray(envelope.checkedWeb) || envelope.checkedWeb.length)) {
    throw new Error("unexpected-web-check");
  }
  return {
    proposal: { baseRevision: envelope.baseRevision, operations },
    context: { at, evidence: [...local, ...byUrl.values()] }
  };
}

export async function generateLivingProposal(calls: AiCalls, input: LivingProviderInput, signal: AbortSignal) {
  const prepared = prepareStep(step, input);
  const events: unknown[] = [];
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
      task: {
        webSearch: true,
        webSearchOnly: true,
        optionalWebSearch: true,
        searchBudget: 8,
        timeoutMs: 300_000,
        onWebSearchEvent: event => events.push(event)
      }
    },
    (raw, exchange) => {
      if (exchange.signal.aborted) throw new Error("cancelled");
      const normalized = normalizeLivingProposal(
        prepared.parse(raw),
        openedUrlsFromEvents(events),
        input.evidence,
        new Date().toISOString(),
        explicitlyRequiresLivingWeb(input.prompt)
      );
      applyLivingChanges(input.base, normalized.proposal, normalized.context);
      exchange.parsed();
      return normalized;
    }
  );
}
