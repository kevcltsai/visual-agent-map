import { errorMessage } from "../../core/error-message";
import type { MapDocument } from "../../map-model";
import type { ImageCandidate } from "../../core/image-candidates";
import { imageKey } from "../../core/image-keys";
import { t, type TranslationKey } from "../../i18n";
import { acceptImage, safeImageName } from "./image-input";
import type { MapChatImages, MapChatPanel } from "./map-chat";

/** What the picture searches of one reply share: the cards already searched, the usage notices answered, and the blocks. */
export interface ChatImageBatch {
  imageNodes: Set<string>;
  /** Models whose usage notice was accepted in this reply (asked once for the whole reply). */
  asked: Set<string>;
  /** A usage notice was declined: none of this reply's searches starts, whichever action comes next. */
  declined: boolean;
  /** The blocks of every find_images action of the reply: their lines are one line (see chatLine). */
  group: MapChatImages[];
}
export const newChatImageBatch = (): ChatImageBatch => ({
  imageNodes: new Set<string>(),
  asked: new Set<string>(),
  declined: false,
  group: []
});

/** Picture searches of one reply that run at the same time; the others wait. */
const CHAT_IMAGE_SEARCH_PARALLEL = 3;
/** One card of one map, for the picture searches that are queued or running. */
const chatImageTopicKey = (mapId: string, nodeId: string): string => `${mapId}\u0000${nodeId}`;
/** The longest search words a picture search may carry. */
const CHAT_IMAGE_QUERY_MAX = 80;
/** How long the cover picture may take to download before the card keeps only the picture in its Detail. */
const CHAT_IMAGE_DOWNLOAD_MS = 15000;
/**
 * The words of one picture search as they leave the program: a link, a domain, a line break or a control character the model (or
 * a researched web page) put in the direction never reaches the search engine. Cut to {@link CHAT_IMAGE_QUERY_MAX} characters.
 */
