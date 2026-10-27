import { instructionLanguageOf, type ContentLanguage } from "../../../i18n";
import { MAX_IMAGES, normalizeHttpsUrl } from "../../seamless-research/apply";
import type { Phase2Footnote, Phase2Image, Phase2Verdict } from "../../seamless-research/apply";
import { renderTemplate, type StepDefinition } from "../../step-runner";
import { languageVariables, type FragmentPair } from "../_shared/fragments";
import promptEn from "./prompt.en.md";
import promptZh from "./prompt.zh.md";
import extraRequirementsEn from "./extra-requirements.en.md";
import extraRequirementsZh from "./extra-requirements.zh.md";
import extraStructureEn from "./extra-structure.en.md";
import extraStructureZh from "./extra-structure.zh.md";
import extraToneEn from "./extra-tone.en.md";
import extraToneZh from "./extra-tone.zh.md";
import skeletonEn from "./skeleton.en.md";
import skeletonZh from "./skeleton.zh.md";

export interface ResearchVerifyInput {
  topic: string;
  /** Parent context for the topic; may be empty. */
  context: string;
  /** The filtered phase-1 text. */
  skeleton: string;
  language: ContentLanguage;
  /** The user's extra requirements for this topic (dialog, chat direction or research card). Empty adds nothing to the prompt. */
  requirements?: string;
  /** Writing tone text of the chosen tone. Empty adds nothing. */
  toneText?: string;
  /** Section outline of a content template the user chose (one line per section). Empty adds nothing. */
  structure?: string;
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
export const IMAGES_ARRAY_SCHEMA = {
  type: "array",
  maxItems: MAX_IMAGES,
  items: {
    type: "object",
    additionalProperties: false,
    properties: { imageUrl: httpsField, sourceUrl: httpsField, title: stringField, license: stringField },
    required: ["imageUrl", "sourceUrl", "title", "license"]
  }
};
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
    images: IMAGES_ARRAY_SCHEMA
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
/** The shape needs an https address (a different scheme is a parse error); an address that fails the URL gate returns undefined and the caller drops that one item. */
function https(row: Row, key: string, reason: ResearchVerifyParseReason): string | undefined {
  const value = text(row, key, reason).trim();
  if (!/^https:\/\//i.test(value)) throw new ResearchVerifyParseError(reason, `${key} must be an https address`);
  return normalizeHttpsUrl(value);
}

/** Strict parse of an `images` array: exact fields, https addresses only, at most six. */
export function parseImageRows(value: unknown): Phase2Image[] {
  const imageRows = rows(value, "images", ["imageUrl", "sourceUrl", "title", "license"]);
  if (imageRows.length > MAX_IMAGES)
    throw new ResearchVerifyParseError("too-many-images", `${imageRows.length} images`);
  return imageRows.flatMap(row => {
    const imageUrl = https(row, "imageUrl", "images");
    const sourceUrl = https(row, "sourceUrl", "images");
    const title = text(row, "title", "images", false).trim();
    const license = text(row, "license", "images", false).trim();
    return imageUrl && sourceUrl ? [{ imageUrl, sourceUrl, title, license }] : [];
  });
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
  const footnotes = rows(value.footnotes, "footnotes", ["id", "url", "title"]).flatMap(row => {
    const id = text(row, "id", "footnotes").trim();
    if (!/^[\w-]+$/.test(id)) throw new ResearchVerifyParseError("footnotes", "id has unsupported characters");
    const url = https(row, "url", "footnotes");
    const title = text(row, "title", "footnotes", false).trim();
    return url ? [{ id, url, title }] : [];
  });
  const verdicts = rows(value.verdicts, "verdicts", ["sentence", "verdict", "correction", "sourceUrl"]).map(row => {
    const verdict = row.verdict;
    if (verdict !== "supported" && verdict !== "unsupported")
      throw new ResearchVerifyParseError("verdicts", "verdict must be supported or unsupported");
    const item: Phase2Verdict = { sentence: text(row, "sentence", "verdicts").trim(), verdict };
    if (row.correction !== undefined) item.correction = text(row, "correction", "verdicts", false).trim();
    if (row.sourceUrl !== undefined) {
      const sourceUrl = https(row, "sourceUrl", "verdicts");
      if (sourceUrl) item.sourceUrl = sourceUrl;
    }
    return item;
  });
  const images = parseImageRows(value.images);
  return { detail, footnotes, verdicts, images };
}

const PROMPT: FragmentPair = { zh: promptZh, en: promptEn };
const SKELETON: FragmentPair = { zh: skeletonZh, en: skeletonEn };
const EXTRA_REQUIREMENTS: FragmentPair = { zh: extraRequirementsZh, en: extraRequirementsEn };
const EXTRA_TONE: FragmentPair = { zh: extraToneZh, en: extraToneEn };
const EXTRA_STRUCTURE: FragmentPair = { zh: extraStructureZh, en: extraStructureEn };

/** The optional blocks that carry the user's choices into phase 2. Nothing is added when a choice is empty. */
function extraBlocks(input: ResearchVerifyInput): string {
  const side = instructionLanguageOf(input.language);
  const blocks: string[] = [];
  const requirements = input.requirements?.trim();
  const tone = input.toneText?.trim();
  const structure = input.structure?.trim();
  if (requirements)
    blocks.push(renderTemplate(EXTRA_REQUIREMENTS[side], { requirements: JSON.stringify(requirements) }).trimEnd());
  if (tone) blocks.push(renderTemplate(EXTRA_TONE[side], { tone }).trimEnd());
  if (structure) blocks.push(renderTemplate(EXTRA_STRUCTURE[side], { structure }).trimEnd());
  return blocks.join("\n\n");
}

/** Task text for phase 1: the conservative skeleton instruction in the language's instruction language. */
export function skeletonInstruction(language: ContentLanguage): string {
  return renderTemplate(SKELETON[instructionLanguageOf(language)], {});
}

/**
 * Phase 2: search the web, add sourced detail to the skeleton, and judge each skeleton sentence. Images come from the separate researchImagesStep; the `images` field is kept in the schema and is always empty here.
 * Run it with web search only. A reply that does not match the schema is a ResearchVerifyParseError.
 */
export const researchVerifyStep: StepDefinition<ResearchVerifyInput, ResearchVerifyResult> = {
  id: "research-verify",
  version: 1,
  render: input => {
    const prompt = renderTemplate(PROMPT[instructionLanguageOf(input.language)], {
      ...languageVariables(input.language, { language: "region" }, undefined, undefined, {
        kind: "question",
        text: input.topic
      }),
      topic: JSON.stringify(input.topic),
      context: JSON.stringify(input.context),
      skeleton: JSON.stringify(input.skeleton)
    });
    const extra = extraBlocks(input);
    return extra ? `${prompt.trimEnd()}\n\n${extra}\n` : prompt;
  },
  schema: RESEARCH_VERIFY_SCHEMA,
  parse: raw => parseResearchVerify(raw)
};
