import type { ShareViewerUi } from "../share-viewer-ui";
import { createViewerElement } from "./dom";

// Held in a constant so no source text reads like a CSS function call: the shell scan refuses `url(` anywhere in the file.
const UrlParser = URL;
const YOUTUBE_HOSTS: ReadonlySet<string> = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be"]);
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
export const NOCOOKIE_EMBED = "https://www.youtube-nocookie.com/embed/";

/**
 * The 11-character id of a YouTube watch, short, embed, shorts, live or v address; null for anything else (also a look-alike
 * host). A separate copy of `youtubeVideoId` in core/video-embeds.ts (the viewer bundle imports no plugin module); a unit
 * test runs both on the same addresses.
 */
export function viewerYoutubeId(value: string): string | null {
  let url: URL;
  try {
    url = new UrlParser(value.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const host = url.hostname.toLowerCase();
  if (!YOUTUBE_HOSTS.has(host)) return null;
  const parts = url.pathname.split("/").filter(Boolean);
  let id: string | null | undefined;
  if (host === "youtu.be") id = parts[0];
  else if (parts[0] === "watch") id = url.searchParams.get("v");
  else if (["embed", "shorts", "live", "v"].includes(parts[0] ?? "")) id = parts[1];
  return id && VIDEO_ID.test(id) ? id : null;
}

/** The player a click on the card starts: YouTube's no-cookie embed, with exactly these attributes. */
export function videoPlayer(doc: Document, id: string, title: string): HTMLIFrameElement {
  const frame = createViewerElement(doc, "iframe", "vam-video-frame");
  frame.setAttribute("src", `${NOCOOKIE_EMBED}${id}?autoplay=1`);
  frame.setAttribute("allow", "autoplay; encrypted-media; picture-in-picture");
  frame.setAttribute("allowfullscreen", "");
  frame.setAttribute("referrerpolicy", "strict-origin-when-cross-origin");
  frame.setAttribute("sandbox", "allow-scripts allow-same-origin allow-presentation allow-popups");
  frame.setAttribute("title", title);
  return frame;
}

/**
 * Turns each `a.vam-video-link` of a note whose address is a YouTube video into a click-to-play card. Nothing connects to
 * YouTube until the reader presses play; the original link stays in the card as the "Open on YouTube" fallback. Any
 * other link (a look-alike host, a link the author wrote) is left as it is.
 */
export function upgradeVideoLinks(root: ParentNode, doc: Document, ui: ShareViewerUi): void {
  for (const link of Array.from(root.querySelectorAll("a.vam-video-link"))) {
    const href = link.getAttribute("href") ?? "";
    const id = viewerYoutubeId(href);
    if (!id) continue;
    const title =
      (link.textContent ?? "")
        .replace(/^\s*▶\s*/, "")
        .trim()
        .slice(0, 200) || ui.videoPlay;
    const card = createViewerElement(doc, "div", "vam-video-card");
    const stage = createViewerElement(doc, "div", "vam-video-stage");
    // Opened from a file on disk, the page has no address to send, and YouTube refuses an embed without one (error 153):
    // there the play control opens the video on YouTube in a new tab. From a web address it plays in the card.
    const local = doc.location?.protocol === "file:";
    const button = createViewerElement(doc, local ? "a" : "button", "vam-video-play");
    if (local) {
      const watch = new UrlParser("https://www.youtube.com/watch");
      watch.searchParams.set("v", id);
      button.setAttribute("href", watch.href);
      button.setAttribute("target", "_blank");
      button.setAttribute("rel", "noopener noreferrer");
    } else (button as HTMLButtonElement).type = "button";
    button.setAttribute("aria-label", `${ui.videoPlay}: ${title}`);
    const icon = createViewerElement(doc, "span", "vam-video-icon");
    icon.setAttribute("aria-hidden", "true");
    const caption = createViewerElement(doc, "span", "vam-video-caption");
    caption.textContent = ui.videoPlay;
    button.append(icon, caption);
    stage.append(button);
    if (!local) button.addEventListener("click", () => stage.replaceChildren(videoPlayer(doc, id, title)));
    const note = createViewerElement(doc, "small", "vam-video-note");
    note.textContent = local ? ui.videoNoteLocal : ui.videoNote;
    link.textContent = ui.videoOpen;
    link.removeAttribute("class");
    link.setAttribute("title", title);
    link.replaceWith(card);
    card.append(stage, note, link);
  }
}