function cleanImageQuery(text: string): string {
  const plain = Array.from(text, char => {
    const code = char.charCodeAt(0);
    return code < 32 || (code >= 127 && code <= 159) || code === 0x2028 || code === 0x2029 ? " " : char;
  }).join("");
  return plain
    .replace(/\S*:\/\/\S*/g, " ")
    .replace(/\bwww\.\S*/gi, " ")
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?(?:[/?#]\S*)?/g, " ")
    .replace(/\[[0-9a-f:.]*:[0-9a-f:.]*\](?::\d+)?(?:[/?#]\S*)?/gi, " ")
    .replace(/(?:[\p{L}\p{N}-]+\.)+[a-z]{2,}(?::\d+)?(?:[/?#]\S*)?/giu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, CHAT_IMAGE_QUERY_MAX)
    .trim();
}

type PlaceResult = { ok: true } | { ok: false; reason: string };
type CanvasPlaceResult = { ok: true; id: string } | { ok: false; reason: string };
/** What one place_image came to: the block (its state changes later) and the id of the new canvas image (null when none was put), or why it did not start. */
export type ChatCanvasImageFind =
  { block: MapChatImages; placed: Promise<string | null> } | { skipped: TranslationKey } | { failed: string };
type CoverBytes = { name: string; data: ArrayBuffer } | null;

/** What one find came to: the blocks (their state changes later), a reason it was skipped, or a failure. */
export type ChatImageFind = { blocks: MapChatImages[] } | { skipped: TranslationKey } | { failed: string };

/** What the finder needs of its view. Every port is bound late (an arrow that calls the view's method when it runs). */
export interface ChatImagePorts {
  where(): { closed: boolean; chat: MapChatPanel | null; path: string; mapId: string | undefined };
  readNote(path: string, map: MapDocument): Promise<{ title: string; model: string }>;
  modelLabel(model: string): string;
  /** Why no search may start for the card of `block` (map switched, AI lock, being merged, an AI task on it), or null. */
  preflight(block: MapChatImages): Promise<string | null>;
  confirmUsage(model: string): Promise<boolean>;
  searchImages(query: string, model: string, signal: AbortSignal): Promise<ImageCandidate[]>;
  /** The thumbnail check of a search. */
  probe(found: ImageCandidate[], signal: AbortSignal): Promise<ImageCandidate[]>;
  /** The image keys of every picture in the Detail of this map's cards. */
  usedImageKeys(): Set<string>;
  /** Whether the card of `block` may take a cover picture now (it has a target and no cover). */
  coverWanted(block: MapChatImages): boolean;
  fetchBytes(url: string): Promise<ArrayBuffer>;
  /** Writes the picture (and the cover, when there is one) into the card's note as one undo step. */
  write(block: MapChatImages, candidate: ImageCandidate, alive: () => boolean, cover: CoverBytes): Promise<PlaceResult>;
  /** The model a place_image search runs on (it belongs to no card). */
  canvasModel(): string;
  /** Why a place_image may not start now (the map cannot take a canvas image), or null. */
  canvasPreflight(block: MapChatImages): string | null;
  /** Puts the downloaded picture on the canvas as an annotated image (one write, one undo step); the id of the new image. */
  writeCanvas(
    block: MapChatImages,
    candidate: ImageCandidate,
    file: { name: string; data: ArrayBuffer },
    alive: () => boolean
  ): Promise<CanvasPlaceResult>;
  /** The blocks are shown in the chat (and recorded). */
  added(chat: MapChatPanel, blocks: MapChatImages[]): void;
  running(chat: MapChatPanel, block: MapChatImages): void;
  settle(
    chat: MapChatPanel,
    block: MapChatImages,
    patch: Partial<Pick<MapChatImages, "state" | "reason" | "items">>
  ): void;
}

/**
 * find_images: the chat only picked the cards and the search words. For every target card the Markdown quick action's
 * `markdown.image-search` step runs through the card's own model (after its usage notice, once for the whole reply), only
 * pictures whose thumbnail loads are kept, and the first one is put into the card's note by itself (see {@link place}); there is
 * nothing for the user to pick. Several cards are several searches, at most {@link CHAT_IMAGE_SEARCH_PARALLEL} at a time in the view.
 * One finder per view; it owns the searches, so closing the view or leaving the map stops them (see {@link stopAll}).
 */
export class ChatImageFinder {
  constructor(private readonly ports: ChatImagePorts) {}

  /** Picture searches the chat started and that have not ended; the view owns them, so closing it or leaving the map stops them. */
  searches = new Map<number, AbortController>();
  sequence = 0;
  private generation = 0;
  /** Cards of a map with a queued or running picture search (key: chatImageTopicKey), with the search's controller. */
  topics = new Map<string, AbortController>();
  running = 0;
  waiters: (() => boolean)[] = [];
  /** Writes of pictures go one after another (the searches overlap, the writes and their undo steps do not). */
  writes: Promise<unknown> = Promise.resolve();

  /** A search is queued or running. */
  isRunning(): boolean {
    return this.searches.size > 0;
  }

  /** A search of this card of this map is queued or running. */
  isSearching(mapId: string, nodeId: string): boolean {
    return this.topics.has(chatImageTopicKey(mapId, nodeId));
  }

  /** Every picture search the chat started stops; a result that still arrives is neither shown nor written. */
  stopAll(): void {
    this.generation += 1;
    const searches = [...this.searches.values()];
    this.searches.clear();
    for (const controller of searches) controller.abort();
  }

  /** `readsResearch`: the chat reads researched web text, so the search words come from the cards' own titles. */
  async find(
    map: MapDocument,
    chat: MapChatPanel,
    cards: string[],
    direction: string,
    readsResearch: boolean,
    batch: ChatImageBatch
  ): Promise<ChatImageFind> {
    const ports = this.ports;
    // A card is searched once per reply, and not again while a search of it in this map is queued or running.
    const ids = [...new Set(cards)].filter(id => !batch.imageNodes.has(id) && !this.isSearching(map.id, id));
    if (!ids.length) return { skipped: "ui.map_chat_skip_images_dup" };
    for (const id of ids) batch.imageNodes.add(id);
    const anchor = { path: ports.where().path, id: map.id };
    const generation = this.generation;
    const current = (): boolean => this.currentSession(chat, anchor, generation);
    if (!current()) return { skipped: "ui.map_chat_skip_map_changed" };
    // Web text can reach the model once research ran: the search words then come from the cards' own titles, never from the model.
    const words = readsResearch ? "" : cleanImageQuery(direction);
    const jobs: {
      block: MapChatImages;
      controller: AbortController;
      model: string;
      key?: number;
      release?: () => void;
    }[] = [];
    const blocks: MapChatImages[] = [];
    for (const id of ids) {
      const node = map.nodes.find(item => item.id === id);
      if (!node) continue;
      const note = await ports.readNote(node.path, map);
      if (!current()) return { skipped: "ui.map_chat_skip_map_changed" };
      const title = cleanImageQuery(note.title);
      // One target keeps the words as they are; several are told apart by their card ("牛肋眼 西式做法" style). A research
      // conversation uses the parent card's title and the card's own.
      const parent = node.parentId ? map.nodes.find(item => item.id === node.parentId) : undefined;
      const parentTitle =
        readsResearch && parent ? cleanImageQuery((await ports.readNote(parent.path, map)).title) : "";
      if (!current()) return { skipped: "ui.map_chat_skip_map_changed" };
      const joined = cleanImageQuery(
        (readsResearch ? [parentTitle, title] : ids.length > 1 ? [words, title] : [words || title])
          .filter(Boolean)
          .join(" ")
      );
      // A card whose title is nothing after the cleaning is not searched: the words alone would find pictures of something else.
      const query = title ? joined || title : "";
      const block: MapChatImages = {
        query,
        nodeId: node.id,
        nodeTitle: note.title,
        modelLabel: ports.modelLabel(note.model),
        mapPath: anchor.path,
        mapId: anchor.id,
        state: "searching",
        items: []
      };
      blocks.push(block);
      // Checked before any AI call is spent: a card that cannot take a picture right now says why and the others go on.
      const reason = query ? await ports.preflight(block) : t("ui.map_chat_skip_unavailable");
      if (!current()) return { skipped: "ui.map_chat_skip_map_changed" };
      if (reason) {
        block.state = "empty";
        block.reason = reason;
        continue;
      }
      jobs.push({ block, controller: new AbortController(), model: note.model });
    }
    if (!blocks.length) return { skipped: "ui.map_chat_skip_topic_gone" };
    // The usage notice of each model that is going to be used, once for the whole reply (all its actions); a refusal starts none
    // of this reply's searches, in this action or in the ones that follow.
    if (batch.declined) return { skipped: "ui.map_chat_skip_not_started" };
    for (const model of new Set(jobs.map(job => job.model))) {
      if (!current()) return { skipped: "ui.map_chat_skip_map_changed" };
      if (batch.asked.has(model)) continue;
      let ok = false;
      try {
        ok = await ports.confirmUsage(model);
      } catch (error) {
        return { failed: errorMessage(error) };
      }
      if (!ok) {
        batch.declined = true;
        return { skipped: "ui.map_chat_skip_not_started" };
      }
      batch.asked.add(model);
    }
    if (!current()) return { skipped: "ui.map_chat_skip_map_changed" };
    for (const job of jobs) {
      const { block, controller } = job;
      // The card counts as being searched from here until its job ends, fails or is stopped (any abort releases it).
      const topic = chatImageTopicKey(anchor.id, block.nodeId);
      this.topics.set(topic, controller);
      const release = (): void => {
        if (this.topics.get(topic) === controller) this.topics.delete(topic);
      };
      job.release = release;
      controller.signal.addEventListener("abort", release, { once: true });
      const key = ++this.sequence;
      this.searches.set(key, controller);
      job.key = key;
      block.stop = () => {
        if (this.searches.get(key) !== controller) return;
        this.searches.delete(key);
        controller.abort();
        ports.settle(chat, block, { state: "stopped" });
      };
    }
    batch.group.push(...blocks);
    ports.added(chat, blocks);
    // At most CHAT_IMAGE_SEARCH_PARALLEL searches run at once in this view (across the actions of a reply); the others wait in order.
    for (const job of jobs)
      void (async (): Promise<void> => {
        const acquired = await this.acquireSlot(job.controller.signal);
        try {
          if (acquired) await this.run(job.block, job.controller, chat, job.model);
        } finally {
          if (job.release) {
            job.controller.signal.removeEventListener("abort", job.release);
            job.release();
          }
          if (acquired) this.releaseSlot();
          if (job.key !== undefined && this.searches.get(job.key) === job.controller) this.searches.delete(job.key);
        }
      })();
    return { blocks: batch.group };
  }

  /**
   * place_image: the same search, thumbnail check and download as find_images, but the picture goes on the canvas as an annotated
   * image and belongs to no card. The block is returned at once; `placed` settles with the new image's id, or null when none was
   * put (nothing found, Stop, the map changed, the write refused). It never rejects.
   */
  async findCanvas(
    map: MapDocument,
    chat: MapChatPanel,
    direction: string,
    batch: ChatImageBatch,
    /** The chain's Stop signal: aborting it stops this search like the block's own Stop. */
    signal?: AbortSignal
  ): Promise<ChatCanvasImageFind> {
    const ports = this.ports;
    const query = cleanImageQuery(direction);
    if (!query) return { skipped: "ui.map_chat_skip_unavailable" };
    if (batch.declined) return { skipped: "ui.map_chat_skip_not_started" };
    const anchor = { path: ports.where().path, id: map.id };
    const generation = this.generation;
    if (!this.currentSession(chat, anchor, generation)) return { skipped: "ui.map_chat_skip_map_changed" };
    if (signal?.aborted) return { skipped: "ui.map_chat_skip_not_started" };
    const model = ports.canvasModel();
    const block: MapChatImages = {
      query,
      nodeId: "",
      nodeTitle: "",
      canvas: true,
      modelLabel: ports.modelLabel(model),
      mapPath: anchor.path,
      mapId: anchor.id,
      state: "searching",
      items: []
    };
    const refused = ports.canvasPreflight(block);
    if (refused) return { failed: refused };
    if (!batch.asked.has(model)) {
      let ok = false;
      try {
        ok = await ports.confirmUsage(model);
      } catch (error) {
        return { failed: errorMessage(error) };
      }
      if (!ok) {
        batch.declined = true;
        return { skipped: "ui.map_chat_skip_not_started" };
      }
      batch.asked.add(model);
    }
    if (!this.currentSession(chat, anchor, generation)) return { skipped: "ui.map_chat_skip_map_changed" };
    if (signal?.aborted) return { skipped: "ui.map_chat_skip_not_started" };
    const controller = new AbortController();
    const key = ++this.sequence;
    this.searches.set(key, controller);
    block.stop = () => {
      if (this.searches.get(key) !== controller) return;
      this.searches.delete(key);
      controller.abort();
      ports.settle(chat, block, { state: "stopped" });
    };
    const onChainAbort = (): void => block.stop?.();
    const unlink = (): void => signal?.removeEventListener("abort", onChainAbort);
    signal?.addEventListener("abort", onChainAbort, { once: true });
    controller.signal.addEventListener("abort", unlink, { once: true });
    ports.added(chat, [block]);
    if (signal?.aborted) onChainAbort();
    const placed = (async (): Promise<string | null> => {
      const acquired = await this.acquireSlot(controller.signal);
      try {
        return acquired ? await this.runCanvas(block, controller, chat, model) : null;
      } catch {
        return null;
      } finally {
        unlink();
        controller.signal.removeEventListener("abort", unlink);
        if (acquired) this.releaseSlot();
        if (this.searches.get(key) === controller) this.searches.delete(key);
      }
    })();
    return { block, placed };
  }

  /** One place_image to its end (see {@link run} for the fences): the id of the canvas image, or null with the block saying why. */
  private async runCanvas(
    block: MapChatImages,
    controller: AbortController,
    chat: MapChatPanel,
    model: string
  ): Promise<string | null> {
    const ports = this.ports;
    const current = (): boolean => {
      const here = ports.where();
      return (
        !here.closed &&
        !controller.signal.aborted &&
        here.chat === chat &&
        here.path === block.mapPath &&
        here.mapId === block.mapId
      );
    };
    const dropped = (): null => {
      const here = ports.where();
      if (!here.closed && !controller.signal.aborted && here.chat === chat)
        ports.settle(chat, block, { state: "failed", reason: t("ui.map_chat_images_stale_map") });
      return null;
    };
    if (!current()) return dropped();
    try {
      const refused = ports.canvasPreflight(block);
      if (refused) {
        ports.settle(chat, block, { state: "empty", reason: refused });
        return null;
      }
      ports.running(chat, block);
      const found = await ports.searchImages(block.query, model, controller.signal);
      if (!current()) return dropped();
      const loadable = (await ports.probe(found, controller.signal)).filter(item => item.url.startsWith("https://"));
      if (!current()) return dropped();
      // The first picture that downloads and passes the byte check (a few tries): a thumbnail that loads can still be refused here.
      for (const candidate of loadable.slice(0, 3)) {
        let data: ArrayBuffer;
        try {
          data = await this.download(candidate.url, controller.signal);
        } catch {
          if (!current()) return dropped();
          continue;
        }
        if (!current()) return dropped();
        const accepted = acceptImage({ mime: "image/*", size: data.byteLength, bytes: data });
        const name = accepted.ok ? safeImageName(candidate.title, accepted.mime) : null;
        if (!name) continue;
        const work = (): Promise<CanvasPlaceResult> => ports.writeCanvas(block, candidate, { name, data }, current);
        const run = this.writes.then(work, work);
        this.writes = run.catch(() => undefined);
        const result = await run;
        // Written is written, even when a Stop came in while the write ran: the block tells the truth.
        if (result.ok) {
          ports.settle(chat, block, { state: "ready", items: [{ candidate, inserted: candidate.title }] });
          return result.id;
        }
        if (current()) ports.settle(chat, block, { state: "empty", reason: result.reason });
        else dropped();
        return null;
      }
      ports.settle(chat, block, { state: "empty" });
      return null;
    } catch (error) {
      if (!current()) return dropped();
      ports.settle(chat, block, { state: "failed", reason: errorMessage(error) });
      return null;
    }
  }

  private currentSession(chat: MapChatPanel, anchor: { path: string; id: string }, generation: number): boolean {
    const here = this.ports.where();
    return (
      this.generation === generation && !here.closed && here.chat === chat &&
      here.path === anchor.path && here.mapId === anchor.id
    );
  }

  private async acquireSlot(signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return false;
    if (this.running < CHAT_IMAGE_SEARCH_PARALLEL) {
      this.running += 1;
      return true;
    }
    // Cancellation removes a queued job immediately. Active jobs keep their slot until their underlying work settles.
    return new Promise<boolean>(resolve => {
      const cancel = (): void => {
        const at = this.waiters.indexOf(grant);
        if (at >= 0) this.waiters.splice(at, 1);
        signal.removeEventListener("abort", cancel);
        resolve(false);
      };
      const grant = (): boolean => {
        signal.removeEventListener("abort", cancel);
        const acquired = !signal.aborted;
        resolve(acquired);
        return acquired;
      };
      this.waiters.push(grant);
      signal.addEventListener("abort", cancel, { once: true });
    });
  }
  private releaseSlot(): void {
    while (this.waiters.length) {
      if (this.waiters.shift()?.()) return;
    }
    this.running -= 1;
  }

  /**
   * Runs one card's picture search to its end: the first loadable picture is put into the card, or the block says why none was.
   * Nothing is written when the view, the panel or the map is not the same any more, or the search was stopped.
   */
  async run(block: MapChatImages, controller: AbortController, chat: MapChatPanel, model: string): Promise<void> {
    const ports = this.ports;
    const sameMap = (): boolean => {
      const here = ports.where();
      return here.path === block.mapPath && here.mapId === block.mapId;
    };
    /** Still the place the search was started for: written only then. */
    const current = (): boolean =>
      !ports.where().closed && !controller.signal.aborted && ports.where().chat === chat && sameMap();
    /** The conversation moved on to another map (or a stop was not the cause): say it, but only when the panel is still here. */
    const dropped = (): void => {
      const here = ports.where();
      if (here.closed || controller.signal.aborted || here.chat !== chat) return;
      ports.settle(chat, block, { state: "failed", reason: t("ui.map_chat_images_stale_map") });
    };
    if (!current()) return dropped();
    try {
      // Checked again where the search really starts: a card may have been locked or started on while it waited its turn.
      const refused = await ports.preflight(block);
      if (!current()) return dropped();
      if (refused) return ports.settle(chat, block, { state: "empty", reason: refused });
      ports.running(chat, block);
      const found = await ports.searchImages(block.query, model, controller.signal);
      if (!current()) return dropped();
      // Web results can be stale or block hotlinking: only an image that actually loads is used.
      const loadable = (await ports.probe(found, controller.signal)).filter(item => item.url.startsWith("https://"));
      // A picture another card of this map already shows is taken only when every loadable one is used.
      const used = ports.usedImageKeys();
      const first = loadable.find(item => !used.has(imageKey(item.url))) ?? loadable[0];
      if (!current()) return dropped();
      if (!first) return ports.settle(chat, block, { state: "empty" });
      const placed = await this.place(block, first, current, controller.signal);
      // Written is written, even when a Stop came in while the write ran: the block tells the truth.
      if (placed.ok) {
        ports.settle(chat, block, {
          state: "ready",
          items: [{ candidate: first, inserted: block.nodeTitle }]
        });
      } else if (current()) ports.settle(chat, block, { state: "empty", reason: placed.reason });
      else dropped();
    } catch (error) {
      if (!current()) return dropped();
      ports.settle(chat, block, { state: "failed", reason: errorMessage(error) });
    }
  }

  /**
   * Puts the found picture at the end of the card's Detail (a blank line before it) and, when the card has no cover, saves it
   * beside the note as the cover: both are one undo step (one ⌘Z takes the picture back out of the note and off the card).
   * The cover is downloaded first, outside the write queue and with a time limit (a slow download holds no other card back);
   * then the note and the cover are written by the view's `write` port inside one `mutate`, and their undo entries are folded before
   * they reach the history. Refused, with the reason in words and nothing written, when `alive` says the search was stopped or the
   * view's write refuses (the map in view is not the one the search came from, the card is gone, locked, being merged or being
   * worked on by an AI task, the map cannot be edited). The same checks run again inside the write, where nothing else can change the map.
   */
  async place(
    block: MapChatImages,
    candidate: ImageCandidate,
    alive: () => boolean,
    signal: AbortSignal = new AbortController().signal
  ): Promise<PlaceResult> {
    const cover = await this.coverBytes(block, candidate, signal);
    if (!alive()) return { ok: false, reason: t("ui.map_chat_images_stale_map") };
    const work = (): Promise<PlaceResult> => this.ports.write(block, candidate, alive, cover);
    const run = this.writes.then(work, work);
    this.writes = run.catch(() => undefined);
    return run;
  }

  /** A download that ends when the search is stopped or after {@link CHAT_IMAGE_DOWNLOAD_MS}, whichever comes first. */
  download(url: string, signal: AbortSignal): Promise<ArrayBuffer> {
    return new Promise<ArrayBuffer>((resolve, reject) => {
      if (signal.aborted) return reject(new Error("aborted"));
      const end = (): void => {
        window.clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
      };
      const onAbort = (): void => {
        end();
        reject(new Error("aborted"));
      };
      const timer = window.setTimeout(() => {
        end();
        reject(new Error("timeout"));
      }, CHAT_IMAGE_DOWNLOAD_MS);
      signal.addEventListener("abort", onAbort);
      this.ports.fetchBytes(url).then(
        data => {
          end();
          resolve(data);
        },
        (error: unknown) => {
          end();
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      );
    });
  }

  /**
   * The cover picture of a placed picture, downloaded before the write: only when the card has no cover and has not turned it
   * off (nothing is downloaded otherwise). The picture is checked by its bytes ({@link acceptImage}). Null when there is none to write.
   */
  async coverBytes(block: MapChatImages, candidate: ImageCandidate, signal: AbortSignal): Promise<CoverBytes> {
    if (!this.ports.coverWanted(block)) return null;
    let data: ArrayBuffer;
    try {
      data = await this.download(candidate.url, signal);
    } catch {
      return null;
    }
    const accepted = acceptImage({ mime: "image/*", size: data.byteLength, bytes: data });
    if (!accepted.ok) return null;
    const name = safeImageName(candidate.title, accepted.mime);
    return name ? { name, data } : null;
  }
}
