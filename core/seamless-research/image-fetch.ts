/** Public-only image download (pure logic): every hop is re-validated, the connection is pinned to a checked address. No Node imports here. */
import { isPrivateHost, normalizeHttpsUrl } from "./apply";

export type IpFamily = 4 | 6;

export interface ImageRequest {
  url: string;
  hostname: string;
  address: string;
  family: IpFamily;
}

export interface ImageResponse {
  status: number;
  location?: string;
  body?: Uint8Array;
}

export interface ImageFetchDeps {
  lookup(hostname: string): Promise<{ address: string; family: IpFamily }[]>;
  get(request: ImageRequest, signal: AbortSignal): Promise<ImageResponse>;
  signal: AbortSignal;
  maxRedirects?: number;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function ipLiteral(hostname: string): { address: string; family: IpFamily } | undefined {
  if (hostname.startsWith("[") && hostname.endsWith("]")) return { address: hostname.slice(1, -1), family: 6 };
  if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) return { address: hostname, family: 4 };
  return undefined;
}

/**
 * Downloads `url` without trusting any hop: each address (the first one and every redirect target) goes through
 * normalizeHttpsUrl, every DNS answer must be public, and the request is pinned to the address that was checked.
 * Returns undefined when the run was stopped; anything else that is wrong throws (messages never carry the URL).
 */
export async function fetchPublicImage(url: string, deps: ImageFetchDeps): Promise<Uint8Array | undefined> {
  const maxRedirects = deps.maxRedirects ?? 3;
  let current = url;
  for (let redirects = 0; ; redirects++) {
    if (deps.signal.aborted) return undefined;
    const safe = normalizeHttpsUrl(current);
    if (!safe) throw new Error("image address is not allowed");
    const hostname = new URL(safe).hostname;
    let target: { address: string; family: IpFamily };
    const literal = ipLiteral(hostname);
    if (literal) {
      if (isPrivateHost(literal.address)) throw new Error("image host resolves to a private address");
      target = literal;
    } else {
      const answers = await deps.lookup(hostname);
      if (deps.signal.aborted) return undefined;
      if (answers.length === 0) throw new Error("image host did not resolve");
      if (answers.some(answer => isPrivateHost(answer.address)))
        throw new Error("image host resolves to a private address");
      target = answers[0];
    }
    const response = await deps.get(
      { url: safe, hostname, address: target.address, family: target.family },
      deps.signal
    );
    if (deps.signal.aborted) return undefined;
    if (REDIRECT_STATUSES.has(response.status)) {
      if (!response.location) throw new Error("image redirect has no location");
      if (redirects >= maxRedirects) throw new Error("image redirect limit exceeded");
      try {
        current = new URL(response.location, safe).href;
      } catch {
        throw new Error("image redirect location is invalid");
      }
      continue;
    }
    if (response.status < 200 || response.status >= 300)
      throw new Error(`image download failed: HTTP ${response.status}`);
    return response.body ?? new Uint8Array(0);
  }
}

/** `lookup` option for https.request that always answers with the already checked address (supports both callback shapes). */
export function pinnedLookup(address: string, family: IpFamily) {
  return (
    _hostname: string,
    options: { all?: boolean } | undefined,
    callback: (
      error: Error | null,
      addressOrList: string | { address: string; family: number }[],
      family?: number
    ) => void
  ): void => {
    if (options && options.all === true) callback(null, [{ address, family }]);
    else callback(null, address, family);
  };
}
