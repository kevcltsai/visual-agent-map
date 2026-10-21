// Extracts the `summary` and `detail` string values from the incomplete JSON text of a StructuredOutput tool call
// (the accumulated input_json_delta.partial_json). Pure: no Obsidian imports, never throws.
export interface PartialFields {
  summary?: string;
  summaryComplete: boolean;
  detail?: string;
  detailComplete: boolean;
}

interface Decoded {
  value: string;
  end: number;
  complete: boolean;
}

const isHex = (text: string) => /^[0-9a-fA-F]{4}$/.test(text);
const isHigh = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLow = (code: number) => code >= 0xdc00 && code <= 0xdfff;
const SIMPLE: Record<string, string> = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };

// `start` is the index just after the opening quote. An incomplete trailing escape (or a high surrogate whose partner has not arrived) is dropped.
function decodeString(buffer: string, start: number): Decoded {
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
      if (hex.length < 4 || !isHex(hex)) {
        if (hex.length < 4 && /^[0-9a-fA-F]*$/.test(hex)) break;
        value += "u";
        i += 2;
        continue;
      }
      const code = parseInt(hex, 16);
      if (isHigh(code)) {
        const rest = buffer.slice(i + 6, i + 12);
        if (rest.length < 6) {
          if ("\\u".startsWith(rest.slice(0, 2)) && /^[0-9a-fA-F]*$/.test(rest.slice(2))) break;
          value += String.fromCharCode(code);
          i += 6;
          continue;
        }
        if (rest.startsWith("\\u") && isHex(rest.slice(2)) && isLow(parseInt(rest.slice(2), 16))) {
          value += String.fromCharCode(code, parseInt(rest.slice(2), 16));
          i += 12;
          continue;
        }
      }
      value += String.fromCharCode(code);
      i += 6;
      continue;
    }
    value += next in SIMPLE ? SIMPLE[next] : next;
    i += 2;
  }
  return { value, end: buffer.length, complete: false };
}

// Skips one JSON value starting at i; returns the index after it, or -1 when the buffer ends inside it.
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

const skipSpace = (buffer: string, from: number) => {
  let i = from;
  while (i < buffer.length && /\s/.test(buffer[i])) i++;
  return i;
};

export function partialFields(buffer: string): PartialFields {
  const out: PartialFields = { summaryComplete: false, detailComplete: false };
  try {
    if (typeof buffer !== "string") return out;
    let i = skipSpace(buffer, 0);
    if (buffer[i] !== "{") return out;
    i++;
    while (i < buffer.length) {
      i = skipSpace(buffer, i);
      if (buffer[i] === ",") {
        i = skipSpace(buffer, i + 1);
      }
      if (i >= buffer.length || buffer[i] !== '"') break;
      const key = decodeString(buffer, i + 1);
      if (!key.complete) break;
      i = skipSpace(buffer, key.end);
      if (buffer[i] !== ":") break;
      i = skipSpace(buffer, i + 1);
      if (i >= buffer.length) break;
      if ((key.value === "summary" || key.value === "detail") && buffer[i] === '"') {
        const text = decodeString(buffer, i + 1);
        if (key.value === "summary") {
          out.summary = text.value;
          out.summaryComplete = text.complete;
        } else {
          out.detail = text.value;
          out.detailComplete = text.complete;
        }
        if (!text.complete) break;
        i = text.end;
        continue;
      }
      const end = skipValue(buffer, i);
      if (end < 0) break;
      i = end;
    }
  } catch {
    /* partial text must never throw */
  }
  return out;
}

// Accumulates one StructuredOutput tool call. A later tool_use replaces the earlier one (start), and an is_error result retracts it (reject).
export class StructuredPreview {
  private buffer = "";
  private fields: PartialFields = partialFields("");
  start(): void {
    this.buffer = "";
    this.fields = partialFields("");
  }
  append(delta: string): void {
    this.buffer += delta;
    this.fields = partialFields(this.buffer);
  }
  snapshot(): PartialFields {
    return { ...this.fields };
  }
  reject(): void {
    this.start();
  }
}
