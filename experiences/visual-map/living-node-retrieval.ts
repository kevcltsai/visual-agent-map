import { renderTemplate } from "../../core/step-runner";
import type { LivingKnowledge, LivingRecord } from "./living-node-changes";
import { livingNodeChangeSetTemplate as promptTemplate } from "./steps/fragments";

/** One input budget per run, in characters, for the whole provider prompt. */
export const LIVING_PROMPT_BUDGET = 100_000;
/** Room kept for warnings text that is only known after sources are chosen. */
const SLACK = 2_000;

export interface LivingRange {
  label: string;
  /** Inclusive calendar days, YYYY-MM-DD. */
  start: string;
  end: string;
  /** A bare `YYYY` is only a preference: its records come first but may be partly omitted with disclosure. */
  preferred?: boolean;
}

export interface LivingSelectors {
  ranges: LivingRange[];
  /** Record ids named in the prompt that exist in the card. */
  ids: string[];
  /** Quoted heading paths `Note > H2 > H3`, split into segments (first segment is the note). */
  paths: string[][];
}

const pad = (value: number): string => String(value).padStart(2, "0");
const lastDay = (year: number, month: number): number => new Date(Date.UTC(year, month, 0)).getUTCDate();

function realDay(year: number, month: number, day: number): boolean {
  return month >= 1 && month <= 12 && day >= 1 && day <= lastDay(year, month);
}

/** Calendar span of a date label: YYYY, YYYY-MM or YYYY-MM-DD (the part of a timestamp before `T`, as written). */
function span(value: string): { start: string; end: string } | undefined {
  const match = /^(\d{4})(?:-(\d\d)(?:-(\d\d))?)?(?![\d])/.exec(value.trim());
  if (!match) return undefined;
  const year = Number(match[1]);
  if (match[2] === undefined) return { start: match[1] + "-01-01", end: match[1] + "-12-31" };
  const month = Number(match[2]);
  if (month < 1 || month > 12) return undefined;
  if (match[3] === undefined)
    return { start: `${match[1]}-${match[2]}-01`, end: `${match[1]}-${match[2]}-${pad(lastDay(year, month))}` };
  if (!realDay(year, month, Number(match[3]))) return undefined;
  const day = `${match[1]}-${match[2]}-${match[3]}`;
  return { start: day, end: day };
}

// A day range is `A..B`, `between A and B`, or A and B joined by 到／至／en dash／em dash／~／～ (a bare "and" still names two days).
const RANGE =
  /(?<![\w.-])(?:between\s+(\d{4}-\d\d-\d\d)\s+and\s+(\d{4}-\d\d-\d\d)|(\d{4}-\d\d-\d\d)(?:\.\.|\s*[到至–—~～]\s*)(\d{4}-\d\d-\d\d)|Q([1-4])\s+((?:19|20)\d\d)|(\d{4}-\d\d-\d\d)|((?:19|20)\d\d-\d\d)|((?:19|20)\d\d))(?![\w-]|\.\.)/gi;
const QUOTED = /「([^」]+)」|"([^"]+)"|“([^”]+)”/g;

/** The one grammar for what a card prompt may authorise (a bare `YYYY` is only a preference): `YYYY`, `YYYY-MM`, `YYYY-MM-DD`,
 * `YYYY-MM-DD..YYYY-MM-DD` (or `between A and B`, `A 到／至／–／—／~ B`), `Qn YYYY`, record ids already in the card, and quoted heading paths. Anything else is plain text. */
export function parseLivingSelectors(prompt: string, knownIds: Iterable<string> = []): LivingSelectors {
  const ranges: LivingRange[] = [];
  for (const match of prompt.matchAll(RANGE)) {
    const [text, betweenFrom, betweenTo, joinedFrom, joinedTo, quarter, quarterYear] = match;
    const from = betweenFrom ?? joinedFrom;
    const to = betweenTo ?? joinedTo;
    if (from && to) {
      const a = span(from);
      const b = span(to);
      if (a && b && a.start <= b.end) ranges.push({ label: text, start: a.start, end: b.end });
    } else if (quarter) {
      const first = (Number(quarter) - 1) * 3 + 1;
      ranges.push({
        label: text,
        start: `${quarterYear}-${pad(first)}-01`,
        end: `${quarterYear}-${pad(first + 2)}-${pad(lastDay(Number(quarterYear), first + 2))}`
      });
    } else {
      const one = span(text);
      if (one) ranges.push({ label: text, ...one, ...(/^\d{4}$/.test(text) ? { preferred: true } : {}) });
    }
  }
  const known = new Set(knownIds);
  const ids: string[] = [];
  for (const raw of prompt.split(/[^A-Za-z0-9._:-]+/)) {
    for (const token of [raw, raw.replace(/[.:-]+$/, "")])
      if (token && known.has(token) && !ids.includes(token)) ids.push(token);
  }
  const paths: string[][] = [];
  for (const match of prompt.matchAll(QUOTED)) {
    const segments = (match[1] ?? match[2] ?? match[3]).split(">").map(part => part.trim().replace(/\s+/g, " "));
    if (segments.length >= 2 && segments.every(Boolean)) paths.push(segments);
  }
  return { ranges, ids, paths };
}

