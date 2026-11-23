import type { AdmissionContext } from "../../admission";
import type { AiCalls } from "../../ai-calls";
import { neutralizeUnsafeMermaid } from "../../../ai/mermaid-safety";
import { MAX_IMAGE_SLOTS } from "../../book-pipeline/image-slots";
import { stepEffort } from "../../provider-step-runner";
import { prepareStep, renderTemplate, type StepDefinition } from "../../step-runner";
import { noteNumbers, numberTokens } from "../chart/insert";
import { arrayOf, languageInstruction, parseJson, recordOf, type BookStepBase } from "./base";
import type { FindImagesSlot } from "./find-images";
import template from "./draw-diagrams.md";

/** What the diagram step sees of one chapter: its text without picture lines, and the diagram-kind slots still without a picture. */
export interface DrawDiagramsRequest extends BookStepBase {
  chapter: string;
  slots: FindImagesSlot[];
}

/** One diagram the model offers for a slot (untrusted until {@link checkDiagram} passes it). */
export interface DiagramDraft {
  slot: number;
  title: string;
  mermaid: string;
}

const SLOT_TEXT_MAX = 160;
const TITLE_MAX = 80;
const MERMAID_MAX = 1500;

export function diagramsSchema(maxItems: number): unknown {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      diagrams: {
        type: "array",
        maxItems,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            slot: { type: "integer", minimum: 1 },
            title: { type: "string", minLength: 1, maxLength: TITLE_MAX },
            mermaid: { type: "string", minLength: 1, maxLength: MERMAID_MAX }
          },
          required: ["slot", "title", "mermaid"]
        }
      }
    },
    required: ["diagrams"]
  };
}

/** Reads `diagrams` only. A malformed item, a slot not asked for and a repeated slot are dropped one by one; at most one diagram per asked slot. */
export function parseDrawDiagrams(raw: string, asked?: readonly number[]): DiagramDraft[] {
  const value = parseJson(raw);
  const out: DiagramDraft[] = [];
  const seen = new Set<number>();
  for (const entry of arrayOf(value.diagrams, "diagrams").slice(0, MAX_IMAGE_SLOTS)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const item = recordOf(entry, "diagram");
    const slot = item.slot;
    if (typeof slot !== "number" || !Number.isInteger(slot) || seen.has(slot)) continue;
    if (asked && !asked.includes(slot)) continue;
    if (typeof item.title !== "string" || typeof item.mermaid !== "string") continue;
    if (!item.title.trim() || !item.mermaid.trim() || item.mermaid.length > MERMAID_MAX) continue;
    seen.add(slot);
    out.push({ slot, title: item.title, mermaid: item.mermaid });
    if (asked && out.length >= asked.length) break;
  }
  return out;
}

/** The AI call that draws diagrams for the diagram-kind slots no picture was found for (one call a chapter). */
export const drawDiagramsStep: StepDefinition<DrawDiagramsRequest, DiagramDraft[]> = {
  id: "book-pipeline.draw-diagrams",
  version: 1,
  schema: diagramsSchema(MAX_IMAGE_SLOTS),
  render: ({ chapter, slots, language }) =>
    renderTemplate(template, {
      chapter: JSON.stringify(chapter),
      slots: JSON.stringify(
        slots.map(slot => ({
          slot: slot.index,
          kind: slot.kind.slice(0, SLOT_TEXT_MAX),
          shows: slot.explains.slice(0, SLOT_TEXT_MAX)
        }))
      ),
      languageInstruction: languageInstruction(language, chapter)
    }),
  parse: (raw, request) =>
    parseDrawDiagrams(
      raw,
      request.slots.map(slot => slot.index)
    )
};

/** One tool-free call at low effort by the book author model: the budget reserved before the provider is asked, no content in the exchange log. */
export function runDrawDiagrams(
  aiCalls: AiCalls,
  request: DrawDiagramsRequest,
  run: { signal: AbortSignal; admission?: AdmissionContext }
): Promise<DiagramDraft[]> {
  const step: StepDefinition<DrawDiagramsRequest, DiagramDraft[]> = {
    ...drawDiagramsStep,
    schema: diagramsSchema(request.slots.length)
  };
  const prepared = prepareStep(step, request);
  return aiCalls.run(
    prepared,
    {
      model: request.model,
      effort: stepEffort("low"),
      topic: "Book pipeline diagrams",
      taskName: "book-pipeline-diagrams",
      signal: run.signal,
      localCodex: true,
      noContentLog: true,
      failMessage: () => "failed",
      usage: { action: "other", mapPath: request.usageMapPath },
      ...(run.admission ? { admission: run.admission } : {}),
      task: { textOnly: true, searchBudget: 0, timeoutMs: 2 * 60 * 1000 }
    },
    raw => prepared.parse(raw)
  );
}

// ---- the program's check of one chart (a failing chart is dropped alone) -------------------------------------------------------

export type DiagramRejectCode =
  "type" | "bad_body" | "unsafe" | "angle" | "marker" | "number_not_in_text" | "too_tall" | "too_many_nodes";

/** The chart types of the chart step's seven shapes (stages, hierarchy, comparison, proportion, interaction, states, process). */
const TYPES = new Set([
  "timeline",
  "mindmap",
  "xychart-beta",
  "pie",
  "sequenceDiagram",
  "stateDiagram-v2",
  "flowchart",
  "graph"
]);
const MAX_NODES = 12;
const MAX_PIE = 8;
export const MAX_VERTICAL_NODES = 6;
const FLOW_WORDS = new Set([
  "subgraph",
  "end",
  "direction",
  "TD",
  "TB",
  "BT",
  "LR",
  "RL",
  "graph",
  "flowchart",
  "o",
  "x"
]);

