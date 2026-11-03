import { t } from "../i18n";
interface PreviewMetrics {
  min: number;
  max: number;
  height: number;
  image: string;
  title: string;
  body: string;
  labelSize: string;
  table: string;
  line: string;
  padding: string;
}

export function clampPreviewScale(value: unknown): number {
  const scale = typeof value === "number" ? value : Number(value);
  return Number.isFinite(scale) ? Math.max(80, Math.min(240, Math.round(scale))) : 120;
}

export function legacyPreviewScale(value: unknown): number {
  return value === "small" ? 90 : value === "large" ? 160 : 120;
}

export function previewMetrics(scaleValue: number): PreviewMetrics {
  const scale = clampPreviewScale(scaleValue) / 120;
  return {
    min: Math.round(240 * scale),
    max: Math.round(320 * scale),
    height: Math.round(420 * scale),
    image: `${Math.round(150 * scale)}px`,
    title: `${Math.round(15 * scale)}px`,
    body: `${Math.round(13 * scale)}px`,
    labelSize: `${Math.round(11 * scale)}px`,
    table: `${Math.round(11 * scale)}px`,
    line: String(Math.max(1.3, Math.min(1.75, 1.45 + (scale - 1) * 0.18))),
    padding: `${Math.round(14 * scale)}px ${Math.round(16 * scale)}px`
  };
}

interface PreviewBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * Where the hover preview goes, in the canvas's own coordinates (`host` is its size, `card` the hovered card's rectangle
 * relative to it). Tries the right of the card, then the left, below and above, and takes the first spot that lies fully
 * inside the canvas (with `margin` to spare) and does not overlap the card. Null when no side has room: no preview.
 * The right side keeps the preview's top aligned with the card's top (clamped into the canvas), as it always did.
 */
export function placeHoverPreview(
  host: { width: number; height: number },
  card: PreviewBox,
  preview: { width: number; height: number },
  margin = 12
): { left: number; top: number } | null {
  const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(value, Math.max(low, high)));
  const topAligned = clamp(card.top, margin, host.height - preview.height - margin);
  const leftAligned = clamp(card.left, margin, host.width - preview.width - margin);
  const candidates = [
    { left: card.right + margin, top: topAligned },
    { left: card.left - margin - preview.width, top: topAligned },
    { left: leftAligned, top: card.bottom + margin },
    { left: leftAligned, top: card.top - margin - preview.height }
  ];
  for (const spot of candidates) {
    const inside =
      spot.left >= margin &&
      spot.top >= margin &&
      spot.left + preview.width <= host.width - margin &&
      spot.top + preview.height <= host.height - margin;
    const overlaps =
      spot.left < card.right &&
      card.left < spot.left + preview.width &&
      spot.top < card.bottom &&
      card.top < spot.top + preview.height;
    if (inside && !overlaps) return spot;
  }
  return null;
}

export function markdownImages(markdown: string, limit = 4): { alt: string; url: string }[] {
  const images: { alt: string; url: string }[] = [];
  for (const match of markdown.matchAll(/!\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/gi)) {
    images.push({ alt: match[1] || t("note.visual_reference"), url: match[2] });
    if (images.length >= limit) break;
  }
  return images;
}

export function firstMarkdownImage(markdown: string): { alt: string; url: string } | null {
  return markdownImages(markdown, 1)[0] ?? null;
}

export function firstMarkdownTable(markdown: string): string[][] {
  const lines = markdown.split(/\r?\n/);
  for (let i = 0; i < lines.length - 1; i++) {
    if (!/^\s*\|.+\|\s*$/.test(lines[i]) || !/^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) continue;
    const rows: string[][] = [];
    for (let j = i; j < lines.length && /^\s*\|.+\|\s*$/.test(lines[j]); j++) {
      if (j === i + 1) continue;
      rows.push(
        lines[j]
          .trim()
          .slice(1, -1)
          .split("|")
          .map(cell => cell.trim())
          .filter(Boolean)
      );
      if (rows.length >= 4) break;
    }
    return rows.filter(row => row.length);
  }
  return [];
}
