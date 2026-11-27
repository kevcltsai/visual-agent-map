/**
 * Redaction of the Living Node text that goes into a shared file, and the plain-text rule for Living Node markers in imported
 * text (pure text work, no Obsidian). The share projection of a Living Node is built for readers, but its model-written
 * sentences can still carry things only this device may know: a signed URL's secret parameters, a vault or home path,
 * ownership / suppression / draft bookkeeping or a marker comment. (Note embeds are flattened by the caller, share-embeds.)
 */
const WEB_ADDRESS = /\bhttps?:\/\/[^\s<>"'`]+/gi;
const LOCAL_PATH =
  /file:\/\/[^\s<>"'`)\]]*|(?:[A-Za-z]:[\\/](?:Users|Documents and Settings)[\\/][^\s<>"'`)\]]*|(?<![\w.:/-])\/(?:Users|home|Volumes|private|var|tmp|mnt|root)\/[^\s<>"'`)\]]*)/g;
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

/** The Living Node share projection with private paths, secrets, bookkeeping and markers taken out. */
export function redactLivingShareText(text: string): string {
  if (!text) return text;
  let out = text
    .replace(REGION, "")
    .replace(MARKER, "")
    .replace(/<!--\s*vam-living-node:[^\n]*$/gim, "");
  out = out.replace(BOOKKEEPING_LINE, "");
  out = stripQueries(out);
  out = out.replace(LOCAL_PATH, "");
  return out.replace(/\n{3,}/g, "\n\n");
}

/** Imported text: Living Node marker comments become nothing, so imported content can never claim ownership or start a card. */
export function stripLivingNodeMarkers(text: string): string {
  return text.replace(MARKER, "").replace(/<!--\s*vam-living-node:[^\n]*$/gim, "");
}
