/** One web image the model offered: its https image link, a title, and the https page it came from. */
export interface ImageCandidate {
  title: string;
  url: string;
  source: string;
}

/** Markdown for a chosen image and a link to the page it came from. */
export function imageMarkdown(candidate: ImageCandidate): string {
  const title = candidate.title.replace(/[\]\\\r\n[<>]/g, " ");
  return `![${title}](<${candidate.url}>)\n\n[${title}](<${candidate.source}>)`;
}

const WIKIMEDIA_ORIGINAL =
  /^https:\/\/upload\.wikimedia\.org\/wikipedia\/([^/]+)\/([0-9a-f])\/([0-9a-f]{2})\/([^/?#]+\.(?:jpe?g|png|gif|webp))$/i;

const WIKIMEDIA_THUMB =
  /^(https:\/\/upload\.wikimedia\.org\/wikipedia\/[^/]+\/thumb\/[0-9a-f]\/[0-9a-f]{2}\/[^/?#]+\/)(\d+)(px-[^/?#]+)$/i;
/** The thumbnail widths Wikimedia serves; any other width answers 400 (measured 2026-11-14: 320, 640 and 800 fail). */
const WIKIMEDIA_THUMB_WIDTHS = new Set([20, 40, 60, 120, 250, 330, 500, 960, 1280, 1920, 3840]);

/**
 * A Wikimedia original (can be hundreds of MB, which Obsidian renders blank) as its 1280px thumbnail, and a thumbnail at a
 * width Wikimedia does not serve (it shows as a broken image) moved to 1280px; any other link unchanged.
 */
export function wikimediaThumbnail(url: string): string {
  const thumb = WIKIMEDIA_THUMB.exec(url);
  if (thumb) return WIKIMEDIA_THUMB_WIDTHS.has(Number(thumb[2])) ? url : `${thumb[1]}1280${thumb[3]}`;
  const match = WIKIMEDIA_ORIGINAL.exec(url);
  if (!match) return url;
  const [, project, a, ab, file] = match;
  return `https://upload.wikimedia.org/wikipedia/${project}/thumb/${a}/${ab}/${file}/1280px-${file}`;
}

/** Every Markdown image embed of the text, `![alt](url)` or `![alt](<url>)`, with Wikimedia originals swapped for thumbnails. */
export function wikimediaThumbnails(markdown: string): string {
  return markdown.replace(
    /(!\[[^\]\n]*\]\(<?)(https:\/\/upload\.wikimedia\.org\/[^\s)>]+)/g,
    (_, head: string, url: string) => head + wikimediaThumbnail(url)
  );
}
