import { EditorView, ViewPlugin } from "@codemirror/view";
import type { Plugin } from "obsidian";
import { translate } from "../../i18n";
import {
  isBookStructureTitle,
  isChecklistLabel,
  isImagePlanLabel,
  planDisplayField,
  type PlanDisplayField
} from "../../core/book-pipeline/plan-text";
import { planCalloutKind } from "../../core/book-pipeline/plan-view";

/**
 * Display only: the pipeline stores its plan in hidden `[!vam-book]` callouts (the stylesheet hides that type). The root's book plan and a
 * card's plan block are the ones the owner reads and edits, so they get this class and the stylesheet shows them; every other
 * `[!vam-book]` callout stays hidden. Nothing here writes to a note; the stored text and labels are untouched.
 */
export const PLAN_CALLOUT_CLASS = "vam-book-plan";
export const PLAN_FOLD_CLASS = "vam-book-plan-fold";
export const PLAN_HIDDEN_CLASS = "vam-book-plan-hidden";
const DONE_ATTR = "data-vam-plan-view";
const CALLOUT = '.callout[data-callout="vam-book"]';
const LABEL_KEY = {
  entry: "ui.book_plan_label_entry",
  previous: "ui.book_plan_label_previous",
  handoff: "ui.book_plan_label_handoff"
} as const satisfies Record<PlanDisplayField, Parameters<typeof translate>[1]>;
const LABEL_LINE = /^(\s*)(.+?)([：:]\s*)(.*)$/s;

const textNodesOf = (root: Node): Text[] => {
  const walker = root.ownerDocument!.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const found: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) found.push(node as Text);
  return found;
};

/** Chinese notes: shows a plan line's label under its friendlier name (`接入點：` reads 怎麼開場：). Only the text node is changed, the file is not. */
function relabel(content: HTMLElement): void {
  for (const node of textNodesOf(content)) {
    const m = LABEL_LINE.exec(node.data);
    const field = m ? planDisplayField(m[2]) : undefined;
    if (m && field) node.data = `${m[1]}${translate("zh-TW", LABEL_KEY[field])}${m[3]}${m[4]}`;
  }
}

/** The root's old `### 全書結構` part (no longer written) is not shown: its heading and what follows up to the next heading. */
function hideStructure(content: HTMLElement): void {
  let hiding = false;
  for (const child of Array.from(content.children)) {
    if (/^H[1-6]$/.test(child.tagName)) hiding = isBookStructureTitle(child.textContent ?? "");
    if (hiding) child.classList.add(PLAN_HIDDEN_CLASS);
  }
}

/** The text node that is a lone `圖安排：` / `驗收清單：` line (a label with text after it, like `圖安排：無`, has nothing to fold). */
function labelNode(content: HTMLElement, isLabel: (word: string) => boolean): Text | undefined {
  return textNodesOf(content).find(node => {
    const m = /^\s*(.+?)[：:]\s*$/.exec(node.data);
    return !!m && isLabel(m[1]);
  });
}

/**
 * Folds everything from `label` up to `end` (or the end of the content) into a closed `<details>` whose summary is the label. The range
 * extraction keeps lists and paragraphs well formed even when the label sits inside one (a markdown line that continues the line above).
 */
