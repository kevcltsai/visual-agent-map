import { instructionLanguageOf, LANGUAGES, translate, type TranslationKey, type UiLanguage } from "../i18n";
import PlainZH from "./prompt-presets/plain.zh.md";
import PlainEN from "./prompt-presets/plain.en.md";
import MagazineZH from "./prompt-presets/magazine.zh.md";
import MagazineEN from "./prompt-presets/magazine.en.md";
import SummaryZH from "./prompt-presets/summary.zh.md";
import SummaryEN from "./prompt-presets/summary.en.md";
import GuideZH from "./prompt-presets/guide.zh.md";
import GuideEN from "./prompt-presets/guide.en.md";
import AcademicZH from "./prompt-presets/academic.zh.md";
import AcademicEN from "./prompt-presets/academic.en.md";
import AutoZH from "./prompt-presets/auto.zh.md";
import AutoEN from "./prompt-presets/auto.en.md";
import KnowledgeTreeZH from "./prompt-presets/knowledge-tree.zh.md";
import KnowledgeTreeEN from "./prompt-presets/knowledge-tree.en.md";

/**
 * Prompt presets: reusable text a user picks instead of retyping. `tone` presets steer the writing voice of notes;
 * `outline` presets are outline-generator prompts. Built-ins live here (immutable, localized); custom ones live in the
 * `promptPresets` setting. The pure helpers below never mutate their input.
 */
export type PromptPresetKind = "tone" | "outline";
export interface PromptPreset {
  id: string;
  kind: PromptPresetKind;
  name: string;
  text: string;
}

/** The tone used when a map or topic names none: today's behaviour, adds nothing to prompts. */
export const DEFAULT_TONE_ID = "academic";
export const AUTO_TONE_ID = "auto";
export const DEFAULT_OUTLINE_PRESET_ID = "knowledge-tree";
/** The outline preset's topic placeholder, per language; the outline generator replaces it with the topic. */
export const OUTLINE_TOPIC_PLACEHOLDER: Readonly<Record<UiLanguage, string>> = Object.fromEntries(
  LANGUAGES.map(item => [item.id, translate(item.id, "ui.outline_topic_placeholder")])
) as Record<UiLanguage, string>;

const strip = (text: string): string => (text.endsWith("\n") ? text.slice(0, -1) : text);

interface BuiltinDefinition {
  id: string;
  kind: PromptPresetKind;
  nameKey: TranslationKey;
  zh: string;
  en: string;
}
const BUILTINS: readonly BuiltinDefinition[] = [
  { id: "plain", kind: "tone", nameKey: "ui.preset_name_plain", zh: PlainZH, en: PlainEN },
  {
    id: "magazine",
    kind: "tone",
    nameKey: "ui.preset_name_magazine",
    zh: MagazineZH,
    en: MagazineEN
  },
  { id: "summary", kind: "tone", nameKey: "ui.preset_name_summary", zh: SummaryZH, en: SummaryEN },
  { id: "guide", kind: "tone", nameKey: "ui.preset_name_guide", zh: GuideZH, en: GuideEN },
  {
    id: DEFAULT_TONE_ID,
    kind: "tone",
    nameKey: "ui.preset_name_academic",
    zh: AcademicZH,
    en: AcademicEN
  },
  { id: AUTO_TONE_ID, kind: "tone", nameKey: "ui.preset_name_auto", zh: AutoZH, en: AutoEN },
  {
    id: DEFAULT_OUTLINE_PRESET_ID,
    kind: "outline",
    nameKey: "ui.preset_name_knowledge_tree",
    zh: KnowledgeTreeZH,
    en: KnowledgeTreeEN
  }
];

export function isBuiltinPreset(id: string): boolean {
  return BUILTINS.some(item => item.id === id);
}

export function builtinPresets(language: UiLanguage, kind?: PromptPresetKind): PromptPreset[] {
  const instruction = instructionLanguageOf(language);
  return BUILTINS.filter(item => !kind || item.kind === kind).map(item => ({
    id: item.id,
    kind: item.kind,
    name: translate(language, item.nameKey),
    text: strip(item[instruction])
  }));
}

