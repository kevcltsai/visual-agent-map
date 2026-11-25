/** Digits that belong to an identifier (A1, v2, C4, H2O, quadrant-1) are not quantities. */
export function numberTokens(text: string): string[] {
  const s = text.normalize("NFKC"),
    out: string[] = [];
  const re = /\d{1,3}(?:,\d{3})+(?!\d)(?:\.\d+)?|\d+(?:\.\d+)?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    const p = m.index > 0 ? s[m.index - 1] : "",
      pp = m.index > 1 ? s[m.index - 2] : "";
    if (/[A-Za-z_]/.test(p)) continue;
    if (p === "-" && /[A-Za-z]/.test(pp)) continue;
    out.push(m[0].replace(/,/g, ""));
  }
  return out;
}

/** Numbers available as evidence: those in the note body, never in diagrams, link targets, URLs, footnote markers or comments. */
export function noteNumbers(detail: string): Set<string> {
  let t = detail.replace(/\r\n/g, "\n");
  t = t.replace(/^[ \t]*(`{3,}|~{3,})[ \t]*mermaid[^\n]*\n[\s\S]*?\n[ \t]*\1[ \t]*$/gm, "");
  t = t
    .replace(/\]\([^)]*\)/g, "]")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/\[\^[^\]]*\]/g, "")
    .replace(/<!--[\s\S]*?-->/g, "");
  return new Set(numberTokens(t));
}

/** The comparable form of a number: 2.0 and 2 are the same quantity; very long digit strings stay as written. */
export function normalNumber(token: string): string {
  const value = Number(token);
  return Number.isFinite(value) && token.length < 16 ? String(value) : token;
}

function decoded(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** URLs, wikilink targets (alias and heading dropped) and local link or image targets, in a comparable form. */
export function linksOf(texts: string[]): Map<string, string> {
  const out = new Map<string, string>();
  const add = (kind: string, raw: string): void => {
    const shown = raw.trim().replace(/[.,;:!?*_'"]+$/, "");
    const key = decoded(shown).toLowerCase().replace(/\/+$/, "").replace(/\.md$/, "");
    if (key) out.set(`${kind}${key}`, shown);
  };
  for (const text of texts) {
    for (const match of text.matchAll(/https?:\/\/[^\s<>"'`)\]]+/g)) add("", match[0]);
    for (const match of text.matchAll(/!?\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/g)) add("wiki:", match[1]);
    for (const match of text.matchAll(/\]\(\s*<?([^)\s>]+)/g)) {
      const target = match[1];
      if (/^(?:https?:|mailto:|#)/i.test(target)) continue;
      add("link:", target);
    }
  }
  return out;
}
