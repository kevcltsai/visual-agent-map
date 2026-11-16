import {
  GLOBAL_PART_DEFAULT,
  KIND_DEFAULT_RECIPE,
  parseRecipeRef,
  withGlobalPart,
  type PartCategory,
  type StyleKind
} from "./note-style-recipe";
import type { NoteStyleSettings, StyleCategory } from "./note-style-store";

/**
 * The writes that keep the three style reference tables (`noteStyleByKind`, `noteStyleDefaults`, `noteStyleRecipe.legacy`),
 * the topics' `note-style` and the style files' part keys in step with a style or part file that is renamed or deleted.
 * No Obsidian, repository or i18n here: the plugin builds the ports (lazy closures, read when the function runs) and shows
 * the Notices. Stateless: nothing is kept between calls.
 */
export type NoteStyleRefSettings = Pick<NoteStyleSettings, "noteStyleByKind" | "noteStyleDefaults" | "noteStyleRecipe">;

export interface NoteStylePorts {
  /** The live settings object, read each time it is needed (it can be replaced while a call waits). */
  settings(): NoteStyleRefSettings;
  save(): Promise<void>;
  files: {
    renameFile(
      category: StyleCategory,
      ref: string,
      name: string
    ): Promise<
      { ok: true; ref: string; unchanged?: true } | { ok: false; reason: "missing" | "name" | "taken" | "failed" }
    >;
    rewritePartRefs(
      category: PartCategory,
      oldName: string,
      newName: string
    ): Promise<{ changed: string[]; failed: string[] }>;
    trashFile(category: StyleCategory, ref: string): Promise<unknown>;
  };
  topics: {
    /** The topics that name a style in their `note-style`. */
    list(): { path: string; ref: string }[];
    /** Writes the new ref into one topic; false when it no longer names `from`. */
    rename(path: string, from: string, to: string): Promise<boolean>;
  };
}

export type RenameStyleResult =
  | { ok: true; ref: string; unchanged: true; topics: 0; styles: 0; failed: [] }
  | {
      ok: true;
      ref: string;
      unchanged?: undefined;
      topics: number;
      styles: number;
      /** The style files, then the topics, that could not be written. */
      failed: string[];
      /** The settings could not be saved; the caller puts its label first in `failed`. */
      settingsFailed: boolean;
    }
  | { ok: false; reason: "missing" | "name" | "taken" | "failed" };

/**
 * Renames a style or part file and follows it: `noteStyleByKind`, the topics' `note-style`, and for a part the style files
 * that name it, the `legacy` table and the global voice or format. A refused name changes nothing (the store's answer is
 * returned as it is). A settings save, topic or style file that cannot be written does not stop the others; `failed` lists
 * them (the caller adds the settings label first).
 */
