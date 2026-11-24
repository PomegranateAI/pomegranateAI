/**
 * Fetch a user-supplied URL without letting it reach internal addresses (SSRF).
 *
 * - Only http: and https: URLs.
 * - Every hostname is resolved and checked INSIDE the socket's DNS lookup, so
 *   the address that gets connected to is the address that was checked: a
 *   name that resolves to a public IP when validated and a private one when
 *   used (DNS rebinding) cannot slip through.
 * - Loopback, private, link-local (cloud metadata), CGNAT, multicast,
 *   unspecified and documentation/benchmark ranges are refused, as is any
 *   IPv6 address that embeds one of them (IPv4-mapped/compatible, 6to4,
 *   NAT64, Teredo).
 * - Redirects are followed manually, at most `maxRedirects` hops, and each
 *   hop goes through the same checks.
 * - The body is capped at `maxBytes` and the whole request at `timeoutMs`.
 */
import * as http from 'node:http';
import * as https from 'node:https';
import * as dns from 'node:dns';
import { BlockList, isIP } from 'node:net';

export class UnsafeUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeUrlError';
  }
}
export class ResponseTooLargeError extends Error {
  constructor(public maxBytes: number) {
    super(`response larger than ${maxBytes} bytes`);
    this.name = 'ResponseTooLargeError';
  }
}

const blocked = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) blocked.addSubnet(net, prefix, 'ipv4');
// NAT64 (64:ff9b::/96, 64:ff9b:1::/48) is deliberately not listed: it is
// judged by the IPv4 address it embeds (see embeddedIPv4), so
// 64:ff9b::8.8.8.8 is allowed and 64:ff9b::127.0.0.1 is not.
for (const [net, prefix] of [
  ['::', 128], ['::1', 128], ['100::', 64], ['2001:db8::', 32],
  ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
] as const) blocked.addSubnet(net, prefix, 'ipv6');

/**
 * Expand a literal IPv6 address (any textual form, including a trailing
 * dotted quad and a %zone suffix) into its eight 16-bit groups.
 * Returns null if it does not parse.
 */
function expandIPv6(address: string): number[] | null {
  let a = address.toLowerCase();
  const zone = a.indexOf('%');
  if (zone !== -1) a = a.slice(0, zone);
  if (isIP(a) !== 6) return null;
  // Turn a trailing dotted quad into two hex groups.
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(a);
  if (dotted) {
    const [b0, b1, b2, b3] = dotted.slice(1).map(Number) as [number, number, number, number];
    a = a.slice(0, dotted.index) + ((b0 << 8) | b1).toString(16) + ':' + ((b2 << 8) | b3).toString(16);
  }
  const halves = a.split('::');
  if (halves.length > 2) return null;
  const parse = (part: string): number[] => (part === '' ? [] : part.split(':').map((x) => parseInt(x, 16)));
  const head = parse(halves[0]!);
  const tail = halves.length === 2 ? parse(halves[1]!) : [];
  const fill = 8 - head.length - tail.length;
  if (halves.length === 2 ? fill < 0 : fill !== 0) return null;
  const groups = [...head, ...new Array<number>(fill).fill(0), ...tail];
  if (groups.length !== 8 || groups.some((x) => !Number.isInteger(x) || x < 0 || x > 0xffff)) return null;
  return groups;
}

function toIPv4(hi: number, lo: number): string {
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
}

/**
 * The IPv4 address(es) an IPv6 transition mechanism would deliver to:
 * IPv4-mapped ::ffff:0:0/96 (and SIIT ::ffff:0:0:0/96), IPv4-compatible
 * ::/96, 6to4 2002::/16, NAT64 64:ff9b::/96 and 64:ff9b:1::/48, and Teredo
 * 2001:0::/32 (server, and the XOR-obfuscated client).
 */
function embeddedIPv4(g: number[]): string[] {
  const zero = (from: number, to: number) => g.slice(from, to).every((x) => x === 0);
  // ::ffff:a.b.c.d (mapped) and ::ffff:0:a.b.c.d (SIIT translated).
  if (zero(0, 5) && g[5] === 0xffff) return [toIPv4(g[6]!, g[7]!)];
  if (zero(0, 4) && g[4] === 0xffff && g[5] === 0) return [toIPv4(g[6]!, g[7]!)];
  // ::a.b.c.d (deprecated IPv4-compatible; :: and ::1 land in 0.0.0.0/8).
  if (zero(0, 6)) return [toIPv4(g[6]!, g[7]!)];
  // 6to4: 2002:AABB:CCDD::/48.
  if (g[0] === 0x2002) return [toIPv4(g[1]!, g[2]!)];
  // NAT64 well-known and local-use prefixes: IPv4 in the last 32 bits.
  if (g[0] === 0x64 && g[1] === 0xff9b && (zero(2, 6) || g[2] === 1)) return [toIPv4(g[6]!, g[7]!)];
  // Teredo: 2001:0000:<server v4>:<flags>:<port>:<client v4 XOR ffffffff>.
  if (g[0] === 0x2001 && g[1] === 0) return [toIPv4(g[2]!, g[3]!), toIPv4(g[6]! ^ 0xffff, g[7]! ^ 0xffff)];
  return [];
}