/** Strips what is not a node name from a line (quoted text, edge labels, shape brackets). */
function nameParts(line: string): string[] {
  return (
    line
      .replace(/"[^"]*"/g, " ")
      .replace(/\|[^|]*\|/g, " ")
      .replace(/\[[^\]]*\]|\([^)]*\)|\{[^}]*\}/g, " ")
      .replace(/[-=.]+[ox>]?|\s--\s.*?--/g, " ")
      .match(/[A-Za-z_][\w]*/g) ?? []
  );
}

/** How many nodes, items or points a chart has, by a rough per-type count (more than the real number only drops a chart, never lets a big one by). */
function countNodes(type: string, lines: string[]): number {
  const body = lines.filter(line => line.trim());
  switch (type) {
    case "flowchart":
    case "graph": {
      const ids = new Set<string>();
      for (const line of body) for (const word of nameParts(line)) if (!FLOW_WORDS.has(word)) ids.add(word);
      return ids.size;
    }
    case "stateDiagram-v2": {
      const ids = new Set<string>();
      for (const line of body) {
        if (!line.includes("-->")) continue;
        for (const side of line.split(":")[0].split("-->")) {
          const id = side.trim().replace(/^"|"$/g, "");
          if (id && id !== "[*]") ids.add(id);
        }
      }
      return ids.size;
    }
    case "pie":
      return body.filter(line => /^\s*"[^"]*"\s*:/.test(line)).length;
    case "mindmap":
      return body.length;
    case "timeline":
      return body
        .filter(line => !/^\s*title\b/.test(line))
        .reduce((sum, line) => sum + line.split(":").filter(part => part.trim()).length, 0);
    case "xychart-beta": {
      let most = 0;
      for (const line of body) {
        const list = /\[([^\]]*)\]/.exec(line.replace(/"[^"]*"/g, "q"));
        if (list) most = Math.max(most, list[1].split(",").length);
      }
      return most;
    }
    default: {
      // sequenceDiagram: the parties
      const ids = new Set<string>();
      for (const line of body) {
        const declared = /^\s*(?:participant|actor)\s+(\S+)/.exec(line);
        if (declared) ids.add(declared[1]);
        else {
          const m = /^\s*([^\s:]+?)\s*(?:-->>|->>|--x|-x|--\)|-\)|-->|->)\+?-?\s*([^\s:]+)/.exec(line);
          if (m) {
            ids.add(m[1]);
            ids.add(m[2]);
          }
        }
      }
      return ids.size;
    }
  }
}

/** Whether the chart grows downwards: flowchart or graph with TD, TB, BT or no direction, and stateDiagram-v2 unless it says `direction LR|RL`. */
function isVertical(type: string, header: string[], lines: string[]): boolean {
  if (type === "flowchart" || type === "graph") return !/^(LR|RL)$/.test(header[1] ?? "");
  if (type === "stateDiagram-v2") return !lines.some(line => /^\s*direction\s+(LR|RL)\b/.test(line));
  return false;
}

export type DiagramCheck = { ok: true; mermaid: string } | { ok: false; code: DiagramRejectCode };

/**
 * Pure per-chart check, so one failing chart is dropped alone. `chapterText` is the chapter without its picture lines (the text the
 * model saw). A chart passes only when: its type is in the whitelist; it passes the shared chart body limits and
 * `neutralizeUnsafeMermaid`; no `<` (the fill's exit check refuses a whole chapter for one) and no marker bracket in the chart or title;
 * every number of the chart and title is in the text; a vertical chart has at most {@link MAX_VERTICAL_NODES} nodes, any chart at most 12, a pie 8.
 * The parser check (`mermaidSyntax`) is the caller's. Returns the normalized chart body.
 */
export function checkDiagram(draft: Pick<DiagramDraft, "title" | "mermaid">, chapterText: string): DiagramCheck {
  const body = draft.mermaid.replace(/\r\n?/g, "\n").trim();
  const lines = body.split("\n");
  if (lines.filter(line => line.trim()).length > 30 || body.length > MERMAID_MAX || /```|~~~/.test(body))
    return { ok: false, code: "bad_body" };
  const header = lines[0].trim().split(/\s+/);
  const type = header[0];
  if (!TYPES.has(type)) return { ok: false, code: "type" };
  if (body.includes("<") || draft.title.includes("<")) return { ok: false, code: "angle" };
  if (/[〔〕]/.test(body + draft.title)) return { ok: false, code: "marker" };
  const fence = "```mermaid\n" + body + "\n```";
  if (neutralizeUnsafeMermaid(fence) !== fence) return { ok: false, code: "unsafe" };
  const known = noteNumbers(chapterText);
  if ([...numberTokens(body.replace(/^\s*\S+/, "")), ...numberTokens(draft.title)].some(n => !known.has(n)))
    return { ok: false, code: "number_not_in_text" };
  const nodes = countNodes(type, lines.slice(1));
  if (nodes > (type === "pie" ? MAX_PIE : MAX_NODES)) return { ok: false, code: "too_many_nodes" };
  if (isVertical(type, header, lines.slice(1)) && nodes > MAX_VERTICAL_NODES) return { ok: false, code: "too_tall" };
  return { ok: true, mermaid: body };
}
