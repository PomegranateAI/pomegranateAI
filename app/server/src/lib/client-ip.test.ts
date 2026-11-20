import { describe, it, expect } from 'vitest';
import { clientIpFrom, trustedProxyHops } from './client-ip.js';

describe('clientIpFrom', () => {
  it('ignores X-Forwarded-For when no proxy is trusted (default)', () => {
    expect(clientIpFrom('6.6.6.6', '203.0.113.9', 0)).toBe('203.0.113.9');
  });

  it('behind one proxy, takes the entry that proxy appended, not the spoofed leftmost one', () => {
    // client sent "X-Forwarded-For: 6.6.6.6"; the proxy appended the real client 198.51.100.4
    expect(clientIpFrom('6.6.6.6, 198.51.100.4', '10.0.0.2', 1)).toBe('198.51.100.4');
  });

  it('behind two proxies, takes the second entry from the right', () => {
    expect(clientIpFrom('6.6.6.6, 198.51.100.4, 10.0.0.7', '10.0.0.2', 2)).toBe('198.51.100.4');
  });

  it('falls back to the socket when the chain is shorter than the trusted hops', () => {
    expect(clientIpFrom(undefined, '203.0.113.9', 1)).toBe('203.0.113.9');
    expect(clientIpFrom('6.6.6.6', '203.0.113.9', 2)).toBe('203.0.113.9');
  });

  it('reads the hop count from the environment, rejecting junk', () => {
    expect(trustedProxyHops({ POMEGRANATE_TRUSTED_PROXY_HOPS: '1' } as NodeJS.ProcessEnv)).toBe(1);
    expect(trustedProxyHops({ POMEGRANATE_TRUSTED_PROXY_HOPS: '-3' } as NodeJS.ProcessEnv)).toBe(0);
    expect(trustedProxyHops({} as NodeJS.ProcessEnv)).toBe(0);
  });
});
