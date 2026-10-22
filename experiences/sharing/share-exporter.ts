import { Component, FileSystemAdapter, MarkdownRenderer, normalizePath, sanitizeHTMLToDom, type App } from "obsidian";
import type { MapDocument } from "../../map-model";
import type { Note } from "../../repository";
import { translate } from "../../i18n";
import { createAssetRegistry, cleanShareMarkdown } from "./share-clean";
import {
  assertCurrent,
  assetNamesIn,
  omitAssetImages,
  pause,
  plainWikilinks,
  replaceAssetRefs,
  resolveRelative,
  scopeCountsToMode,
  type BuildTicket
} from "./share-build";
import { extractMermaidSources, scrubMermaidSvg, scrubShareTree, unwrapLocalLinks } from "./share-dom";
import {
  buildSharePayload,
  fitWithin,
  SHARE_IMAGE_MAX_EDGE,
  type ShareLanguage,
  type SharePayload,
  type ShareNoteInput
} from "./share-format";
import { renderShareHtml, renderShareShell } from "./share-html";
import {
  forbiddenStringsFor,
  scanForLeaks,
  scanPayloadForLeaks,
  type ForbiddenString,
  type LeakCategory
} from "./share-leak-scan";
import { shareViewerUiFor } from "./share-viewer-text";

/** Everything the exporter reads from the open map. A snapshot: later edits to the map do not change an export in progress. */
export interface ShareSource {
  map: MapDocument;
  notes: ReadonlyMap<string, Note>;
  goal?: string;
  /** Vault path of the map file (only used to build the leak scan's forbidden strings; never written out). */
  mapPath: string;
}
export interface ShareOptionsInput {
  includeDetail: boolean;
  includeImages: boolean;
}
export type ShareProgress =
  | { phase: "render"; done: number; total: number }
  | { phase: "images"; done: number; total: number }
  | { phase: "assemble"; done: number; total: number };

export interface ShareBuildResult {
  payload: SharePayload;
  /** The finished file text; absent when the leak gate blocked it. */
  html?: string;
  bytes: number;
  counts: { topics: number; notesWithContent: number; images: number };
  /** Categories only, never the matched text. Empty means the gate passed. */
  leakCategories: LeakCategory[];
  failedImages: number;
  /** Diagrams left as source text because they did not draw in time. */
  mermaidUndrawn: number;
  /** Diagrams left as source text because the vault has not allowed Mermaid. */
  mermaidBlocked: number;
}

interface RenderedNote {
  markdown: string;
  html: string;
  attachments: string[];
  mermaidUndrawn: number;
  mermaidBlocked: number;
}
interface ExporterConfig {
  vamVersion: string;
  language: ShareLanguage;
  /** Per-note wait for Mermaid diagrams. */
  mermaidTimeoutMs?: number;
  now?: () => Date;
}

const IMAGE_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  avif: "image/avif"
};
/** Embedded images are re-encoded as WebP at this quality (OQ-8). */
export const SHARE_WEBP_QUALITY = 0.82;
const MERMAID_UNIT = ".mermaid-wrapper, .mermaid";

const blobToDataUrl = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.readAsDataURL(blob);
  });

async function drawable(
  bytes: ArrayBuffer,
  mime: string
): Promise<{ source: CanvasImageSource; width: number; height: number; release(): void }> {
  const blob = new Blob([bytes], { type: mime });
  if (mime !== "image/svg+xml") {
    const bitmap = await createImageBitmap(blob);
    return { source: bitmap, width: bitmap.width, height: bitmap.height, release: () => bitmap.close() };
  }
  // SVG: an <img> rasterizes it without running anything inside it.
  const url = URL.createObjectURL(blob);
  const image = new Image();
  try {
    image.src = url;
    await image.decode();
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
  // An SVG without width/height has no intrinsic size (the browser reports 300x150): take the viewBox instead.
  const markup = new TextDecoder().decode(bytes);
  const box = /<svg\b[^>]*\sviewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(markup);
  const sized = /<svg\b[^>]*\swidth\s*=/i.test(markup);
  const fromBox = !sized && box && Number(box[1]) > 0 && Number(box[2]) > 0;
  return {
    source: image,
    width: fromBox ? Number(box[1]) : image.naturalWidth || 1024,
    height: fromBox ? Number(box[2]) : image.naturalHeight || 768,
    release: () => URL.revokeObjectURL(url)
  };
}

/** Re-encodes one image: longest edge at most 1600 px, WebP (PNG if the engine cannot produce WebP). Null when it cannot be decoded. */
export async function encodeShareImage(bytes: ArrayBuffer, mime: string): Promise<string | null> {
  let picture: Awaited<ReturnType<typeof drawable>> | null = null;
  try {
    picture = await drawable(bytes, mime);
    const size = fitWithin(picture.width, picture.height, SHARE_IMAGE_MAX_EDGE);
    const canvas = createEl("canvas");
    canvas.width = size.width;
    canvas.height = size.height;
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.drawImage(picture.source, 0, 0, size.width, size.height);
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, "image/webp", SHARE_WEBP_QUALITY));
    if (blob) return await blobToDataUrl(blob);
    const png = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, "image/png"));
    return png ? await blobToDataUrl(png) : null;
  } catch {
    return null;
  } finally {
    picture?.release();
  }
}