/** Load-time normalization of the `promptPresets` setting: drops malformed entries, duplicates and built-in ids. */
export function normalizePresets(value: unknown): PromptPreset[] {
  if (!Array.isArray(value)) return [];
  const result: PromptPreset[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const item = entry as Partial<PromptPreset>;
    if (typeof item.id !== "string" || !item.id.trim() || isBuiltinPreset(item.id)) continue;
    if (item.kind !== "tone" && item.kind !== "outline") continue;
    if (typeof item.name !== "string" || !item.name.trim() || typeof item.text !== "string") continue;
    if (result.some(existing => existing.id === item.id)) continue;
    result.push({ id: item.id, kind: item.kind, name: item.name, text: item.text });
  }
  return result;
}

/** Built-in presets of `kind` first, then the custom ones of that kind. */
export function listPresets(
  custom: readonly PromptPreset[] | undefined,
  kind: PromptPresetKind,
  language: UiLanguage
): PromptPreset[] {
  return [...builtinPresets(language, kind), ...(custom ?? []).filter(item => item.kind === kind)];
}

export function findPreset(
  custom: readonly PromptPreset[] | undefined,
  kind: PromptPresetKind,
  id: string | undefined,
  language: UiLanguage
): PromptPreset | undefined {
  return id ? listPresets(custom, kind, language).find(item => item.id === id) : undefined;
}

/** The preset for `id`, or the kind's default (academic / knowledge-tree) when `id` is absent or unknown. */
export function resolvePreset(
  custom: readonly PromptPreset[] | undefined,
  kind: PromptPresetKind,
  id: string | undefined,
  language: UiLanguage
): { preset: PromptPreset; missing: boolean } {
  const found = findPreset(custom, kind, id, language);
  const fallbackId = kind === "tone" ? DEFAULT_TONE_ID : DEFAULT_OUTLINE_PRESET_ID;
  return { preset: found ?? findPreset(custom, kind, fallbackId, language)!, missing: !!id && !found };
}

/**
 * The tone text to put in TaskContext.toneText. Precedence: topic override > map default > academic. An unknown id
 * falls through to the next level. Academic (and nothing chosen) returns undefined so prompts stay byte-identical.
 */
export function resolveToneText(
  custom: readonly PromptPreset[] | undefined,
  ids: readonly (string | undefined)[],
  language: UiLanguage
): string | undefined {
  for (const id of ids) {
    const found = findPreset(custom, "tone", id, language);
    if (!found) continue;
    return found.id === DEFAULT_TONE_ID ? undefined : found.text.trim() || undefined;
  }
  return undefined;
}

function uniqueId(existing: readonly PromptPreset[], kind: PromptPresetKind): string {
  for (let n = 1; ; n++) {
    const id = `custom-${kind}-${n}`;
    if (!existing.some(item => item.id === id) && !isBuiltinPreset(id)) return id;
  }
}

/** Append a new custom preset; a blank name is rejected (list returned unchanged). */
export function createPreset(
  custom: readonly PromptPreset[],
  input: { kind: PromptPresetKind; name: string; text: string }
): { presets: PromptPreset[]; created?: PromptPreset } {
  if (!input.name.trim()) return { presets: [...custom] };
  const created: PromptPreset = {
    id: uniqueId(custom, input.kind),
    kind: input.kind,
    name: input.name.trim(),
    text: input.text
  };
  return { presets: [...custom, created], created };
}

/** Copy any preset (built-in or custom) into a new custom one; the name defaults to "<name> copy". */
export function duplicatePreset(
  custom: readonly PromptPreset[],
  sourceId: string,
  language: UiLanguage,
  name?: string
): { presets: PromptPreset[]; created?: PromptPreset } {
  const source = [...builtinPresets(language), ...custom].find(item => item.id === sourceId);
  if (!source) return { presets: [...custom] };
  const suffix = translate(language, "ui.preset_copy_suffix");
  return createPreset(custom, { kind: source.kind, name: name ?? `${source.name}${suffix}`, text: source.text });
}

/** Edit a custom preset's name and/or text. Built-ins, unknown ids and a blank name leave the list unchanged. */
export function updatePreset(
  custom: readonly PromptPreset[],
  id: string,
  patch: { name?: string; text?: string }
): PromptPreset[] {
  if (isBuiltinPreset(id) || (patch.name !== undefined && !patch.name.trim())) return [...custom];
  return custom.map(item =>
    item.id === id
      ? {
          ...item,
          ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
          ...(patch.text !== undefined ? { text: patch.text } : {})
        }
      : item
  );
}

/** Remove a custom preset. Built-ins and unknown ids leave the list unchanged. */
export function deletePreset(custom: readonly PromptPreset[], id: string): PromptPreset[] {
  return isBuiltinPreset(id) ? [...custom] : custom.filter(item => item.id !== id);
}
