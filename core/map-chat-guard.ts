import { parseMap } from "../map-model";

/**
 * "Do not break VAM" guard for the writes a map chat reply asks for. Pure: it looks only at the target path and the old and
 * new text, never at the vault. It answers with a code; wording for the user belongs to the caller.
 */
export type MapChatGuardCode =
  | "outside_vault"
  | "config_dir"
  | "not_markdown"
  | "map_unparseable"
  | "map_file"
  | "duplicate_identity_key"
  | "topic_identity_changed"
  | "reserved_frontmatter"
  | "exists"
  | "no_baseline";
export type MapChatGuardResult = { ok: true } | { ok: false; code: MapChatGuardCode };

export interface MapChatWriteCheck {
  kind: "edit" | "create";
  /** The path the reply named, as written. */
  path: string;
  /** The file text before the write (edit only). */
  oldContent?: string;
  /** The file text after the write. */
  newContent: string;
  /** True when a file or folder already exists at the path (create only; the caller reads it from the vault). */
  exists?: boolean;
  /** Paths (normalised) of the Markdown files that were sent in this turn's context, with their content hash. */
  knownHashes?: Readonly<Record<string, string>>;
  /** `app.vault.configDir`, the vault's configuration folder (not always `.obsidian`). */
  configDir: string;
}

/** The identity keys of a topic note; a write must leave each exactly as it was. */
export const TOPIC_IDENTITY_KEYS: readonly string[] = ["agent-map-node", "node-id", "topic-id"];

/**
 * A vault-relative path in one canonical spelling (forward slashes, no `./`, no repeated or trailing slash), or null when
 * the text cannot name a place inside the vault: empty, absolute (`/`, drive letter, `~`), or containing a `..` segment.
 */
export function normalizeVaultPath(path: string): string | null {
  if (typeof path !== "string") return null;
  const text = path.trim().replace(/\\/g, "/");
  if (!text || text.startsWith("/") || text.startsWith("~") || /^[A-Za-z]:/.test(text) || text.includes("\0"))
    return null;
  const parts: string[] = [];
  for (const part of text.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") return null;
    parts.push(part);
  }
  return parts.length ? parts.join("/") : null;
}

function frontmatterBlock(content: string): string | null {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  return match ? match[1] : null;
}

/** Top-level `key: value` lines of a front matter block, value trimmed and unquoted. Enough to compare identity keys. */
function topLevelValues(block: string | null, keys: readonly string[]): Map<string, string> {
  const found = new Map<string, string>();
  if (block === null) return found;
  for (const line of block.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*?)\s*$/);
    if (!match || !keys.includes(match[1]) || found.has(match[1])) continue;
    found.set(match[1], match[2].replace(/^(["'])(.*)\1$/, "$2"));
  }
  return found;
}

/** True when a top-level identity key appears more than once: which value wins is parser-dependent, so such a file is not edited. */
function hasDuplicateIdentityKey(block: string | null): boolean {
  if (block === null) return false;
  const seen = new Set<string>();
  for (const line of block.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z0-9_-]+)\s*:/);
    if (!match || !TOPIC_IDENTITY_KEYS.includes(match[1])) continue;
    if (seen.has(match[1])) return true;
    seen.add(match[1]);
  }
  return false;
}

const hasMapMarker = (content: string): boolean =>
  /```agent-map\s*\n/.test(content) ||
  topLevelValues(frontmatterBlock(content), ["visual-agent-map"]).has("visual-agent-map");

export function guardMapChatWrite(check: MapChatWriteCheck): MapChatGuardResult {
  const path = normalizeVaultPath(check.path);
  if (path === null) return { ok: false, code: "outside_vault" };
  const configDir = normalizeVaultPath(check.configDir);
  const lower = path.toLowerCase();
  const inside = (dir: string | null): boolean =>
    !!dir && (lower === dir.toLowerCase() || lower.startsWith(`${dir.toLowerCase()}/`));
  if (configDir === null || inside(configDir)) return { ok: false, code: "config_dir" };
  if (!path.toLowerCase().endsWith(".md")) return { ok: false, code: "not_markdown" };
  if (check.kind === "create") {
    if (check.exists) return { ok: false, code: "exists" };
    if (
      hasMapMarker(check.newContent) ||
      topLevelValues(frontmatterBlock(check.newContent), TOPIC_IDENTITY_KEYS).size > 0
    )
      return { ok: false, code: "reserved_frontmatter" };
    return { ok: true };
  }
  const baseline = check.knownHashes ?? {};
  if (!Object.prototype.hasOwnProperty.call(baseline, path)) return { ok: false, code: "no_baseline" };
  const before = check.oldContent ?? "";
  if (hasMapMarker(before) || hasMapMarker(check.newContent)) {
    // A map file is the plugin's own data: the chat never edits it (map changes go through the topic actions).
    try {
      parseMap(check.newContent);
    } catch {
      return { ok: false, code: "map_unparseable" };
    }
    return { ok: false, code: "map_file" };
  }
  if (hasDuplicateIdentityKey(frontmatterBlock(before)) || hasDuplicateIdentityKey(frontmatterBlock(check.newContent)))
    return { ok: false, code: "duplicate_identity_key" };
  const was = topLevelValues(frontmatterBlock(before), TOPIC_IDENTITY_KEYS);
  const now = topLevelValues(frontmatterBlock(check.newContent), TOPIC_IDENTITY_KEYS);
  for (const key of TOPIC_IDENTITY_KEYS) {
    if (was.get(key) === now.get(key)) continue;
    // A note that was not a topic must not become one.
    return { ok: false, code: was.has(key) ? "topic_identity_changed" : "reserved_frontmatter" };
  }
  return { ok: true };
}

/** The file text with the one exact occurrence of `find` replaced; null when `find` is empty, missing or appears more than once. */
export function applyMdEdit(content: string, find: string, replace: string): string | null {
  if (!find) return null;
  const at = content.indexOf(find);
  if (at < 0 || content.indexOf(find, at + 1) >= 0) return null;
  return content.slice(0, at) + replace + content.slice(at + find.length);
}
