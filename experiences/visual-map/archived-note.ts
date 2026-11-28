// Pure (no Obsidian import) so the share format can read knowledge references without loading the host API.
/**
 * True for a VAM-managed note (`agent-map-node`) that is archived: `topic-state: archived`, or no `topic-state` and the
 * note sits directly in a folder named `Archive`. Ordinary notes (also in an `Archive` folder) are never archived.
 */
export function isArchivedVamNote(path: string, fm: Record<string, unknown> | null | undefined): boolean {
  if (!fm || typeof fm !== "object") return false;
  const managed = fm["agent-map-node"] === true || fm["agent-map-node"] === "true";
  if (!managed) return false;
  return (
    fm["topic-state"] === "archived" ||
    (fm["topic-state"] === undefined && path.replace(/\\/g, "/").split("/").at(-2) === "Archive")
  );
}
