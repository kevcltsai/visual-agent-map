/** The identity of a picture for "the same image twice in one book": a Wikimedia file by its decoded lowercase file name (original, thumbnail and either host alike); any other address by its href without query and hash. */
export function imageKey(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return url.trim().toLowerCase();
  }
  const host = parsed.hostname.toLowerCase();
  if (/^(upload|thumb)\.wikimedia\.org$/.test(host)) {
    const parts = parsed.pathname.split("/").filter(Boolean);
    let name = parts[parts.length - 1] ?? "";
    const thumbAt = parts.indexOf("thumb");
    // /wikipedia/commons/thumb/a/ab/File.jpg/1280px-File.jpg: the file name is the segment before the sized one.
    if (thumbAt >= 0 && parts.length >= thumbAt + 5) name = parts[parts.length - 2];
    try {
      name = decodeURIComponent(name);
    } catch {
      /* keep the raw name */
    }
    return name.toLowerCase();
  }
  parsed.search = "";
  parsed.hash = "";
  return parsed.href;
}
