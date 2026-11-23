import type { AdmissionContext } from "../../admission";
import type { AiCalls } from "../../ai-calls";
import { stepEffort } from "../../provider-step-runner";
import { prepareStep, renderTemplate, type StepDefinition } from "../../step-runner";
import { languageInstruction, type BookStepBase } from "./base";
import { sniffImageMime } from "../../book-pipeline/cover";
import template from "./image-fit-check.md";

/** One candidate picture and the position it was found for. `imageDataUrl` rides to the provider as the attached image; it is never rendered into the prompt. */
export interface ImageFitRequest extends BookStepBase {
  chapter: string;
  kind: string;
  explains: string;
  imageDataUrl: string;
}
/** The answer: whether the picture shows what the position needs, and the one line the reader sees under it (what is visible; empty when it does not fit). */
export interface ImageFit {
  fits: boolean;
  caption: string;
}

const CAPTION_MAX = 200;
const POSITION_TEXT_MAX = 160;

/** One plain line: no line breaks, no slot-marker brackets, capped. It is written into the note through the figure's own escape (see figureOf), so it is not escaped twice here. */
function plainCaption(value: unknown): string {
  return typeof value === "string"
    ? value
        .replace(/[〔〕]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, CAPTION_MAX)
    : "";
}

function parseFit(raw: string): ImageFit {
  const start = raw.indexOf("{"),
    end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("The reply is not JSON");
  let parsed: { fits?: unknown; caption?: unknown };
  try {
    parsed = JSON.parse(raw.slice(start, end + 1)) as { fits?: unknown; caption?: unknown };
  } catch {
    throw new Error("The reply is not JSON");
  }
  if (typeof parsed.fits !== "boolean") throw new Error("The reply has no verdict");
  return { fits: parsed.fits, caption: parsed.fits ? plainCaption(parsed.caption) : "" };
}

/** One look at one picture a non-Commons finder offered (the program downloaded it, never saved it): does it show what its position needs, and what is visible in it. */
export const imageFitCheckStep: StepDefinition<ImageFitRequest, ImageFit> = {
  id: "book-pipeline.image-fit-check",
  version: 1,
  render: ({ chapter, kind, explains, language }) =>
    renderTemplate(template, {
      chapter: JSON.stringify(chapter),
      position: JSON.stringify({ kind: kind.slice(0, POSITION_TEXT_MAX), shows: explains.slice(0, POSITION_TEXT_MAX) }),
      languageInstruction: languageInstruction(language, chapter)
    }),
  parse: raw => parseFit(raw)
};

/** One AI call with the picture attached; no web search, no content in the exchange log. */
export async function runImageFitCheck(
  aiCalls: AiCalls,
  request: ImageFitRequest,
  run: { signal: AbortSignal; admission?: AdmissionContext }
): Promise<ImageFit> {
  const prepared = prepareStep(imageFitCheckStep, request);
  return aiCalls.run(
    prepared,
    {
      model: request.model,
      effort: stepEffort(request.reasoning),
      topic: "Book pipeline image check",
      taskName: "book-pipeline-image-fit",
      signal: run.signal,
      localCodex: true,
      noContentLog: true,
      failMessage: () => "failed",
      usage: { action: "other", mapPath: request.usageMapPath },
      ...(run.admission ? { admission: run.admission } : {}),
      task: { textOnly: true, searchBudget: 0, imageDataUrl: request.imageDataUrl, timeoutMs: 90 * 1000 }
    },
    raw => prepared.parse(raw)
  );
}

export const PICTURE_MAX_BYTES = 8 * 1024 * 1024;
export const PICTURE_TIMEOUT_MS = 15_000;
export type PictureFailure = "url" | "status" | "size" | "type" | "timeout" | "aborted" | "failed";
export type PictureDownload =
  | { ok: true; bytes: Uint8Array; mime: string }
  | { ok: false; reason: PictureFailure };
export type PictureFetch = (url: string) => Promise<{ status: number; headers?: Record<string, string>; bytes: ArrayBuffer }>;

/** The image type by its first bytes: PNG, JPEG, WebP (see sniffImageMime) or GIF; undefined for anything else (SVG, HTML, a short body). */
function sniffPictureMime(bytes: Uint8Array): string | undefined {
  const gif = bytes.length >= 6 && [0x47, 0x49, 0x46, 0x38].every((byte, i) => bytes[i] === byte);
  return gif ? "image/gif" : sniffImageMime(bytes);
}

/**
 * Downloads one candidate picture for the model to look at; the bytes are only held in memory, never saved. The fetch is injected (production:
 * `requestUrl`, which cannot be aborted, so an answer that arrives after an abort or the timeout is dropped). Order: https without credentials,
 * status 200, content-length, real size, first bytes are PNG/JPEG/GIF/WebP.
 */
export async function downloadPicture(
  url: string,
  fetch: PictureFetch,
  options: { signal?: AbortSignal; timeoutMs?: number; maxBytes?: number } = {}
): Promise<PictureDownload> {
  const { signal } = options;
  const max = options.maxBytes ?? PICTURE_MAX_BYTES;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) return { ok: false, reason: "url" };
  } catch {
    return { ok: false, reason: "url" };
  }
  if (signal?.aborted) return { ok: false, reason: "aborted" };
  let onAbort = (): void => undefined;
  let timer: number | undefined;
  const stop = new Promise<PictureDownload>(resolve => {
    onAbort = () => resolve({ ok: false, reason: "aborted" });
    signal?.addEventListener("abort", onAbort, { once: true });
    timer = window.setTimeout(() => resolve({ ok: false, reason: "timeout" }), options.timeoutMs ?? PICTURE_TIMEOUT_MS);
  });
  try {
    const response = await Promise.race([fetch(url).catch((): PictureDownload => ({ ok: false, reason: "failed" })), stop]);
    // The fetch may answer in the same turn as an abort: the abort wins, the bytes are dropped.
    if (signal?.aborted) return { ok: false, reason: "aborted" };
    if ("ok" in response) return response;
    if (response.status !== 200) return { ok: false, reason: "status" };
    const length = Number(
      Object.entries(response.headers ?? {}).find(([name]) => name.toLowerCase() === "content-length")?.[1]
    );
    if ((Number.isFinite(length) && length > max) || response.bytes.byteLength > max) return { ok: false, reason: "size" };
    const bytes = new Uint8Array(response.bytes);
    const mime = sniffPictureMime(bytes);
    return mime ? { ok: true, bytes, mime } : { ok: false, reason: "type" };
  } finally {
    if (timer !== undefined) window.clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}
