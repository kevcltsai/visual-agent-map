import { translate, type NoteLanguage } from "../i18n";
import type { MapDocument, TopicRelationKind } from "../map-model";
import { REFERENCE_START, REFERENCE_END, section, placeholder, withoutReference } from "./repository-note-body";

const REFERENCE_LABELS = ["所屬主題", "所屬心智圖", "母議題", "子議題", "來源議題", "狀態"];
const ENGLISH_REFERENCE_LABELS = ["Topic", "Mind map", "Parent topic", "Child topics", "Source topic", "Status"];
/** The fixed text of a note's relationship lines, by note language (the labels are in the order of {@link REFERENCE_LABELS}). */
interface ReferenceText {
  readonly labels: readonly string[];
  readonly none: string;
  readonly archived: string;
  readonly unassigned: string;
  readonly colon: string;
  readonly listSeparator: string;
  /**
   * The wording of a topic relation at each end, `[kind, start, finish]` in the order the lines are written. Start is
   * the relation's `from` end (A supports B: A reads "Supports: [[B]]", B reads "Supported by: [[A]]"); `related` has
   * no direction, so both ends read the same.
   */
  readonly relations: ReadonlyArray<readonly [TopicRelationKind, string, string]>;
}
export const REFERENCE_TEXT: Readonly<Record<NoteLanguage, ReferenceText>> = {
  "zh-TW": {
    labels: REFERENCE_LABELS,
    none: "無",
    archived: "已封存",
    unassigned: "未歸類",
    colon: "：",
    listSeparator: "、",
    relations: [
      ["supports", "支持", "被支持"],
      ["contradicts", "反駁", "被反駁"],
      ["verifies", "驗證", "被驗證"],
      ["derives_from", "推導自", "推導出"],
      ["prerequisite", "是前置知識於", "前置知識"],
      ["related", "相關", "相關"]
    ]
  },
  en: {
    labels: ENGLISH_REFERENCE_LABELS,
    none: "None",
    archived: "Archived",
    unassigned: "Unassigned",
    colon: ": ",
    listSeparator: ", ",
    relations: [
      ["supports", "Supports", "Supported by"],
      ["contradicts", "Contradicts", "Contradicted by"],
      ["verifies", "Verifies", "Verified by"],
      ["derives_from", "Derived from", "Derives"],
      ["prerequisite", "Prerequisite for", "Prerequisites"],
      ["related", "Related", "Related"]
    ]
  }
};
/**
 * The relation lines of the topic `nodeId` in `map`: one line per wording that has any relation, in kind order with the
 * start wording first, the other ends joined like Child topics. A relation is skipped when either end is not a topic
 * of the map with a Markdown note (`hasNote`). Descriptions are never written.
 */
export function relationReferences(
  map: MapDocument,
  nodeId: string,
  language: NoteLanguage,
  hasNote: (path: string) => boolean
): string[] {
  const ref = REFERENCE_TEXT[language];
  const notes = new Map(map.nodes.filter(node => hasNote(node.path)).map(node => [node.id, node.path]));
  if (!notes.has(nodeId)) return [];
  const lines: string[] = [];
  for (const [kind, start, finish] of ref.relations) {
    const ends = (side: "from" | "to"): string[] =>
      (map.topicRelations ?? [])
        .filter(r => r.kind === kind && r[side] === nodeId)
        .map(r => notes.get(side === "from" ? r.to : r.from))
        .filter((path): path is string => path !== undefined);
    const groups =
      start === finish
        ? [[start, [...ends("from"), ...ends("to")]] as const]
        : [[start, ends("from")] as const, [finish, ends("to")] as const];
    for (const [label, paths] of groups)
      if (paths.length)
        lines.push(
          `${label}${ref.colon}${[...new Set(paths)].map(path => `[[${noteLink(path)}]]`).join(ref.listSeparator)}`
        );
  }
  return lines;
}

export function localizeReference(value: string, language: NoteLanguage): string {
  const match =
    /^(所屬主題|所屬心智圖|母議題|子議題|來源議題|狀態|Topic|Mind map|Parent topic|Child topics|Source topic|Status)[：:]\s*(.*)$/.exec(
      value
    );
  if (!match) return value;
  const index = (REFERENCE_LABELS.includes(match[1]) ? REFERENCE_LABELS : ENGLISH_REFERENCE_LABELS).indexOf(match[1]);
  const target = REFERENCE_TEXT[language];
  const plain =
    match[2] === "無" || match[2] === "None"
      ? target.none
      : match[2] === "已封存" || match[2] === "Archived"
        ? target.archived
        : match[2] === "未歸類" || match[2] === "Unassigned"
          ? target.unassigned
          : match[2];
  return `${target.labels[index]}${target.colon}${plain}`;
}

/**
 * The language a note's derived scaffolding (Preview heading, summary placeholder, relationship labels) is already
 * written in, or undefined when it has none. A rebuild keeps it, so changing the UI language never relabels notes.
 */
export function derivedLabelLanguage(content: string, fm: Record<string, unknown>): NoteLanguage | undefined {
  if (Array.isArray(fm["agent-map-references"]))
    for (const entry of fm["agent-map-references"]) {
      const label = /^([^：:]+)[：:]/.exec(String(entry))?.[1];
      if (label && REFERENCE_LABELS.includes(label)) return "zh-TW";
      if (label && ENGLISH_REFERENCE_LABELS.includes(label)) return "en";
    }
  if (/^(?:## |> \[!info\][+-]? )預覽[ \t]*$/m.test(content)) return "zh-TW";
  if (/^(?:## |> \[!info\][+-]? )Preview[ \t]*$/m.test(content)) return "en";
  const summary = section(content, "Current Summary");
  if (summary === placeholder("zh-TW")) return "zh-TW";
  if (summary === placeholder("en")) return "en";
  return undefined;
}

export function withReferenceLinks(body: string, fm: Record<string, unknown>, language: NoteLanguage): string {
  const sources = Array.isArray(fm["source-notes"]) ? fm["source-notes"].map(String).filter(Boolean) : [];
  const relationships = Array.isArray(fm["agent-map-references"])
    ? fm["agent-map-references"].map(String).filter(text => text.includes("[["))
    : [];
  const label = translate(language, "note.source_topic_label");
  const links = [
    ...relationships.map(value => localizeReference(value, language)),
    ...sources.map(path => `${label}[[${noteLink(path)}]]`)
  ];
  const clean = withoutReference(body).trimEnd();
  return links.length
    ? `${clean}\n\n${REFERENCE_START}\n## Reference Links\n\n${[...new Set(links)].map(link => `- ${link}`).join("\n")}\n${REFERENCE_END}\n`
    : `${clean}\n`;
}

export function noteLink(path: string): string {
  return path.replace(/\.md$/, "").replace(/\|/g, "\\|");
}
