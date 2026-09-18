// Loopback hardening — localhost→127.0.0.1 normalization and the dead-port
// discriminator that restores `connection-refused` classification on
// machines whose per-process proxy rules accept-then-close loopback
// connections (see src/transport/loopback.ts).

import * as http from 'node:http';
import * as net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { normalizeLoopbackUrl, isLoopbackUrl, looksRefused } from '../src/transport/loopback.js';
import { RestTransport } from '../src/transport/rest.js';
import { TransportError } from '../src/util/errors.js';

const servers: http.Server[] = [];
const sockets: net.Server[] = [];

afterEach(() => {
  for (const s of servers.splice(0)) s.close();
  for (const s of sockets.splice(0)) s.close();
});

function startHttpServer(): Promise<number> {
  return new Promise((resolve) => {
    const server = http.createServer(() => { /* never answers meaningfully */ });
    servers.push(server);
    server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port));
  });
}

/** A port that was listening and is not anymore — refused on any stack. */
function deadPort(): Promise<number> {
  return new Promise((resolve) => {
    const server = net.createServer();
    sockets.push(server);
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as net.AddressInfo).port;
      server.close(() => resolve(port));
    });
  });
}

describe('normalizeLoopbackUrl', () => {
  it('rewrites a localhost host to the IPv4 literal, keeping everything else', () => {
    expect(normalizeLoopbackUrl('http://localhost:24730/api/x')).toBe('http://127.0.0.1:24730/api/x');
    expect(normalizeLoopbackUrl('http://LOCALHOST:24730')).toBe('http://127.0.0.1:24730');
    expect(normalizeLoopbackUrl('http://localhost')).toBe('http://127.0.0.1');
    expect(normalizeLoopbackUrl('http://localhost:1/a?b=c#d')).toBe('http://127.0.0.1:1/a?b=c#d');
    expect(normalizeLoopbackUrl('http://localhost/')).toBe('http://127.0.0.1/');
  });

  it('leaves every other host untouched', () => {
    expect(normalizeLoopbackUrl('http://localhost.example.com:5/x')).toBe('http://localhost.example.com:5/x');
    expect(normalizeLoopbackUrl('https://example.com/x')).toBe('https://example.com/x');
    expect(normalizeLoopbackUrl('http://[::1]:8080/x')).toBe('http://[::1]:8080/x');
    expect(normalizeLoopbackUrl('not a url')).toBe('not a url');
  });
});

describe('isLoopbackUrl', () => {
  it('recognizes the loopback spellings', () => {
    expect(isLoopbackUrl('http://localhost:1/x')).toBe(true);
    expect(isLoopbackUrl('http://127.0.0.1:1/x')).toBe(true);
    expect(isLoopbackUrl('http://[::1]:1/x')).toBe(true);
    expect(isLoopbackUrl('https://example.com/x')).toBe(false);
    expect(isLoopbackUrl('garbage')).toBe(false);
  });
});

describe('looksRefused', () => {
  it('reports a live listener as not refused', async () => {
    const port = await startHttpServer();
    await expect(looksRefused('127.0.0.1', port)).resolves.toBe(false);
  });

  it('reports a genuinely dead port as refused (ECONNREFUSED or proxied accept-then-close)', async () => {
    const port = await deadPort();
    await expect(looksRefused('127.0.0.1', port)).resolves.toBe(true);
  });
});

describe('RestTransport loopback hardening', () => {
  it('dials 127.0.0.1 even when configured with a localhost base URL', async () => {
    const port = await startHttpServer();
    let dialed: string | undefined;
    const transport = new RestTransport({
      baseUrl: `http://localhost:${port}`,
      fetchImpl: (async (input: RequestInfo | URL) => {
        dialed = String(input);
        return new Response('{}', { status: 200 });
      }) as typeof fetch,
    });
    await transport.ping();
    expect(dialed).toContain(`http://127.0.0.1:${port}/`);
    expect(dialed).not.toContain('localhost');
  });

  it('classifies a dead loopback port as connection-refused even when fetch surfaces it as an opaque socket error', async () => {
    const port = await deadPort();
    const socketError = Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' });
    const fetchFailure = Object.assign(new TypeError('fetch failed'), { cause: socketError });
    const transport = new RestTransport({
      baseUrl: `http://127.0.0.1:${port}`,
      fetchImpl: (async () => { throw fetchFailure; }) as typeof fetch,
    });
    const err = await transport.ping().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TransportError);
    expect((err as TransportError).kind).toBe('connection-refused');
  });

  it('keeps a non-refused failure unclassified as unknown when the port is actually listening', async () => {
    const port = await startHttpServer();
    const socketError = Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' });
    const fetchFailure = Object.assign(new TypeError('fetch failed'), { cause: socketError });
    const transport = new RestTransport({
      baseUrl: `http://127.0.0.1:${port}`,
      fetchImpl: (async () => { throw fetchFailure; }) as typeof fetch,
    });
    const err = await transport.ping().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TransportError);
    expect((err as TransportError).kind).toBe('unknown');
  });
});
