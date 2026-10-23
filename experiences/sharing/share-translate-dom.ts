import { sanitizeHTMLToDom } from "obsidian";
import type { ShareTranslateDom } from "./share-translate-service";

/**
 * The DOM the translation service works on, built from Obsidian's own pieces (D-2026-10-116). `parse` reads the
 * already-cleaned note HTML in an inert document (nothing runs, nothing loads); `sanitize` is the same sanitizer the
 * exporter uses; the span and div come from the global helpers.
 */
export function obsidianTranslateDom(): ShareTranslateDom {
  return {
    parse: html => new DOMParser().parseFromString(html, "text/html").body,
    serialize: root => root.innerHTML,
    sanitize: root => {
      const clean = sanitizeHTMLToDom(root.innerHTML);
      root.replaceChildren(clean);
    },
    createSpan: () => createSpan(),
    createDiv: () => createDiv()
  };
}
