import { App, TFile } from "obsidian";

export interface ReferenceDocument { path: string; content: string; external?: boolean; key?: string }
export interface ReferenceGroup { id: string; name: string; location: string; documents: ReferenceDocument[] }

export async function readMarkdownFile(app: App, file: TFile): Promise<ReferenceDocument> {
  if (file.extension.toLowerCase() !== "md") throw new Error(`Only Markdown can be used as local reference: ${file.path}`);
  return { path: file.path, content: await app.vault.read(file) };
}

export function dedupeReferenceGroups(groups: ReferenceGroup[]): ReferenceGroup[] {
  const seen = new Set<string>();
  return groups.map(group => ({ ...group, documents: group.documents.filter(document => {
    const key = document.key || document.path;
    if (seen.has(key)) return false;
    seen.add(key); return true;
  }) }));
}

export function packReferenceChunks(chunks: string[], characterLimit = 18_000): string[] {
  const batches: string[] = [];
  let batch = "";
  for (const chunk of chunks) {
    if (batch && batch.length + chunk.length > characterLimit) { batches.push(batch); batch = ""; }
    batch += `${batch ? "\n\n" : ""}${chunk}`;
  }
  if (batch) batches.push(batch);
  return batches;
}

export function referenceBatches(groups: ReferenceGroup[], documentLimit = 14_000, batchLimit = 18_000): string[] {
  const chunks: string[] = [];
  let sourceNumber = 0;
  for (const group of dedupeReferenceGroups(groups)) for (const document of group.documents) {
    sourceNumber++;
    const id = `S${sourceNumber}`;
    const citation = document.external ? "external Markdown; cite the exact path as plain text" : "Vault Markdown; cite as an Obsidian wikilink";
    const pieces = document.content.match(new RegExp(`[\\s\\S]{1,${documentLimit}}`, "g")) ?? [""];
    pieces.forEach((piece, index) => chunks.push(`[${id}] ${citation}: ${document.path}${pieces.length > 1 ? ` (part ${index + 1}/${pieces.length})` : ""}\n${piece}`));
  }
  return packReferenceChunks(chunks, batchLimit);
}

export function referenceCatalog(groups: ReferenceGroup[]): string {
  const documents = dedupeReferenceGroups(groups).flatMap(group => group.documents);
  return documents.map((document, index) => `[S${index + 1}] ${document.external ? "External file (plain path)" : "Vault note (wikilink)"}: ${document.path}`).join("\n");
}

export function resolveReferenceLinks(detail: string, groups: ReferenceGroup[]): string {
  const documents = dedupeReferenceGroups(groups).flatMap(group => group.documents);
  const identified = detail.replace(/\[S(\d+)\]/g, (original, number: string) => {
    const document = documents[Number(number) - 1];
    if (!document) return `來源待確認：${original}`;
    return document.external ? `外部來源：${document.path}` : `[[${document.path}]]`;
  });
  return identified.replace(/\[\[([^\]]+)\]\]/g, (original, target: string) => {
    const name = target.split("|")[0].trim();
    const exact = documents.filter(document => document.path === name);
    const matches = exact.length ? exact : documents.filter(document => {
      const basename = document.path.split("/").pop() ?? document.path;
      return basename === name || basename.replace(/\.md$/i, "") === name;
    });
    if (matches.length > 1) return `來源待確認：${name}`;
    if (matches.length !== 1 || !matches[0].external) return original;
    return `外部來源：${matches[0].path}`;
  });
}
