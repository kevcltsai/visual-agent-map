import type { CodexActivity } from "../ai/runtime/codex-app-server";
import type { AiCalls } from "./ai-calls";
import { providerStepRunner, type ProviderStepHooks, type ProviderStepRunner } from "./provider-step-runner";
import { prepareStep } from "./step-runner";
import {
  MapChatError,
  mapChatStep,
  parseMapChat,
  MAP_CHAT_SCHEMA,
  type MapChatRequest,
  type MapChatResult
} from "./steps/map-chat/step";

export { MapChatError, parseMapChat, MAP_CHAT_SCHEMA };
export type { MapChatRequest, MapChatResult };
export type MapChatRunner = ProviderStepRunner<MapChatRequest, MapChatResult>;
/** A model event of one chat turn, for the progress stage: Claude's first stream event, or Codex's activity. */
export type MapChatProgressEvent = { kind: "first-event" } | { kind: "activity"; activity: CodexActivity };

export function buildMapChatPrompt(request: MapChatRequest): string {
  return mapChatStep.render(request);
}

// --- streaming the `reply` field out of the partial StructuredOutput JSON ---

const isHex = (text: string): boolean => /^[0-9a-fA-F]{4}$/.test(text);
const SIMPLE: Record<string, string> = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };

/** Decodes the JSON string that starts at `start` (just after its opening quote). An unfinished escape is left out. */
function decodeString(buffer: string, start: number): { value: string; end: number; complete: boolean } {
  let value = "";
  let i = start;
  while (i < buffer.length) {
    const char = buffer[i];
    if (char === '"') return { value, end: i + 1, complete: true };
    if (char !== "\\") {
      value += char;
      i++;
      continue;
    }
    if (i + 1 >= buffer.length) break;
    const next = buffer[i + 1];
    if (next === "u") {
      const hex = buffer.slice(i + 2, i + 6);
      if (!isHex(hex)) {
        if (hex.length < 4 && /^[0-9a-fA-F]*$/.test(hex)) break;
        value += "u";
        i += 2;
        continue;
      }
      value += String.fromCharCode(parseInt(hex, 16));
      i += 6;
      continue;
    }
    value += next in SIMPLE ? SIMPLE[next] : next;
    i += 2;
  }
  return { value, end: buffer.length, complete: false };
}

/** Index after the JSON value that starts at `start`, or -1 when the buffer ends inside it. */
function skipValue(buffer: string, start: number): number {
  let i = start;
  let depth = 0;
  while (i < buffer.length) {
    const char = buffer[i];
    if (char === '"') {
      i++;
      while (i < buffer.length && buffer[i] !== '"') i += buffer[i] === "\\" ? 2 : 1;
      if (i >= buffer.length) return -1;
      i++;
      if (depth === 0) return i;
      continue;
    }
    if (char === "{" || char === "[") depth++;
    else if (char === "}" || char === "]") {
      if (depth === 0) return i;
      depth--;
      if (depth === 0) return i + 1;
    } else if (depth === 0 && char === ",") return i;
    i++;
  }
  return -1;
}

const skipSpace = (buffer: string, from: number): number => {
  let i = from;
  while (i < buffer.length && /\s/.test(buffer[i])) i++;
  return i;
};

/**
 * The text of the top-level `reply` string in an unfinished JSON object, decoded so far. `complete` is true once its closing
 * quote has arrived. Never throws: a buffer that is cut anywhere gives the finished part, and a buffer with no `reply` yet
 * gives an empty, incomplete result.
 */
export function partialReply(buffer: string): { text: string; complete: boolean } {
  const none = { text: "", complete: false };
  try {
    if (typeof buffer !== "string") return none;
    let i = skipSpace(buffer, 0);
    if (buffer[i] !== "{") return none;
    i++;
    while (i < buffer.length) {
      i = skipSpace(buffer, i);
      if (buffer[i] === ",") i = skipSpace(buffer, i + 1);
      if (i >= buffer.length || buffer[i] !== '"') break;
      const key = decodeString(buffer, i + 1);
      if (!key.complete) break;
      i = skipSpace(buffer, key.end);
      if (buffer[i] !== ":") break;
      i = skipSpace(buffer, i + 1);
      if (i >= buffer.length) break;
      if (key.value === "reply" && buffer[i] === '"') {
        const reply = decodeString(buffer, i + 1);
        return { text: reply.value, complete: reply.complete };
      }
      const end = skipValue(buffer, i);
      if (end < 0) break;
      i = end;
    }
  } catch {
    /* partial text must never throw */
  }
  return none;
}

