import type { UiLanguage } from "../i18n";
import type { ReasoningLevel } from "../ai/types";
import { FALLBACK_MODEL } from "../ai/model-resolution";
import type { PromptPreset } from "../ai/prompt-presets";
import type { StyleKind } from "../ai/note-style-recipe";
import type { DetailTemplate } from "../ai/detail-templates";
import { clampMapChatWidth, MAP_CHAT_WIDTH_DEFAULT } from "./map-chat-layout";

export interface Settings {
  /** Hidden developer switch (edit data.json only, no settings UI): off hides every way to start or resume hypothesis research. Old argument maps still open. */
  experimentalArgumentMap: boolean;
  /** Models of the picture-book pipeline's three roles (model ids as in `cliModel`). */
  bookPlanModel: string;
  bookWriteModel: string;
  bookImageModel: string;
  bookProofModel: string;
  /** Save every map AI conversation as a record file in the map folder (off by default). */
  mapChatRecords: boolean;
  detailTemplates: DetailTemplate[];
  defaultDetailTemplateId?: string;
  /** Workspace default note style: `style:<file name>`, an old template id, or a built-in style id. Absent = defaultDetailTemplateId. */
  defaultNoteStyleId?: string;
  /** The style each kind uses (a style ref); a kind with no entry uses its built-in style. Read only until the settings page writes it. */
  noteStyleByKind?: Partial<Record<StyleKind, string>>;
  /** The global voice and format (part refs); a missing key is the built-in default (academic, standard). */
  noteStyleDefaults?: { voice?: string; format?: string };
  /** The marker of the conversion to the recipe model, and the old id -> new ref table that implicit styles read. */
  noteStyleRecipe?: {
    migrated: 1;
    mapsNotified?: true;
    legacy?: { templates: Record<string, string>; tones: Record<string, string> };
  };
  /** Persisted identity state of the notes AI cards reference (see experiences/visual-map/living-node-sources.ts). */
  livingSourceIdentity?: unknown[];
  /** The note style folder; written when the user first creates it. Absent = `<workspace>/<localized name>`. */
  noteStylesFolder?: string;
  /** Old custom template id -> the style file it was exported to (with ".md"). */
  noteStyleFiles?: Record<string, string>;
  /** Custom tone/outline presets; built-ins live in ai/prompt-presets.ts. Absent = none. */
  promptPresets?: PromptPreset[];
  language: UiLanguage;
  workspaceFolder: string;
  /** Legacy container (pre-0.19): maps here stay openable; new maps go to mindMapsFolder / aimFolder. */
  topicsFolder: string;
  mindMapsFolder: string;
  aimFolder: string;
  notesFolder: string;
  mapsFolder: string;
  mapId: string;
  codexPath: string;
  claudePath: string;
  cliModel: string;
  /** Width in pixels of the map AI chat's side window (280 to 560); remembered between sessions. */
  mapChatWidth: number;
  /** Whether the side window was open when the map was last used; remembered between sessions. */
  mapChatOpen: boolean;
  /** The chat's switch "AI changes to a picture": show a preview first, or apply at once. Remembered between sessions. */
  mapChatImageMode: "preview" | "direct";
  cliReasoning: ReasoningLevel;
  previewSize?: "small" | "medium" | "large";
  previewScale: number;
  models: string;
  migrated: boolean;
  structureVersion: number;
  firstUseNoticeSeen: boolean;
  codexUsageNoticeSeen: boolean;
  claudeUsageNoticeSeen: boolean;
  aiExchangeLoggingEnabled: boolean;
  markdownSelectionAiAutoOpen: boolean;
  /** Add diagrams after research (default on): the chart step after a note or an AIM conclusion is written. */
  addDiagramsAfterResearch: boolean;
  workspaceInitialized: boolean;
  canvasHintSeen: boolean;
  /** Fingerprint of the recovery files the startup notice already reported; absent when none were left. */
  reportedRecoveryFiles?: string;
}
const BOOK_PLAN_MODEL = "claude:sonnet";
const BOOK_WRITE_MODEL = "claude:opus";
const BOOK_IMAGE_MODEL = "claude:haiku";
/** The AI proofread model when none is set: not the author's own model and not weaker (opus: sonnet, sonnet: opus, haiku or unknown: sonnet). */
export function defaultProofModel(authorModel: string): string {
  return authorModel.includes("sonnet") ? "claude:opus" : "claude:sonnet";
}
const BOOK_PROOF_MODEL = defaultProofModel(BOOK_WRITE_MODEL);
export const DEFAULT_SETTINGS: Settings = {
  detailTemplates: [],
  promptPresets: [],
  language: "en",
  workspaceFolder: "Agent Workspace",
  topicsFolder: "Agent Workspace/Topics",
  mindMapsFolder: "Agent Workspace/Mind Maps",
  aimFolder: "Agent Workspace/AIM",
  notesFolder: "Agent Workspace/Nodes",
  mapsFolder: "Agent Workspace/Maps",
  mapId: "default",
  codexPath: "codex",
  claudePath: "claude",
  cliModel: FALLBACK_MODEL,
  mapChatWidth: MAP_CHAT_WIDTH_DEFAULT,
  mapChatOpen: true,
  mapChatImageMode: "preview",
  mapChatRecords: false,
  experimentalArgumentMap: false,
  bookPlanModel: BOOK_PLAN_MODEL,
  bookWriteModel: BOOK_WRITE_MODEL,
  bookImageModel: BOOK_IMAGE_MODEL,
  bookProofModel: BOOK_PROOF_MODEL,
  cliReasoning: "low",
  previewScale: 120,
  models: "",
  migrated: false,
  structureVersion: 2,
  firstUseNoticeSeen: false,
  codexUsageNoticeSeen: false,
  claudeUsageNoticeSeen: false,
  aiExchangeLoggingEnabled: false,
  markdownSelectionAiAutoOpen: true,
  addDiagramsAfterResearch: true,
  workspaceInitialized: false,
  canvasHintSeen: false
};

