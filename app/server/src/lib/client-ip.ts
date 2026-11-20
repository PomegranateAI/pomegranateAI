/**
 * The client's IP address, for rate limiting and audit logs.
 *
 * X-Forwarded-For is written by whoever sends the request, so its leftmost
 * entry is attacker-controlled. Only the entries appended by proxies we run
 * can be trusted:
 *
 * - POMEGRANATE_TRUSTED_PROXY_HOPS unset or 0 (default): the server is reached
 *   directly; X-Forwarded-For is ignored and the socket address is used.
 * - N > 0: the server sits behind N proxies, each appending the address it
 *   received the request from. The client is the Nth entry from the RIGHT.
 *   A request that carries fewer entries than that did not come through the
 *   proxies, so the socket address is used instead.
 */
export function trustedProxyHops(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.POMEGRANATE_TRUSTED_PROXY_HOPS ?? 0);
  return Number.isInteger(n) && n > 0 ? n : 0;
}

export function clientIpFrom(
  forwardedFor: string | undefined,
  socketAddress: string | undefined,
  hops: number = trustedProxyHops(),
): string | undefined {
  if (hops > 0 && forwardedFor) {
    const chain = forwardedFor.split(',').map((s) => s.trim()).filter(Boolean);
    if (chain.length >= hops) return chain[chain.length - hops];
  }
  return socketAddress || undefined;
}

/** Hono context → client IP (node-server exposes the socket on c.env.incoming). */
export function clientIp(c: any): string | undefined {
  const socket = c.env?.incoming?.socket?.remoteAddress as string | undefined;
  return clientIpFrom(c.req.header('x-forwarded-for'), socket);
}
