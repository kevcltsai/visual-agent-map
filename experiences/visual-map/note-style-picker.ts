import { Notice, normalizePath, TFile, type App } from "obsidian";
import type VisualAgentMapPlugin from "../../main";
import { emptyNoteStyleStore, type NoteStyleStore } from "../../ai/note-style-store";
import type { TopicKind } from "../../note-values";
import { builtinRef } from "../../core/blocks/block-files";
import { t, type TranslationKey } from "../../i18n";
import type { NoteStyleIssue } from "../../ai/note-style-file";
import { backgroundResultNotice } from "../../ui/background-run";
import { ChoiceModal, type Choice } from "../../ui/modals/choice-modal";
import { NOTE_STYLE_PRESETS } from "./note-style";
import { styleRefOf, type StyleRef } from "../../ai/note-style-label";
import { BUILTIN_BLOCKS, BUILTIN_FORMATS } from "../../core/blocks/builtin";
import { AIM_DELIVERY_STRUCTURE, BUILTIN_RECIPES, UPDATE_MODE_KEYS, type UpdateMode } from "../../ai/note-style-recipe";

export { styleRefOf };
export type { StyleRef };

/** One template block of the user in a picker, with the reasons it cannot be read (empty when it can). */
export interface StyleListItem {
  kind: "file";
  /** `file:<name>`, as the map, topic or run stores it. */
  id: string;
  name: string;
  /** The file (with ".md") in the Templates block folder. */
  fileName: string;
  issues: NoteStyleIssue[];
}

/**
 * One style (recipe) in a one-line choice. A structural subset of the store's `RecipeListItem`,
 * so that list can be handed over as it is.
 */
export interface PickerRecipe {
  /** `builtin:<id>` or `file:<name>`. */
  ref: string;
  kind: "builtin" | "file";
  name: string;
  /** The file (with ".md") of a user's style. */
  fileName?: string;
  /** The AIM report: only for the AIM kind, never offered for a topic. */
  aimOnly?: true;
  structure: { name: string };
  voice: { name: string };
  format: { name: string };
  update: UpdateMode;
  issues: NoteStyleIssue[];
}

/** The built-in styles by name, without reading any file (a test double, or a store with no style list yet). */
export function builtinRecipeItems(): PickerRecipe[] {
  const nameOf = (list: readonly { id: string; nameKey: TranslationKey }[], id: string): string => {
    const found = list.find(item => item.id === id);
    return found ? t(found.nameKey) : id;
  };
  const templates = BUILTIN_BLOCKS.filter(block => block.category === "template");
  const tones = BUILTIN_BLOCKS.filter(block => block.category === "tone");
  return BUILTIN_RECIPES.map(recipe => {
    const aim = recipe.structure === AIM_DELIVERY_STRUCTURE;
    return {
      ref: builtinRef(recipe.id),
      kind: "builtin" as const,
      name: t(recipe.nameKey),
      ...(aim ? { aimOnly: true as const } : {}),
      structure: { name: aim ? t(recipe.nameKey) : nameOf(templates, recipe.structure) },
      voice: { name: nameOf(tones, recipe.voice) },
      format: { name: nameOf(BUILTIN_FORMATS, recipe.format) },
      update: recipe.update,
      issues: []
    };
  });
}

/** The four small labels of a style: structure, voice, format and (not for the AIM report) the update mode. */
export function recipeTags(item: PickerRecipe): string {
  const tags = [item.structure.name, item.voice.name, item.format.name];
  if (!item.aimOnly) tags.push(t(UPDATE_MODE_KEYS[item.update]));
  return tags.join(" · ");
}

/** What the four note-style entries need from the block folders (absent in a test double: only the built-ins are listed). */
export interface StylePicker {
  /** Re-reads the block folders; call `list()` afterwards. */
  refresh(): Promise<void>;
  /** The user's own template blocks. */
  list(): StyleListItem[];
  /** Every style, built-ins (the AIM report marked `aimOnly`) first, then the user's style files. */
  recipes(): PickerRecipe[];
  /** Opens the template block behind a style in a new tab (a built-in with no file gets one first). */
  edit(ref: StyleRef): Promise<void>;
}

/** A style file that does not parse stops the run; the Notice offers to open the file. */
export class NoteStyleFileError extends Error {
  constructor(
    message: string,
    readonly open: () => void
  ) {
    super(message);
  }
}

/** A Notice with one action button (open the file, switch style). */
export function actionNotice(message: string, label: string, run: () => void, timeout = 12000): Notice {
  return backgroundResultNotice(message, { label, open: run }, timeout);
}

/** Shows a failure; a bad style file gets an "Open this file" button. */
export function errorNotice(error: unknown): Notice {
  const message = (error as { message?: unknown } | null)?.message;
  const text = typeof message === "string" ? message : String(error);
  if (error instanceof NoteStyleFileError) return actionNotice(text, t("ui.note_style_open_file"), error.open);
  return new Notice(text);
}

export function stylePickerFor(app: App, plugin: VisualAgentMapPlugin): StylePicker | undefined {
  const store = (plugin as { noteStyles?: NoteStyleStore }).noteStyles;
  if (!store) return undefined;
  return {
    refresh: () => store.refresh(),
    list: () =>
      store
        .listBlocks("template")
        .flatMap((item): StyleListItem[] =>
          item.kind === "file" && item.fileName !== undefined
            ? [{ kind: "file", id: item.ref, name: item.name, fileName: item.fileName, issues: item.issues }]
            : []
        ),
    recipes: () => store.listRecipes(),
    edit: ref => openStyleFile(app, store, ref)
  };
}