const topLevelMermaid = (host: HTMLElement): HTMLElement[] =>
  Array.from(host.querySelectorAll<HTMLElement>(MERMAID_UNIT)).filter(
    unit => !unit.parentElement?.closest(MERMAID_UNIT)
  );
const isBlocked = (unit: HTMLElement): boolean => unit.classList.contains("is-guarded");
const drawnSvg = (unit: HTMLElement): SVGSVGElement | null =>
  isBlocked(unit) ? null : unit.matches(".mermaid") ? unit.querySelector("svg") : unit.querySelector(".mermaid svg");
/** Source-carrying code blocks that Obsidian has not turned into a diagram (yet). */
const undrawnCodeBlocks = (host: HTMLElement): number =>
  Array.from(host.querySelectorAll("pre > code.language-mermaid")).filter(code => !code.closest(".is-guarded")).length;

export class ShareExporter {
  private readonly rendered = new Map<string, RenderedNote>();
  /** name -> data URL, or null when the file could not be read or decoded. */
  private readonly images = new Map<string, string | null>();
  private readonly registry = createAssetRegistry();
  private readonly ownerPath = new Map<string, string>();
  private readonly component = new Component();
  private container: HTMLElement | null = null;
  private disposed = false;
  private forbidden: ForbiddenString[] | null = null;
  private shellText: { language: ShareLanguage; text: string } | null = null;

  constructor(
    private readonly app: App,
    private readonly source: ShareSource,
    private readonly config: ExporterConfig
  ) {
    this.component.load();
  }

  /** Removes the hidden render container and stops everything the render started. Later results are dropped. */
  dispose(): void {
    this.disposed = true;
    this.component.unload();
    this.container?.remove();
    this.container = null;
    this.rendered.clear();
    this.images.clear();
  }

  private host(): HTMLElement {
    if (!this.container) {
      this.container = activeDocument.body.createDiv({
        cls: "vam-share-render-host markdown-preview-view markdown-rendered"
      });
      this.container.setAttribute("aria-hidden", "true");
    }
    return this.container;
  }

  private titles(): Map<string, string> {
    const titles = new Map<string, string>();
    for (const node of this.source.map.nodes) {
      const title = this.source.notes.get(node.id)?.title;
      if (!title) continue;
      titles.set(node.path.replace(/\.md$/i, ""), title);
      titles.set(node.path.split("/").pop()?.replace(/\.md$/i, "") ?? node.path, title);
      titles.set(title, title);
    }
    return titles;
  }

  /** Renders every note's detail once; later builds reuse the result. */
  async ensureRendered(ticket: BuildTicket, onProgress: (progress: ShareProgress) => void): Promise<void> {
    const nodes = this.source.map.nodes.filter(
      node => !this.rendered.has(node.id) && this.source.notes.get(node.id)?.detail?.trim()
    );
    const total = this.source.map.nodes.filter(node => this.source.notes.get(node.id)?.detail?.trim()).length;
    let done = total - nodes.length;
    const titles = this.titles();
    for (const node of nodes) {
      assertCurrent(ticket);
      onProgress({ phase: "render", done, total });
      const result = await this.renderOne(this.source.notes.get(node.id)?.detail ?? "", titles, ticket);
      assertCurrent(ticket);
      if (this.disposed) return;
      this.rendered.set(node.id, result);
      for (const name of result.attachments) if (!this.ownerPath.has(name)) this.ownerPath.set(name, node.path);
      done++;
    }
    onProgress({ phase: "render", done: total, total });
  }

