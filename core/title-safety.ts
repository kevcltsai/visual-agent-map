/** Why a card or map title cannot be saved: it would break the note's H1 or a `[[link|alias]]`. */
export type TitleProblem = "fence" | "brackets";

/** The reason a user-typed title is refused, or undefined when it is safe. `#` is allowed. */
export function titleProblem(text: string): TitleProblem | undefined {
  if (text.includes("```")) return "fence";
  if (text.includes("[[") || text.includes("]]")) return "brackets";
  return undefined;
}

/** Cleans an AI-generated title: removes ``` and turns `[[` into `[` and `]]` into `]`. Never used on user text. */
export function sanitizeGeneratedTitle(text: string): string {
  let out = text.replace(/`{3,}/g, "");
  while (out.includes("[[") || out.includes("]]")) out = out.replace(/\[\[/g, "[").replace(/\]\]/g, "]");
  return out;
}
