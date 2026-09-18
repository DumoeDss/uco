// Loopback hardening — two defenses that keep uco working on machines whose
// proxy setup interferes with localhost traffic. We cannot change a user's
// system, but both failure classes observed in the wild are avoidable from
// the client side:
//
// 1. `localhost` never goes on the wire. Node's fetch may resolve it to ::1
//    (Happy-Eyeballs prefers IPv6) while our servers bind 127.0.0.1 only —
//    and per-process proxy rules (Proxifier/TUN configurations matching
//    node.exe) commonly hijack the ::1 path and drop the connection. Every
//    URL we dial for a loopback server is rewritten to the IPv4 literal
//    first; the configured value is preserved everywhere else (display,
//    persistence) untouched.
// 2. Dead-port detection survives proxies that accept-then-close. Such rules
//    answer the TCP handshake for ANY loopback port, so a dead bridge looks
//    like "connected, then closed" (undici UND_ERR_SOCKET) instead of
//    ECONNREFUSED — degrading the actionable `connection-refused` diagnosis
//    to `unknown`. `looksRefused` re-establishes the distinction with a raw
//    socket: a healthy server holds an idle connection open, a proxied dead
//    port closes it immediately.

import * as net from 'node:net';

/**
 * Rewrite a http(s) URL whose host is exactly `localhost` (any casing) to
 * the `127.0.0.1` literal. Ports, paths, queries, and every other hostname
 * (remote servers, explicit ::1) pass through unchanged.
 */
export function normalizeLoopbackUrl(url: string): string {
  return url.replace(
    /^(https?:\/\/)localhost(?=[:/]|$)/i,
    (_match, scheme: string) => `${scheme}127.0.0.1`,
  );
}

/** True when the URL's host is a loopback literal or name. */
export function isLoopbackUrl(url: string): boolean {
  try {
    const { hostname } = new URL(url);
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
  } catch {
    return false;
  }
}

/**
 * Raw-TCP discriminator for "is this port actually dead", for use on the
 * error path of an already-failed request.
 *
 * - ECONNREFUSED on the socket → dead (healthy stacks).
 * - Connect followed by an immediate close with no data → dead behind a
 *   per-process proxy (the proxy accepted the handshake, then dropped it
 *   when the upstream refused).
 * - Connect that stays open (or sends data) until the timeout → something
 *   real is listening; the original failure was not a dead port, so callers
 *   keep their mid-request classification (reset/timeout).
 */
export function looksRefused(host: string, port: number, timeoutMs = 750): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const socket = net.connect({ host, port });
    const finish = (refused: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(refused);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    socket.once('error', (err: Error & { code?: string }) => {
      finish(err.code === 'ECONNREFUSED');
    });
    socket.once('connect', () => {
      socket.once('data', () => finish(false));
      socket.once('close', () => finish(true));
    });
  });
}
