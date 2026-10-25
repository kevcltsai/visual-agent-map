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
