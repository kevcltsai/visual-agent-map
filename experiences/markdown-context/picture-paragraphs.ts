import { classifyShareTarget } from "../sharing/share-code";

/** Marks a reading-view paragraph that holds a picture, so the stylesheet can set it as picture + caption without `:has`. */
export const PICTURE_PARAGRAPH_CLASS = "vam-picture-paragraph";

/**
 * A paragraph whose own children include a picture: an `<img>` (`![](…)`) or an `![[…]]` embed of an image file. The embed is
 * judged by its target's extension, since Obsidian adds its `image-embed` class only once the picture has loaded.
 */
export function markPictureParagraphs(root: HTMLElement): void {
  const paragraphs = root.tagName === "P" ? [root] : Array.from(root.querySelectorAll("p"));
  for (const p of paragraphs) {
    const picture = Array.from(p.children).some(
      child =>
        child.tagName === "IMG" ||
        child.classList.contains("image-embed") ||
        (child.classList.contains("internal-embed") && classifyShareTarget(child.getAttribute("src") ?? "") === "image")
    );
    if (picture) p.classList.add(PICTURE_PARAGRAPH_CLASS);
  }
}
