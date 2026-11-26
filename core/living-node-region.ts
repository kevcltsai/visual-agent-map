/** Living Node's same-note region is outside the legacy note-section rewriting contract. */
export const LIVING_NODE_BEGIN = "<!-- vam-living-node:begin v1 -->";
export const LIVING_NODE_END = "<!-- vam-living-node:end v1 -->";

export function splitLivingNodeRegion(content: string): { body: string; region: string } {
  const start = content.indexOf(LIVING_NODE_BEGIN);
  const end = content.indexOf(LIVING_NODE_END);
  if (start < 0 && end < 0) return { body: content, region: "" };
  if (
    start < 0 ||
    end < start ||
    content.indexOf(LIVING_NODE_BEGIN, start + LIVING_NODE_BEGIN.length) >= 0 ||
    content.indexOf(LIVING_NODE_END, end + LIVING_NODE_END.length) >= 0
  )
    throw new Error("ambiguous-living-node-region");
  const after = end + LIVING_NODE_END.length;
  return {
    body: content.slice(0, start) + content.slice(after),
    region: content.slice(start, after)
  };
}
