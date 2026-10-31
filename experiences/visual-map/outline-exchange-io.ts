import { Notice, type Vault } from "obsidian";
import { t } from "../../i18n";
import type { MapDocument } from "../../map-model";
import {
  EXCHANGE_MAX_BYTES,
  parseOutlineExchange,
  toFreeMind,
  toOpml,
  type ExchangeFormat,
  type ExchangeNoteInput,
  type ExchangeRejection
} from "./outline-exchange";
import type { OutlineImportRequest } from "./outline-import-modal";

/**
 * File side of OPML / FreeMind exchange: choosing a file and handing it to the parser, and writing an export next to
 * its map. The parser (outline-exchange.ts) owns every limit and the DOCTYPE refusal; this file only reports them.
 */

const messageOf = (error: unknown): string => {
  const message = (error as { message?: unknown } | null)?.message;
  return typeof message === "string" ? message : String(error);
};

/** The reason a file was refused, in words the person can act on. */
export function exchangeRefusal(reason: ExchangeRejection, line?: number): string {
  switch (reason) {
    case "too-large":
      return t("ui.exchange_reason_too_large", Math.round(EXCHANGE_MAX_BYTES / (1024 * 1024)));
    case "forbidden-doctype":
    case "forbidden-pi":
    case "bad-entity":
      return t("ui.exchange_reason_unsafe");
    case "too-many-elements":
    case "too-many-nodes":
    case "too-deep":
      return t("ui.exchange_reason_too_big");
    default:
      return t("ui.exchange_reason_invalid", line === undefined ? reason : `${reason}, ${line}`);
  }
}

/** The part of the view an import needs; the view's own new-map flow does the creating. */
export interface ExchangeImportHost {
  importOutline(request: OutlineImportRequest): Promise<void>;
}

/**
 * Parses one chosen file and, only when it is accepted whole, creates a new map from it. A refused file shows the
 * reason and creates nothing. `size` is checked before the text is read, so an oversize file is never loaded.
 */
export async function importExchangeFile(
  host: ExchangeImportHost,
  file: { name: string; size: number; text(): Promise<string> }
): Promise<boolean> {
  const refuse = (why: string): false => {
    new Notice(t("ui.exchange_refused", file.name, why));
    return false;
  };
  if (file.size > EXCHANGE_MAX_BYTES) return refuse(exchangeRefusal("too-large"));
  let text: string;
  try {
    text = await file.text();
  } catch {
    return refuse(t("ui.exchange_reason_unreadable"));
  }
  const parsed = parseOutlineExchange(text, { fileName: file.name });
  if (!parsed.ok) return refuse(exchangeRefusal(parsed.reason, parsed.line));
  try {
    await host.importOutline({ nodes: parsed.nodes, source: file.name, shallowResearch: false });
  } catch (error) {
    new Notice(messageOf(error));
    return false;
  }
  return true;
}

/** Opens the system file chooser (OPML, FreeMind or XML) and imports the chosen file. */
export function chooseAndImportExchange(host: ExchangeImportHost): void {
  // The chooser works on an input that is never attached to the page, so nothing is left behind.
  const input = createEl("input", { type: "file", attr: { accept: ".opml,.mm,.xml" } });
  input.addEventListener("change", () => {
    const file = input.files?.[0];
    if (file) void importExchangeFile(host, file).catch(error => new Notice(messageOf(error)));
  });
  input.click();
}

const FORBIDDEN_NAME = /[\\/:*?"<>|#^[\]]/g;
/** A file name stem from the map title: no path or reserved characters, never empty. */
export function exchangeFileStem(title: string): string {
  const stem = Array.from(title, ch => (ch.charCodeAt(0) < 32 ? " " : ch))
    .join("")
    .replace(FORBIDDEN_NAME, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .slice(0, 80)
    .trim();
  return stem || "map";
}

const EXTENSION: Record<ExchangeFormat, string> = { opml: "opml", freemind: "mm" };

/**
 * Writes the map as OPML or FreeMind in the map's own folder under a name that is free; an existing file is never
 * overwritten. Returns the path written.
 */
export async function exportMapExchange(
  vault: Pick<Vault, "create" | "getAbstractFileByPath"> & { adapter: Pick<Vault["adapter"], "exists"> },
  request: {
    mapPath: string;
    map: Pick<MapDocument, "title" | "nodes">;
    notes: ReadonlyMap<string, { title: string; detail: string }>;
    format: ExchangeFormat;
  }
): Promise<string> {
  const notes = new Map<string, ExchangeNoteInput>();
  for (const [id, note] of request.notes) notes.set(id, { title: note.title, body: note.detail });
  const input = { title: request.map.title, nodes: request.map.nodes };
  const text = request.format === "opml" ? toOpml(input, notes) : toFreeMind(input, notes);
  const slash = request.mapPath.lastIndexOf("/");
  const folder = slash < 0 ? "" : request.mapPath.slice(0, slash + 1);
  const stem = exchangeFileStem(request.map.title);
  const extension = EXTENSION[request.format];
  for (let attempt = 1; attempt <= 1000; attempt++) {
    const path = `${folder}${stem}${attempt === 1 ? "" : ` ${attempt}`}.${extension}`;
    if (vault.getAbstractFileByPath(path) || (await vault.adapter.exists(path))) continue;
    try {
      await vault.create(path, text);
      return path;
    } catch (error) {
      // Lost a race, or a case-insensitive disk already holds the name: try the next one.
      if (/exist/i.test(messageOf(error))) continue;
      throw error;
    }
  }
  throw new Error(t("ui.exchange_export_no_name"));
}

/** Exports and tells the person where the file went (or why it did not). */
export async function exportMapWithNotice(
  vault: Parameters<typeof exportMapExchange>[0],
  request: Parameters<typeof exportMapExchange>[1]
): Promise<string | null> {
  try {
    const path = await exportMapExchange(vault, request);
    new Notice(t("ui.exchange_exported", path));
    return path;
  } catch (error) {
    new Notice(t("ui.exchange_export_failed", messageOf(error)));
    return null;
  }
}