function fold(content: HTMLElement, label: Text, end: Node | null): HTMLElement | undefined {
  const doc = content.ownerDocument;
  const word = /^\s*(.+?)[：:]\s*$/.exec(label.data)![1];
  const marker = content.createSpan();
  const after = label.nextSibling;
  if (after && after.nodeName === "BR") after.parentNode!.removeChild(after);
  label.replaceWith(marker);
  const range = doc.createRange();
  range.setStartBefore(marker);
  if (end) range.setEndBefore(end);
  else range.setEnd(content, content.childNodes.length);
  const body = range.extractContents();
  marker.remove();
  const details = content.createEl("details", { cls: PLAN_FOLD_CLASS });
  const summary = details.createEl("summary", { text: word });
  // The editor treats a press inside the callout as "start editing it"; a press on the summary only opens or closes the fold.
  summary.addEventListener("mousedown", event => event.stopPropagation());
  details.append(body);
  for (const child of Array.from(details.children)) {
    if (child !== summary && !child.textContent?.trim() && !child.querySelector("img, svg")) child.remove();
  }
  // A line that continued the one above leaves an empty list item where the range was cut.
  for (const item of Array.from(details.querySelectorAll("li")))
    if (!item.textContent?.trim() && !item.querySelector("img, svg, ul, ol")) item.remove();
  let anchor: Node = range.startContainer;
  if (anchor === content) content.insertBefore(details, content.childNodes[range.startOffset] ?? null);
  else {
    while (anchor.parentNode && anchor.parentNode !== content) anchor = anchor.parentNode;
    anchor.parentNode?.insertBefore(details, anchor.nextSibling);
    if (anchor.nodeType === 1 && !anchor.textContent?.trim()) anchor.parentNode?.removeChild(anchor);
  }
  return details;
}

/** A card's plan block: the picture plan and the acceptance checklist are closed folds. A structure that is not recognised is left as it is. */
function foldCardPlan(content: HTMLElement): void {
  const checklist = labelNode(content, isChecklistLabel);
  const images = labelNode(content, isImagePlanLabel);
  const checklistFold = checklist ? fold(content, checklist, null) : undefined;
  if (images) fold(content, images, checklistFold ?? null);
}

/** Marks the plan callouts under `root` (and `root` itself) and gives them their display form. Idempotent. */
export function markPlanCallouts(root: HTMLElement): void {
  const callouts = root.matches(CALLOUT) ? [root] : [];
  callouts.push(...Array.from(root.querySelectorAll<HTMLElement>(CALLOUT)));
  for (const callout of callouts) {
    if (callout.hasAttribute(DONE_ATTR)) continue;
    const title = callout.querySelector<HTMLElement>(".callout-title-inner");
    const kind = title ? planCalloutKind(title.textContent ?? "") : undefined;
    if (!title || !kind) continue;
    callout.classList.add(PLAN_CALLOUT_CLASS);
    const content = callout.querySelector<HTMLElement>(".callout-content");
    // An empty body is not rendered yet: it is looked at again when it is.
    if (!content || !content.childNodes.length) continue;
    callout.setAttribute(DONE_ATTR, kind.kind);
    if (kind.kind === "book") hideStructure(content);
    else foldCardPlan(content);
    if (kind.zh) {
      relabel(content);
      title.textContent =
        kind.kind === "book"
          ? translate("zh-TW", "ui.book_plan_title_book", translate("zh-TW", "ui.book_bar_plan_go"))
          : translate("zh-TW", "ui.book_plan_title_card");
    }
  }
}

const touchesCallout = (mutation: MutationRecord): boolean =>
  Array.from(mutation.addedNodes).some(
    node =>
      node.nodeType === 1 &&
      ((node as Element).matches(".callout, .cm-callout") || !!(node as Element).querySelector?.(".callout"))
  ) || !!(mutation.target as Element).closest?.(".cm-callout");

/** Reading view (a markdown post processor) and live preview (a watcher on each editor, which Obsidian does not hand to post processors). */
export function registerBookPlanView(plugin: Plugin): void {
  plugin.registerMarkdownPostProcessor(element => markPlanCallouts(element));
  plugin.registerEditorExtension(
    ViewPlugin.fromClass(
      class {
        private readonly observer: MutationObserver;
        constructor(view: EditorView) {
          this.observer = new MutationObserver(mutations => {
            if (mutations.some(touchesCallout)) markPlanCallouts(view.dom);
          });
          this.observer.observe(view.dom, { childList: true, subtree: true });
          markPlanCallouts(view.dom);
        }
        destroy(): void {
          this.observer.disconnect();
        }
      }
    )
  );
}
