import type { TaskContext } from "../../../ai/types";
import SummaryDescription from "./schema-summary-description.md";
import DetailDescription from "./schema-detail-description.md";
import { renderTemplate } from "../../step-runner";
import baseResponseSchema from "../../../response-schema.json";
import { instructionLanguageOf, languagePromptName, translate, type ContentLanguage } from "../../../i18n";

/** How a task context is answered: the response schema sent to the model and the flags its parser needs. */
export interface TaskResponseShape {
  schema: unknown;
  /** Argument-evidence contract: the need ids the reply may cite (from the request, never from the reply). */
  argumentEvidenceNeedIds?: string[];
}

/** Reply schema of the argument-evidence contract: the usual summary and detail plus one entry per answered need. */
function argumentEvidenceSchema(responseSchema: typeof baseResponseSchema, needIds: readonly string[]): unknown {
  return {
    ...responseSchema,
    properties: {
      ...responseSchema.properties,
      argumentEvidence: {
        type: "array",
        minItems: 1,
        maxItems: needIds.length,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            need: { type: "string", enum: [...needIds] },
            status: { type: "string", enum: ["found", "not_found"] },
            stance: { type: "string", enum: ["supports", "contradicts", "uncertain"] },
            claim: { type: "string" },
            quote: { type: "string", maxLength: 200 },
            url: { type: "string" }
          },
          required: ["need", "status", "stance", "claim", "quote", "url"]
        }
      }
    },
    required: [...responseSchema.required, "argumentEvidence"]
  };
}

/**
 * The response schema with its two prose field descriptions written for the output language. The descriptions are part of
 * what the model reads, so the fixed Chinese wording in `response-schema.json` pulled English and other runs into Chinese.
 * zh-TW keeps the file's Traditional wording unchanged, zh-CN has the same sentences in Simplified Chinese; every other language names itself.
 */
export function localizedResponseSchema(language: ContentLanguage): typeof baseResponseSchema {
  if (instructionLanguageOf(language) === "zh") {
    // The Chinese-instruction languages read their own dictionary row (zh-TW is the file's wording, zh-CN is Simplified).
    return {
      ...baseResponseSchema,
      properties: {
        ...baseResponseSchema.properties,
        summary: { type: "string", description: translate(language, "schema.summary_description") },
        detail: { type: "string", description: translate(language, "schema.detail_description") }
      }
    };
  }
  const variables = { language: languagePromptName(language, "en", "plain") };
  return {
    ...baseResponseSchema,
    properties: {
      ...baseResponseSchema.properties,
      summary: { type: "string", description: renderTemplate(SummaryDescription, variables) },
      detail: { type: "string", description: renderTemplate(DetailDescription, variables) }
    }
  };
}

export function taskResponseShape(context: TaskContext, language: ContentLanguage): TaskResponseShape {
  const responseSchema = localizedResponseSchema(language);
  if (context.responseContract === "argument-evidence") {
    const needIds = (context.argumentEvidenceNeeds ?? []).map(need => need.id);
    if (
      !needIds.length ||
      new Set(needIds).size !== needIds.length ||
      needIds.some(id => !id) ||
      context.researchMode !== "research"
    )
      throw new Error("The argument-evidence contract needs distinct need ids and a plain research request.");
    return {
      schema: argumentEvidenceSchema(responseSchema, needIds),
      argumentEvidenceNeedIds: needIds
    };
  }
  return { schema: responseSchema };
}
