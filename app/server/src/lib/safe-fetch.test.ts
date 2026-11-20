import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { isBlockedAddress, safeFetch, UnsafeUrlError } from './safe-fetch.js';

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

  it('refuses non-http schemes and embedded credentials', async () => {
    await expect(safeFetch('file:///etc/passwd', { maxBytes: 1000 })).rejects.toBeInstanceOf(UnsafeUrlError);
    await expect(safeFetch('ftp://example.com/x', { maxBytes: 1000 })).rejects.toBeInstanceOf(UnsafeUrlError);
    await expect(safeFetch('http://user:pass@example.com/', { maxBytes: 1000 })).rejects.toBeInstanceOf(UnsafeUrlError);
  });
});