/** Section of a Markdown note addressed by a heading path (the last headings of its ancestor chain).
 * It must resolve to exactly one section; a duplicate or missing heading, or the shared `Observation` heading, fails closed. */
export function resolveLivingSection(
  content: string,
  path: readonly string[],
  shown: readonly string[] = path
): string {
  const fail = (): never => {
    throw new Error("living-section-ambiguous: " + shown.join(" > "));
  };
  if (!path.length || path[path.length - 1].toLowerCase() === "observation") return fail();
  const lines = content.split(/\r?\n/);
  const stack: { level: number; text: string }[] = [];
  const found: { from: number; level: number; trail: string[] }[] = [];
  let fence: string | undefined;
  lines.forEach((line, index) => {
    const marker = /^\s{0,3}(```+|~~~+)/.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = marker[0];
      else if (marker[0] === fence) fence = undefined;
      return;
    }
    if (fence) return;
    const heading = /^ {0,3}(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/.exec(line);
    if (!heading) return;
    const level = heading[1].length;
    while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
    stack.push({ level, text: heading[2].trim().replace(/\s+/g, " ") });
    found.push({ from: index, level, trail: stack.map(item => item.text) });
  });
  const matches = found.filter(
    item =>
      item.trail.length >= path.length &&
      path.every((part, i) => item.trail[item.trail.length - path.length + i] === part)
  );
  if (matches.length !== 1) return fail();
  const [{ from, level }] = matches;
  const next = found.find(item => item.from > from && item.level <= level);
  return lines
    .slice(from, next ? next.from : lines.length)
    .join("\n")
    .trim();
}

const eventMillis = (record: LivingRecord): number | undefined => {
  const time = record.eventTime ? Date.parse(record.eventTime) : NaN;
  return Number.isNaN(time) ? undefined : time;
};
const sizeOf = (record: LivingRecord): number => JSON.stringify(record).length + 1;
const byId = (a: LivingRecord, b: LivingRecord): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

function inRange(record: LivingRecord, selectors: LivingSelectors): boolean {
  if (selectors.ids.includes(record.id)) return true;
  const own = record.eventTime ? span(record.eventTime) : undefined;
  return !!own && selectors.ranges.some(range => own.start <= range.end && own.end >= range.start);
}

function inPreferred(record: LivingRecord, selectors: LivingSelectors): boolean {
  const own = record.eventTime ? span(record.eventTime) : undefined;
  return !!own && selectors.ranges.some(range => range.preferred && own.start <= range.end && own.end >= range.start);
}

export interface LivingProjection {
  required: LivingRecord[];
  shown: Set<string>;
  omitted: LivingRecord[];
  requiredSize: number;
  recentSize: number;
}

/** Which records the model sees: (a) records inside a required range (not a bare year) or named, oldest first, are required; a bare year's records follow, oldest first, as a preference;
 * then (b) remaining timed records newest first, then (c) untimed records, ties by id. A required overflow fails closed. */
export function projectLivingRecords(
  base: Pick<LivingKnowledge, "records">,
  selectors: LivingSelectors,
  budget: number
): LivingProjection {
  const strict: LivingSelectors = { ...selectors, ranges: selectors.ranges.filter(range => !range.preferred) };
  const byTime = (a: LivingRecord, b: LivingRecord): number =>
    (eventMillis(a) ?? 0) - (eventMillis(b) ?? 0) || byId(a, b);
  const required = base.records.filter(record => inRange(record, strict)).sort(byTime);
  const requiredSize = required.reduce((sum, record) => sum + sizeOf(record), 0);
  if (requiredSize > budget)
    throw new Error(
      "living-range-too-large: " + [...strict.ranges.map(range => range.label), ...selectors.ids].join(", ")
    );
  const shown = new Set(required.map(record => record.id));
  const rest = base.records.filter(record => !shown.has(record.id));
  const preferred = rest.filter(record => inPreferred(record, selectors));
  const others = rest.filter(record => !inPreferred(record, selectors));
  const ranked = [
    ...preferred.sort(byTime),
    ...others
      .filter(record => eventMillis(record) !== undefined)
      .sort((a, b) => eventMillis(b)! - eventMillis(a)! || byId(a, b)),
    ...others.filter(record => eventMillis(record) === undefined).sort(byId)
  ];
  let recentSize = 0;
  for (const record of ranked) {
    const size = sizeOf(record);
    if (requiredSize + recentSize + size > budget) break;
    recentSize += size;
    shown.add(record.id);
  }
  return { required, shown, omitted: base.records.filter(record => !shown.has(record.id)), requiredSize, recentSize };
}

export interface LivingPromptInput {
  prompt: string;
  language: string;
  context: string;
}

export function renderLivingPrompt(input: LivingPromptInput, knowledge: string): string {
  return renderTemplate(promptTemplate, {
    prompt: JSON.stringify(input.prompt),
    language: JSON.stringify(input.language),
    knowledge,
    context: input.context
  });
}

/** What the knowledge part costs with no records shown, in the worst case (longest times in the omitted boundary). */
function knowledgeOverhead(base: LivingKnowledge): number {
  const longest = base.records.reduce(
    (best, record) =>
      JSON.stringify(record.eventTime ?? "").length > JSON.stringify(best).length ? record.eventTime! : best,
    ""
  );
  return JSON.stringify({
    revision: base.revision,
    records: [],
    omitted: { count: base.records.length, oldest: longest, newest: longest },
    output: base.output,
    aiLatest: base.aiLatest
  }).length;
}

/** The only fields of a card's knowledge any model may see: never suppression or ownership/deletion hashes. */
export function livingModelView(base: LivingKnowledge) {
  return { revision: base.revision, records: base.records, output: base.output, aiLatest: base.aiLatest };
}

/** The model's view of the store: all records when they fit, else the projection with a disclosed omitted boundary. */
export function livingKnowledgeText(base: LivingKnowledge, projection: LivingProjection): string {
  if (!projection.omitted.length) return JSON.stringify(livingModelView(base));
  const times = projection.omitted.flatMap(record =>
    eventMillis(record) === undefined ? [] : [record.eventTime as string]
  );
  times.sort((a, b) => Date.parse(a) - Date.parse(b));
  return JSON.stringify({
    revision: base.revision,
    records: base.records.filter(record => projection.shown.has(record.id)),
    omitted: {
      count: projection.omitted.length,
      ...(times.length ? { oldest: times[0], newest: times[times.length - 1] } : {})
    },
    output: base.output,
    aiLatest: base.aiLatest
  });
}

/** The provider prompt for one run, or the thrown reason it cannot be built within the one budget. */
export function buildLivingPrompt(input: LivingPromptInput & { base: LivingKnowledge }): {
  prompt: string;
  omitted: Set<string>;
} {
  const whole = renderLivingPrompt(
    input,
    JSON.stringify({
      revision: input.base.revision,
      records: input.base.records,
      output: input.base.output,
      aiLatest: input.base.aiLatest
    })
  );
  if (whole.length <= LIVING_PROMPT_BUDGET) return { prompt: whole, omitted: new Set() };
  const shell = renderLivingPrompt(input, "").length + knowledgeOverhead(input.base);
  const selectors = parseLivingSelectors(
    input.prompt,
    input.base.records.map(record => record.id)
  );
  const projection = projectLivingRecords(input.base, selectors, LIVING_PROMPT_BUDGET - shell);
  return {
    prompt: renderLivingPrompt(input, livingKnowledgeText(input.base, projection)),
    omitted: new Set(projection.omitted.map(record => record.id))
  };
}

export interface LivingContextDocument {
  size: number;
  optional: boolean;
}

/** One budget equation, in this priority: shell + required sources + required range + recent records + optional sources
 * <= 100k characters. Returns which optional documents fit (by index); a required overflow throws. */
export function fitLivingContext(input: {
  prompt: string;
  language: string;
  base: LivingKnowledge;
  documents: readonly LivingContextDocument[];
  /** Upper bound of warning text the context will still gain. */
  warningRoom: number;
}): Set<number> {
  const shell =
    renderLivingPrompt(
      { prompt: input.prompt, language: input.language, context: '{"documents":[],"warnings":[]}' },
      ""
    ).length +
    knowledgeOverhead(input.base) +
    SLACK +
    input.warningRoom;
  const requiredSources = input.documents.reduce((sum, doc) => sum + (doc.optional ? 0 : doc.size), 0);
  if (shell + requiredSources > LIVING_PROMPT_BUDGET) throw new Error("living-node-context-too-large");
  const all = input.base.records.reduce((sum, record) => sum + sizeOf(record), 0);
  const room = LIVING_PROMPT_BUDGET - shell - requiredSources;
  const selectors = parseLivingSelectors(
    input.prompt,
    input.base.records.map(record => record.id)
  );
  const projection = projectLivingRecords(input.base, selectors, room);
  const records = Math.min(all, projection.requiredSize + projection.recentSize);
  let left = room - records;
  const kept = new Set<number>();
  input.documents.forEach((doc, index) => {
    if (!doc.optional) return;
    if (doc.size > left) return;
    left -= doc.size;
    kept.add(index);
  });
  return kept;
}
