import { parseRecipeRef, STYLE_KINDS } from "./ai/note-style-recipe";
import { normalizeTemplates } from "./ai/detail-templates";
import { normalizePresets } from "./ai/prompt-presets";
import { normalizeReasoningLevel } from "./ai/task-policy";
import {
  DEFAULT_SETTINGS,
  defaultProofModel,
  normalizeMapChatWidth,
  normalizeMapChatOpen,
  normalizeMapChatImageMode,
  resolveMapFolders,
  type Settings
} from "./core/repository-settings";
import { initialUiLanguage } from "./i18n";
import { clampPreviewScale, legacyPreviewScale } from "./ui/preview-utils";

/**
 * The old per-chat model (`mapChatModel`, removed when the chat and the settings page became one current model): a saved
 * non-empty string (trimmed) becomes the current model once; anything else (empty, blank, non-string, null) counts as unset.
 */
function migratedChatModel(saved: Partial<Settings> | null): string {
  const old = (saved as { mapChatModel?: unknown } | null)?.mapChatModel;
  return typeof old === "string" ? old.trim() : "";
}
/** True when the saved data still has the removed `mapChatModel` key and must be rewritten without it. */
export function hasLegacyChatModel(saved: unknown): boolean {
  return !!saved && typeof saved === "object" && "mapChatModel" in saved;
}
/** The kind -> style table: only the seven known kinds, each a ref `parseRecipeRef` reads; nothing left = no key. */
export function normalizeNoteStyleByKind(value: unknown): Settings["noteStyleByKind"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const saved = value as Record<string, unknown>;
  const kept: Record<string, string> = {};
  for (const kind of STYLE_KINDS) {
    const ref = Object.prototype.hasOwnProperty.call(saved, kind) ? saved[kind] : undefined;
    if (typeof ref === "string" && parseRecipeRef(ref)) kept[kind] = ref;
  }
  return Object.keys(kept).length ? kept : undefined;
}
/** The global voice and format: only the two keys, each a part ref of its category; nothing left = no key. */
export function normalizeNoteStyleDefaults(value: unknown): Settings["noteStyleDefaults"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const saved = value as Record<string, unknown>;
  const kept: { voice?: string; format?: string } = {};
  for (const category of ["voice", "format"] as const) {
    const ref = saved[category];
    if (typeof ref === "string" && parseRecipeRef(ref, category)) kept[category] = ref;
  }
  return kept.voice !== undefined || kept.format !== undefined ? kept : undefined;
}
function isStringMap(value: unknown): value is Record<string, string> {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.values(value).every(item => typeof item === "string")
  );
}
/** The conversion marker is kept only when its shape is valid. */
export function normalizeNoteStyleRecipeMarker(value: unknown): Settings["noteStyleRecipe"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const saved = value as { migrated?: unknown; mapsNotified?: unknown; legacy?: unknown };
  if (saved.migrated !== 1) return undefined;
  const legacy = saved.legacy as { templates?: unknown; tones?: unknown } | undefined;
  const legacyOk = legacy === undefined || (!!legacy && isStringMap(legacy.templates) && isStringMap(legacy.tones));
  if (!legacyOk) return undefined;
  return {
    migrated: 1,
    ...(saved.mapsNotified === true ? { mapsNotified: true as const } : {}),
    ...(legacy
      ? {
          legacy: {
            templates: legacy.templates as Record<string, string>,
            tones: legacy.tones as Record<string, string>
          }
        }
      : {})
  };
}
/** A saved model id, or `fallback` when it is missing or not a non-empty string. */
function savedModel(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

/**
 * The settings in effect for what was saved: every field is checked, and a missing or invalid one takes its default. A new
 * install (no language saved) starts in `appLocale`, Obsidian's own language, when VAM has an interface in it.
 */
export function settingsFromSaved(saved: Partial<Settings> | null, appLocale?: string): Settings {
  const legacy: (Partial<Settings> & { cliPath?: string }) | null = saved;
  const savedWorkspace = saved?.workspaceFolder || DEFAULT_SETTINGS.workspaceFolder;
  const bookWriteModel = savedModel(saved?.bookWriteModel, DEFAULT_SETTINGS.bookWriteModel);
  return {
    ...DEFAULT_SETTINGS,
    detailTemplates: normalizeTemplates(saved?.detailTemplates),
    promptPresets: normalizePresets(saved?.promptPresets),
    defaultDetailTemplateId:
      typeof saved?.defaultDetailTemplateId === "string" ? saved.defaultDetailTemplateId : undefined,
    ...(typeof saved?.defaultNoteStyleId === "string" && saved.defaultNoteStyleId
      ? { defaultNoteStyleId: saved.defaultNoteStyleId }
      : {}),
    ...(normalizeNoteStyleByKind(saved?.noteStyleByKind)
      ? { noteStyleByKind: normalizeNoteStyleByKind(saved?.noteStyleByKind) }
      : {}),
    ...(normalizeNoteStyleDefaults(saved?.noteStyleDefaults)
      ? { noteStyleDefaults: normalizeNoteStyleDefaults(saved?.noteStyleDefaults) }
      : {}),
    ...(normalizeNoteStyleRecipeMarker(saved?.noteStyleRecipe)
      ? { noteStyleRecipe: normalizeNoteStyleRecipeMarker(saved?.noteStyleRecipe) }
      : {}),
    ...(typeof saved?.noteStylesFolder === "string" && saved.noteStylesFolder
      ? { noteStylesFolder: saved.noteStylesFolder }
      : {}),
    ...(saved?.noteStyleFiles && typeof saved.noteStyleFiles === "object" && !Array.isArray(saved.noteStyleFiles)
      ? {
          noteStyleFiles: Object.fromEntries(
            Object.entries(saved.noteStyleFiles).filter(([, name]) => typeof name === "string" && name)
          )
        }
      : {}),
    language: initialUiLanguage(saved?.language, appLocale),
    workspaceFolder: savedWorkspace,
    topicsFolder: saved?.topicsFolder || DEFAULT_SETTINGS.topicsFolder,
    ...resolveMapFolders(saved),
    notesFolder: saved?.notesFolder || DEFAULT_SETTINGS.notesFolder,
    mapsFolder: saved?.mapsFolder || DEFAULT_SETTINGS.mapsFolder,
    mapId: saved?.mapId || "default",
    codexPath: saved?.codexPath || legacy?.cliPath || DEFAULT_SETTINGS.codexPath,
    claudePath: saved?.claudePath || DEFAULT_SETTINGS.claudePath,
    cliModel: migratedChatModel(saved) || saved?.cliModel || DEFAULT_SETTINGS.cliModel,
    mapChatWidth: normalizeMapChatWidth(saved?.mapChatWidth),
    mapChatOpen: normalizeMapChatOpen(saved?.mapChatOpen),
    mapChatImageMode: normalizeMapChatImageMode(saved?.mapChatImageMode),
    mapChatRecords: saved?.mapChatRecords === true,
    experimentalArgumentMap: saved?.experimentalArgumentMap === true,
    bookPlanModel: savedModel(saved?.bookPlanModel, DEFAULT_SETTINGS.bookPlanModel),
    bookWriteModel,
    bookImageModel: savedModel(saved?.bookImageModel, DEFAULT_SETTINGS.bookImageModel),
    bookProofModel: savedModel(saved?.bookProofModel, defaultProofModel(bookWriteModel)),
    cliReasoning: normalizeReasoningLevel(saved?.cliReasoning),
    previewScale:
      saved?.previewScale !== undefined
        ? clampPreviewScale(saved.previewScale)
        : legacyPreviewScale(saved?.previewSize),
    models: "",
    migrated: saved?.migrated === true,
    structureVersion: saved?.structureVersion ?? (saved ? 1 : DEFAULT_SETTINGS.structureVersion),
    firstUseNoticeSeen: saved?.firstUseNoticeSeen === true,
    codexUsageNoticeSeen: saved?.codexUsageNoticeSeen === true,
    claudeUsageNoticeSeen: saved?.claudeUsageNoticeSeen === true,
    aiExchangeLoggingEnabled: saved?.aiExchangeLoggingEnabled === true,
    markdownSelectionAiAutoOpen: saved?.markdownSelectionAiAutoOpen !== false,
    addDiagramsAfterResearch: saved?.addDiagramsAfterResearch !== false,
    workspaceInitialized: saved ? saved.workspaceInitialized !== false : false,
    canvasHintSeen: saved?.canvasHintSeen === true
  };
}
