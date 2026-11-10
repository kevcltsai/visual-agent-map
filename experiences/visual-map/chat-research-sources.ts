import type { ReferenceGroup } from "../../ai/reference-materials";
import type { MultiResearchRequest } from "./multi-research-modal";

/** A multi-topic research request that may also carry reference documents (only the chat sets them). */
export type ResearchRequestWithReferences = MultiResearchRequest & { referenceGroups?: ReferenceGroup[] };

/** What one chat turn attached, as `buildMapChatContext` reads it: dropped files, dropped text and the note the chip names. */
export interface ChatReferenceInput {
  files: { path: string; content: string }[];
  activeFile: { path: string; content: string } | null;
  snippets: { path: string; text: string; fileContent?: string }[];
}

/**
 * The turn's attachments as one reference group for a research started from the chat. A note and a snippet of it are one document
 * (the whole note wins); a snippet whose file could not be read keeps only its own text. No attachment means no group.
 */
export function chatResearchReferenceGroups(input: ChatReferenceInput): ReferenceGroup[] {
  const documents: ReferenceGroup["documents"] = [];
  const whole = new Set<string>();
  for (const file of [...input.files, ...(input.activeFile ? [input.activeFile] : [])]) {
    if (whole.has(file.path)) continue;
    whole.add(file.path);
    documents.push({ path: file.path, content: file.content, key: file.path });
  }
  input.snippets.forEach((snippet, index) => {
    if (!snippet.text.trim()) return;
    const key = whole.has(snippet.path) ? snippet.path : `chat-snippet:${index}`;
    documents.push({ path: snippet.path || "Selected text", content: snippet.text, key });
  });
  return documents.length ? [{ id: "chat-references", name: "Chat references", location: "", documents }] : [];
}
