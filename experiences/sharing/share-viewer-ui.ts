/**
 * Interface text of the share viewer. The exporter fills it in its own interface language and it travels inside the file
 * (`<script type="application/json" id="vam-ui">`), so the viewer needs no dictionary. `{0}` is replaced by the viewer.
 * No imports: the viewer bundle shares this type.
 */
export interface ShareViewerUi {
  /** BCP 47 tag for `<html lang>`. */
  lang: "en" | "zh-TW" | "zh-CN";
  readOnly: string;
  madeWithVam: string;
  install: string;
  /** `{0}` is the map goal. */
  goal: string;
  hint: string;
  layout: string;
  collapseAll: string;
  expandAll: string;
  /** `{0}` is the level number. */
  expandToLevel: string;
  autoLayout: string;
  zoomIn: string;
  zoomOut: string;
  /** `{0}` is the zoom percentage, e.g. "100%". */
  zoomReset: string;
  showAll: string;
  toResearch: string;
  tierCore: string;
  tierSupport: string;
  tierSide: string;
  /** Reason shown for a tier the author set by hand (no `reason`). */
  manualReason: string;
  topicDetails: string;
  detailsButton: string;
  close: string;
  collapse: string;
  /** `{0}` is the number of hidden subtopics. */
  expandCount: string;
  subtopics: string;
  noContent: string;
  imageOmitted: string;
  /** `{0}` is the web address the image came from (shown as a link under the image). */
  imageSource: string;
  resizePanel: string;
  untitledMap: string;
}

/** English text, the fallback when a field is missing or not a string in a hand-edited file (a test keeps it equal to the en dictionary). */
export const SHARE_VIEWER_UI_DEFAULT: Readonly<ShareViewerUi> = {
  lang: "en",
  readOnly: "Shared map · read-only",
  madeWithVam: "Made with VAM",
  install: "Install VAM",
  goal: "Goal: {0}",
  hint: "Drag empty space to pan · Scroll to zoom · Click a topic to read it",
  layout: "Layout",
  collapseAll: "Collapse all",
  expandAll: "Expand all",
  expandToLevel: "Expand to level {0}",
  autoLayout: "Auto layout",
  zoomIn: "Zoom in",
  zoomOut: "Zoom out",
  zoomReset: "Zoom {0}, reset to 100%",
  showAll: "Show all",
  toResearch: "To research",
  tierCore: "Must learn",
  tierSupport: "Learn when needed",
  tierSide: "Skippable",
  manualReason: "You set this",
  topicDetails: "Topic details",
  detailsButton: "Details",
  close: "Close",
  collapse: "Collapse",
  expandCount: "Expand {0}",
  subtopics: "Subtopics",
  noContent: "This topic has no notes in the shared file.",
  imageOmitted: "[image not included]",
  imageSource: "Source: {0}",
  resizePanel: "Resize the side panel",
  untitledMap: "Untitled map"
};
