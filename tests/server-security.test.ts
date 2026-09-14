import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import {
  createServer,
  type McpServerHandle,
  type OwnedServerRuntime,
} from '../src/server/app.js';
import { parseServerConfig, validateServerConfig } from '../src/server/config.js';

const handles: McpServerHandle[] = [];

afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.stop();
});

describe('secure server configuration', () => {
  it('defaults to loopback and required auth and fails closed without a token', () => {
    expect(() => parseServerConfig([], {})).toThrow(/required by default/);
    expect(parseServerConfig(['--token', 'secret'], {})).toMatchObject({
      listenHost: '127.0.0.1',
      allowLan: false,
      authorization: 'required',
      token: 'secret',
    });
  });

  it('uses UCO_SERVER_TOKEN as fallback while preserving CLI-token precedence', () => {
    expect(parseServerConfig([], { UCO_SERVER_TOKEN: 'environment-secret' }).token)
      .toBe('environment-secret');
    expect(parseServerConfig(
      ['--token', 'cli-secret'],
      { UCO_SERVER_TOKEN: 'environment-secret' },
    ).token).toBe('cli-secret');
  });

  it('retains an explicit loopback auth-none compatibility path', () => {
    expect(parseServerConfig(['--authorization', 'none'], {})).toMatchObject({
      authorization: 'none',
      listenHost: '127.0.0.1',
      token: undefined,
    });
  });

  it.each([
    {
      label: 'LAN without opt-in',
      args: ['--listen-host', '0.0.0.0', '--token', 'secret'],
      message: /allow-lan/,
    },
    {
      label: 'LAN auth-none',
      args: ['--listen-host', '0.0.0.0', '--allow-lan', '--authorization', 'none'],
      message: /LAN listening requires|Unauthenticated mode/,
    },
    {
      label: 'LAN missing token',
      args: ['--listen-host', '0.0.0.0', '--allow-lan'],
      message: /required by default/,
    },
    {
      label: 'auth-none plus token',
      args: ['--authorization', 'none', '--token', 'secret'],
      message: /cannot be combined/,
    },
  ])('rejects $label before binding', ({ args, message }) => {
    expect(() => parseServerConfig(args, {})).toThrow(message);
  });

  it('accepts IPv4 loopback range, localhost, ::1, and authenticated LAN opt-in', () => {
    for (const host of ['localhost', '127.0.0.2', '::1', '[::1]']) {
      expect(parseServerConfig(['--listen-host', host, '--token', 'secret'], {}))
        .toMatchObject({ authorization: 'required' });
    }
    expect(parseServerConfig([
      '--listen-host', '0.0.0.0', '--allow-lan', '--token', 'secret',
    ], {})).toMatchObject({ listenHost: '0.0.0.0', allowLan: true });
  });

  it('re-checks the invariants at createServer for programmatic callers', () => {
    const loopback = parseServerConfig(['--authorization', 'none'], {});
    expect(() => createServer({ ...loopback, listenHost: '0.0.0.0' }))
      .toThrow(/allow-lan/);
    expect(() => validateServerConfig({
      ...loopback,
      listenHost: '0.0.0.0',
      allowLan: true,
    })).toThrow(/LAN listening requires|Unauthenticated mode/);
    expect(() => createServer({
      ...loopback,
      authorization: 'invalid' as 'none',
    })).toThrow(/authorization must be/);
  });
});

