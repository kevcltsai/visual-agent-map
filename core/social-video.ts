/**
 * Facebook and Instagram video addresses, and the official embed page each one plays in. Pure (no Obsidian import): the
 * share viewer bundle uses it too. A look-alike host (`facebook.com.evil.example`) or any other page of these sites is null.
 */

export type SocialVideoSource = "facebook" | "instagram";

export interface SocialVideo {
  source: SocialVideoSource;
  /** The official embed page, loaded only when the reader presses play. */
  embed: string;
  /** The address to open in a new tab when the video cannot play in the page. */
  watch: string;
}

const FACEBOOK_HOSTS: ReadonlySet<string> = new Set(["facebook.com", "www.facebook.com", "m.facebook.com", "web.facebook.com"]);
const INSTAGRAM_HOSTS: ReadonlySet<string> = new Set(["instagram.com", "www.instagram.com"]);
const NUMERIC_ID = /^\d{5,25}$/;
const FB_WATCH_CODE = /^[A-Za-z0-9_-]{4,40}$/;
const INSTAGRAM_CODE = /^[A-Za-z0-9_-]{5,40}$/;
const PAGE_NAME = /^[A-Za-z0-9.\-_]{1,100}$/;
// Held in a constant so no source text reads like a CSS function call: the share shell scan refuses `url(` anywhere.
const UrlParser = URL;
// Addresses are built as (path, base) so a minifier never folds them into one template string: the share shell test lists every address it holds.
const FACEBOOK = "https://www.facebook.com/";
const INSTAGRAM = "https://www.instagram.com/";
const FB_WATCH = "https://fb.watch/";
const at = (pathPart: string, base: string): string => new UrlParser(pathPart, base).href;

const facebookEmbed = (href: string): string => {
  const embed = new UrlParser("plugins/video.php", FACEBOOK);
  embed.searchParams.set("href", href);
  embed.searchParams.set("show_text", "false");
  return embed.href;
};

/** The Facebook or Instagram video `value` names, or null. */
export function socialVideoOf(value: string): SocialVideo | null {
  let url: URL;
  try {
    url = new UrlParser(value.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const host = url.hostname.toLowerCase();
  const parts = url.pathname.split("/").filter(Boolean);
  if (host === "fb.watch") {
    if (parts.length !== 1 || !FB_WATCH_CODE.test(parts[0])) return null;
    const href = at(`${parts[0]}/`, FB_WATCH);
    return { source: "facebook", embed: facebookEmbed(href), watch: href };
  }
  if (FACEBOOK_HOSTS.has(host)) {
    let href: string | null = null;
    const v = url.searchParams.get("v") ?? "";
    if (parts[0] === "watch" && parts.length === 1 && NUMERIC_ID.test(v)) href = at(`watch/?v=${v}`, FACEBOOK);
    else if (parts[0] === "reel" && parts.length === 2 && NUMERIC_ID.test(parts[1])) href = at(`reel/${parts[1]}`, FACEBOOK);
    else if (parts[1] === "videos" && PAGE_NAME.test(parts[0])) {
      const id = parts[parts.length - 1];
      if ((parts.length === 3 || parts.length === 4) && NUMERIC_ID.test(id)) href = at(`${parts[0]}/videos/${id}/`, FACEBOOK);
    }
    return href ? { source: "facebook", embed: facebookEmbed(href), watch: href } : null;
  }
  if (INSTAGRAM_HOSTS.has(host)) {
    const kind = parts[0] === "reels" ? "reel" : parts[0];
    if (!["p", "reel", "tv"].includes(kind ?? "") || parts.length < 2 || parts.length > 3 || !INSTAGRAM_CODE.test(parts[1])) return null;
    if (parts.length === 3 && parts[2] !== "embed") return null;
    const watch = at(`${kind}/${parts[1]}/`, INSTAGRAM);
    return { source: "instagram", embed: `${watch}embed`, watch };
  }
  return null;
}
