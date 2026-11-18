import type { AdmissionContext } from "../../admission";
import type { AiCalls } from "../../ai-calls";
import type { ImageCandidate } from "../../image-candidates";
import { stepEffort } from "../../provider-step-runner";
import { prepareStep, renderTemplate, type StepDefinition } from "../../step-runner";
import { parseImageCandidates } from "../image-search/step";
import { languageInstruction, type BookStepBase } from "./base";
import template from "./find-images.md";
import againTemplate from "./find-images-again.md";
import retryTemplate from "./find-images-retry.md";

/** One planned picture position as the search sees it (the planner's kind and what it must show; never the marker). */
export interface FindImagesSlot {
  index: number;
  kind: string;
  explains: string;
}

/** What the picture search of one chapter sees: the chapter text (title, summary and the works it names) and its picture positions. */
export interface FindImagesRequest extends BookStepBase {
  chapter: string;
  slots: FindImagesSlot[];
  /** Image keys (see imageKey) the book already uses: file names or addresses only, never model-written titles. */
  exclude?: string[];
  /** Set on the one repeat ask after a caption came back in the wrong language. */
  languageRetry?: boolean;
  /** Set on the one second search for the positions the first search found nothing usable for (another direction; `exclude` also holds what was already tried). */
  again?: boolean;
}

/** One offered picture: the shared candidate plus the one plain line the finder wrote about it. */
export interface FoundImage extends ImageCandidate {
  caption: string;
}
/** The answer: up to {@link PER_SLOT_MAX} candidates per slot index; `found` counts the kept images, `offTopic` those the model marked as not relevant or described no content for. */
export interface FoundImages {
  bySlot: Map<number, FoundImage[]>;
  found: number;
  offTopic: number;
}

const EXCLUDE_MAX = 30;
const EXCLUDE_ITEM_MAX = 120;
const PER_SLOT_MAX = 3;
const CAPTION_MAX = 200;
const SLOT_TEXT_MAX = 160;

/** Per slot, each image goes through the shared candidate parser on its own, so the caption stays with the image the parser kept. */
function parseFound(raw: string): FoundImages {
  const out: FoundImages = { bySlot: new Map(), found: 0, offTopic: 0 };
  const start = raw.indexOf("{"),
    end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return out;
  let parsed: { slots?: unknown };
  try {
    parsed = JSON.parse(raw.slice(start, end + 1)) as { slots?: unknown };
  } catch {
    return out;
  }
  if (!Array.isArray(parsed.slots)) return out;
  for (const entry of parsed.slots as Array<Record<string, unknown> | null>) {
    if (!entry || !Number.isInteger(entry.slot) || !Array.isArray(entry.images)) continue;
    const index = entry.slot as number;
    const list = out.bySlot.get(index) ?? [];
    for (const item of entry.images as Array<Record<string, unknown> | null>) {
      if (list.length >= PER_SLOT_MAX) break;
      if (!item || typeof item !== "object") continue;
      if (item.relevant === false || typeof item.shows !== "string" || !item.shows.trim()) {
        out.offTopic++;
        continue;
      }
      const [candidate] = parseImageCandidates(JSON.stringify({ images: [item] }));
      if (!candidate || list.some(have => have.url === candidate.url)) continue;
      const caption = typeof item.caption === "string" && item.caption.trim() ? item.caption : item.shows;
      list.push({ ...candidate, caption: caption.replace(/\s+/g, " ").trim().slice(0, CAPTION_MAX) });
      out.found++;
    }
    out.bySlot.set(index, list);
  }
  return out;
}

/** The map chat's image candidates (same parser: https links with an https source page), asked per picture position for the book's sources. */
export const findImagesStep: StepDefinition<FindImagesRequest, FoundImages> = {
  id: "book-pipeline.find-images",
  version: 5,
  render: ({ chapter, slots, exclude, language, languageRetry, again }) =>
    renderTemplate(template, {
      chapter: JSON.stringify(chapter),
      slots: JSON.stringify(
        slots.map(slot => ({
          slot: slot.index,
          kind: slot.kind.slice(0, SLOT_TEXT_MAX),
          shows: slot.explains.slice(0, SLOT_TEXT_MAX)
        }))
      ),
      languageInstruction: languageInstruction(language, chapter),
      languageRetry: languageRetry ? retryTemplate : "",
      again: again ? againTemplate : "",
      exclude: JSON.stringify((exclude ?? []).slice(0, EXCLUDE_MAX).map(key => key.slice(0, EXCLUDE_ITEM_MAX)))
    }),
  parse: raw => parseFound(raw)
};

/** A Chinese book needs a caption with Chinese characters; other languages are not checked (a Latin script cannot tell them apart reliably). */
function captionFits(caption: string, language: string): boolean {
  return !/^zh/i.test(language) || /[\u3400-\u9fff]/.test(caption);
}
function wrongCaptions(found: FoundImages, language: string): number {
  let n = 0;
  for (const list of found.bySlot.values()) for (const image of list) if (!captionFits(image.caption, language)) n++;
  return n;
}

/** One web search call for a chapter's pictures (every slot at once): web search only, the budget reserved before the provider is asked, no content in the exchange log. A caption in the wrong language gets one repeat ask; one still wrong is emptied (the figure then reads its title). */
export async function runFindImages(
  aiCalls: AiCalls,
  request: FindImagesRequest,
  run: { signal: AbortSignal; admission?: AdmissionContext }
): Promise<FoundImages> {
  const ask = (asked: FindImagesRequest): Promise<FoundImages> => {
    const prepared = prepareStep(findImagesStep, asked);
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
  };
  let result = await ask(request);
  const wrong = wrongCaptions(result, request.language);
  if (wrong > 0) {
    try {
      const again = await ask({ ...request, languageRetry: true });
      if (wrongCaptions(again, request.language) < wrong) result = again;
    } catch (error) {
      if (run.signal.aborted) throw error;
    }
    for (const list of result.bySlot.values())
      for (const image of list) if (!captionFits(image.caption, request.language)) image.caption = "";
  }
  return result;
}
