import { estimateTokens } from "../ai/context-builder";
import { referenceBatches, type ReferenceGroup } from "../ai/reference-materials";
import { translate, uiLocale } from "../i18n";
import { estimateCondenseCalls, MAX_CONDENSE_CALLS, sourceText } from "./source-gateway";
import {
  OUTLINE_GENERATE_TOKEN_BUDGET,
  outlineGenerateStep,
  type OutlineGenerateRequest
} from "./steps/outline-generate/step";

/**
 * The map's data sources for one outline request, decided against this step's own budget (the whole serialized request):
 * the documents as they are when the request fits, else their condensed findings when those fit, else the request is refused
 * whole (the same notice every source feature uses) before anything is sent. Nothing is truncated. Returns "" when there are no sources.
 */
export async function outlineSourceMaterial(
  request: OutlineGenerateRequest,
  groups: readonly ReferenceGroup[],
  condense: () => Promise<string>
): Promise<string> {
  if (!groups.some(group => group.documents.length)) return "";
  const refuse = (): Error => new Error(translate(uiLocale(request.language), "ui.source_context_exceeds_budget"));
  const fits = (material: string): boolean =>
    estimateTokens(outlineGenerateStep.render({ ...request, sourceMaterial: material })) <=
    OUTLINE_GENERATE_TOKEN_BUDGET;
  const direct = sourceText(groups, referenceBatches([...groups]).join("\n\n"));
  if (fits(direct)) return direct;
  if (estimateCondenseCalls(groups) > MAX_CONDENSE_CALLS) throw refuse();
  const condensed = sourceText(groups, await condense());
  if (!fits(condensed)) throw refuse();
  return condensed;
}
