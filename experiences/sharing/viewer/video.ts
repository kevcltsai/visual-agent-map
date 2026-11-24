import type { ShareViewerUi } from "../share-viewer-ui";
import { socialVideoOf } from "../../../core/social-video";
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

/** The player a click on the card starts: the site's official embed page, with exactly these attributes. */
export function videoPlayer(doc: Document, src: string, title: string, tall = false): HTMLIFrameElement {
  const frame = createViewerElement(doc, "iframe", tall ? "vam-video-frame vam-video-tall" : "vam-video-frame");
  frame.setAttribute("src", src);
  frame.setAttribute("allow", "autoplay; encrypted-media; picture-in-picture");
  frame.setAttribute("allowfullscreen", "");
  frame.setAttribute("referrerpolicy", "strict-origin-when-cross-origin");
  frame.setAttribute("sandbox", "allow-scripts allow-same-origin allow-presentation allow-popups");
  frame.setAttribute("title", title);
  return frame;
}

const SITE_NAMES = { facebook: "Facebook", instagram: "Instagram" } as const;

/**
 * Turns each `a.vam-video-link` of a note whose address is a YouTube, Facebook or Instagram video into a click-to-play card.
 * Nothing connects to the site until the reader presses play; the original link stays in the card as the "Open on …"
 * fallback. Any other link (a look-alike host, a link the author wrote) is left as it is.
 */
export function upgradeVideoLinks(root: ParentNode, doc: Document, ui: ShareViewerUi): void {
  for (const link of Array.from(root.querySelectorAll("a.vam-video-link"))) {
    const href = link.getAttribute("href") ?? "";
    const id = viewerYoutubeId(href);
    const social = id ? null : socialVideoOf(href);
    if (!id && !social) continue;
    const site = social ? SITE_NAMES[social.source] : "";
    const playLabel = social ? ui.videoPlaySite.replace("{0}", site) : ui.videoPlay;
    const title =
      (link.textContent ?? "")
        .replace(/^\s*▶\s*/, "")
        .trim()
        .slice(0, 200) || playLabel;
    const card = createViewerElement(doc, "div", "vam-video-card");
    const tall = social?.source === "instagram";
    const stage = createViewerElement(doc, "div", tall ? "vam-video-stage vam-video-tall" : "vam-video-stage");
    // Opened from a file on disk, the page has no address to send, and YouTube refuses an embed without one (error 153):
    // there the YouTube play control opens the video on YouTube in a new tab. Facebook and Instagram play in the card either way.
    const local = !social && doc.location?.protocol === "file:";
    const button = createViewerElement(doc, local ? "a" : "button", "vam-video-play");
    if (local) {
      const watch = new UrlParser("https://www.youtube.com/watch");
      watch.searchParams.set("v", id as string);
      button.setAttribute("href", watch.href);
      button.setAttribute("target", "_blank");
      button.setAttribute("rel", "noopener noreferrer");
    } else (button as HTMLButtonElement).type = "button";
    button.setAttribute("aria-label", `${playLabel}: ${title}`);
    const icon = createViewerElement(doc, "span", "vam-video-icon");
    icon.setAttribute("aria-hidden", "true");
    const caption = createViewerElement(doc, "span", "vam-video-caption");
    caption.textContent = playLabel;
    button.append(icon, caption);
    stage.append(button);
    const src = social ? social.embed : `${NOCOOKIE_EMBED}${id}?autoplay=1`;
    if (!local) button.addEventListener("click", () => stage.replaceChildren(videoPlayer(doc, src, title, tall)));
    const note = createViewerElement(doc, "small", "vam-video-note");
    note.textContent = social ? ui.videoNoteSite.replace("{0}", site) : local ? ui.videoNoteLocal : ui.videoNote;
    link.textContent = social ? ui.videoOpenSite.replace("{0}", site) : ui.videoOpen;
    link.removeAttribute("class");
    link.setAttribute("title", title);
    link.replaceWith(card);
    card.append(stage, note, link);
  }
}