/**
 * True when `address` (a literal IP) must not be contacted. For IPv6, every
 * IPv4 address embedded by a transition mechanism is also run through the
 * IPv4 blocklist, so ::ffff:7f00:1, 2002:7f00:1::, 64:ff9b::10.0.0.1 and a
 * Teredo address whose client is 127.0.0.1 are refused like the IPv4 itself.
 * 6to4 and Teredo are therefore allowed only when every embedded IPv4 is public.
 */
export function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return true;
  if (family === 4) return blocked.check(address, 'ipv4');
  const groups = expandIPv6(address);
  if (!groups) return true; // fail closed on anything we cannot parse
  if (blocked.check(groups.map((x) => x.toString(16)).join(':'), 'ipv6')) return true;
  return embeddedIPv4(groups).some((v4) => blocked.check(v4, 'ipv4'));
}

type LookupAllFn = (
  hostname: string,
  options: dns.LookupAllOptions,
  callback: (err: NodeJS.ErrnoException | null, addresses: dns.LookupAddress[]) => void,
) => void;

/**
 * Build a DNS lookup that refuses any answer pointing at a blocked address.
 * Every resolved address goes through isBlockedAddress, the same check an IP
 * literal gets. `resolve` is injectable so tests need no real DNS.
 */
export function makeGuardedLookup(resolve: LookupAllFn = dns.lookup as unknown as LookupAllFn) {
  return function guardedLookup(
    hostname: string,
    options: dns.LookupOptions,
    callback: (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void,
  ): void {
    resolve(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err, '', 0);
      const list = addresses ?? [];
      const bad = list.find((a) => isBlockedAddress(a.address));
      if (!list.length || bad) {
        return callback(new UnsafeUrlError(`refusing to connect to a private or reserved address (${hostname})`), '', 0);
      }
      if (options.all) return callback(null, list);
      callback(null, list[0]!.address, list[0]!.family);
    });
  };
}

const guardedLookup = makeGuardedLookup();

export interface SafeFetchResult {
  status: number;
  contentType: string;
  body: Buffer;
  /** The final URL after redirects. */
  url: string;
}

export async function safeFetch(
  rawUrl: string,
  opts: { maxBytes: number; timeoutMs?: number; maxRedirects?: number },
): Promise<SafeFetchResult> {
  const deadline = Date.now() + (opts.timeoutMs ?? 15_000);
  let url = rawUrl;
  for (let hop = 0; hop <= (opts.maxRedirects ?? 5); hop++) {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new UnsafeUrlError(`unsupported scheme ${u.protocol}`);
    if (u.username || u.password) throw new UnsafeUrlError('URLs with credentials are not allowed');
    const host = u.hostname.replace(/^\[|\]$/g, '');
    // A literal IP never goes through the lookup, so check it here.
    if (isIP(host) && isBlockedAddress(host)) throw new UnsafeUrlError(`refusing to connect to a private or reserved address (${host})`);

    const res = await request(u, deadline - Date.now(), opts.maxBytes);
    if (res.status >= 300 && res.status < 400 && res.location) {
      url = new URL(res.location, u).toString();
      continue;
    }
    return { status: res.status, contentType: res.contentType, body: res.body, url };
  }
  throw new UnsafeUrlError('too many redirects');
}

function request(
  u: URL,
  timeoutMs: number,
  maxBytes: number,
): Promise<{ status: number; contentType: string; body: Buffer; location?: string }> {
  if (timeoutMs <= 0) return Promise.reject(new Error('timed out'));
  const lib = u.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.request(
      u,
      { method: 'GET', lookup: guardedLookup as never, headers: { 'user-agent': 'Pomegranate link reader', accept: '*/*' } },
      (res) => {
        const status = res.statusCode ?? 0;
        const location = res.headers.location;
        if (status >= 300 && status < 400 && location) {
          res.resume();
          return resolve({ status, contentType: '', body: Buffer.alloc(0), location });
        }
        const chunks: Buffer[] = [];
        let total = 0;
        res.on('data', (chunk: Buffer) => {
          total += chunk.length;
          if (total > maxBytes) {
            req.destroy(new ResponseTooLargeError(maxBytes));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () =>
          resolve({ status, contentType: String(res.headers['content-type'] ?? '').toLowerCase(), body: Buffer.concat(chunks) }),
        );
        res.on('error', reject);
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timed out')));
    req.on('error', reject);
    req.end();
  });
}
