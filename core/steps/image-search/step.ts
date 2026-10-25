import { renderTemplate, type StepDefinition } from "../../step-runner";
import type { ImageCandidate } from "../../image-candidates";
import template from "./prompt.md";

export interface ImageSearchInput {
  query: string;
}

/** Finds images anywhere on the web through the model's web search. Not localized. */
export const imageSearchStep: StepDefinition<ImageSearchInput, ImageCandidate[]> = {
  id: "markdown.image-search",
  version: 1,
  render: ({ query }) => renderTemplate(template, { query: JSON.stringify(query) }),
  parse: raw => parseImageCandidates(raw)
};

/** Keeps https image links with an https source page, without duplicates, at most six. */
export function parseImageCandidates(raw: string): ImageCandidate[] {
  const start = raw.indexOf("{"),
    end = raw.lastIndexOf("}");
  if (start < 0 || end < start) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return [];
  }
  const images = (parsed as { images?: unknown }).images;
  if (!Array.isArray(images)) return [];
  const seen = new Set<string>();
  const found: ImageCandidate[] = [];
  for (const item of images as Array<Record<string, unknown>>) {
    if (!item || typeof item.imageUrl !== "string" || typeof item.sourceUrl !== "string") continue;
    try {
      const url = new URL(item.imageUrl.trim());
      const source = new URL(item.sourceUrl.trim());
      if (url.protocol !== "https:" || source.protocol !== "https:" || seen.has(url.href)) continue;
      seen.add(url.href);
      const title =
        typeof item.title === "string" && item.title.trim()
          ? item.title.trim()
          : url.pathname.split("/").pop() || url.hostname;
      found.push({ title, url: url.href, source: source.href });
    } catch {
      /* Not a URL. */
    }
    if (found.length === 6) break;
  }
  return found;
}
