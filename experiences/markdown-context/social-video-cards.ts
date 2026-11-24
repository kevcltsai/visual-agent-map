import { socialVideoOf } from "../../core/social-video";

/**
 * Facebook and Instagram videos in rendered Markdown (a note's reading view, a map card's preview). Obsidian embeds only
 * YouTube; a Facebook or Instagram address stays a link, or a broken image when written as `![](url)`. Each becomes a
 * click-to-play card: nothing connects to the site until the reader presses play, then the site's official embed plays in
 * the card. The card keeps an "Open on …" link that opens the video in the browser. No Obsidian import: a unit test runs it.
 */

export interface SocialVideoLabels {
  /** Each takes the site's name ("Facebook", "Instagram"). */
  play: (site: string) => string;
  note: (site: string) => string;
  open: (site: string) => string;
}

const SITE_NAMES = { facebook: "Facebook", instagram: "Instagram" } as const;

const elementsIn = (root: Element): Element[] => {
  const found: Element[] = [];
  for (const child of Array.from(root.childNodes)) {
    if (child.nodeType !== 1) continue;
    found.push(child as Element, ...elementsIn(child as Element));
  }
  return found;
};

/** Replaces every Facebook or Instagram video link or image under `root` with a click-to-play card; returns how many. */
export function upgradeSocialVideoLinks(root: Element, labels: SocialVideoLabels): number {
  // Typed as just the factory (like the share viewer's dom.ts): the unit test DOM has no Obsidian `createEl`.
  const doc: Pick<Document, "createElement"> = root.ownerDocument;
  let made = 0;
  for (const element of elementsIn(root)) {
    const name = element.localName.toLowerCase();
    const address = name === "a" ? element.getAttribute("href") : name === "img" ? element.getAttribute("src") : null;
    const video = address ? socialVideoOf(address) : null;
    if (!video) continue;
    // An image inside a video link went with the link's card.
    let up = element.parentNode;
    while (up && up !== root) up = up.parentNode;
    if (!up) continue;
    const site = SITE_NAMES[video.source];
    const text = (name === "a" ? element.textContent : element.getAttribute("alt"))?.trim() ?? "";
    const title = (text && text !== address ? text : labels.play(site)).slice(0, 200);
    const tall = video.source === "instagram";
    const card = doc.createElement("div");
    card.setAttribute("class", "vam-social-video-card");
    const stage = doc.createElement("div");
    stage.setAttribute("class", tall ? "vam-social-video-stage vam-social-video-tall" : "vam-social-video-stage");
    const play = doc.createElement("button");
    play.setAttribute("type", "button");
    play.setAttribute("class", "vam-social-video-play");
    play.setAttribute("aria-label", `${labels.play(site)}: ${title}`);
    play.textContent = `▶ ${labels.play(site)}`;
    play.addEventListener("click", () => {
      const frame = doc.createElement("iframe");
      frame.setAttribute("class", "vam-social-video-frame");
      frame.setAttribute("src", video.embed);
      frame.setAttribute("allow", "autoplay; encrypted-media; picture-in-picture");
      frame.setAttribute("allowfullscreen", "");
      frame.setAttribute("referrerpolicy", "strict-origin-when-cross-origin");
      frame.setAttribute("title", title);
      stage.replaceChildren(frame);
    });
    stage.append(play);
    const note = doc.createElement("small");
    note.setAttribute("class", "vam-social-video-note");
    note.textContent = labels.note(site);
    const open = doc.createElement("a");
    open.setAttribute("class", "external-link");
    open.setAttribute("href", video.watch);
    open.setAttribute("target", "_blank");
    open.setAttribute("rel", "noopener noreferrer");
    open.textContent = labels.open(site);
    card.append(stage, note, open);
    element.replaceWith(card);
    made++;
  }
  return made;
}
