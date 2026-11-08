import { normalizeVaultPath } from "../../core/map-chat-guard";
import { MAP_CHAT_NEW_PREFIX, type MapChatAction } from "../../core/steps/map-chat/step";

/** ok: applied; out: outside the topic's subtree (refused, and the user is told); ignore: not something a topic chat does (skipped quietly). */
export type TopicScopeVerdict = "ok" | "out" | "ignore";

interface ScopeNode {
  id: string;
  parentId: string | null;
  path: string;
}

/** The topic and everything under it. */
export function topicSubtreeIds(nodes: readonly ScopeNode[], rootId: string): Set<string> {
  const scope = new Set<string>([rootId]);
  for (let grew = true; grew;) {
    grew = false;
    for (const node of nodes)
      if (node.parentId && scope.has(node.parentId) && !scope.has(node.id)) {
        scope.add(node.id);
        grew = true;
      }
  }
  return scope;
}

const RUNS_HERE: readonly string[] = ["research_standard", "expand", "synthesize"];

/**
 * One verdict per action: whether a topic chat may apply it. The rule is code, not a prompt: nothing outside the subtree of
 * `rootId` is written, no map is made, opened or renamed, and the topic itself is never deleted or moved. A card the reply
 * adds (`new:<ref>`) counts only when it was added under the subtree.
 */
export function judgeTopicScope(
  actions: readonly MapChatAction[],
  nodes: readonly ScopeNode[],
  rootId: string
): TopicScopeVerdict[] {
  const scope = topicSubtreeIds(nodes, rootId);
  const refs = new Set<string>();
  const idOk = (id: string): boolean =>
    id.startsWith(MAP_CHAT_NEW_PREFIX) ? refs.has(id.slice(MAP_CHAT_NEW_PREFIX.length)) : scope.has(id);
  const allOk = (ids: readonly string[]): boolean => ids.every(idOk);
  const paths = new Map<string, string>();
  for (const node of nodes) paths.set(node.path, node.id);
  return actions.map((action): TopicScopeVerdict => {
    switch (action.kind) {
      case "add_child":
        if (!action.parentId || !idOk(action.parentId)) return "out";
        if (action.ref) refs.add(action.ref);
        return "ok";
      case "rename_topic":
      case "update_summary":
      case "edit_topic_note":
      case "collapse_topic":
      case "expand_topic":
      case "focus_topic":
        return idOk(action.nodeId) ? "ok" : "out";
      case "move_topic":
        return action.nodeId !== rootId &&
          idOk(action.nodeId) &&
          idOk(action.newParentId) &&
          (!action.beforeId || idOk(action.beforeId))
          ? "ok"
          : "out";
      case "reorder_topics":
        return idOk(action.parentId) && allOk(action.nodeIds) ? "ok" : "out";
      case "delete_topic":
        return action.nodeId !== rootId && idOk(action.nodeId) ? "ok" : "out";
      case "edit_md_file": {
        const key = normalizeVaultPath(action.path);
        const id = key ? paths.get(key) : undefined;
        return id && scope.has(id) ? "ok" : "out";
      }
      case "set_topic_kind":
      case "set_appearance":
        return action.nodeIds.length && allOk(action.nodeIds) ? "ok" : "out";
      case "add_relation":
      case "remove_relation":
        return idOk(action.fromId) && idOk(action.toId) ? "ok" : "out";
      case "run_map_action":
        if (!allOk(action.nodeIds)) return "out";
        return RUNS_HERE.includes(action.action) ? "ok" : "ignore";
      case "select_topics":
        return allOk(action.nodeIds) && !action.all ? "ignore" : "out";
      case "auto_layout":
      case "ask_topic_kind":
        return "ignore";
      default:
        // create_map, open_map, rename_map, create_md_file, add_anchor, link_anchor: never from a topic chat.
        return "out";
    }
  });
}
