import type { ImageCandidate } from "../core/image-candidates";

/** Keeps the candidates whose image loads within a few seconds, in order; the rest are dead or blocked links. */
export async function loadableImages(candidates: ImageCandidate[], signal: AbortSignal): Promise<ImageCandidate[]> {
  const loads = await Promise.all(
    candidates.map(
      candidate =>
        new Promise<boolean>(resolve => {
          const probe = createEl("img");
          probe.referrerPolicy = "no-referrer";
          const abort = (): void => done(false);
          const timer = window.setTimeout(abort, 8_000);
          const done = (ok: boolean): void => {
            window.clearTimeout(timer);
            signal.removeEventListener("abort", abort);
            const loaded = ok && probe.naturalWidth > 0;
            probe.onload = probe.onerror = null;
            if (!loaded) probe.src = "";
            resolve(loaded);
          };
          probe.onload = () => done(true);
          probe.onerror = () => done(false);
          signal.addEventListener("abort", abort, { once: true });
          probe.src = candidate.url;
        })
    )
  );
  return candidates.filter((_, index) => loads[index]);
}
