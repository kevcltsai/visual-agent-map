import { Notice, normalizePath, TFile, type App } from "obsidian";
import type VisualAgentMapPlugin from "../../main";
import { STANDARD_TEMPLATE_ID } from "../../ai/detail-templates";
import { builtinPairOf, type NoteStyleStore, type StyleListItem } from "../../ai/note-style-store";
import { t, type TranslationKey } from "../../i18n";
import type { NoteStyleIssue } from "../../ai/note-style-file";
import { backgroundResultNotice } from "../../ui/background-run";
import { ChoiceModal, type Choice } from "../../ui/modals/choice-modal";
import { NOTE_STYLE_PRESETS } from "./note-style";

/** Which style a picker row stands for: a built-in id, `style:<name>` of a file, or the uuid of an old custom template. */
export interface StyleRef {
  kind: "builtin" | "file" | "legacy";
  id: string;
}

/** What the four note-style entries need from the style folder (absent in a test double: only the built-ins are listed). */
export interface StylePicker {
  /** Re-reads the folder; call `list()` afterwards. */
  refresh(): Promise<void>;
  list(): StyleListItem[];
  /** Old custom templates that have no file yet (they stay pickable). */
  unexported(): { id: string; name: string }[];
  /** Creates the folder and files when needed, then opens the style's file in a new tab. */
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
    list: () => store.list(),
    unexported: () => store.unexportedTemplates().map(({ id, name }) => ({ id, name })),
    edit: ref => openStyleFile(app, store, ref)
  };
}

/** Opens the file of a style in a new tab (creating the folder and files first, as "Open the styles folder" does). */
export async function openStyleFile(app: App, store: NoteStyleStore, ref: StyleRef): Promise<void> {
  try {
    const folder = await store.ensureStyleFolder();
    const item = store.list().find(entry => entry.kind === ref.kind && entry.id === ref.id);
    if (!item) {
      new Notice(
        t("ui.note_style_edit_missing_0", ref.kind === "file" ? `${ref.id.slice("style:".length)}.md` : ref.id)
      );
      return;
    }
    const file = app.vault.getAbstractFileByPath(normalizePath(`${folder}/${item.fileName}`));
    if (file instanceof TFile) await app.workspace.getLeaf("tab").openFile(file);
    else new Notice(t("ui.note_style_edit_missing_0", item.fileName));
  } catch (error) {
    new Notice(error instanceof Error ? error.message : String(error));
  }
}

/** The style a stored template and tone pair stands for, when it is a built-in, a file or an old template. */
export function styleRefOf(
  templateId: string | undefined,
  toneId: string | undefined,
  oldTemplateIds: readonly string[] = []
): StyleRef | undefined {
  const builtin = builtinPairOf(templateId, toneId);
  if (builtin) return { kind: "builtin", id: builtin };
  if (templateId?.startsWith("style:")) return { kind: "file", id: templateId };
  if (templateId && templateId !== STANDARD_TEMPLATE_ID && oldTemplateIds.includes(templateId))
    return { kind: "legacy", id: templateId };
  return undefined;
}

const ISSUE_KEYS = new Set([
  "file_long",
  "tone_long",
  "frontmatter_unclosed",
  "frontmatter_line",
  "value_invalid",
  "key_duplicate",
  "no_sections",
  "count_invalid",
  "comment_unclosed",
  "format_heading_repeated"
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

export interface StyleChooserOptions {
  title: string;
  description: string;
  /** Rows before the styles (e.g. "Use the default"). */
  leading?: Choice[];
  /** Marks the row of the style in force. */
  current?: StyleRef;
  /** The style "Edit this style" opens when none is set (e.g. the workspace default); falls back to current. */
  editRef?: StyleRef;
  /** Old custom templates to list when there is no style folder (a plugin without a store). */
  oldTemplates?: { id: string; name: string }[];
  /** The pair to store for the chosen style; a file style comes without a tone (the caller deletes the layer's tone). */
  pick: (templateId: string, toneId: string | undefined) => void;
}

/** A list of every usable style: five built-ins, the files, old templates; a bad file shows its reason and opens instead. */
export async function openStyleChooser(
  app: App,
  picker: StylePicker | undefined,
  options: StyleChooserOptions
): Promise<void> {
  if (picker) await picker.refresh();
  const items = picker?.list() ?? [];
  const same = (ref: StyleRef): boolean => options.current?.kind === ref.kind && options.current.id === ref.id;
  const mark = (ref: StyleRef): { description?: string } =>
    same(ref) ? { description: t("ui.detail_template_current") } : {};
  const issueOf = (kind: StyleRef["kind"], id: string): StyleListItem | undefined =>
    items.find(item => item.kind === kind && item.id === id && item.issues.length);
  const bad = (item: StyleListItem, label: string): Choice => ({
    label,
    description: styleProblem(item),
    buttonLabel: t("ui.note_style_open_file"),
    action: () => void picker?.edit({ kind: item.kind, id: item.id })
  });
  const choices: Choice[] = [...(options.leading ?? [])];
  for (const preset of NOTE_STYLE_PRESETS) {
    const ref: StyleRef = { kind: "builtin", id: preset.id };
    const broken = issueOf("builtin", preset.id);
    choices.push(
      broken
        ? bad(broken, t(preset.name))
        : { label: t(preset.name), ...mark(ref), action: () => options.pick(preset.templateId, preset.toneId) }
    );
  }
  for (const item of items) {
    if (item.kind === "builtin") continue;
    if (item.issues.length) {
      choices.push(bad(item, item.name));
      continue;
    }
    const ref: StyleRef = { kind: item.kind, id: item.id };
    choices.push({
      label: item.name,
      ...mark(ref),
      action: () => options.pick(item.id, undefined)
    });
  }
  for (const old of picker?.unexported() ?? options.oldTemplates ?? []) {
    choices.push({
      label: old.name,
      ...mark({ kind: "legacy", id: old.id }),
      action: () => options.pick(old.id, undefined)
    });
  }
  const editRef = options.current ?? options.editRef;
  if (editRef && picker)
    choices.push({
      label: t("ui.note_style_edit"),
      description: t("ui.note_style_edit_current_desc"),
      buttonLabel: t("ui.note_style_edit_button"),
      action: () => void picker.edit(editRef)
    });
  new ChoiceModal(
    app,
    options.title,
    options.description,
    choices.map(choice => ({ ...choice, named: true }))
  ).open();
}