  private async renderOne(detail: string, titles: Map<string, string>, ticket: BuildTicket): Promise<RenderedNote> {
    const cleaned = cleanShareMarkdown(detail, { titleOf: target => titles.get(target), assets: this.registry });
    const host = this.host().createDiv();
    const child = new Component();
    this.component.addChild(child);
    try {
      await MarkdownRenderer.render(this.app, cleaned.markdown, host, "", child);
      assertCurrent(ticket);
      await this.settleMermaid(host, ticket);
      const finished = this.finish(host, cleaned.markdown);
      return {
        markdown: cleaned.markdown,
        html: finished.html,
        attachments: cleaned.attachments.map(item => item.name),
        mermaidUndrawn: finished.undrawn,
        mermaidBlocked: finished.blocked
      };
    } finally {
      this.component.removeChild(child);
      host.remove();
    }
  }

  /** Waits until every diagram has drawn, or the per-note timeout passes. A vault that has not allowed Mermaid never draws; do not wait for it. */
  private async settleMermaid(host: HTMLElement, ticket: BuildTicket): Promise<void> {
    const deadline = Date.now() + (this.config.mermaidTimeoutMs ?? 10_000);
    for (;;) {
      const pending =
        undrawnCodeBlocks(host) + topLevelMermaid(host).filter(unit => !isBlocked(unit) && !drawnSvg(unit)).length;
      if (!pending || Date.now() >= deadline) return;
      await pause(ticket, 100);
    }
  }

  /** Mermaid out, sanitize, scrub, mermaid back in. See share-dom.ts for why the diagrams take this detour. */
  private finish(host: HTMLElement, markdown: string): { html: string; undrawn: number; blocked: number } {
    const sources = extractMermaidSources(markdown);
    const diagrams: Element[] = [];
    let undrawn = 0;
    let blocked = 0;
    const note = (key: "share.mermaid_blocked_note" | "share.mermaid_undrawn_note"): string =>
      translate(this.config.language, key);
    topLevelMermaid(host).forEach((unit, index) => {
      const svg = drawnSvg(unit);
      if (svg) {
        const copy = svg.cloneNode(true) as SVGSVGElement;
        if (scrubMermaidSvg(copy)) {
          diagrams.push(copy);
          const slot = createDiv();
          slot.className = "vam-mermaid-slot";
          unit.replaceWith(slot);
          return;
        }
      }
      const guardSource = unit.querySelector(".mermaid-guard-source code")?.textContent ?? "";
      const code = sources[index] ?? guardSource;
      const wasBlocked = isBlocked(unit);
      if (wasBlocked) blocked++;
      else undrawn++;
      const fallback = createDiv();
      const pre = createEl("pre");
      const codeEl = createEl("code");
      codeEl.className = "language-mermaid";
      codeEl.textContent = code;
      pre.append(codeEl);
      const caption = createEl("p");
      caption.className = "vam-mermaid-note";
      caption.textContent = note(wasBlocked ? "share.mermaid_blocked_note" : "share.mermaid_undrawn_note");
      fallback.append(pre, caption);
      unit.replaceWith(fallback);
    });
    // A code block still waiting for the renderer when time ran out.
    for (const pre of Array.from(host.querySelectorAll("pre")))
      if (
        pre.querySelector("code.language-mermaid") &&
        !pre.nextElementSibling?.classList.contains("vam-mermaid-note")
      ) {
        undrawn++;
        const caption = createEl("p");
        caption.className = "vam-mermaid-note";
        caption.textContent = note("share.mermaid_undrawn_note");
        pre.after(caption);
      }
    const clean = createDiv();
    clean.append(sanitizeHTMLToDom(host.innerHTML));
    unwrapLocalLinks(clean, () => createSpan());
    scrubShareTree(clean);
    const slots = Array.from(clean.querySelectorAll(".vam-mermaid-slot"));
    slots.forEach((slot, index) => {
      const diagram = diagrams[index];
      if (diagram) slot.replaceWith(diagram);
      else slot.remove();
    });
    return { html: clean.innerHTML, undrawn, blocked };
  }

  private resolveImage(name: string): { bytes: Promise<ArrayBuffer>; mime: string } | null {
    const entry = this.registry.entries().find(item => item.name === name);
    const fromPath = this.ownerPath.get(name);
    if (!entry || fromPath === undefined) return null;
    const ext = entry.ref.split("#")[0].split(".").pop()?.toLowerCase() ?? "";
    const mime = IMAGE_MIME[ext];
    if (!mime) return null;
    const folder = fromPath.split("/").slice(0, -1).join("/");
    const relative = resolveRelative(folder, entry.ref);
    const candidates = [
      this.app.metadataCache.getFirstLinkpathDest(entry.ref, fromPath)?.path,
      relative ? normalizePath(relative) : undefined,
      normalizePath(entry.ref)
    ];
    for (const path of candidates) {
      const file = path ? this.app.vault.getFileByPath(path) : null;
      if (file) return { bytes: this.app.vault.readBinary(file), mime };
    }
    return null;
  }