/** Saved width of the map chat's side window: a whole number from 280 to 560; anything else is the default. */
export function normalizeMapChatWidth(value: unknown): number {
  return clampMapChatWidth(value);
}
/** Saved open state of the map chat's side window; open unless it was saved as closed. */
export function normalizeMapChatOpen(value: unknown): boolean {
  return value !== false;
}

/** Saved choice of the map chat for AI changes to a picture: "preview" (show me first) unless saved as "direct". */
export function normalizeMapChatImageMode(value: unknown): "preview" | "direct" {
  return value === "direct" ? "direct" : "preview";
}

/**
 * Map container folders for loaded settings: a saved value wins (never rewritten for upgraded users);
 * otherwise they derive from the saved workspace folder, so a custom workspace gets sibling folders.
 */
export function resolveMapFolders(
  saved: Partial<Pick<Settings, "workspaceFolder" | "mindMapsFolder" | "aimFolder">> | null | undefined
): Pick<Settings, "mindMapsFolder" | "aimFolder"> {
  const workspace = saved?.workspaceFolder || DEFAULT_SETTINGS.workspaceFolder;
  return {
    mindMapsFolder: saved?.mindMapsFolder || `${workspace}/Mind Maps`,
    aimFolder: saved?.aimFolder || `${workspace}/AIM`
  };
}

/** Folders that hold managed topic folders: the two current containers plus the legacy Topics container. */
export function managedMapContainers(
  settings: Pick<Settings, "topicsFolder" | "mindMapsFolder" | "aimFolder">
): string[] {
  return [settings.mindMapsFolder, settings.aimFolder, settings.topicsFolder];
}
/** The container (from managedMapContainers) that holds `path`, or undefined for maps outside all of them. */
export function managedMapContainer(
  settings: Pick<Settings, "topicsFolder" | "mindMapsFolder" | "aimFolder">,
  path: string
): string | undefined {
  return managedMapContainers(settings).find(folder => path.startsWith(`${folder}/`));
}
export function isManagedMapPath(
  settings: Pick<Settings, "topicsFolder" | "mindMapsFolder" | "aimFolder">,
  path: string
): boolean {
  return managedMapContainer(settings, path) !== undefined;
}
