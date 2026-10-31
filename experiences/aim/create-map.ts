import { titleProblem } from "../../core/title-safety";
import type { MapDocument, MapNode } from "../../map-model";
import type { Repository } from "../../repository";
import { normalizeReasoningLevel } from "../../ai/task-policy";
import { randomUUID } from "node:crypto";
import { noteLanguageOf, translate, type ContentLanguage } from "../../i18n";
import { chooseAimContentLanguage } from "./content-language";
import { buildAimRootContext, type AimOutcomeExpectation } from "./outcome-expectations";

export interface AimStartInput {
  topic: string;
  context: string;
  /** The language picked by hand in the start dialog; absent means detect it from the topic and context. */
  outputLanguage?: ContentLanguage;
  outcomeExpectation?: AimOutcomeExpectation;
  requestId?: string;
  model?: string;
  /** `auto` is accepted from the start dialog but never written into the AIM map data. */
  reasoning?: "auto" | "low" | "medium" | "high";
  minimumAnswersBeforeConclusion?: number;
  /** Unattended runs ask everything in the intake and never wait for the user afterwards. */
  interaction?: "unattended" | "interactive";
}
export interface AimStartResult {
  mapPath: string;
  map: MapDocument;
  root: MapNode;
}

/** Creates the first durable AIM slice through VAM's existing Map/Note Repository. */
export async function createAimMap(
  repository: Repository,
  model: string,
  input: AimStartInput
): Promise<AimStartResult> {
  const topic = input.topic.trim();
  if (!topic) throw new Error("AIM topic is required.");
  // The topic is the user's own text and becomes the map title: refuse it before anything is written (D-2026-10-95).
  const problem = titleProblem(topic);
  if (problem) throw new Error(translate(repository.settings.language, `ui.title_problem_${problem}`));
  const requestId = input.requestId?.trim();
  if (!requestId) throw new Error("AIM creation request identity is required.");
  // Decided once from the user's own words (before the expectation labels are appended).
  const detectedLanguage =
    input.outputLanguage ?? chooseAimContentLanguage(repository.settings.language, topic, input.context);
  // Recorded on the map when it was picked by hand, or when it differs from the note language (D-2026-10-88).
  const outputLanguage =
    input.outputLanguage !== undefined || detectedLanguage !== noteLanguageOf(detectedLanguage)
      ? detectedLanguage
      : undefined;
  let mapPath = "";
  for (const file of await repository.mapFiles()) {
    if ((await repository.readMap(file.path)).aim?.creationId === requestId) {
      mapPath = file.path;
      break;
    }
  }
  if (!mapPath) {
    const minimumAnswersBeforeConclusion = input.minimumAnswersBeforeConclusion ?? 3;
    mapPath = await repository.createMap(
      topic,
      [],
      undefined,
      {
        version: 1,
        creationId: requestId,
        contentLanguage: noteLanguageOf(detectedLanguage),
        minimumAnswersBeforeConclusion,
        ...(input.interaction === "unattended" ? { interaction: "unattended" as const } : {}),
        branches: [],
        runs: [],
        resultDrafts: [],
        pendingCommits: []
      },
      outputLanguage
    );
  }
  const map = await repository.readMap(mapPath);
  if (map.title !== topic) throw new Error("This AIM creation request was already used for another topic.");
  if (!map.aim) throw new Error("The existing map does not contain a AIM creation record.");

  // The stored value is a note language; the notes below are written in it.
  const noteLanguage = map.aim.contentLanguage ?? noteLanguageOf(detectedLanguage);
  const rootContext = buildAimRootContext(input.context, input.outcomeExpectation, noteLanguage);
  let draft = map.aim.rootDraft;
  if (!draft && !map.nodes.some(node => node.aimKind === "topic")) {
    const notePath = repository.unique(repository.topicFolder(mapPath, "Notes"), topic);
    const chosenReasoning = normalizeReasoningLevel(input.reasoning ?? repository.settings.cliReasoning);
    draft = {
      nodeId: randomUUID(),
      notePath,
      title: topic,
      context: rootContext,
      model: input.model ?? model,
      // Never "auto": the map data only knows low/medium/high, so an auto choice is left out of the draft.
      ...(chosenReasoning === "auto" ? {} : { reasoning: chosenReasoning })
    };
    map.aim.rootDraft = draft;
    map.aim.contentLanguage ??= noteLanguage;
    await repository.saveMap(mapPath, map);
  }
  if (draft) {
    const noteModel = draft.model ?? model;
    const noteReasoning = normalizeReasoningLevel(
      draft.reasoning ?? input.reasoning ?? repository.settings.cliReasoning
    );
    // The root follows the workspace only when both the model and the reasoning equal the current ones; otherwise the
    // person's choice is kept as a manual override.
    const followsCurrent =
      noteModel === repository.settings.cliModel &&
      noteReasoning === normalizeReasoningLevel(repository.settings.cliReasoning);
    await repository.createNoteAt(
      draft.title,
      noteModel,
      map,
      mapPath,
      followsCurrent ? "workspace" : "manual",
      draft.notePath,
      draft.nodeId,
      {
        summary: draft.title,
        detail: draft.context ? `${translate(noteLanguage, "note.aim_user_context")}\n\n${draft.context}` : "",
        reasoning: noteReasoning,
        contentLanguage: noteLanguage
      }
    );
    const root: MapNode = {
      id: draft.nodeId,
      path: draft.notePath,
      parentId: null,
      x: 80,
      y: 80,
      collapsed: false,
      aimKind: "topic"
    };
    map.nodes.push(root);
    delete map.aim.rootDraft;
    await repository.saveMap(mapPath, map);
  }
  const savedMap = await repository.readMap(mapPath);
  const root = savedMap.nodes.find(node => node.aimKind === "topic");
  if (!root) throw new Error("AIM mother topic was not saved; reopen this map to resume its creation.");
  return { mapPath, map: savedMap, root };
}
