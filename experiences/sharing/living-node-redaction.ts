/**
 * Redaction of the Living Node text that leaves the note (share file, OPML/FreeMind export, clipboard), applied once where the
 * projection is built (pure text work, no Obsidian). The projection is built for readers, but its model-written sentences can
 * still carry things only this device may know: a signed URL's secrets, a vault or home path, ownership / suppression / draft
 * bookkeeping, a marker comment, or an embed that would pull in a note that is not shared. Redacting twice changes nothing.
 */
import { escapeRegExp } from "../../core/escape-regexp";

const WEB_ADDRESS = /\b(?:https?:\/\/|www\.)[^\s<>"'`]+/gi;
// A path may contain spaces: it runs to the end of the line or the next closing bracket or quote.
const PATH_TAIL = "[^\\n)\\]\"'`<>]*";
const LOCAL_PATH = new RegExp(
  [
    `file:\\/\\/${PATH_TAIL}`,
    `(?<![\\w])[A-Za-z]:[\\\\/]${PATH_TAIL}`,
    `(?<![\\w.:/-])~\\/${PATH_TAIL}`,
    `(?<![\\w.:/-])\\/(?:Users|home|Volumes|private|var|tmp|mnt|root)\\/${PATH_TAIL}`
  ].join("|"),
  "g"
);
const REGION = /<!--\s*vam-living-node:begin[\s\S]*?<!--\s*vam-living-node:end[^>]*-->/gi;
const MARKER = /<!--\s*vam-living-node:[\s\S]*?-->/gi;
const BOOKKEEPING_LINE = /^[ \t>*+-]*["']?(?:living-node-[\w-]+|ownership|suppress\w*|draft\w*)["']?[ \t]*[:=].*$/gim;

/**
 * Drops the whole query string and fragment of every web address, whatever the parameter names or how `&` is written (a
 * signed address keeps its secrets in either, under names no list can cover). A closing bracket that belongs to the
 * surrounding sentence rather than to the address stays.
 */
function stripQueries(text: string): string {
  return text.replace(WEB_ADDRESS, token => {
    const cut = token.search(/[?#]/);
    if (cut < 0) return token;
    const opens = (token.match(/[([]/g) ?? []).length;
    const closes = (token.match(/[)\]]/g) ?? []).length;
    return token.slice(0, cut) + ")".repeat(Math.max(0, closes - opens));
  });
}

/** The Living Node text with private paths (`basePath` is the vault's real folder), secrets, bookkeeping, markers and embeds taken out. */
export function redactLivingShareText(text: string, basePath?: string): string {
  if (!text) return text;
  let out = text
    .replace(REGION, "")
    .replace(MARKER, "")
    .replace(/<!--\s*vam-living-node:[^\n]*$/gim, "");
  out = out.replace(BOOKKEEPING_LINE, "");
  out = stripQueries(out);
  const base = basePath?.replace(/[\\/]+$/, "");
  if (base) out = out.replace(new RegExp(`${escapeRegExp(base)}(?:[\\\\/]${PATH_TAIL})?`, "g"), "");
  out = out.replace(LOCAL_PATH, "");
  // Every image opener (`![[`, `![alt](`, `![alt][ref]`, nested or multiline alt) becomes a plain link, also inside code, so no
  // fence elsewhere in the note can change what is read in.
  return out
    .replace(/!\[/g, "[")
    .replace(/\n{3,}/g, "\n\n");
}
