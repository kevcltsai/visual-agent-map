// Read-only engineering evidence from an existing AI exchange log. No prompts, paths, replies or IDs in output.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const object = value => value && typeof value === "object" && !Array.isArray(value);
const count = value => Number.isSafeInteger(value) && value >= 0;
const duration = value => typeof value === "number" && Number.isFinite(value) && value >= 0;
const statuses = ["preparing", "sent", "received", "parsed", "completed", "failed"];

function elapsed(start, end) {
  if (typeof start !== "string" || typeof end !== "string") return undefined;
  const ms = Date.parse(end) - Date.parse(start);
  return duration(ms) ? ms : undefined;
}

function timing(values, eligible) {
  const sorted = values.filter(duration).sort((a, b) => a - b);
  const percentile = p => sorted[Math.ceil(sorted.length * p) - 1] ?? null;
  return { samples: sorted.length, unavailable: eligible - sorted.length, p50Ms: percentile(0.5), p95Ms: percentile(0.95) };
}

function summarize(entries) {
  const complete = { entries: 0, inputTokens: 0, outputTokens: 0 };
  const partial = { entries: 0, inputSamples: 0, outputSamples: 0, knownInputTokens: 0, knownOutputTokens: 0 };
  const cache = { read: { samples: 0, tokens: 0 }, write: { samples: 0, tokens: 0 } };
  const outcomes = Object.fromEntries(statuses.map(status => [status, 0]));
  let missing = 0;
  let retrySamples = 0;
  let retryEvents = 0;
  const terminalDurations = [];
  const firstText = [];
  const providerReply = [];
  for (const entry of entries) {
    outcomes[entry.status]++;
    const milestone = object(entry.milestones) ? entry.milestones : {};
    const usage = object(milestone.usage) ? milestone.usage : {};
    const input = count(usage.inputTokens);
    const output = count(usage.outputTokens);
    if (input && output) {
      complete.entries++;
      complete.inputTokens += usage.inputTokens;
      complete.outputTokens += usage.outputTokens;
    } else if (input || output) {
      partial.entries++;
      if (input) { partial.inputSamples++; partial.knownInputTokens += usage.inputTokens; }
      if (output) { partial.outputSamples++; partial.knownOutputTokens += usage.outputTokens; }
    } else missing++;
    for (const [key, field] of [["read", "cacheReadInputTokens"], ["write", "cacheWriteInputTokens"]]) {
      if (count(usage[field])) { cache[key].samples++; cache[key].tokens += usage[field]; }
    }
    if (Array.isArray(milestone.apiRetries)) { retrySamples++; retryEvents += milestone.apiRetries.length; }
    if (entry.status === "completed" || entry.status === "failed") terminalDurations.push(entry.durationMs);
    firstText.push(elapsed(entry.sentAt, milestone.firstTextAt));
    providerReply.push(elapsed(entry.sentAt, milestone.receivedAt));
  }
  return {
    entries: entries.length,
    outcomes,
    usage: { complete, partial, missing, cache },
    exchangeDuration: timing(terminalDurations, outcomes.completed + outcomes.failed),
    firstTextFromLoggedSend: timing(firstText, entries.length),
    replyFromLoggedSend: timing(providerReply, entries.length),
    reportedApiRetries: { samples: retrySamples, unavailable: entries.length - retrySamples, events: retryEvents }
  };
}

/** Filters are exact and never printed. Legacy logs and missing milestones remain explicitly unavailable. */
export function buildUsageScorecard(entries, filters = {}) {
  if (!Array.isArray(entries) || entries.some(entry => !object(entry) || typeof entry.model !== "string" || !statuses.includes(entry.status))) {
    throw new Error("Invalid exchange log shape");
  }
  const selected = entries.filter(entry => ["model", "effort", "step"].every(key => filters[key] === undefined || entry[key] === filters[key]));
  return {
    schema: 1,
    evidence: "existing-exchange-log",
    scope: "logged exchange entries only; not all provider requests or user tasks",
    inputIncludesCacheWhereReported: true,
    taskAttribution: "unavailable",
    semanticQuality: "unavailable",
    estimatedUsage: "not mixed with provider reports",
    sourceEntries: entries.length,
    selectedEntries: selected.length,
    total: summarize(selected),
    claude: summarize(selected.filter(entry => entry.model.startsWith("claude:"))),
    codex: summarize(selected.filter(entry => !entry.model.startsWith("claude:")))
  };
}

export function main(args) {
  const [file, ...options] = args;
  const filters = {};
  if (!file || file.startsWith("--")) return 2;
  for (const option of options) {
    const match = /^--(model|effort|step)=(.+)$/.exec(option);
    if (!match || Object.hasOwn(filters, match[1])) return 2;
    filters[match[1]] = match[2];
  }
  try {
    const report = buildUsageScorecard(JSON.parse(readFileSync(file, "utf8")), filters);
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    return 0;
  } catch {
    process.stderr.write("Unable to read a valid exchange log.\n");
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
