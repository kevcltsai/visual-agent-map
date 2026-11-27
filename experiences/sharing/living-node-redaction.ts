/**
 * Redaction of the Living Node text that goes into a shared file, and the plain-text rule for Living Node markers in imported
 * text (pure text work, no Obsidian). The share projection of a Living Node is built for readers, but its model-written
 * sentences can still carry things only this device may know: a signed URL's secret parameters, a vault or home path,
 * ownership / suppression / draft bookkeeping or a marker comment. (Note embeds are flattened by the caller, share-embeds.)
 */
const SECRET_PARAM = /^(?:x-amz-[\w-]*|sig|signature|token|key|expires)$/i;
const URL_WITH_QUERY = /\b(https?:\/\/[^\s<>)\]]*?)\?([^\s<>)\]#]*)(#[^\s<>)\]]*)?/gi;
const LOCAL_PATH =
  /file:\/\/[^\s<>"'`)\]]*|(?:[A-Za-z]:[\\/](?:Users|Documents and Settings)[\\/][^\s<>"'`)\]]*|(?<![\w.:/-])\/(?:Users|home|Volumes|private|var|tmp|mnt|root)\/[^\s<>"'`)\]]*)/g;
const REGION = /<!--\s*vam-living-node:begin[\s\S]*?<!--\s*vam-living-node:end[^>]*-->/gi;
const MARKER = /<!--\s*vam-living-node:[\s\S]*?-->/gi;
const BOOKKEEPING_LINE = /^[ \t>*+-]*["']?(?:living-node-[\w-]+|ownership|suppress\w*|draft\w*)["']?[ \t]*[:=].*$/gim;

/** Drops secret query parameters (signed-URL fields, tokens, keys, expiry); other parameters and the address stay. */
function stripSecretParams(text: string): string {
  return text.replace(URL_WITH_QUERY, (_all, base: string, query: string, hash?: string) => {
    const kept = query.split("&").filter(pair => pair && !SECRET_PARAM.test(decodeName(pair.split("=")[0])));
    return base + (kept.length ? `?${kept.join("&")}` : "") + (hash ?? "");
  });
}

function decodeName(name: string): string {
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
}

/** The Living Node share projection with private paths, secrets, bookkeeping and markers taken out. */
export function redactLivingShareText(text: string): string {
  if (!text) return text;
  let out = text
    .replace(REGION, "")
    .replace(MARKER, "")
    .replace(/<!--\s*vam-living-node:[^\n]*$/gim, "");
  out = out.replace(BOOKKEEPING_LINE, "");
  out = stripSecretParams(out);
  out = out.replace(LOCAL_PATH, "");
  return out.replace(/\n{3,}/g, "\n\n");
}

/** Imported text: Living Node marker comments become nothing, so imported content can never claim ownership or start a card. */
export function stripLivingNodeMarkers(text: string): string {
  return text.replace(MARKER, "").replace(/<!--\s*vam-living-node:[^\n]*$/gim, "");
}
