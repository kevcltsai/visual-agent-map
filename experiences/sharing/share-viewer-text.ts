import { translate } from "../../i18n";
import type { ShareViewerUi, ShareViewerUiExtras } from "./share-viewer-ui";
import type { ShareLanguage } from "./share-format";
import { SHARE_VIEWER_UI_EXTRA, type ShareExtraUiLanguage } from "./share-viewer-dictionaries";
import { LANGUAGES, OUTPUT_LANGUAGES } from "../../i18n/languages";

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
    outline: text("share.viewer_outline"),
    untitledMap: text("share.viewer_untitled"),
    language: text("share.viewer_language"),
    aiTranslated: text("share.viewer_ai_translated_0"),
    aiTranslatedUnknown: text("share.viewer_ai_translated_unknown"),
    originalText: text("share.viewer_original_text"),
    imageTextUntranslated: text("share.viewer_image_text_untranslated"),
    markerLabel: text("share.viewer_markers_0"),
    markerNames: {
      done: text("share.viewer_marker_done"),
      warning: text("share.viewer_marker_warning"),
      star: text("share.viewer_marker_star"),
      "priority-1": text("share.viewer_marker_priority_1"),
      "priority-2": text("share.viewer_marker_priority_2"),
      "priority-3": text("share.viewer_marker_priority_3")
    }
  };
}

// Which dictionary a language has comes from the registry and the dictionary table, not from ids written here.
const PLUGIN_LANGUAGE_IDS: readonly string[] = LANGUAGES.map(item => item.id);
const EXTRA_LANGUAGE_IDS: readonly string[] = Object.keys(SHARE_VIEWER_UI_EXTRA);
const isPluginLanguage = (value: string): value is ShareLanguage => PLUGIN_LANGUAGE_IDS.includes(value);
const isExtraLanguage = (value: string): value is ShareExtraUiLanguage => EXTRA_LANGUAGE_IDS.includes(value);

/** A language's own name: the table first, then the platform's, then the tag itself. */
function nativeNameOf(language: string): string {
  const known = [...LANGUAGES, ...OUTPUT_LANGUAGES].find(item => item.id === language);
  if (known) return known.label;
  try {
    const display: string | undefined = new Intl.DisplayNames([language], { type: "language" }).of(language);
    return display ?? language;
  } catch {
    return language;
  }
}

/**
 * The viewer text of every language a translated file carries (zh-TW, zh-CN and en from the plugin dictionaries, ja, ko
 * and es from share-viewer-dictionaries.ts, anything else shows English) and each language's own name, so the viewer
 * switches the whole page without a dictionary of its own.
 */
export function shareViewerUiExtras(languages: readonly string[]): ShareViewerUiExtras {
  const uiByLanguage: Record<string, ShareViewerUi> = {};
  const languageNames: Record<string, string> = {};
  for (const language of languages) {
    uiByLanguage[language] = isPluginLanguage(language)
      ? shareViewerUiFor(language)
      : isExtraLanguage(language)
        ? { ...SHARE_VIEWER_UI_EXTRA[language] }
        : { ...shareViewerUiFor("en"), lang: language };
    languageNames[language] = nativeNameOf(language);
  }
  return { uiByLanguage, languageNames };
}
