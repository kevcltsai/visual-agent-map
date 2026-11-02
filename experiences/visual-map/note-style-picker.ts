import { Notice, normalizePath, TFile, type App } from "obsidian";
import type VisualAgentMapPlugin from "../../main";
import { builtinPairOf, type NoteStyleAliases } from "../../ai/note-style-upgrade";
import type { NoteStyleStore } from "../../ai/note-style-store";
import { builtinRef, parseBlockRef } from "../../core/blocks/block-files";
import { t, type TranslationKey } from "../../i18n";
import type { NoteStyleIssue } from "../../ai/note-style-file";
import { backgroundResultNotice } from "../../ui/background-run";
import { ChoiceModal, type Choice } from "../../ui/modals/choice-modal";
import { NOTE_STYLE_PRESETS } from "./note-style";

/** Which style a picker row stands for: a built-in style id, or `file:<name>` of a template block the user wrote. */
export interface StyleRef {
  kind: "builtin" | "file";
  id: string;
}

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

/** What the four note-style entries need from the block folders (absent in a test double: only the built-ins are listed). */
export interface StylePicker {
  /** Re-reads the block folders; call `list()` afterwards. */
  refresh(): Promise<void>;
  /** The user's own template blocks. */
  list(): StyleListItem[];
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

/**
 * The style a stored template and tone pair stands for, when it is a built-in or a template block of the user. An old id
 * the upgrade moved to a block (`aliases`) stands for that block.
 */
export function styleRefOf(
  templateId: string | undefined,
  toneId: string | undefined,
  aliases: NoteStyleAliases = {}
): StyleRef | undefined {
  const builtin = builtinPairOf(templateId, toneId);
  if (builtin) return { kind: "builtin", id: builtin };
  if (parseBlockRef(templateId)?.kind === "file" && templateId) return { kind: "file", id: templateId };
  const moved =
    templateId && Object.prototype.hasOwnProperty.call(aliases, templateId) ? aliases[templateId] : undefined;
  if (moved?.template && parseBlockRef(moved.template)?.kind === "file") return { kind: "file", id: moved.template };
  return undefined;
}

const ISSUE_KEYS = new Set([
  "file_long",
  "tone_long",
  "frontmatter_unclosed",
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
  /** The pair to store for the chosen style; a template block comes without a tone (the layer's tone stays). */
  pick: (templateId: string, toneId: string | undefined) => void;
}

/** A list of every usable style: five built-ins and the user's template blocks; a bad block shows its reason and opens instead. */
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
  const bad = (item: StyleListItem, label: string): Choice => ({
    label,
    description: styleProblem(item),
    buttonLabel: t("ui.note_style_open_file"),
    action: () => void picker?.edit({ kind: item.kind, id: item.id })
  });
  const choices: Choice[] = [...(options.leading ?? [])];
  for (const preset of NOTE_STYLE_PRESETS) {
    const ref: StyleRef = { kind: "builtin", id: preset.id };
    choices.push({ label: t(preset.name), ...mark(ref), action: () => options.pick(preset.templateId, preset.toneId) });
  }
  for (const item of items) {
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
