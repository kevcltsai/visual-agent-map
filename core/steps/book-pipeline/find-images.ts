import type { AdmissionContext } from "../../admission";
import type { AiCalls } from "../../ai-calls";
import type { ImageCandidate } from "../../image-candidates";
import { stepEffort } from "../../provider-step-runner";
import { prepareStep, renderTemplate, type StepDefinition } from "../../step-runner";
import { parseImageCandidates } from "../image-search/step";
import type { BookStepBase } from "./base";
import template from "./find-images.md";

/** What the picture search of one chapter sees: the search text built from its title, summary and named works. */
export interface FindImagesRequest extends BookStepBase {
  query: string;
  /** Image keys (see imageKey) the book already uses: file names or addresses only, never model-written titles. */
  exclude?: string[];
}

const EXCLUDE_MAX = 30;
const EXCLUDE_ITEM_MAX = 120;

/** Drops the images the model itself marked as not relevant or described no content for, then the shared candidate parser. */
function parseFound(raw: string): ImageCandidate[] {
  const start = raw.indexOf("{"),
    end = raw.lastIndexOf("}");
  let kept = raw;
  let dropped = 0;
  if (start >= 0 && end > start) {
    try {
      const parsed = JSON.parse(raw.slice(start, end + 1)) as { images?: unknown };
      if (Array.isArray(parsed.images)) {
        const images = (parsed.images as Array<Record<string, unknown> | null>).filter(item => {
          const ok = !!item && item.relevant !== false && typeof item.shows === "string" && item.shows.trim() !== "";
          if (!ok) dropped++;
          return ok;
        });
        kept = JSON.stringify({ images });
      }
    } catch {
      /* the shared parser returns [] */
    }
  }
  const found = parseImageCandidates(kept);
  // For the pictures log only; not enumerable so the result still compares as a plain list.
  Object.defineProperty(found, "offTopic", { value: dropped, enumerable: false });
  return found;
}

/** The map chat's image candidates (same parser: https links with an https source page, at most six), asked for the book's sources. */
export const findImagesStep: StepDefinition<FindImagesRequest, ImageCandidate[]> = {
  id: "book-pipeline.find-images",
  version: 2,
  render: ({ query, exclude }) =>
    renderTemplate(template, {
      query: JSON.stringify(query),
      exclude: JSON.stringify((exclude ?? []).slice(0, EXCLUDE_MAX).map(key => key.slice(0, EXCLUDE_ITEM_MAX)))
    }),
  parse: raw => parseFound(raw)
};

/** One web search call for a chapter's pictures: web search only, the budget reserved before the provider is asked, no content in the exchange log. */
export function runFindImages(
  aiCalls: AiCalls,
  request: FindImagesRequest,
  run: { signal: AbortSignal; admission?: AdmissionContext }
): Promise<ImageCandidate[]> {
  const prepared = prepareStep(findImagesStep, request);
  return aiCalls.run(
    prepared,
    {
      model: request.model,
      effort: stepEffort(request.reasoning),
      topic: "Book pipeline images",
      taskName: "book-pipeline-images",
      signal: run.signal,
      localCodex: false,
      noContentLog: true,
      failMessage: () => "failed",
      usage: { action: "other", mapPath: request.usageMapPath },
      ...(run.admission ? { admission: run.admission } : {}),
      task: { webSearchOnly: true, searchBudget: 4, timeoutMs: 2 * 60 * 1000 }
    },
    raw => prepared.parse(raw)
  );
}
