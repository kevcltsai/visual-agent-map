import type { DetailCount } from "../../ai/detail-templates";
import type { RunStyle } from "../../ai/note-style-store";

/** The AIM outline limit (`parseDeliveryOutline`): a style with more sections cannot be the outline. */
export const AIM_MAX_SECTIONS = 12;
const CHART_BLOCK = "```mermaid";

/** A note style other than the AIM report, reduced to what the final document needs. */
export interface AimNoteStyle {
  /** The recipe ref; part of the checkpoint fingerprint. */
  ref: string;
  sections: readonly { name: string; description: string; count?: DetailCount }[];
  /** Absent for the academic voice. */
  toneText?: string;
  /** The format rules text; "" adds no format text. */
  formatText: string;
  /** Whether the style asks for a mermaid diagram (never for the lean format). */
  charts: boolean;
}

/** Undefined (the AIM report, today's behavior) for no style, the AIM report style, or a section count the outline cannot hold. */
export function aimNoteStyleOf(style: RunStyle | undefined): AimNoteStyle | undefined {
  if (!style || style.recipe.aimDelivery) return undefined;
  const sections = style.template.sections;
  if (!sections.length || sections.length > AIM_MAX_SECTIONS) return undefined;
  const mapped = sections.map(section => ({
    name: section.name,
    description: section.description.trim(),
    ...(section.count ? { count: section.count } : {})
  }));
  const lean = style.contextFields.styleSelection?.format?.id === "lean";
  return {
    ref: style.recipe.ref,
    sections: mapped,
    ...(style.toneText === undefined ? {} : { toneText: style.toneText }),
    formatText: style.formatText,
    charts: !lean && (style.formatText.includes(CHART_BLOCK) || mapped.some(s => s.description.includes(CHART_BLOCK)))
  };
}

/** The sections as prompt text: a `###` heading, the description, and the item count; deterministic. */
export function renderAimStructure(sections: AimNoteStyle["sections"]): string {
  return sections
    .map(section =>
      [
        `### ${section.name}`,
        section.description,
        section.count ? `${section.count.mode === "exact" ? "Exactly" : "At least"} ${section.count.n} items.` : ""
      ]
        .filter(Boolean)
        .join("\n")
    )
    .join("\n\n");
}
