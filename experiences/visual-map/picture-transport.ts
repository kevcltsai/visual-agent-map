import { lookup as dnsLookup } from "node:dns";
import { request as httpsRequest } from "node:https";
import type { LookupFunction } from "node:net";
import {
  isPicturePublicUrl,
  PictureFetchError,
  pictureFailureOf,
  type PictureFailure,
  type PictureFetch
} from "../../core/steps/book-pipeline/image-fit-check";

/** The Node https transport for the picture look (desktop only; the plugin's manifest says isDesktopOnly). Kept out of core/, which stays platform-free. */
export const PICTURE_MAX_REDIRECTS = 3;
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

function privateIpv4(a: number, b: number): boolean {
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0)
  );
}

/** The eight 16-bit groups of an IPv6 address (a dotted IPv4 tail counts as two groups); undefined when it is not one. */
function ipv6Groups(address: string): number[] | undefined {
  let text = address.split("%")[0].toLowerCase();
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(1).map(Number);
    if ([a, b, c, d].some(n => n > 255)) return undefined;
    text = `${text.slice(0, dotted.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return undefined;
  const side = (part: string): string[] => (part ? part.split(":") : []);
  const head = side(halves[0]);
  const tail = halves.length === 2 ? side(halves[1]) : [];
  if (halves.length === 1 && head.length !== 8) return undefined;
  if (halves.length === 2 && head.length + tail.length > 7) return undefined;
  const groups = [...head, ...Array<string>(8 - head.length - tail.length).fill("0"), ...tail].map(g =>
    /^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN
  );
  return groups.length === 8 && groups.every(g => !Number.isNaN(g)) ? groups : undefined;
}

/**
 * True for an address a picture must never be fetched from: loopback, unspecified, private (10/8, 172.16/12, 192.168/16), link-local
 * (169.254/16, fe80::/10), CGNAT (100.64/10), unique-local (fc00::/7), multicast and reserved, and the IPv4 inside an IPv4-mapped,
 * IPv4-compatible or NAT64 IPv6 form. An address it cannot read is refused too.
 */
export function isPrivateAddress(address: string): boolean {
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(address);
  if (v4) {
    const parts = v4.slice(1).map(Number);
    return parts.some(n => n > 255) || privateIpv4(parts[0], parts[1]);
  }
  const g = ipv6Groups(address);
  if (!g) return true;
  if (g.every(n => n === 0) || (g.slice(0, 7).every(n => n === 0) && g[7] === 1)) return true;
  if ((g[0] & 0xfe00) === 0xfc00 || (g[0] & 0xffc0) === 0xfe80 || (g[0] & 0xff00) === 0xff00) return true;
  const embedded = (): boolean => privateIpv4(g[6] >> 8, g[6] & 255) || (g[6] === 0 && g[7] === 0);
  if (g.slice(0, 5).every(n => n === 0) && (g[5] === 0xffff || g[5] === 0)) return embedded();
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every(n => n === 0)) return embedded();
  return false;
}

type Resolved = { address: string; family: number };
type Resolver = (
  host: string,
  options: { all: true },
  done: (error: NodeJS.ErrnoException | null, addresses: Resolved[]) => void
) => void;

/**
 * A `lookup` for https.request: resolves with dns.lookup (every address) and fails the connection when any answer is a private address,
 * so a public name that resolves inward is refused at connect time (the address checked is the one connected to).
 */
export function createSafeLookup(resolve: Resolver = dnsLookup) {
  return (
    host: string,
    options: { all?: boolean; family?: number },
    done: (error: Error | null, address?: string | Resolved[], family?: number) => void
  ): void => {
    resolve(host, { ...options, all: true }, (error, addresses) => {
      if (error) return done(error);
      if (!addresses.length || addresses.some(item => isPrivateAddress(item.address)))
        return done(new PictureFetchError("url"));
      if (options.all) return done(null, addresses);
      done(null, addresses[0].address, addresses[0].family);
    });
  };
}

type Request = typeof httpsRequest;
/** What one hop returns: the picture's answer, or the place to go next. */
type Hop = { redirect: string } | { status: number; headers: Record<string, string>; bytes: ArrayBuffer };

function hop(
  url: URL,
  request: Request,
  lookup: ReturnType<typeof createSafeLookup>,
  signal: AbortSignal,
  maxBytes: number,
  userAgent: string
): Promise<Hop> {
  return new Promise<Hop>((resolve, reject) => {
    let finish = (settle: () => void): void => settle();
    const fail = (reason: PictureFailure, req?: { destroy(): void }): void =>
      finish(() => {
        req?.destroy();
        reject(new PictureFetchError(reason));
      });
    const req = request(
      url,
      {
        method: "GET",
        lookup: lookup as unknown as LookupFunction,
        headers: { Accept: "image/*", "Accept-Encoding": "identity", "User-Agent": userAgent }
      },
      res => {
        const status = res.statusCode ?? 0;
        const location = res.headers.location;
        if (REDIRECT_STATUS.has(status) && typeof location === "string") {
          // The body of a redirect is never read: the connection is ended at once (a server may send an endless one).
          finish(() => resolve({ redirect: location }));
          req.destroy();
          return;
        }
        const length = Number(res.headers["content-length"]);
        if (status === 200 && Number.isFinite(length) && length > maxBytes) return fail("size", req);
        const chunks: Uint8Array[] = [];
        let total = 0;
        res.on("data", (chunk: Uint8Array) => {
          total += chunk.length;
          if (total > maxBytes) return fail("size", req);
          chunks.push(chunk);
        });
        res.on("end", () => {
          const bytes = new Uint8Array(total);
          let at = 0;
          for (const chunk of chunks) {
            bytes.set(chunk, at);
            at += chunk.length;
          }
          const headers: Record<string, string> = {};
          for (const [name, value] of Object.entries(res.headers)) if (typeof value === "string") headers[name] = value;
          finish(() => resolve({ status, headers, bytes: bytes.buffer }));
        });
        res.on("error", () => fail("failed", req));
        res.on("aborted", () => fail("failed", req));
      }
    );
    const onAbort = (): void => fail("aborted", req);
    finish = settle => {
      signal.removeEventListener("abort", onAbort);
      finish = () => undefined;
      settle();
    };
    req.on("error", (error: Error) => fail(pictureFailureOf(error)));
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    req.end();
  });
}

/**
 * The production {@link PictureFetch}: a GET over Node https with no automatic redirect (at most {@link PICTURE_MAX_REDIRECTS} by hand, each
 * Location checked with the same https-only public-host rule), a lookup that refuses private addresses, and the size cap enforced while the
 * body streams (the request is destroyed at the first byte over the cap). Injectable for tests.
 */
export function createPictureFetch(
  deps: { request?: Request; lookup?: ReturnType<typeof createSafeLookup>; userAgent?: string } = {}
): PictureFetch {
  const request = deps.request ?? httpsRequest;
  // Node sends no User-Agent of its own, and sites such as Wikimedia refuse a request without one (403).
  const userAgent = deps.userAgent ?? "VisualAgentMap-Obsidian-plugin";
  const lookup = deps.lookup ?? createSafeLookup();
  return async (address, { signal, maxBytes }) => {
    let url = new URL(address);
    for (let redirects = 0; ; redirects++) {
      if (!isPicturePublicUrl(url)) throw new PictureFetchError("url");
      const result = await hop(url, request, lookup, signal, maxBytes, userAgent);
      if (!("redirect" in result)) return result;
      if (redirects >= PICTURE_MAX_REDIRECTS) throw new PictureFetchError("url");
      try {
        url = new URL(result.redirect, url);
      } catch {
        throw new PictureFetchError("url");
      }
    }
  };
}
