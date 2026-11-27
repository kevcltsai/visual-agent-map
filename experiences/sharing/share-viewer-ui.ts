import type { TopicColor } from "../../topic-colors";
import type { TopicMarker } from "../../topic-markers";
import type { ShareNodeKind, ShareRelationKind } from "./share-format";

/**
 * Interface text of the share viewer. The exporter fills it in its own interface language and it travels inside the file
 * (`<script type="application/json" id="vam-ui">`), so the viewer needs no dictionary. `{0}` is replaced by the viewer.
 * No imports: the viewer bundle shares this type.
 */
export interface ShareViewerUi {
  /** BCP 47 tag of this text (the file's own page language follows the content language, see the viewer). */
  lang: string;
  readOnly: string;
  madeWithVam: string;
  install: string;
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
  /** `{0}` is the file size (for example `412 KB`): the label of an attached file's download button. */
  attachmentDownload: string;
  /** Shown on a file card whose file is not in the shared file (too big, images off, or not found). */
  attachmentNotIncluded: string;
  /** Mark on a card that points at a card of another map (the card shows its title only). */
  refLabel: string;
  /** Shown in place of a reference whose original card could not be used. */
  refUnavailable: string;
  resizePanel: string;
  /** Label of the outline (the topic tree on the left) and of its toggle button. */
  outline: string;
  untitledMap: string;
  /** Label of the language menu in the toolbar. */
  language: string;
  /** `{0}` is the name of the original language. Shown while a translated version is open. */
  aiTranslated: string;
  /** Same notice when the original language is unknown (no `{0}`). */
  aiTranslatedUnknown: string;
  /** Menu name of the original text when its language is unknown. */
  originalText: string;
  /** Shown beside the AI notice: pictures keep their original text. */
  imageTextUntranslated: string;
  /** Accessible-name part of a topic that has markers; `{0}` is the marker names joined (ticket 33). */
  markerLabel: string;
  /** Accessible name of the topic's link row; `{0}` is the link hosts joined. */
  linksLabel: string;
  /** Accessible name of one link; `{0}` is its host. */
  linkOpen: string;
  /** Pill and accessible name of an annotated image on the canvas. */
  annotatedImage: string;
  /** `{0}` is the number of anchors on the picture. */
  annotatedAnchors: string;
  /** `{0}` is the anchor's note. */
  anchorNamed: string;
  /** Accessible name of an anchor without a note. */
  anchorUnnamed: string;
  /** The name of each topic marker, read by screen readers instead of the symbol. */
  markerNames: Record<TopicMarker, string>;
  /** Accessible-name part of a topic that has a colour; `{0}` is the colour name (ticket 37). */
  colorLabel: string;
  /** The name of each topic colour, so colour is never the only cue. */
  colorNames: Record<TopicColor, string>;
  /** Accessible-name part of a topic that has a type; `{0}` is the type name (share-complete). */
  kindLabel: string;
  /** The name of each topic type, shown on the card and in the side panel. */
  kindNames: Record<ShareNodeKind, string>;
  /** The name of each relation kind, shown on the line and in the side panel's list. */
  relationNames: Record<ShareRelationKind, string>;
  /** Heading of the side panel's relation list. */
  relationsHeading: string;
  /** Accessible name of a frame around cards, and `{0}` the frame's own name. */
  frameLabel: string;
  frameNamed: string;
  /** Click-to-play YouTube card: the play button label, the note under it, and the link that opens the video on YouTube. */
  videoPlay: string;
  videoNote: string;
  /** The note under the play card when the file is opened from disk: play opens YouTube in a new tab. */
  videoNoteLocal: string;
  videoOpen: string;
  /** The same three texts for a Facebook or Instagram video, `{0}` the site's name. */
  videoPlaySite: string;
  videoNoteSite: string;
  videoOpenSite: string;
}

/**
 * What a translated file adds next to the plain interface text (inside the same `vam-ui` block, so a file without
 * translations is unchanged): the interface text per language of the file, and each language's own name.
 */
export interface ShareViewerUiExtras {
  uiByLanguage?: Record<string, ShareViewerUi>;
  languageNames?: Record<string, string>;
}

/** English text, the fallback when a field is missing or not a string in a hand-edited file (a test keeps it equal to the en dictionary). */
export const SHARE_VIEWER_UI_DEFAULT: Readonly<ShareViewerUi> = {
  lang: "en",
  readOnly: "Shared map · read-only",
  madeWithVam: "Made with VAM",
  install: "Install VAM",
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
  attachmentDownload: "Download ({0})",
  attachmentNotIncluded: "Not included",
  refLabel: "Reference",
  refUnavailable: "Unavailable reference",
  resizePanel: "Resize the side panel",
  outline: "Outline",
  untitledMap: "Untitled map",
  language: "Language",
  aiTranslated: "Translated by AI from {0}.",
  aiTranslatedUnknown: "Translated by AI.",
  originalText: "Original",
  imageTextUntranslated: "Text inside images is not translated.",
  markerLabel: "Markers: {0}",
  linksLabel: "Links: {0}",
  linkOpen: "Open link: {0}",
  annotatedImage: "Annotated image",
  annotatedAnchors: "{0} anchors",
  anchorNamed: "Anchor: {0}",
  anchorUnnamed: "Anchor (no note)",
  markerNames: {
    done: "Done",
    warning: "Warning",
    star: "Star",
    "priority-1": "Priority 1",
    "priority-2": "Priority 2",
    "priority-3": "Priority 3",
    "priority-4": "Priority 4",
    "priority-5": "Priority 5",
    "progress-0": "Progress 0%",
    "progress-25": "Progress 25%",
    "progress-50": "Progress 50%",
    "progress-75": "Progress 75%",
    "progress-100": "Progress 100%",
    "flag-red": "Red flag",
    "flag-yellow": "Yellow flag",
    "flag-green": "Green flag",
    "flag-blue": "Blue flag",
    smile: "Smile",
    neutral: "Neutral",
    sad: "Sad",
    question: "Question"
  },
  colorLabel: "Color: {0}",
  colorNames: { red: "Red", orange: "Orange", yellow: "Yellow", green: "Green", blue: "Blue", purple: "Purple" },
  kindLabel: "Type: {0}",
  kindNames: {
    action: "Action",
    atomic: "Atomic knowledge",
    hypothesis: "Hypothesis",
    evidence: "Evidence",
    conclusion: "Conclusion"
  },
  relationNames: {
    supports: "Supports",
    contradicts: "Contradicts",
    verifies: "Verifies",
    derives_from: "Derives from",
    related: "Related",
    prerequisite: "Prerequisite"
  },
  relationsHeading: "Relations",
  frameLabel: "Frame",
  frameNamed: "Frame: {0}",
  videoPlay: "Click to play the YouTube video",
  videoNote: "The video only connects to YouTube when you play it (the no-cookie version)",
  videoNoteLocal: "Opened from a file, the video plays on YouTube in a new tab",
  videoOpen: "Open on YouTube",
  videoPlaySite: "Click to play the {0} video",
  videoNoteSite: "The video only connects to {0} when you play it",
  videoOpenSite: "Open on {0}"
};
