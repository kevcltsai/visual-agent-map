import { translate } from "../../i18n";
import type { ShareViewerUi } from "./share-viewer-ui";
import type { ShareLanguage } from "./share-format";

/** The viewer's interface text in `language` (the exporter's interface language), from the plugin dictionaries. */
export function shareViewerUiFor(language: ShareLanguage): ShareViewerUi {
  const text = (key: Parameters<typeof translate>[1]): string => translate(language, key);
  return {
    lang: language,
    readOnly: text("share.viewer_read_only"),
    madeWithVam: text("share.viewer_made_with"),
    install: text("share.viewer_install"),
    goal: text("share.viewer_goal_0"),
    hint: text("share.viewer_hint"),
    layout: text("ui.layout"),
    collapseAll: text("ui.collapse_all"),
    expandAll: text("ui.expand_all"),
    expandToLevel: text("ui.expand_to_level_0"),
    autoLayout: text("ui.auto_layout"),
    zoomIn: text("ui.zoom_in"),
    zoomOut: text("ui.zoom_out"),
    zoomReset: text("ui.zoom_level_0_reset"),
    showAll: text("ui.show_all"),
    toResearch: text("ui.to_research"),
    tierCore: text("ui.relevance_core"),
    tierSupport: text("ui.relevance_support"),
    tierSide: text("ui.relevance_side"),
    manualReason: text("ui.relevance_manual_reason"),
    topicDetails: text("share.viewer_topic_details"),
    detailsButton: text("share.viewer_details_button"),
    close: text("ui.close"),
    collapse: text("ui.collapse"),
    expandCount: text("share.viewer_expand_0"),
    subtopics: text("share.viewer_subtopics"),
    noContent: text("share.viewer_no_content"),
    imageOmitted: text("share.viewer_image_omitted"),
    imageSource: text("share.viewer_image_source_0"),
    resizePanel: text("share.viewer_resize_panel"),
    untitledMap: text("share.viewer_untitled")
  };
}
