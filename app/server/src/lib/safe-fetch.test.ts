import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { isBlockedAddress, makeGuardedLookup, safeFetch, UnsafeUrlError } from './safe-fetch.js';

describe('isBlockedAddress', () => {
  it.each([
    '127.0.0.1', '10.1.2.3', '172.16.0.5', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0',
    '::1', '::', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1', '::ffff:169.254.169.254', '::ffff:a00:1', '64:ff9b::a00:1',
  ])('blocks %s', (ip) => {
    expect(isBlockedAddress(ip)).toBe(true);
  });

  it.each(['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111'])('allows public %s', (ip) => {
    expect(isBlockedAddress(ip)).toBe(false);
  });

  // IPv6 transition mechanisms that embed an IPv4 address: the embedded IPv4
  // must go through the IPv4 blocklist.
  it.each([
    ['6to4 -> 127.0.0.1', '2002:7f00:0001::'],
    ['6to4 -> 10.0.0.1', '2002:0a00:0001::'],
    ['6to4 -> 169.254.169.254', '2002:a9fe:a9fe::1'],
    ['6to4 -> 0.0.0.0', '2002::'],
    ['NAT64 dotted -> 127.0.0.1', '64:ff9b::127.0.0.1'],
    ['NAT64 hex -> 10.0.0.1', '64:ff9b::a00:1'],
    ['NAT64 local-use -> 192.168.1.1', '64:ff9b:1::c0a8:101'],
    ['Teredo client 127.0.0.1', '2001:0:4136:e378:8000:63bf:80ff:fffe'],
    ['Teredo server 10.0.0.1', '2001:0:a00:1:8000:63bf:f7f7:f7f7'],
    ['IPv4-compatible dotted 127.0.0.1', '::127.0.0.1'],
    ['IPv4-compatible hex 10.0.0.1', '::a00:1'],
    ['IPv4-mapped hex 127.0.0.1', '::ffff:7f00:1'],
    ['IPv4-mapped expanded', '0:0:0:0:0:ffff:7f00:1'],
    ['IPv4-mapped uppercase', '::FFFF:127.0.0.1'],
    ['SIIT translated 127.0.0.1', '::ffff:0:7f00:1'],
    ['link-local with zone', 'fe80::1%eth0'],
  ])('blocks %s (%s)', (_label, ip) => {
    expect(isBlockedAddress(ip)).toBe(true);
  });

  it.each([
    ['6to4 -> 8.8.8.8', '2002:0808:0808::'],
    ['NAT64 -> 8.8.8.8', '64:ff9b::8.8.8.8'],
    ['NAT64 hex -> 8.8.8.8', '64:ff9b::808:808'],
    ['Teredo public server and client 8.8.8.8', '2001:0:4136:e378:8000:63bf:f7f7:f7f7'],
    ['IPv4-mapped 8.8.8.8', '::ffff:808:808'],
    ['global unicast', '2606:4700::1111'],
  ])('allows %s (%s)', (_label, ip) => {
    expect(isBlockedAddress(ip)).toBe(false);
  });
});

describe('makeGuardedLookup (DNS answers go through the same check)', () => {
  const lookupWith = (addresses: { address: string; family: number }[]) =>
    new Promise<{ err: Error | null; address: unknown }>((resolve) => {
      const lookup = makeGuardedLookup((_h, _o, cb) => cb(null, addresses));
      lookup('evil.example', {}, (err, address) => resolve({ err, address }));
    });

  it.each(['2002:7f00:1::', '64:ff9b::127.0.0.1', '2001:0:4136:e378:8000:63bf:80ff:fffe', '::ffff:7f00:1', '10.0.0.1'])(
    'refuses a name resolving to %s',
    async (ip) => {
      const { err } = await lookupWith([{ address: ip, family: ip.includes(':') ? 6 : 4 }]);
      expect(err).toBeInstanceOf(UnsafeUrlError);
    },
  );

  it('refuses when any one of several answers is blocked', async () => {
    const { err } = await lookupWith([
      { address: '8.8.8.8', family: 4 },
      { address: '2002:a00:1::', family: 6 },
    ]);
    expect(err).toBeInstanceOf(UnsafeUrlError);
  });

  it('passes public answers through', async () => {
    const { err, address } = await lookupWith([{ address: '2606:4700::1111', family: 6 }]);
    expect(err).toBeNull();
    expect(address).toBe('2606:4700::1111');
  });
});

describe('safeFetch', () => {
  // A real server is listening on loopback, so a refusal proves the guard
  // stopped the request — not that nothing was there.
  let server: http.Server;
  let port: number;
  beforeAll(async () => {
    server = http.createServer((_req, res) => res.end('internal secret'));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it('refuses a loopback IP literal', async () => {
    await expect(safeFetch(`http://127.0.0.1:${port}/`, { maxBytes: 1000 })).rejects.toBeInstanceOf(UnsafeUrlError);
  });

  it('refuses a hostname that resolves to loopback', async () => {
    await expect(safeFetch(`http://localhost:${port}/`, { maxBytes: 1000 })).rejects.toBeInstanceOf(UnsafeUrlError);
  });

  it('refuses the cloud metadata address', async () => {
    await expect(safeFetch('http://169.254.169.254/latest/meta-data/', { maxBytes: 1000 })).rejects.toBeInstanceOf(UnsafeUrlError);
  });

  it('refuses IPv6 literals that embed loopback (mapped, 6to4, NAT64)', async () => {
    for (const host of ['[::ffff:127.0.0.1]', '[2002:7f00:1::]', '[64:ff9b::7f00:1]']) {
      await expect(safeFetch(`http://${host}:${port}/`, { maxBytes: 1000 })).rejects.toBeInstanceOf(UnsafeUrlError);
    }
  });

  it('refuses non-http schemes and embedded credentials', async () => {
    await expect(safeFetch('file:///etc/passwd', { maxBytes: 1000 })).rejects.toBeInstanceOf(UnsafeUrlError);
    await expect(safeFetch('ftp://example.com/x', { maxBytes: 1000 })).rejects.toBeInstanceOf(UnsafeUrlError);
    await expect(safeFetch('http://user:pass@example.com/', { maxBytes: 1000 })).rejects.toBeInstanceOf(UnsafeUrlError);
  });
});