/**
 * The reply to show from Codex's visible text so far, for a display only (the result still comes from `prepared.parse`). The
 * text is every message item joined by a blank line, so it may start with a lead-in ("Here is the JSON:"), hold an earlier
 * item, or be cut anywhere. The reply is read from the last `{` that starts a line and has a `reply` string; a JSON string never
 * holds a raw newline, so a `{` that follows a newline is never inside the reply. No reply yet gives "".
 */
export function replyFromAgentText(text: string): string {
  if (typeof text !== "string") return "";
  for (let at = text.lastIndexOf("{"); at >= 0; at = text.lastIndexOf("{", at - 1)) {
    if (/^[ \t]*$/.test(text.slice(text.lastIndexOf("\n", at - 1) + 1, at))) {
      const reply = partialReply(text.slice(at)).text;
      if (reply) return reply;
    }
    if (at === 0) break;
  }
  return "";
}

export function providerMapChatRunner(aiCalls: AiCalls): MapChatRunner {
  return providerStepRunner<MapChatRequest, MapChatResult>(aiCalls, {
    name: "map-chat",
    topic: request => `Map chat · ${request.message.trim().slice(0, 80)}`,
    stopped: () => new MapChatError("stopped", "Map chat stopped"),
    stream: true,
    lastMessageOnly: true
  });
}

export class MapChatService {
  constructor(private readonly run: MapChatRunner) {}
  /**
   * One chat turn. `onReply` receives the whole reply text decoded so far (not a delta) each time it grows; it starts over
   * from "" when the CLI begins a new StructuredOutput call or rejects the previous one. Throws {@link MapChatError} for an
   * empty message, an over-budget context, a stop or a malformed reply. Actions that name nothing valid come back in
   * `rejected`. Claude streams the StructuredOutput JSON; Codex streams its message text (only growing). Other providers never call `onReply`.
   * `onProgress` gets the runtime's model events (never after a stop); it only drives a display.
   */
  async chat(
    request: MapChatRequest,
    signal: AbortSignal,
    onReply?: (reply: string) => void,
    onProgress?: (event: MapChatProgressEvent) => void
  ): Promise<MapChatResult> {
    const stopped = (): MapChatError => new MapChatError("stopped", "Map chat stopped");
    if (signal.aborted) throw stopped();
    const prepared = prepareStep(mapChatStep, request);
    let shown = "";
    const onStructuredJson = onReply
      ? (buffer: string | null): void => {
          if (signal.aborted) return;
          const text = buffer ? partialReply(buffer).text : "";
          if (text === shown) return;
          shown = text;
          onReply(text);
        }
      : undefined;
    // Codex's text only grows on screen: a shorter reading (another message item started, a different cut) never replaces it.
    const onText = onReply
      ? (full: string): void => {
          if (signal.aborted) return;
          const text = replyFromAgentText(full);
          if (!text || text.length < shown.length || text === shown) return;
          shown = text;
          onReply(text);
        }
      : undefined;
    const hooks: ProviderStepHooks | undefined =
      onProgress || onText
        ? {
            ...(onText ? { onText } : {}),
            ...(onProgress
              ? {
                  onFirstEvent: () => {
                    if (!signal.aborted) onProgress({ kind: "first-event" });
                  },
                  onActivity: (activity: CodexActivity) => {
                    if (!signal.aborted) onProgress({ kind: "activity", activity });
                  }
                }
              : {})
          }
        : undefined;
    let raw: string;
    try {
      raw = await this.run(request, signal, prepared, onStructuredJson, hooks);
    } catch (error) {
      if (signal.aborted && !(error instanceof MapChatError)) throw stopped();
      if (error instanceof MapChatError && error.code === "stopped") throw stopped();
      throw error;
    }
    if (signal.aborted) throw stopped();
    return prepared.parse(raw);
  }
}