describe('server listening and Origin boundary', () => {
  it('reports the actual loopback socket address and ephemeral port', async () => {
    const server = createServer(parseServerConfig([
      '--port', '0', '--authorization', 'none',
    ], {}));
    handles.push(server);

    const listening = await server.start();

    expect(listening.address).toBe('127.0.0.1');
    expect(listening.port).toBeGreaterThan(0);
    expect(server.httpServer.address()).toMatchObject(listening);
  });

  it('can bind an explicitly authenticated LAN listener and reports the socket result', async () => {
    const server = createServer(parseServerConfig([
      '--port', '0',
      '--listen-host', '0.0.0.0',
      '--allow-lan',
      '--token', 'lan-secret',
    ], {}));
    handles.push(server);

    const listening = await server.start();
    expect(listening).toMatchObject({ address: '0.0.0.0' });
    expect(listening.port).toBeGreaterThan(0);
  });

  it.each(['/help', '/health', '/api/health', '/unknown'])('rejects Origin before REST routing: %s', async (route) => {
    const server = createServer(parseServerConfig([
      '--port', '0', '--authorization', 'none',
    ], {}));
    handles.push(server);
    const listening = await server.start();

    const response = await fetch(`http://127.0.0.1:${listening.port}${route}`, {
      headers: { Origin: 'https://browser.example' },
    });
    expect(response.status).toBe(403);
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: { code: 'forbidden-origin' },
    });
  });

  it('rejects Origin before a valid bearer token reaches a protected REST route', async () => {
    const server = createServer(parseServerConfig([
      '--port', '0', '--token', 'rest-secret',
    ], {}));
    handles.push(server);
    const listening = await server.start();

    const response = await fetch(`http://127.0.0.1:${listening.port}/api/tools`, {
      headers: {
        Origin: 'null',
        Authorization: 'Bearer rest-secret',
      },
    });
    expect(response.status).toBe(403);
  });

  it('rejects WebSocket Origin before token parsing and never registers a connection', async () => {
    const server = createServer(parseServerConfig([
      '--port', '0', '--token', 'ws-secret',
    ], {}));
    handles.push(server);
    const listening = await server.start();
    const ws = new WebSocket(
      `ws://127.0.0.1:${listening.port}/hub/mcp-server?access_token=ws-secret`,
      { headers: { Origin: 'https://browser.example' } },
    );

    const status = await new Promise<number>((resolve, reject) => {
      ws.once('unexpected-response', (_request, response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      });
      ws.once('open', () => reject(new Error('Origin-bearing WebSocket unexpectedly opened.')));
      ws.once('error', () => undefined);
    });

    expect(status).toBe(403);
    expect(server.registry.size).toBe(0);
  });

  it('preserves no-Origin WebSocket Authorization-header compatibility', async () => {
    const server = createServer(parseServerConfig([
      '--port', '0', '--token', 'ws-header-secret',
    ], {}));
    handles.push(server);
    const listening = await server.start();
    const ws = new WebSocket(`ws://127.0.0.1:${listening.port}/hub/mcp-server`, {
      headers: { Authorization: 'Bearer ws-header-secret' },
    });

    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    expect(server.registry.size).toBe(1);
    ws.close();
  });
});

describe('owned precommit transport gate', () => {
  it('exposes only authenticated exact-instance health until commit', async () => {
    const runtime: OwnedServerRuntime = {
      serverInstanceId: 'fixture-instance',
      phase: 'precommit',
    };
    const server = createServer(parseServerConfig([
      '--port', '0', '--token', 'owned-secret',
    ], {}), runtime);
    handles.push(server);
    const listening = await server.start();
    const baseUrl = `http://127.0.0.1:${listening.port}`;

    const unauthorizedHealth = await fetch(`${baseUrl}/api/health`);
    expect(unauthorizedHealth.status).toBe(401);

    const health = await fetch(`${baseUrl}/api/health`, {
      headers: { Authorization: 'Bearer owned-secret' },
    });
    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toMatchObject({
      serverInstanceId: 'fixture-instance',
      handoffPhase: 'precommit',
      stages: { http: { authenticated: true } },
    });

    for (const route of ['/help', '/health', '/api/tools']) {
      const response = await fetch(`${baseUrl}${route}`, {
        headers: { Authorization: 'Bearer owned-secret' },
      });
      expect(response.status, route).toBe(503);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: 'owned-server-precommit' },
      });
    }

    runtime.phase = 'committed';
    const committedHelp = await fetch(`${baseUrl}/help`);
    expect(committedHelp.status).toBe(200);
  });

  it('rejects WebSocket registration until the exact child is committed', async () => {
    const runtime: OwnedServerRuntime = {
      serverInstanceId: 'fixture-instance',
      phase: 'precommit',
    };
    const server = createServer(parseServerConfig([
      '--port', '0', '--token', 'owned-secret',
    ], {}), runtime);
    handles.push(server);
    const listening = await server.start();
    const ws = new WebSocket(
      `ws://127.0.0.1:${listening.port}/hub/mcp-server?access_token=owned-secret`,
    );

    const status = await new Promise<number>((resolve, reject) => {
      ws.once('unexpected-response', (_request, response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      });
      ws.once('open', () => reject(new Error('Precommit WebSocket unexpectedly opened.')));
      ws.once('error', () => undefined);
    });

    expect(status).toBe(503);
    expect(server.registry.size).toBe(0);
  });
});
