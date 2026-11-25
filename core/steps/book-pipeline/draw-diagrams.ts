import type { AdmissionContext } from "../../admission";
import type { AiCalls } from "../../ai-calls";
import { neutralizeUnsafeMermaid } from "../../../ai/mermaid-safety";
import { MAX_IMAGE_SLOTS } from "../../book-pipeline/image-slots";
import { stepEffort } from "../../provider-step-runner";
import { prepareStep, renderTemplate, type StepDefinition } from "../../step-runner";
import { checkFigure, parseFigure, type FigureCode } from "../../book-pipeline/figure-spec";
import { noteNumbers, numberTokens } from "../../evidence-tokens";
import { arrayOf, languageInstruction, parseJson, recordOf, type BookStepBase } from "./base";
import type { FindImagesSlot } from "./find-images";
import template from "./draw-diagrams.md";

/** What the diagram step sees of one chapter: its text without picture lines, and the diagram-kind slots still without a picture. */
export interface DrawDiagramsRequest extends BookStepBase {
  chapter: string;
  slots: FindImagesSlot[];
}

/** One diagram the model offers for a slot (untrusted until {@link checkDiagram} or {@link checkFigureDraft} passes it): exactly one of a Mermaid chart and a figure (see figure-spec.ts). */
export type DiagramDraft =
  | { slot: number; title: string; mermaid: string; figure?: undefined }
  | { slot: number; title: string; mermaid?: undefined; figure: unknown };

const SLOT_TEXT_MAX = 160;
const TITLE_MAX = 80;
const MERMAID_MAX = 1500;

const str = (maxLength = 24): unknown => ({ type: "string", minLength: 1, maxLength });
const objectOf = (properties: Record<string, unknown>, required: string[]): unknown => ({
  type: "object",
  additionalProperties: false,
  properties,
  required
});
const cellRef = { type: "array", items: { type: "integer", minimum: 1, maximum: 10 }, minItems: 2, maxItems: 2 };

/** The figure's shape (figure-spec.ts) as one flat object: `type` picks the fields that apply, the others stay out; the plugin checks the rest. */
function figureSchema(): unknown {
  return objectOf(
    {
      type: { type: "string", enum: ["bar", "scale", "graph", "board"] },
      unit: str(8),
      stacked: { type: "boolean" },
      groups: {
        type: "array",
        maxItems: 6,
        items: objectOf(
          {
            label: str(),
            values: {
              type: "array",
              minItems: 1,
              maxItems: 3,
              items: objectOf({ series: str(), value: str(12) }, ["value"])
            }
          },
          ["label", "values"]
        )
      },
      min: str(12),
      max: str(12),
      marks: {
        type: "array",
        maxItems: 6,
        items: objectOf({ label: str(), at: str(12), from: str(12), to: str(12) }, ["label"])
      },
      directed: { type: "boolean" },
      layout: { type: "string", enum: ["circle", "row"] },
      nodes: { type: "array", maxItems: 8, items: objectOf({ id: str(12), label: str() }, ["id", "label"]) },
      edges: {
        type: "array",
        maxItems: 12,
        items: objectOf({ from: str(12), to: str(12), label: str() }, ["from", "to"])
      },
      rows: str(2),
      cols: str(2),
      shade: { type: "string", enum: ["checker", "none"] },
      cells: {
        type: "array",
        maxItems: 100,
        items: objectOf(
          {
            row: { type: "integer", minimum: 1, maximum: 10 },
            col: { type: "integer", minimum: 1, maximum: 10 },
            label: str(),
            cut: { type: "boolean" }
          },
          ["row", "col"]
        )
      },
      pairs: {
        type: "array",
        maxItems: 10,
        items: objectOf({ a: cellRef, b: cellRef, label: str() }, ["a", "b"])
      }
    },
    ["type"]
  );
}

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
            mermaid: { type: "string", minLength: 1, maxLength: MERMAID_MAX },
            figure: figureSchema()
          },
          required: ["slot", "title"]
        }
      }
    },
    required: ["diagrams"]
  };
}

/** Reads `diagrams` only. An item has a chart or a figure object, not both. A malformed item, a slot not asked for and a repeated slot are dropped one by one; at most one diagram per asked slot. */
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
    if (typeof item.title !== "string" || !item.title.trim()) continue;
    const figure = item.figure;
    if (figure !== undefined && figure !== null) {
      // A figure item has no chart (an empty or null one is the same as none); the figure is read by checkFigureDraft.
      if (typeof figure !== "object" || Array.isArray(figure)) continue;
      if (typeof item.mermaid === "string" && item.mermaid.trim()) continue;
      seen.add(slot);
      out.push({ slot, title: item.title, figure });
    } else {
      if (typeof item.mermaid !== "string" || !item.mermaid.trim() || item.mermaid.length > MERMAID_MAX) continue;
      seen.add(slot);
      out.push({ slot, title: item.title, mermaid: item.mermaid });
    }
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
export const MAX_VERTICAL_NODES = 5;
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

/** Whether the chart grows tall in the book page whatever its direction word says (flowchart, graph, stateDiagram-v2 and mindmap). */
function isTall(type: string): boolean {
  return type === "flowchart" || type === "graph" || type === "stateDiagram-v2" || type === "mindmap";
}

export type DiagramCheck = { ok: true; mermaid: string } | { ok: false; code: DiagramRejectCode };

/**
 * Pure per-chart check, so one failing chart is dropped alone. `chapterText` is the chapter without its picture lines (the text the
 * model saw). A chart passes only when: its type is in the whitelist; it passes the shared chart body limits and
 * `neutralizeUnsafeMermaid`; no `<` (the fill's exit check refuses a whole chapter for one) and no marker bracket in the chart or title;
 * every number of the chart and title is in the text; a flowchart, graph, stateDiagram-v2 or mindmap (any direction: the book page may stack it) has at most {@link MAX_VERTICAL_NODES} nodes, any chart at most 12, a pie 8.
 * The parser check (`mermaidSyntax`) is the caller's. Returns the normalized chart body.
 */
export function checkDiagram(draft: { title: string; mermaid: string }, chapterText: string): DiagramCheck {
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
  if (isTall(type) && nodes > MAX_VERTICAL_NODES) return { ok: false, code: "too_tall" };
  return { ok: true, mermaid: body };
}

export type FigureDraftCheck = { ok: true; body: string } | { ok: false; code: FigureCode };

/** The figure counterpart of {@link checkDiagram}: the figure parses and passes `checkFigure`, and the title is plain (no `<`, no marker bracket) and its numbers are in the text. Returns the canonical JSON. */
export function checkFigureDraft(draft: { title: string; figure: unknown }, chapterText: string): FigureDraftCheck {
  const parsed = parseFigure(draft.figure);
  if (!parsed.ok) return { ok: false, code: parsed.code };
  if (/[<>[\]〔〕]/.test(draft.title)) return { ok: false, code: "unsafe_text" };
  const checked = checkFigure(parsed.spec, chapterText);
  if (!checked.ok) return checked;
  const known = noteNumbers(chapterText);
  if (numberTokens(draft.title).some(n => !known.has(n))) return { ok: false, code: "number_not_in_text" };
  return checked;
}
