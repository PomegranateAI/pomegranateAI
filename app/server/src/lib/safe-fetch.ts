/**
 * Fetch a user-supplied URL without letting it reach internal addresses (SSRF).
 *
 * - Only http: and https: URLs.
 * - Every hostname is resolved and checked INSIDE the socket's DNS lookup, so
 *   the address that gets connected to is the address that was checked: a
 *   name that resolves to a public IP when validated and a private one when
 *   used (DNS rebinding) cannot slip through.
 * - Loopback, private, link-local (cloud metadata), CGNAT, multicast,
 *   unspecified, documentation/benchmark ranges and their IPv4-mapped IPv6
 *   forms are refused.
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
for (const [net, prefix] of [
  ['::', 128], ['::1', 128], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64], ['2001:db8::', 32],
  ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
] as const) blocked.addSubnet(net, prefix, 'ipv6');

/** True when `address` (a literal IP) must not be contacted. */
export function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return true;
  if (family === 4) return blocked.check(address, 'ipv4');
  const lower = address.toLowerCase();
  // IPv4-mapped / IPv4-compatible IPv6 (::ffff:10.0.0.1, ::ffff:a00:1): check the IPv4 part.
  const mapped = /^::(ffff:)?(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped) return blocked.check(mapped[2]!, 'ipv4');
  const hexMapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (hexMapped) {
    const hi = parseInt(hexMapped[1]!, 16), lo = parseInt(hexMapped[2]!, 16);
    return blocked.check(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`, 'ipv4');
  }
  return blocked.check(address, 'ipv6');
}

/** DNS lookup that refuses any answer pointing at a blocked address. */
function guardedLookup(
  hostname: string,
  options: dns.LookupOptions,
  callback: (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void,
): void {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, '', 0);
    const list = addresses as dns.LookupAddress[];
    const bad = list.find((a) => isBlockedAddress(a.address));
    if (!list.length || bad) {
      return callback(new UnsafeUrlError(`refusing to connect to a private or reserved address (${hostname})`), '', 0);
    }
    if (options.all) return callback(null, list);
    callback(null, list[0]!.address, list[0]!.family);
  });
}

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
