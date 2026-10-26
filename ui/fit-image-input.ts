import { t } from "../i18n";

/** Re-encodes an image as JPEG to fit a runtime's image input limits; without limits the image is returned as is. */
export async function fitImageForInput(
  dataUrl: string,
  limits: { maxEdgePx: number; maxBytes: number } | undefined,
  signal: AbortSignal
): Promise<string> {
  if (!limits) return dataUrl;
  const image = createEl("img");
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error(t("ui.context_ai_image_unavailable")));
    image.src = dataUrl;
  });
  if (signal.aborted) throw new Error(t("ui.ai_task_cancelled"));
  const longest = Math.max(image.naturalWidth, image.naturalHeight);
  if (dataUrl.length <= limits.maxBytes && longest <= limits.maxEdgePx) return dataUrl;
  const canvas = createEl("canvas");
  const context = canvas.getContext("2d");
  if (!context) throw new Error(t("ui.context_ai_image_unavailable"));
  for (const [edge, quality] of [
    [1568, 0.9],
    [1280, 0.85],
    [1024, 0.8]
  ] as const) {
    const scale = Math.min(1, edge / longest);
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    context.fillStyle = "#fff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const fitted = canvas.toDataURL("image/jpeg", quality);
    if (fitted.length <= limits.maxBytes) return fitted;
  }
  throw new Error(t("ui.context_ai_image_unavailable"));
}
