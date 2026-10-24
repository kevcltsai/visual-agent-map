/**
 * Cleans a model reply before it is laid out as Markdown in the map chat. The reply is untrusted: laid out as it is, it could
 * load a remote image (leaking what the chat knows through the address), embed a note, or hand a code block to a plugin that
 * runs it. Only what is outside code is rewritten; the user still sees every link, and the stored reply is never changed.
 */

const FENCE_OPEN = /^( {0,3})(`{3,}|~{3,})(.*)$/;

/** Rewrites one stretch of text that holds no code. Images are handled before `<` is escaped, because `<` can wrap an address. */
function cleanText(text: string): string {
  return (
    text
      // ![[note]] embeds a vault file; [[note]] is only a link.
      .replace(/!\[\[/g, "[[")
      // ![alt](https://…), ![alt](<https://…> "title") and protocol-relative addresses: a link, so nothing loads by itself.
      .replace(/!\[([^\]]*)\]\(\s*<?\s*((?:https?:)?\/\/[^)\s>]*)>?([^)]*)\)/gi, "[$1]($2$3)")
      // Reference-style images (![alt][ref], ![alt][], ![ref]) take their address from a definition elsewhere.
      .replace(/!\[([^[\]]*)\](?=\[|[^(\w]|$)/g, "[$1]")
      // Raw HTML (iframe, img, script, ...) becomes text.
      .replace(/</g, "&lt;")
  );
}

/** Rewrites one paragraph, leaving inline code spans (a backtick run closed by a run of the same length) as they are. */
function cleanParagraph(paragraph: string): string {
  let out = "";
  let from = 0;
  let at = 0;
  while (at < paragraph.length) {
    if (paragraph[at] !== "`") {
      at++;
      continue;
    }
    let end = at;
    while (paragraph[end] === "`") end++;
    const run = paragraph.slice(at, end);
    let close = -1;
    for (let search = end; search < paragraph.length;) {
      const next = paragraph.indexOf("`", search);
      if (next < 0) break;
      let stop = next;
      while (paragraph[stop] === "`") stop++;
      if (stop - next === run.length) {
        close = stop;
        break;
      }
      search = stop;
    }
    if (close < 0) {
      at = end;
      continue;
    }
    out += cleanText(paragraph.slice(from, at)) + paragraph.slice(at, close);
    from = close;
    at = close;
  }
  return out + cleanText(paragraph.slice(from));
}

/** Rewrites text outside code fences; paragraphs (split at blank lines) are separate, so a stray backtick shields nothing past it. */
function cleanProse(text: string): string {
  return text
    .split(/(\n[ \t]*\n)/)
    .map((part, index) => (index % 2 ? part : cleanParagraph(part)))
    .join("");
}

export function sanitizeChatMarkdown(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let prose: string[] = [];
  const flush = () => {
    if (prose.length) out.push(cleanProse(prose.join("\n")));
    prose = [];
  };
  for (let at = 0; at < lines.length; at++) {
    const open = FENCE_OPEN.exec(lines[at]);
    // A backtick fence's info string cannot contain a backtick (otherwise the line is inline code, not a fence).
    if (!open || (open[2][0] === "`" && open[3].includes("`"))) {
      prose.push(lines[at]);
      continue;
    }
    flush();
    out.push(open[1] + open[2]);
    const mark = open[2][0];
    const length = open[2].length;
    for (at++; at < lines.length; at++) {
      out.push(lines[at]);
      const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(lines[at]);
      if (close && close[1][0] === mark && close[1].length >= length) break;
    }
  }
  flush();
  return out.join("\n");
}
