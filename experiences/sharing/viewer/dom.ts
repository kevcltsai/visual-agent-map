/**
 * The viewer's single element factory. The viewer is a standalone browser page, so Obsidian's global `createEl` family
 * does not exist here and `document.createElement` is the only way to build nodes. The parameter is typed as just the
 * `createElement` method (not a full `Document`), which is what keeps `obsidianmd/prefer-create-el` from asking for
 * Obsidian helpers that this page does not have; the rule stays enabled for the whole viewer.
 */
export type ElementFactory = Pick<Document, "createElement">;

export function createViewerElement<K extends keyof HTMLElementTagNameMap>(
  factory: ElementFactory,
  tag: K,
  className?: string
): HTMLElementTagNameMap[K] {
  const element = factory.createElement(tag);
  if (className) element.className = className;
  return element;
}
