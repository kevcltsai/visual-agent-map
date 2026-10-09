import { editorLivePreviewField, type Plugin } from "obsidian";
import { RangeSetBuilder } from "@codemirror/state";
import { Decoration, ViewPlugin, type DecorationSet, type EditorView, type ViewUpdate } from "@codemirror/view";

const markerLine = /^\s*<!-- visual-agent-map:(?:detail|references):(?:start|end) -->\s*$/;

function decorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  if (!view.state.field(editorLivePreviewField, false)) return builder.finish();
  let fence: { character: string; length: number } | null = null;
  for (let number = 1; number <= view.state.doc.lines; number++) {
    const line = view.state.doc.line(number);
    const delimiter = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line.text);
    if (delimiter) {
      if (!fence) fence = { character: delimiter[1][0], length: delimiter[1].length };
      else if (delimiter[1][0] === fence.character && delimiter[1].length >= fence.length && !delimiter[2].trim()) fence = null;
      continue;
    }
    if (!fence && markerLine.test(line.text) && !/^ {4}|^\t/.test(line.text)) {
      builder.add(line.from, line.from, Decoration.line({ class: "vam-internal-marker-line" }));
    }
  }
  return builder.finish();
}

export function registerInternalMarkerPresentation(plugin: Plugin): void {
  plugin.registerEditorExtension(ViewPlugin.fromClass(class {
    decorations: DecorationSet;
    constructor(view: EditorView) { this.decorations = decorations(view); }
    update(update: ViewUpdate): void {
      if (update.docChanged || update.startState.field(editorLivePreviewField, false) !== update.state.field(editorLivePreviewField, false)) this.decorations = decorations(update.view);
    }
  }, { decorations: instance => instance.decorations }));

  plugin.registerMarkdownPostProcessor(element => {
    const walker = element.ownerDocument.createTreeWalker(element, 4);
    const nodes: Text[] = [];
    while (walker.nextNode()) nodes.push(walker.currentNode as Text);
    for (const node of nodes) {
      if (node.parentElement?.closest("pre, code")) continue;
      const text = node.textContent ?? "";
      const filtered = text.split("\n").filter(line => !markerLine.test(line)).join("\n");
      if (filtered === text) continue;
      const parent = node.parentElement;
      node.textContent = filtered;
      if (parent?.tagName === "P" && !parent.textContent?.trim() && !parent.querySelector("img, video, audio, iframe")) parent.addClass("vam-internal-marker-only");
    }
  });
}