export async function renameStyleReferences(
  ports: NoteStylePorts,
  category: StyleCategory,
  ref: string,
  name: string
): Promise<RenameStyleResult> {
  const topics = category === "recipe" ? ports.topics.list().filter(item => item.ref === ref) : [];
  const oldName = ref.slice("file:".length);
  const renamed = await ports.files.renameFile(category, ref, name);
  if (!renamed.ok) return renamed;
  if (renamed.unchanged) return { ok: true, ref, unchanged: true, topics: 0, styles: 0, failed: [] };
  const failed: string[] = [];
  let settingsFailed = false;
  const next = renamed.ref;
  const settings = ports.settings();
  const swap = <T extends Record<string, string>>(table: T | undefined): T | undefined =>
    table && Object.values(table).includes(ref)
      ? (Object.fromEntries(Object.entries(table).map(([key, value]) => [key, value === ref ? next : value])) as T)
      : undefined;
  let settingsChanged = false;
  const byKind = category === "recipe" ? swap(settings.noteStyleByKind) : undefined;
  if (byKind) {
    settings.noteStyleByKind = byKind;
    settingsChanged = true;
  }
  if (category !== "recipe") {
    const legacy = settings.noteStyleRecipe?.legacy;
    const table = category === "structure" ? "templates" : category === "voice" ? "tones" : undefined;
    const swapped = table ? swap(legacy?.[table]) : undefined;
    if (legacy && table && swapped) {
      settings.noteStyleRecipe = { ...settings.noteStyleRecipe!, legacy: { ...legacy, [table]: swapped } };
      settingsChanged = true;
    }
    const defaults = settings.noteStyleDefaults;
    if (category !== "structure" && defaults?.[category] === ref) {
      settings.noteStyleDefaults = { ...defaults, [category]: next };
      settingsChanged = true;
    }
  }
  if (settingsChanged) {
    try {
      await ports.save();
    } catch {
      settingsFailed = true;
    }
  }
  let styles = 0;
  if (category !== "recipe") {
    const written = await ports.files.rewritePartRefs(category, oldName, next.slice("file:".length));
    styles = written.changed.length;
    failed.push(...written.failed);
  }
  let changedTopics = 0;
  for (const topic of topics) {
    try {
      if (await ports.topics.rename(topic.path, ref, next)) changedTopics++;
    } catch {
      failed.push(topic.path);
    }
  }
  return { ok: true, ref: next, topics: changedTopics, styles, failed, settingsFailed };
}

/** Removes the entries of `noteStyleByKind` that name `ref` (those topic types go back to their built-in style); one save, none when nothing matched. Returns the kinds. */
export async function clearKindStyles(ports: NoteStylePorts, ref: string): Promise<StyleKind[]> {
  const settings = ports.settings();
  const stored = settings.noteStyleByKind;
  const kinds = stored ? (Object.keys(stored) as StyleKind[]).filter(kind => stored[kind] === ref) : [];
  if (!kinds.length) return kinds;
  const next = { ...stored };
  for (const kind of kinds) delete next[kind];
  if (Object.keys(next).length) settings.noteStyleByKind = next;
  else delete settings.noteStyleByKind;
  await ports.save();
  return kinds;
}

/** Sets the style a kind uses. Choosing the kind's own built-in style removes the entry (a kind with no entry uses it). One save. */
export async function setKindStyle(ports: NoteStylePorts, kind: StyleKind, ref: string): Promise<void> {
  const settings = ports.settings();
  const next = { ...settings.noteStyleByKind };
  if (ref === KIND_DEFAULT_RECIPE[kind]) delete next[kind];
  else next[kind] = ref;
  if (Object.keys(next).length) settings.noteStyleByKind = next;
  else delete settings.noteStyleByKind;
  await ports.save();
}

/**
 * Sets the global voice or format (a part ref). Choosing the built-in default removes the key, and the whole object when no
 * key is left. Does nothing (no save) for a value that is not a part ref.
 */
export async function setGlobalPart(ports: NoteStylePorts, category: "voice" | "format", ref: string): Promise<void> {
  if (!parseRecipeRef(ref, category)) return;
  const settings = ports.settings();
  const next = withGlobalPart(settings.noteStyleDefaults, category, ref);
  if (next) settings.noteStyleDefaults = next;
  else delete settings.noteStyleDefaults;
  await ports.save();
}

/**
 * Moves a style or part file to the trash and clears what named it: a style, the topic types that used it; a part, the
 * global voice or format that named it. Returns false, changing nothing else, when the file could not be moved. Errors
 * after the move (a failing save) are not caught.
 */
export async function deleteStyleReferences(
  ports: NoteStylePorts,
  category: StyleCategory,
  ref: string
): Promise<boolean> {
  try {
    await ports.files.trashFile(category, ref);
  } catch {
    return false;
  }
  if (category === "recipe") await clearKindStyles(ports, ref);
  else if (category !== "structure" && ports.settings().noteStyleDefaults?.[category] === ref)
    await setGlobalPart(ports, category, GLOBAL_PART_DEFAULT[category]);
  return true;
}
