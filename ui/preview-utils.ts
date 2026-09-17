interface PreviewMetrics { min: number; max: number; height: number; image: string; title: string; body: string; labelSize: string; table: string; line: string; padding: string }

export function clampPreviewScale(value: unknown): number {
  const scale = typeof value === "number" ? value : Number(value);
  return Number.isFinite(scale) ? Math.max(80, Math.min(240, Math.round(scale))) : 120;
}

export function legacyPreviewScale(value: unknown): number { return value === "small" ? 90 : value === "large" ? 160 : 120; }

export function previewMetrics(scaleValue: number): PreviewMetrics {
  const scale = clampPreviewScale(scaleValue) / 120;
  return { min: Math.round(240 * scale), max: Math.round(320 * scale), height: Math.round(420 * scale), image: `${Math.round(150 * scale)}px`, title: `${Math.round(15 * scale)}px`, body: `${Math.round(13 * scale)}px`, labelSize: `${Math.round(11 * scale)}px`, table: `${Math.round(11 * scale)}px`, line: String(Math.max(1.3, Math.min(1.75, 1.45 + (scale - 1) * 0.18))), padding: `${Math.round(14 * scale)}px ${Math.round(16 * scale)}px` };
}

export function markdownImages(markdown: string, limit = 4): { alt: string; url: string }[] {
  const images: { alt: string; url: string }[] = [];
  for (const match of markdown.matchAll(/!\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/gi)) {
    images.push({ alt: match[1] || "視覺參考", url: match[2] });
    if (images.length >= limit) break;
  }
  return images;
}

export function firstMarkdownImage(markdown: string): { alt: string; url: string } | null { return markdownImages(markdown, 1)[0] ?? null; }

export function firstMarkdownTable(markdown: string): string[][] {
  const lines = markdown.split(/\r?\n/);
  for (let i = 0; i < lines.length - 1; i++) {
    if (!/^\s*\|.+\|\s*$/.test(lines[i]) || !/^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) continue;
    const rows: string[][] = [];
    for (let j = i; j < lines.length && /^\s*\|.+\|\s*$/.test(lines[j]); j++) {
      if (j === i + 1) continue;
      rows.push(lines[j].trim().slice(1, -1).split("|").map(cell => cell.trim()).filter(Boolean));
      if (rows.length >= 4) break;
    }
    return rows.filter(row => row.length);
  }
  return [];
}
