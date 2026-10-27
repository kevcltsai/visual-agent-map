import { instructionLanguageOf, type ContentLanguage } from "../../../i18n";
import { MAX_IMAGES, isHttpsUrl } from "../../seamless-research/apply";
import type { Phase2Footnote, Phase2Image, Phase2Verdict } from "../../seamless-research/apply";
import { renderTemplate, type StepDefinition } from "../../step-runner";
import { languageVariables, type FragmentPair } from "../_shared/fragments";
import promptEn from "./prompt.en.md";
import promptZh from "./prompt.zh.md";
import skeletonEn from "./skeleton.en.md";
import skeletonZh from "./skeleton.zh.md";

export interface ResearchVerifyInput {
  topic: string;
  /** Parent context for the topic; may be empty. */
  context: string;
  /** The filtered phase-1 text. */
  skeleton: string;
  language: ContentLanguage;
}
export interface ResearchVerifyResult {
  detail: string;
  footnotes: Phase2Footnote[];
  verdicts: Phase2Verdict[];
  images: Phase2Image[];
}

export type ResearchVerifyParseReason =
  "not-json" | "not-object" | "unexpected-field" | "detail" | "footnotes" | "verdicts" | "images" | "too-many-images";

/** The phase-2 reply does not match the schema. Never turned into an empty or partial success. */
export class ResearchVerifyParseError extends Error {
  readonly reason: ResearchVerifyParseReason;
  constructor(reason: ResearchVerifyParseReason, detail: string) {
    super(`Invalid research-verify response (${reason}): ${detail}`);
    this.name = "ResearchVerifyParseError";
    this.reason = reason;
  }
}

const stringField = { type: "string" };
const httpsField = { type: "string", pattern: "^https://" };
export const RESEARCH_VERIFY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    detail: { type: "string", minLength: 1 },
    footnotes: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: { id: { type: "string", pattern: "^[\\w-]+$" }, url: httpsField, title: stringField },
        required: ["id", "url", "title"]
      }
    },
    verdicts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          sentence: { type: "string", minLength: 1 },
          verdict: { type: "string", enum: ["supported", "unsupported"] },
          correction: stringField,
          sourceUrl: httpsField
        },
        required: ["sentence", "verdict"]
      }
    },
    images: {
      type: "array",
      maxItems: MAX_IMAGES,
      items: {
        type: "object",
        additionalProperties: false,
        properties: { imageUrl: httpsField, sourceUrl: httpsField, title: stringField, license: stringField },
        required: ["imageUrl", "sourceUrl", "title", "license"]
      }
    }
  },
  required: ["detail", "footnotes", "verdicts", "images"]
};

type Row = Record<string, unknown>;
const isRow = (value: unknown): value is Row => !!value && typeof value === "object" && !Array.isArray(value);
const onlyKeys = (row: Row, allowed: readonly string[]): boolean =>
  Object.keys(row).every(key => allowed.includes(key));

function rows(value: unknown, reason: ResearchVerifyParseReason, keys: readonly string[]): Row[] {
  if (!Array.isArray(value)) throw new ResearchVerifyParseError(reason, "not an array");
  return value.map((item, index) => {
    if (!isRow(item) || !onlyKeys(item, keys))
      throw new ResearchVerifyParseError(reason, `item ${index} is not an object with the expected fields`);
    return item;
  });
}
function text(row: Row, key: string, reason: ResearchVerifyParseReason, required = true): string {
  const value = row[key];
  if (typeof value !== "string" || (required && !value.trim()))
    throw new ResearchVerifyParseError(reason, `${key} must be ${required ? "a non-empty " : "a "}string`);
  return value;
}
function https(row: Row, key: string, reason: ResearchVerifyParseReason): string {
  const value = text(row, key, reason).trim();
  if (!isHttpsUrl(value)) throw new ResearchVerifyParseError(reason, `${key} must be an https address`);
  return value;
}

/** Strict parse of the phase-2 reply: exact fields, https addresses only, at most six images. Any mismatch throws ResearchVerifyParseError. */
export function parseResearchVerify(raw: string): ResearchVerifyResult {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new ResearchVerifyParseError("not-json", "the reply is not JSON");
  }
  if (!isRow(value)) throw new ResearchVerifyParseError("not-object", "the reply is not an object");
  if (!onlyKeys(value, ["detail", "footnotes", "verdicts", "images"]))
    throw new ResearchVerifyParseError("unexpected-field", Object.keys(value).join(","));
  const detail = text(value, "detail", "detail").trim();
  const footnotes = rows(value.footnotes, "footnotes", ["id", "url", "title"]).map(row => {
    const id = text(row, "id", "footnotes").trim();
    if (!/^[\w-]+$/.test(id)) throw new ResearchVerifyParseError("footnotes", "id has unsupported characters");
    return { id, url: https(row, "url", "footnotes"), title: text(row, "title", "footnotes", false).trim() };
  });
  const verdicts = rows(value.verdicts, "verdicts", ["sentence", "verdict", "correction", "sourceUrl"]).map(row => {
    const verdict = row.verdict;
    if (verdict !== "supported" && verdict !== "unsupported")
      throw new ResearchVerifyParseError("verdicts", "verdict must be supported or unsupported");
    const item: Phase2Verdict = { sentence: text(row, "sentence", "verdicts").trim(), verdict };
    if (row.correction !== undefined) item.correction = text(row, "correction", "verdicts", false).trim();
    if (row.sourceUrl !== undefined) item.sourceUrl = https(row, "sourceUrl", "verdicts");
    return item;
  });
  const imageRows = rows(value.images, "images", ["imageUrl", "sourceUrl", "title", "license"]);
  if (imageRows.length > MAX_IMAGES)
    throw new ResearchVerifyParseError("too-many-images", `${imageRows.length} images`);
  const images = imageRows.map(row => ({
    imageUrl: https(row, "imageUrl", "images"),
    sourceUrl: https(row, "sourceUrl", "images"),
    title: text(row, "title", "images", false).trim(),
    license: text(row, "license", "images", false).trim()
  }));
  return { detail, footnotes, verdicts, images };
}

const PROMPT: FragmentPair = { zh: promptZh, en: promptEn };
const SKELETON: FragmentPair = { zh: skeletonZh, en: skeletonEn };

/** Task text for phase 1: the conservative skeleton instruction in the language's instruction language. */
export function skeletonInstruction(language: ContentLanguage): string {
  return renderTemplate(SKELETON[instructionLanguageOf(language)], {});
}

/**
 * Phase 2: search the web, add sourced detail to the skeleton, judge each skeleton sentence, and find licensed images.
 * Run it with web search only. A reply that does not match the schema is a ResearchVerifyParseError.
 */
export const researchVerifyStep: StepDefinition<ResearchVerifyInput, ResearchVerifyResult> = {
  id: "research-verify",
  version: 1,
  render: input =>
    renderTemplate(PROMPT[instructionLanguageOf(input.language)], {
      ...languageVariables(input.language, { language: "region" }, undefined, undefined, {
        kind: "question",
        text: input.topic
      }),
      topic: JSON.stringify(input.topic),
      context: JSON.stringify(input.context),
      skeleton: JSON.stringify(input.skeleton)
    }),
  schema: RESEARCH_VERIFY_SCHEMA,
  parse: raw => parseResearchVerify(raw)
};
