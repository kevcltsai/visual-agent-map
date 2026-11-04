import { aimContractSchema, type AimContract } from "../../../ai/aim-contracts";
import aimGapAuditSchema from "../../../ai/aim-gap-audit-schema";
import { SEARCH_STATUSES, type TaskContext } from "../../../ai/types";
import SummaryDescription from "./schema-summary-description.md";
import DetailDescription from "./schema-detail-description.md";
import { renderTemplate } from "../../step-runner";
import baseResponseSchema from "../../../response-schema.json";
import { instructionLanguageOf, languagePromptName, type ContentLanguage } from "../../../i18n";

/** How a task context is answered: the response schema sent to the model and the flags its parser needs. */
export interface TaskResponseShape {
  schema: unknown;
  isAimGapAudit: boolean;
  isIsolatedWebResearch: boolean;
  contract?: AimContract;
}

/**
 * The response schema with its two prose field descriptions written for the output language. The descriptions are part of
 * what the model reads, so the fixed Chinese wording in `response-schema.json` pulled English and other runs into Chinese.
 * zh-TW keeps the file's Traditional wording unchanged, zh-CN has the same sentences in Simplified Chinese; every other language names itself.
 */
export function localizedResponseSchema(language: ContentLanguage): typeof baseResponseSchema {
  if (language === "zh-CN") {
    return {
      ...baseResponseSchema,
      properties: {
        ...baseResponseSchema.properties,
        summary: { type: "string", description: "适合思维导图的一句简体中文结论，80 字内" },
        detail: { type: "string", description: "完整的简体中文 Markdown 分析" }
      }
    };
  }
  if (instructionLanguageOf(language) === "zh") return baseResponseSchema;
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
  const isAimGapAudit =
    context.responseContract === "aim-gap-audit" && context.promptProfile === "aim" && context.researchMode === "local";
  const isDeliveryAcceptance =
    context.responseContract === "aim-delivery-acceptance" &&
    context.promptProfile === "aim" &&
    context.researchMode === "local";
  const deliverySchema = {
    ...responseSchema,
    properties: {
      ...responseSchema.properties,
      summary: {
        type: "string",
        description: "A short plain-language preview. Never put machine-readable review markers here."
      },
      detail: {
        type: "string",
        pattern: "^\\s*<!--\\s*aim-review\\s+\\{[^\\r\\n]*\\}\\s*-->",
        description:
          "Begin with the COMPLETE first-line AIM review marker containing decision and rationale (and stopReason for conclude). Put the marker in detail only, followed by the acceptance explanation. Never split or truncate the marker."
      }
    }
  };
  const isIsolatedWebResearch = context.aimIsolatedResearch === true && context.researchMode !== "local";
  const webResearchSchema = {
    ...responseSchema,
    properties: {
      ...responseSchema.properties,
      searchStatus: {
        type: "string",
        enum: [...SEARCH_STATUSES],
        description:
          "completed only when at least one web search or page fetch returned usable results for this task; failed when searching was attempted without usable results; not_attempted when no search ran."
      }
    },
    required: [...responseSchema.required, "searchStatus"]
  };
  const contract = context.promptProfile === "aim" && !isAimGapAudit ? context.aimContract : undefined;
  const schema = contract
    ? aimContractSchema(
        contract,
        isIsolatedWebResearch ? webResearchSchema : responseSchema,
        context.aimEvidenceLookup === true
      )
    : isAimGapAudit
      ? aimGapAuditSchema
      : isDeliveryAcceptance
        ? deliverySchema
        : isIsolatedWebResearch
          ? webResearchSchema
          : responseSchema;
  return { schema, isAimGapAudit, isIsolatedWebResearch, ...(contract ? { contract } : {}) };
}
