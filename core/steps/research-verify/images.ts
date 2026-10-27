import { renderTemplate, type StepDefinition } from "../../step-runner";
import type { Phase2Image } from "../../seamless-research/apply";
import { IMAGES_ARRAY_SCHEMA, ResearchVerifyParseError, parseImageRows } from "./step";
import template from "./images.md";

export interface ResearchImagesInput {
  topic: string;
  /** Parent context for the topic; may be empty. */
  context: string;
}
export interface ResearchImagesResult {
  images: Phase2Image[];
}

export const RESEARCH_IMAGES_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: { images: IMAGES_ARRAY_SCHEMA },
  required: ["images"]
};

/** Strict parse of the images reply. Throws ResearchVerifyParseError; eligibleImages decides what may be downloaded. */
export function parseResearchImages(raw: string): ResearchImagesResult {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new ResearchVerifyParseError("not-json", "the reply is not JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ResearchVerifyParseError("not-object", "the reply is not an object");
  const keys = Object.keys(value);
  if (keys.some(key => key !== "images")) throw new ResearchVerifyParseError("unexpected-field", keys.join(","));
  return { images: parseImageRows((value as { images?: unknown }).images) };
}

/**
 * Seamless research images: a separate web call per topic, run alongside research-verify.
 * The model opens candidate pages and reports direct image links with the license stated there. Not localized.
 */
export const researchImagesStep: StepDefinition<ResearchImagesInput, ResearchImagesResult> = {
  id: "research.images",
  version: 1,
  render: input =>
    renderTemplate(template, { topic: JSON.stringify(input.topic), context: JSON.stringify(input.context) }),
  schema: RESEARCH_IMAGES_SCHEMA,
  parse: raw => parseResearchImages(raw)
};