/** Opens a file of the vault in a new tab; false when it is not there. */
export async function openVaultFile(app: App, path: string): Promise<boolean> {
  const file = app.vault.getAbstractFileByPath(normalizePath(path));
  if (!(file instanceof TFile)) return false;
  await app.workspace.getLeaf("tab").openFile(file);
  return true;
}

/** Opens the template block behind a style in a new tab (a built-in with no file gets one first, as "Open" in the settings does). */
export async function openStyleFile(app: App, store: NoteStyleStore, ref: StyleRef): Promise<void> {
  const name = ref.kind === "file" ? `${ref.id.slice("file:".length)}.md` : ref.id;
  try {
    const blockRef =
      ref.kind === "file"
        ? ref.id
        : builtinRef(NOTE_STYLE_PRESETS.find(item => item.id === ref.id)?.templateId ?? ref.id);
    const { path } = await store.ensureBlockFile("template", blockRef);
    if (!(await openVaultFile(app, path))) new Notice(t("ui.note_style_edit_missing_0", name));
  } catch {
    new Notice(t("ui.note_style_edit_missing_0", name));
  }
}

const ISSUE_KEYS = new Set([
  "file_long",
  "tone_long",
  "frontmatter_unclosed",
  "key_duplicate",
  "no_sections",
  "count_invalid",
  "comment_unclosed",
  "format_heading_repeated",
  // The codes only a style file (a recipe) raises.
  "format_zone_moved",
  "update_invalid",
  "part_name_invalid",
  "part_missing",
  "builtin_name"
]);

/** The translated reason of one parse problem: a file-format code or a template error key. */
export function styleIssueText(issue: NoteStyleIssue): string {
  if (ISSUE_KEYS.has(issue.code)) return t(`ui.note_style_issue_${issue.code}` as TranslationKey, ...issue.values);
  return t(issue.code as TranslationKey, ...issue.values);
}

/** The first problem of an unusable file, as one line for the picker. */
export function styleProblem(item: StyleListItem): string | undefined {
  const first = item.issues[0];
  if (!first) return undefined;
  return t("ui.note_style_unusable_0_1_2", item.fileName, first.line, styleIssueText(first));
}

export interface TopicStyleChooserOptions {
  /** The topic's own frontmatter values: what is "Current setting". */
  note: { noteStyle?: string; detailTemplateId?: string; toneId?: string };
  /** The topic type, which decides what "Follow the topic type" means. */
  kind: TopicKind;
  /** A ref sets `note-style`; null follows the topic type (and removes the old 0.28.0 keys). Never called for the current row. */
  write: (ref: string | null) => void | Promise<void>;
  /** The dialog was closed without a choice. */
  dismissed?: () => void;
}

/**
 * The note style of one topic: "Follow the topic type (X)" first, the topic's old template/tone pair when it has one, then
 * every built-in (not the AIM report) and the user's styles, each with its four small labels. The row in force says "Current
 * setting" and writes nothing; a style file with a problem shows its reason and opens instead of being chosen.
 */
export async function openTopicStyleChooser(
  app: App,
  plugin: VisualAgentMapPlugin,
  options: TopicStyleChooserOptions
): Promise<void> {
  const picker = stylePickerFor(app, plugin);
  const store = (plugin as { noteStyles?: NoteStyleStore }).noteStyles ?? emptyNoteStyleStore(() => plugin.settings);
  try {
    await picker?.refresh();
  } catch {
    /* an unreadable folder keeps the styles read last */
  }
  const recipes = (picker ? picker.recipes() : builtinRecipeItems()).filter(item => !item.aimOnly);
  const language = plugin.settings?.language ?? "en";
  const { note } = options;
  const legacy = !note.noteStyle && (!!note.detailTemplateId || !!note.toneId);
  const followed = store.runStyle({ kind: options.kind, outputLanguage: language });
  const current = t("ui.detail_template_current");
  const describe = (tags: string, isCurrent: boolean): string => (isCurrent ? `${current} · ${tags}` : tags);
  const choices: Choice[] = [];
  const followedItem = recipes.find(item => item.ref === followed.recipe.ref);
  const followCurrent = !note.noteStyle && !legacy;
  choices.push({
    label: t("ui.note_style_follow_kind_0", followed.recipe.name),
    description: describe(
      followedItem ? recipeTags(followedItem) : `${followed.label.templateName} · ${followed.label.toneName}`,
      followCurrent
    ),
    action: () => {
      if (!followCurrent) void options.write(null);
    }
  });
  if (legacy) {
    const old = store.runStyle({
      kind: options.kind,
      topic: { template: note.detailTemplateId, tone: note.toneId },
      outputLanguage: language
    });
    choices.push({
      label: old.recipe.name,
      description: describe(`${old.label.templateName} · ${old.label.toneName}`, true),
      action: () => undefined
    });
  }
  for (const item of recipes) {
    if (item.issues.length) {
      const first = item.issues[0];
      choices.push({
        label: item.name,
        description: t("ui.note_style_unusable_0_1_2", item.fileName ?? item.name, first.line, styleIssueText(first)),
        buttonLabel: t("ui.note_style_open_file"),
        action: () => void picker?.edit({ kind: "file", id: item.ref })
      });
      continue;
    }
    const isCurrent = note.noteStyle === item.ref;
    choices.push({
      label: item.name,
      description: describe(recipeTags(item), isCurrent),
      action: () => {
        if (!isCurrent) void options.write(item.ref);
      }
    });
  }
  new ChoiceModal(
    app,
    t("ui.note_style_topic_title"),
    t("ui.note_style_topic_desc"),
    choices.map(choice => ({ ...choice, named: true })),
    options.dismissed
  ).open();
}
