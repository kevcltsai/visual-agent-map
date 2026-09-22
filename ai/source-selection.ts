import type { ResearchDepth } from "../repository";

export interface SourceDocument { name: string; content: string; explicit?: boolean }

function terms(value: string): string[] {
  const words = value.toLowerCase().match(/[a-z0-9]{2,}|[\u3400-\u9fff]{2,}/g) ?? [];
  return [...new Set(words.flatMap(word => /[\u3400-\u9fff]/.test(word) && word.length > 2
    ? Array.from({ length: word.length - 1 }, (_, index) => word.slice(index, index + 2))
    : [word]))];
}

export function selectSourceDocuments(query: string, documents: SourceDocument[], depth: ResearchDepth = "normal"): SourceDocument[] {
  const limit = depth === "fast" ? 2 : depth === "deep" ? 10 : 5;
  const tokens = terms(query);
  const ranked = documents.filter(document => document.name.toLowerCase().endsWith(".md"))
    .map(document => {
      const title = document.name.toLowerCase(), body = document.content.slice(0, 64_000).toLowerCase();
      const score = tokens.reduce((total, token) => total + (title.includes(token) ? 4 : 0) + (body.includes(token) ? 1 : 0), 0);
      return { document, score };
    })
    .sort((left, right) => right.score - left.score || left.document.name.localeCompare(right.document.name));
  return ranked.filter(item => item.score > 0).slice(0, limit).map(item => item.document);
}

export function sourceContext(documents: SourceDocument[]): string {
  return documents.map(document => `來源：${document.name}\n${document.content.slice(0, document.explicit ? 20_000 : 12_000)}`).join("\n\n");
}
