import type { MapAiMode, ResearchDepth, ResearchMode, VisualMode } from "../../ai/types";

export type { MapAiMode };

export const DEFAULT_MAP_AI_MODE: MapAiMode = "quick";

export function isMapAiMode(value: unknown): value is MapAiMode {
  return value === "quick" || value === "standard";
}

/** The mode a topic note was last researched with: `local` is Quick, `research` is Standard; a missing or unknown value was already read as `local`. */
export function noteAiMode(researchMode: ResearchMode): MapAiMode {
  return researchMode === "local" ? "quick" : "standard";
}

/** The stored `research-mode` value of a mode. */
export function researchModeOf(mode: MapAiMode): ResearchMode {
  return mode === "quick" ? "local" : "research";
}

export interface AiModeOptions {
  researchMode: ResearchMode;
  researchDepth: ResearchDepth;
  visualMode: VisualMode;
  mapAiMode: MapAiMode;
}

/**
 * Everything the task context needs for a mode. A research uses the standard answer format ("normal"); the follow-up
 * research of a new subtopic always uses the short overview ("fast") for both modes. Only Standard may look for images.
 */
export function aiModeOptions(mode: MapAiMode, kind: "research" | "subtopic"): AiModeOptions {
  return {
    researchMode: researchModeOf(mode),
    researchDepth: kind === "research" ? "normal" : "fast",
    visualMode: mode === "standard" ? "auto" : "off",
    mapAiMode: mode
  };
}

/** The fixed sentence a Quick answer writes when neither the sources nor the model's knowledge are enough (never translated). */
const KNOWLEDGE_GAP_MARKERS = ["模型知識不足", "模型知识不足"];
const KNOWLEDGE_GAP_MARKER_EN = "model knowledge is insufficient";

export function hasKnowledgeGapMarker(text: string): boolean {
  return (
    KNOWLEDGE_GAP_MARKERS.some(marker => text.includes(marker)) || text.toLowerCase().includes(KNOWLEDGE_GAP_MARKER_EN)
  );
}
