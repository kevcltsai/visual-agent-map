import { renderTemplate } from "../../../../core/step-runner";
import template from "./task.md";
import noteStructure from "./note-structure.md";

/**
 * Task text of `aim.delivery-outline`: design the document, mapping sections to the supplied evidence. With a
 * `structure` (the sections of the user's note style) the outline must use exactly those sections; without it the
 * text is the unchanged default.
 */
export const renderOutlineTask = (sourceCatalog: string, structure?: string): string => {
  const task = renderTemplate(template, { sourceCatalog });
  return structure === undefined ? task : `${task}\n${renderTemplate(noteStructure, { structure })}`;
};