  /** Converts every vault image the rendered notes use, once. */
  async ensureImages(ticket: BuildTicket, onProgress: (progress: ShareProgress) => void): Promise<void> {
    const names = [...new Set([...this.rendered.values()].flatMap(note => note.attachments))];
    const todo = names.filter(name => !this.images.has(name));
    let done = names.length - todo.length;
    for (const name of todo) {
      assertCurrent(ticket);
      onProgress({ phase: "images", done, total: names.length });
      let data: string | null = null;
      try {
        const found = this.resolveImage(name);
        if (found) data = await encodeShareImage(await found.bytes, found.mime);
      } catch {
        data = null;
      }
      assertCurrent(ticket);
      if (this.disposed) return;
      this.images.set(name, data);
      done++;
    }
    onProgress({ phase: "images", done: names.length, total: names.length });
  }

  private forbiddenStrings(): ForbiddenString[] {
    if (!this.forbidden) {
      const adapter = this.app.vault.adapter;
      const folder = this.source.mapPath.split("/").slice(0, -1).join("/");
      this.forbidden = forbiddenStringsFor(
        {
          vaultPath: adapter instanceof FileSystemAdapter ? adapter.getBasePath() : undefined,
          vaultName: this.app.vault.getName(),
          mapFolder: folder
        },
        this.source.map,
        [...this.source.notes.values()]
      );
    }
    return this.forbidden;
  }

  /** Builds the payload and file text from what is cached, and runs both leak scans. Writes nothing. */
  assemble(options: ShareOptionsInput): ShareBuildResult {
    const language = this.config.language;
    const omitted = translate(language, "share.viewer_image_omitted");
    const failed = new Set([...this.images].filter(([, data]) => data === null).map(([name]) => name));
    const notesById: Record<string, ShareNoteInput> = {};
    let notesWithContent = 0;
    let undrawn = 0;
    let blocked = 0;
    for (const node of this.source.map.nodes) {
      const note = this.source.notes.get(node.id);
      if (!note) continue;
      const entry: ShareNoteInput = {
        title: plainWikilinks(note.title),
        summary: plainWikilinks(note.summary),
        status: note.status,
        ...(note.relevance ? { relevance: note.relevance } : {})
      };
      const rendered = this.rendered.get(node.id);
      if (note.detail?.trim()) notesWithContent++;
      if (rendered && options.includeDetail) {
        undrawn += rendered.mermaidUndrawn;
        blocked += rendered.mermaidBlocked;
      }
      if (options.includeDetail && rendered) {
        const dropNames = options.includeImages ? failed : null;
        entry.detail = options.includeImages
          ? replaceAssetRefs(rendered.markdown, failed, omitted)
          : replaceAssetRefs(rendered.markdown, new Set(assetNamesIn(rendered.markdown)), omitted);
        entry.detailHtml = omitAssetImages(rendered.html, dropNames, omitted);
      }
      notesById[node.id] = entry;
    }
    const assets: Record<string, string> = {};
    if (options.includeDetail && options.includeImages)
      for (const [name, data] of this.images) if (data) assets[name] = data;
    const payload = buildSharePayload(this.source.map, notesById, {
      includeDetail: options.includeDetail,
      includeImages: options.includeImages && options.includeDetail,
      language,
      vamVersion: this.config.vamVersion,
      exportedAt: (this.config.now?.() ?? new Date()).toISOString(),
      goal: this.source.goal,
      assets
    });
    const ui = shareViewerUiFor(language);
    const forbidden = this.forbiddenStrings();
    if (!this.shellText || this.shellText.language !== language)
      this.shellText = { language, text: renderShareShell(ui) };
    const hits = [...scanPayloadForLeaks(payload, forbidden), ...scanForLeaks(this.shellText.text, forbidden)];
    const leakCategories = [...new Set(hits.map(hit => hit.category))];
    const scoped = scopeCountsToMode(options, { notesWithContent, failedImages: failed.size });
    const counts = {
      topics: payload.nodes.length,
      notesWithContent: scoped.notesWithContent,
      images: Object.keys(payload.assets).length
    };
    const shared = {
      payload,
      counts,
      leakCategories,
      failedImages: scoped.failedImages,
      mermaidUndrawn: undrawn,
      mermaidBlocked: blocked
    };
    if (hits.length) return { ...shared, bytes: 0 };
    const html = renderShareHtml(payload, ui);
    return { ...shared, html, bytes: new TextEncoder().encode(html).length };
  }
}
