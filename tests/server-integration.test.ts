/**
 * Integration tests for the Node bridge server.
 *
 * Tasks 9.1-9.5:
 *   9.1 REST→WS→plugin→WS→REST round-trip (GET /api/tools)
 *   9.2 All 7 server-facing RPC methods
 *   9.3 Auth flow (REST 401 without token, WS close without token)
 *   9.4 Session/instance flow (enabled-tools filter, pin instance, list)
 *   9.5 Deferred tool completion via NotifyToolRequestCompleted
 */

import { describe, expect, it, beforeAll, afterAll, afterEach } from 'vitest';
import WebSocket from 'ws';
import { createServer, type BridgeHandle } from '../src/server/app.js';
import { DEFAULT_SERVER_API_VERSION, parseServerConfig } from '../src/server/config.js';
import { StubPluginClient, type StubPluginData } from '../src/server/stub-client/index.js';
import { runServerFacingScenarios } from '../src/server/stub-client/scenarios.js';
import type { ServerConfig } from '../src/server/config.js';
import { ClientFacingMethod, ServerFacingMethod } from '../src/server/types.js';
import {
  makeRequest,
  makeResponse,
  serializeMessage,
  parseMessage,
  isRequest,
} from '../src/server/ws/envelope.js';

// ===== Helpers =====

let nextPort = 18080;

/** Get a port unlikely to collide (incrementing counter). */
function getTestPort(): number {
  return nextPort++;
}

/** Create a server config for testing. */
function makeConfig(port: number, token?: string): ServerConfig {
  return parseServerConfig([
    '--port', String(port),
    ...(token ? ['--token', token] : ['--authorization', 'none']),
  ], {});
}

/** Start a server and return the handle + URLs. */
async function startServer(config: ServerConfig): Promise<{ handle: BridgeHandle; baseUrl: string; wsUrl: string }> {
  const handle = createServer(config);
  await handle.start();
  return {
    handle,
    baseUrl: `http://127.0.0.1:${config.port}`,
    wsUrl: `ws://127.0.0.1:${config.port}/hub/plugin`,
  };
}

/** Connect a stub client with retry (server may need a moment). */
async function connectStub(
  wsUrl: string,
  opts?: { token?: string; instanceId?: string },
  data?: StubPluginData,
): Promise<StubPluginClient> {
  const client = new StubPluginClient(
    { url: wsUrl, token: opts?.token, instanceId: opts?.instanceId },
    data,
  );
  // Retry connect a few times in case the server isn't ready yet.
  for (let i = 0; i < 10; i++) {
    try {
      await client.connect();
      await markStubPluginReady(client);
      return client;
    } catch {
      client.disconnect();
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error('Stub client failed to connect');
}

async function markStubPluginReady(client: StubPluginClient): Promise<void> {
  await client.sendServerRequest(ServerFacingMethod.PerformVersionHandshake, {
    apiVersion: DEFAULT_SERVER_API_VERSION,
    pluginVersion: 'test-plugin',
    environment: 'vitest',
  });
  await client.sendServerRequest(ServerFacingMethod.NotifyAboutUpdatedTools, { tools: [] });
}

async function sendRawServerRequest(
  ws: WebSocket,
  method: string,
  params: unknown,
): Promise<unknown> {
  const id = `ready-${method}-${Date.now()}-${Math.random()}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', onMessage);
      reject(new Error(`Timeout waiting for ${method}`));
    }, 2_000);
    const onMessage = (raw: Buffer | Buffer[]): void => {
      const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : Buffer.concat(raw as Buffer[]).toString('utf8');
      const parsed = parseMessage(text);
      if (!parsed.ok || !('id' in parsed.message) || parsed.message.id !== id) return;
      clearTimeout(timer);
      ws.off('message', onMessage);
      if ('error' in parsed.message && parsed.message.error) reject(parsed.message.error);
      else resolve('result' in parsed.message ? parsed.message.result : undefined);
    };
    ws.on('message', onMessage);
    ws.send(serializeMessage(makeRequest(id, method, params)));
  });
}

async function markRawPluginReady(ws: WebSocket): Promise<void> {
  await sendRawServerRequest(ws, ServerFacingMethod.PerformVersionHandshake, {
    apiVersion: DEFAULT_SERVER_API_VERSION,
    pluginVersion: 'test-plugin',
    environment: 'vitest',
  });
  await sendRawServerRequest(ws, ServerFacingMethod.NotifyAboutUpdatedTools, { tools: [] });
}

/** Wait for the stub client to receive a notification of the given method. */
async function waitForNotification(client: StubPluginClient, method: string, timeoutMs = 2000): Promise<boolean> {
  for (let i = 0; i < timeoutMs / 50; i++) {
    if (client.notifications.some((n) => n.method === method)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

// ===== 9.1: REST→WS→plugin→WS→REST round-trip =====

describe('9.1 REST round-trip', () => {
  let handle: BridgeHandle;
  let baseUrl: string;
  let wsUrl: string;
  let client: StubPluginClient;

  beforeAll(async () => {
    const config = makeConfig(getTestPort());
    const ctx = await startServer(config);
    handle = ctx.handle;
    baseUrl = ctx.baseUrl;
    wsUrl = ctx.wsUrl;
    client = await connectStub(wsUrl);
    await waitForNotification(client, ClientFacingMethod.OnInitialClientData);
  });

  afterAll(async () => {
    client?.disconnect();
    await handle?.stop();
  });

  it('GET /api/tools returns stub client tool list', async () => {
    const res = await fetch(`${baseUrl}/api/tools`);
    expect(res.status).toBe(200);
    const data = await res.json() as Array<{ name: string }>;
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeGreaterThan(0);
    expect(data.map((tool) => tool.name)).toEqual(['echo', 'ping']);
  });

  it('POST /api/tools/ping returns tool result', async () => {
    const res = await fetch(`${baseUrl}/api/tools/ping`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'hello' }),
    });
    expect(res.status).toBe(200);
    const data = await res.json() as { status: string; content?: unknown[]; structured?: unknown };
    expect(data.status).toBe('success');
    // Stub returns structured content when available.
    expect(data.structured ?? data.content).toBeDefined();
  });

  it('GET /api/tools fails quickly when no plugin is connected', async () => {
    // Start a server without any stub client.
    const config = makeConfig(getTestPort());
    const ctx = await startServer(config);
    try {
      const startedAt = Date.now();
      const res = await fetch(`http://127.0.0.1:${config.port}/api/tools`);
      const durationMs = Date.now() - startedAt;
      expect(res.status).toBe(500);
      expect(durationMs).toBeLessThan(500);
    } finally {
      await ctx.handle.stop();
    }
  }, 15000);

  it('GET /health remains local and responsive without Unity', async () => {
    const config = makeConfig(getTestPort());
    const ctx = await startServer(config);
    try {
      const startedAt = Date.now();
      const res = await fetch(`${ctx.baseUrl}/health`);
      expect(res.status).toBe(200);
      expect(Date.now() - startedAt).toBeLessThan(500);
      await expect(res.json()).resolves.toMatchObject({
        ok: true,
        stages: { process: { ready: true }, http: { ready: true } },
      });
    } finally {
      await ctx.handle.stop();
    }
  });

  it('times out a delayed side-effect exactly once without replay', async () => {
    const deadlineUnixMs = Date.now() + 200;
    const config = parseServerConfig([
      '--port', String(getTestPort()),
      '--authorization', 'none',
    ], {});
    const ctx = await startServer(config);
    const ws = new WebSocket(ctx.wsUrl);
    let toolCalls = 0;

    try {
      await new Promise<void>((resolve, reject) => {
        ws.once('open', () => resolve());
        ws.once('error', reject);
      });
      ws.on('message', (raw: Buffer | Buffer[]) => {
        const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : Buffer.concat(raw as Buffer[]).toString('utf8');
        const parsed = parseMessage(text);
        if (parsed.ok && isRequest(parsed.message) && parsed.message.method === ClientFacingMethod.RunCallTool) {
          toolCalls++;
          // Deliberately do not respond: the server must time out without replay.
        }
      });
      await markRawPluginReady(ws);

      const startedAt = Date.now();
      const response = await fetch(`${ctx.baseUrl}/api/tools/build-player`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          arguments: {},
          control: {
            version: 1,
            callId: 'side-effect-timeout-call',
            correlationId: 'side-effect-timeout-trace',
            deadlineUnixMs,
          },
        }),
      });
      expect(response.status).toBe(408);
      expect(Date.now() - startedAt).toBeLessThan(500);
      expect(toolCalls).toBe(1);
    } finally {
      ws.close();
      await ctx.handle.stop();
    }
  });

  it('GET /api/tools honors the configured timeout when the plugin does not respond', async () => {
    const config = parseServerConfig([
      '--port', String(getTestPort()),
      '--authorization', 'none',
      '--plugin-timeout-ms', '75',
    ], {});
    const ctx = await startServer(config);
    const ws = new WebSocket(ctx.wsUrl);
    const firstMessage = new Promise<void>((resolve) => ws.once('message', () => resolve()));
    let fetchPromise: Promise<Response> | undefined;

    try {
      await new Promise<void>((resolve, reject) => {
        ws.once('open', () => resolve());
        ws.once('error', reject);
      });
      await firstMessage;
      await markRawPluginReady(ws);

      const startedAt = Date.now();
      fetchPromise = fetch(`${ctx.baseUrl}/api/tools`);
      const outcome = await Promise.race([
        fetchPromise.then((response) => ({ kind: 'response' as const, response })),
        new Promise<{ kind: 'timeout' }>((resolve) => {
          setTimeout(() => resolve({ kind: 'timeout' }), 500);
        }),
      ]);

      expect(outcome.kind).toBe('response');
      if (outcome.kind === 'response') {
        expect(outcome.response.status).toBe(500);
        expect(Date.now() - startedAt).toBeLessThan(500);
      }
    } finally {
      ws.close();
      await ctx.handle.stop();
      await fetchPromise?.catch(() => undefined);
    }
  });

  it('keeps routing to a ready token connection while a newer socket is still unready', async () => {
    const token = 'eligible-routing-secret';
    const config = parseServerConfig([
      '--port', String(getTestPort()),
      '--token', token,
      '--authorization', 'required',
      '--plugin-timeout-ms', '100',
    ]);
    const ctx = await startServer(config);
    const ready = await connectStub(ctx.wsUrl, { token, instanceId: 'same-editor' });
    const unreadyUrl = new URL(ctx.wsUrl);
    unreadyUrl.searchParams.set('access_token', token);
    unreadyUrl.searchParams.set('instanceId', 'same-editor');
    const unready = new WebSocket(unreadyUrl);

    try {
      await new Promise<void>((resolve, reject) => {
        unready.once('open', () => resolve());
        unready.once('error', reject);
      });

      const headers = { Authorization: `Bearer ${token}` };
      const healthRes = await fetch(`${ctx.baseUrl}/api/health`, { headers });
      expect(healthRes.status).toBe(200);
      const health = await healthRes.json() as {
        ready: boolean;
        generation: string;
        connection: { id: string; instanceId: string | null };
        stages: { handshake: { ready: boolean }; toolRunner: { ready: boolean } };
      };
      expect(health.ready).toBe(false);
      expect(health.generation).toBe(health.connection.id);
      expect(health.connection.instanceId).toBe('same-editor');
      expect(health.stages.handshake.ready).toBe(true);
      expect(health.stages.toolRunner.ready).toBe(true);

      const toolsRes = await fetch(`${ctx.baseUrl}/api/tools`, { headers });
      expect(toolsRes.status).toBe(200);
      expect(ready.isConnected).toBe(true);
    } finally {
      unready.close();
      ready.disconnect();
      await ctx.handle.stop();
    }
  });

  it('does not evict a ready auth-none connection for an unready replacement', async () => {
    const config = parseServerConfig([
      '--port', String(getTestPort()),
      '--authorization', 'none',
      '--plugin-timeout-ms', '100',
    ]);
    const ctx = await startServer(config);
    const ready = await connectStub(ctx.wsUrl, { instanceId: 'same-editor' });
    const unready = new WebSocket(`${ctx.wsUrl}?instanceId=same-editor`);

    try {
      await new Promise<void>((resolve, reject) => {
        unready.once('open', () => resolve());
        unready.once('error', reject);
      });

      const toolsRes = await fetch(`${ctx.baseUrl}/api/tools`);
      expect(toolsRes.status).toBe(200);
      expect(ready.isConnected).toBe(true);
      expect(ready.notifications.some((n) => n.method === ClientFacingMethod.ForceDisconnect)).toBe(false);
    } finally {
      unready.close();
      ready.disconnect();
      await ctx.handle.stop();
    }
  });

  it('keeps a generation-owned replacement ineligible until all capabilities register', async () => {
    const token = 'capability-registration-secret';
    const config = parseServerConfig([
      '--port', String(getTestPort()),
      '--token', token,
      '--authorization', 'required',
    ]);
    const ctx = await startServer(config);
    const oldReady = await connectStub(ctx.wsUrl, { token, instanceId: 'capability-editor' });
    const replacementUrl = new URL(ctx.wsUrl);
    replacementUrl.searchParams.set('access_token', token);
    replacementUrl.searchParams.set('instanceId', 'capability-editor');
    const replacement = new WebSocket(replacementUrl);

    try {
      await new Promise<void>((resolve, reject) => {
        replacement.once('open', () => resolve());
        replacement.once('error', reject);
      });
      const oldEntry = ctx.handle.registry.resolve({ instanceId: 'capability-editor' });
      expect(oldEntry).toBeDefined();

      await sendRawServerRequest(replacement, ServerFacingMethod.PerformVersionHandshake, {
        apiVersion: DEFAULT_SERVER_API_VERSION,
        pluginVersion: 'g006-plugin',
        environment: 'vitest',
        capabilities: ['operation-identity-v1', 'cancel-tool-call-v1'],
        generation: 42,
      });
      await sendRawServerRequest(replacement, ServerFacingMethod.NotifyAboutUpdatedTools, { tools: [] });
      expect(ctx.handle.registry.resolve({ instanceId: 'capability-editor' })?.connectionId)
        .toBe(oldEntry!.connectionId);

      await sendRawServerRequest(replacement, ServerFacingMethod.NotifyAboutUpdatedPrompts, { prompts: [] });
      expect(ctx.handle.registry.resolve({ instanceId: 'capability-editor' })?.connectionId)
        .toBe(oldEntry!.connectionId);
      await sendRawServerRequest(replacement, ServerFacingMethod.NotifyAboutUpdatedResources, { resources: [] });

      const promoted = ctx.handle.registry.resolve({ instanceId: 'capability-editor' });
      expect(promoted?.connectionId).not.toBe(oldEntry!.connectionId);
      expect(promoted?.generation).toBe(42);
      expect(promoted?.capabilities.has('cancel-tool-call-v1')).toBe(true);
    } finally {
      replacement.close();
      oldReady.disconnect();
      await ctx.handle.stop();
    }
  });

  it('preserves a durable processing handle and reports local operation busy', async () => {
    const config = makeConfig(getTestPort());
    const ctx = await startServer(config);
    const ws = new WebSocket(ctx.wsUrl);
    try {
      await new Promise<void>((resolve, reject) => {
        ws.once('open', () => resolve());
        ws.once('error', reject);
      });
      ws.on('message', (raw: Buffer | Buffer[]) => {
        const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : Buffer.concat(raw as Buffer[]).toString('utf8');
        const parsed = parseMessage(text);
        if (!parsed.ok || !isRequest(parsed.message)) return;
        if (parsed.message.method === ClientFacingMethod.RunCallTool) {
          ws.send(serializeMessage(makeResponse(parsed.message.id, {
            requestID: 'durable-request',
            status: 'processing',
            value: {
              content: [],
              structuredContent: {
                result: { OperationId: 'operation-123', Status: 'queued', Phase: 'scheduled' },
              },
            },
          })));
        }
      });
      await markRawPluginReady(ws);

      const response = await fetch(`${ctx.baseUrl}/api/tools/tests-run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        status: 'processing',
        structured: { result: { OperationId: 'operation-123', Status: 'queued' } },
      });

      const health = await fetch(`${ctx.baseUrl}/api/health`);
      await expect(health.json()).resolves.toMatchObject({
        ready: false,
        stages: {
          editor: { ready: false, state: 'busy', blockers: ['active-operation'] },
          operations: { ready: false, active: 1 },
        },
      });
    } finally {
      ws.close();
      await ctx.handle.stop();
    }
  });

  it('GET /help returns text/plain', async () => {
    const res = await fetch(`${baseUrl}/help`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('REST endpoints');
    expect(text).toContain('/hub/plugin');
  });
});

// ===== Heartbeat: keep idle Unity WebSocket connections alive =====

describe('WebSocket heartbeat', () => {
  it('sends application-level heartbeat notifications while the connection is idle', async () => {
    const config = {
      ...makeConfig(getTestPort()),
      heartbeatIntervalMs: 50,
    };
    const ctx = await startServer(config);
    const client = await connectStub(ctx.wsUrl);

    try {
      const received = await waitForNotification(client, 'Heartbeat', 500);
      expect(received).toBe(true);
    } finally {
      client.disconnect();
      await ctx.handle.stop();
    }
  });
});

// ===== 9.2: All 7 server-facing RPC methods =====

describe('9.2 Server-facing RPC methods', () => {
  let handle: BridgeHandle;
  let wsUrl: string;
  let client: StubPluginClient;

  beforeAll(async () => {
    const config = makeConfig(getTestPort());
    const ctx = await startServer(config);
    handle = ctx.handle;
    wsUrl = ctx.wsUrl;
    client = await connectStub(wsUrl);
    await waitForNotification(client, ClientFacingMethod.OnInitialClientData);
  });

  afterAll(async () => {
    client?.disconnect();
    await handle?.stop();
  });

  it('all 7 server-facing methods respond correctly', async () => {
    const results = await runServerFacingScenarios(client);
    expect(results.length).toBe(7);
    for (const r of results) {
      expect(r.passed, `${r.name}: ${r.message ?? 'failed'}`).toBe(true);
    }
  });
});

// ===== 9.3: Auth flow =====

describe('9.3 Auth flow', () => {
  let handle: BridgeHandle;
  let baseUrl: string;
  let wsUrl: string;
  const token = 'test-secret';

  beforeAll(async () => {
    const config = makeConfig(getTestPort(), token);
    const ctx = await startServer(config);
    handle = ctx.handle;
    baseUrl = ctx.baseUrl;
    wsUrl = ctx.wsUrl;
  });

  afterAll(async () => {
    await handle?.stop();
  });

  it('REST without auth header returns 401', async () => {
    const res = await fetch(`${baseUrl}/api/tools`);
    expect(res.status).toBe(401);
  });

  it('REST with correct token returns 200', async () => {
    // Need a stub client connected with the token for the full round-trip.
    const client = await connectStub(wsUrl, { token });
    try {
      const res = await fetch(`${baseUrl}/api/tools`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(200);
      const data = await res.json() as Array<{ name: string }>;
      expect(data.length).toBeGreaterThan(0);
    } finally {
      client.disconnect();
    }
  });

  it('authenticated GET /api/tools preserves safety metadata, extensions, and legacy omission', async () => {
    const client = await connectStub(wsUrl, { token }, {
      tools: [
        {
          name: 'z-metadata',
          enabled: false,
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: null,
          openWorldHint: false,
          futureSafetyMember: { version: 2 },
          inputSchema: {
            type: 'object',
            additionalProperties: false,
            $defs: { Value: { customKeyword: 'retained' } },
            $ref: '#/$defs/Value',
          },
          outputSchema: {
            type: 'object',
            additionalProperties: { customOutputKeyword: 'retained' },
            $defs: { Result: { futureOutputKeyword: true } },
            $ref: '#/$defs/Result',
          },
        },
        {
          name: 'a-legacy',
          enabled: true,
          inputSchema: { type: 'object', additionalProperties: true },
        },
      ],
      prompts: [],
      resources: [],
      resourceTemplates: [],
    });
    try {
      const res = await fetch(`${baseUrl}/api/tools`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(200);
      const data = await res.json() as Array<Record<string, unknown>>;
      expect(data.map((tool) => tool['name'])).toEqual(['a-legacy', 'z-metadata']);
      expect(Object.hasOwn(data[0]!, 'readOnlyHint')).toBe(false);
      expect(data[1]).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: null,
        openWorldHint: false,
        futureSafetyMember: { version: 2 },
        inputSchema: {
          additionalProperties: false,
          $defs: { Value: { customKeyword: 'retained' } },
          $ref: '#/$defs/Value',
        },
        outputSchema: {
          additionalProperties: { customOutputKeyword: 'retained' },
          $defs: { Result: { futureOutputKeyword: true } },
          $ref: '#/$defs/Result',
        },
      });
    } finally {
      client.disconnect();
    }
  });

  it('REST with wrong token returns 401', async () => {
    const res = await fetch(`${baseUrl}/api/tools`, {
      headers: { Authorization: 'Bearer wrong-token' },
    });
    expect(res.status).toBe(401);
  });

  it('WS without token fails to connect', async () => {
    const wsUrlNoToken = `ws://127.0.0.1:${handle.httpServer.address() && typeof handle.httpServer.address() === 'object' ? (handle.httpServer.address() as { port: number }).port : 8080}/hub/plugin`;
    const client = new StubPluginClient({ url: wsUrlNoToken });
    await expect(client.connect()).rejects.toThrow();
  });
});

// ===== 9.4: Session / instance flow =====

describe('9.4 Session and instance flow', () => {
  let handle: BridgeHandle;
  let baseUrl: string;
  let wsUrl: string;
  let client: StubPluginClient;

  beforeAll(async () => {
    const config = makeConfig(getTestPort());
    const ctx = await startServer(config);
    handle = ctx.handle;
    baseUrl = ctx.baseUrl;
    wsUrl = ctx.wsUrl;
    client = await connectStub(wsUrl, { instanceId: 'unity-test-123' });
    await waitForNotification(client, ClientFacingMethod.OnInitialClientData);
  });

  afterAll(async () => {
    client?.disconnect();
    await handle?.stop();
  });

  afterEach(() => {
    // Reset session state between tests.
    handle.sessionStore.dispose();
    handle.sessionStore.startSweeper();
  });

  it('set enabled-tools filters GET /api/tools', async () => {
    // Enable only 'ping'.
    const setRes = await fetch(`${baseUrl}/api/session/enabled-tools`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ toolIds: ['ping'] }),
    });
    expect(setRes.status).toBe(200);

    // List tools — should only see 'ping'.
    const listRes = await fetch(`${baseUrl}/api/tools`);
    expect(listRes.status).toBe(200);
    const tools = await listRes.json() as Array<{ name: string }>;
    expect(tools.length).toBe(1);
    expect(tools[0].name).toBe('ping');
  });

  it('clear enabled-tools (empty array) restores all tools', async () => {
    // First restrict.
    await fetch(`${baseUrl}/api/session/enabled-tools`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ toolIds: [] }),
    });

    // List tools — should see all.
    const listRes = await fetch(`${baseUrl}/api/tools`);
    expect(listRes.status).toBe(200);
    const tools = await listRes.json() as Array<{ name: string }>;
    expect(tools.length).toBeGreaterThan(1);
  });

  it('GET /api/session returns session state', async () => {
    const res = await fetch(`${baseUrl}/api/session`);
    expect(res.status).toBe(200);
    const data = await res.json() as { sessionId: string; activeInstanceId: string | null; enabledTools: string[] | null };
    expect(data.sessionId).toBeDefined();
    expect(data.activeInstanceId).toBeNull();
    expect(data.enabledTools).toBeNull();
  });

  it('GET /api/instances lists connected instances', async () => {
    const res = await fetch(`${baseUrl}/api/instances`);
    expect(res.status).toBe(200);
    const data = await res.json() as { count: number; instances: Array<{ instanceId: string; connectionId: string }> };
    expect(data.count).toBeGreaterThanOrEqual(1);
    expect(data.instances.some((i) => i.instanceId === 'unity-test-123')).toBe(true);
  });
});

// ===== 9.5: Deferred tool completion =====

describe('9.5 Deferred tool completion', () => {
  let handle: BridgeHandle;
  let baseUrl: string;
  let wsUrl: string;
  let ws: WebSocket;

  beforeAll(async () => {
    const config = makeConfig(getTestPort());
    const ctx = await startServer(config);
    handle = ctx.handle;
    baseUrl = ctx.baseUrl;
    wsUrl = ctx.wsUrl;

    // Connect a raw WS client that completes RunCallTool via the deferred
    // path (NotifyToolRequestCompleted) instead of a direct RPC response.
    ws = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve());
      ws.on('error', reject);
    });

    ws.on('message', (raw: Buffer | Buffer[]) => {
      const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : Buffer.concat(raw as Buffer[]).toString('utf8');
      const parsed = parseMessage(text);
      if (!parsed.ok) return;
      const msg = parsed.message;
      if (!isRequest(msg)) return;

      if (msg.method === ClientFacingMethod.RunCallTool) {
        // Extract the tool-call requestID from params, then send
        // NotifyToolRequestCompleted (server-facing request) with the result.
        // Do NOT send a direct RPC response — the REST call must resolve
        // via the deferred path only.
        const params = (msg.params ?? {}) as { requestID?: string };
        const deferredReq = makeRequest(
          `deferred-${Date.now()}`,
          ServerFacingMethod.NotifyToolRequestCompleted,
          {
            requestId: params.requestID ?? '',
            result: {
              content: [{ type: 'text', text: 'Deferred result' }],
              structuredContent: { deferred: true },
            },
          },
        );
        ws.send(serializeMessage(deferredReq));
      } else {
        // For non-tool-call requests, respond directly so other operations work.
        ws.send(serializeMessage(makeResponse(msg.id, { status: 'success' })));
      }
    });

    await markRawPluginReady(ws);

    // Give the server a moment to register the connection.
    await new Promise((r) => setTimeout(r, 200));
  });

  afterAll(async () => {
    ws?.close();
    await handle?.stop();
  });

  it('POST /api/tools/ping resolves via NotifyToolRequestCompleted (deferred path)', async () => {
    // This exercises the full deferred chain:
    //   REST POST → forwardToPlugin(RunCallTool) → pending.track + trackDeferred
    //   → WS client sends NotifyToolRequestCompleted
    //   → rpc handler calls pending.resolveDeferred
    //   → forwardToPlugin promise resolves → REST 200
    const res = await fetch(`${baseUrl}/api/tools/ping`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const data = await res.json() as { status: string; structured?: unknown; content?: unknown };
    expect(data.status).toBe('success');
    // The deferred stub returns structuredContent: { deferred: true }.
    expect(data.structured).toEqual({ deferred: true });
  });
});

// ===== 9.6: Multi-plugin routing (auth=required) =====

describe('9.6 Multi-plugin routing (auth=required)', () => {
  let handle: BridgeHandle;
  let baseUrl: string;
  let wsUrl: string;
  const token = 'multi-secret';

  beforeAll(async () => {
    const config = makeConfig(getTestPort(), token);
    const ctx = await startServer(config);
    handle = ctx.handle;
    baseUrl = ctx.baseUrl;
    wsUrl = ctx.wsUrl;
  });

  afterAll(async () => {
    await handle?.stop();
  });

  it('disconnect of one plugin does not reject the other plugin pending requests', async () => {
    // Connect plugin A with instanceId 'inst-a'.
    const clientA = await connectStub(wsUrl, { token, instanceId: 'inst-a' });
    await waitForNotification(clientA, ClientFacingMethod.OnInitialClientData);

    // Connect plugin B with instanceId 'inst-b'.
    const clientB = await connectStub(wsUrl, { token, instanceId: 'inst-b' });
    await waitForNotification(clientB, ClientFacingMethod.OnInitialClientData);

    // Pin session to instance-a so requests route to plugin A.
    const pinRes = await fetch(`${baseUrl}/api/session/instance`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ instanceId: 'inst-a' }),
    });
    expect(pinRes.status).toBe(200);

    // Verify plugin A handles requests.
    const res1 = await fetch(`${baseUrl}/api/tools`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res1.status).toBe(200);
    const tools1 = await res1.json() as Array<{ name: string }>;
    expect(tools1.length).toBeGreaterThan(0);

    // Disconnect plugin B — this must NOT reject plugin A's pending entries.
    clientB.disconnect();
    await new Promise((r) => setTimeout(r, 300));

    // Plugin A should still serve requests correctly.
    const res2 = await fetch(`${baseUrl}/api/tools`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res2.status).toBe(200);
    const tools2 = await res2.json() as Array<{ name: string }>;
    expect(tools2.length).toBeGreaterThan(0);

    clientA.disconnect();
  });
});

// ===== 9.7: ForceDisconnect on second connection (auth=none) =====

describe('9.7 ForceDisconnect on second connection', () => {
  let handle: BridgeHandle;
  let baseUrl: string;
  let wsUrl: string;

  beforeAll(async () => {
    const config = makeConfig(getTestPort());
    const ctx = await startServer(config);
    handle = ctx.handle;
    baseUrl = ctx.baseUrl;
    wsUrl = ctx.wsUrl;
  });

  afterAll(async () => {
    await handle?.stop();
  });

  it('second ready connection ForceDisconnects the first and takes over', async () => {
    // Connect the first plugin.
    const clientA = await connectStub(wsUrl);
    await waitForNotification(clientA, ClientFacingMethod.OnInitialClientData);
    expect(clientA.isConnected).toBe(true);

    // Connect and fully register a second plugin — only then should it
    // ForceDisconnect client A and become the routing target.
    const clientB = await connectStub(wsUrl);
    await waitForNotification(clientB, ClientFacingMethod.OnInitialClientData);

    // Client A should have received a ForceDisconnect notification.
    const gotForceDisconnect = await waitForNotification(clientA, ClientFacingMethod.ForceDisconnect, 2000);
    expect(gotForceDisconnect).toBe(true);

    // Give a moment for client A's socket to close.
    await new Promise((r) => setTimeout(r, 300));

    // The server should now route to client B.
    const res = await fetch(`${baseUrl}/api/tools`);
    expect(res.status).toBe(200);
    const tools = await res.json() as Array<{ name: string }>;
    expect(tools.length).toBeGreaterThan(0);

    clientA.disconnect();
    clientB.disconnect();
  });
});

// ===== 9.8: OnPluginClientConnected notification (auth=required) =====

describe('9.8 Client connected/disconnected notifications', () => {
  let handle: BridgeHandle;
  let wsUrl: string;
  const token = 'notif-secret';

  beforeAll(async () => {
    const config = makeConfig(getTestPort(), token);
    const ctx = await startServer(config);
    handle = ctx.handle;
    wsUrl = ctx.wsUrl;
  });

  afterAll(async () => {
    await handle?.stop();
  });

  it('existing plugin receives OnPluginClientConnected when a second plugin joins', async () => {
    const clientA = await connectStub(wsUrl, { token, instanceId: 'notif-a' });
    await waitForNotification(clientA, ClientFacingMethod.OnInitialClientData);

    const clientB = await connectStub(wsUrl, { token, instanceId: 'notif-b' });

    // A receives its own connect notification first — wait for the one about B.
    let notif: { method: string; params: unknown } | undefined;
    for (let i = 0; i < 40 && !notif; i++) {
      notif = clientA.notifications.find((n) => {
        if (n.method !== ClientFacingMethod.OnPluginClientConnected) return false;
        const p = n.params as { connected?: { sessionId?: string | null } };
        return p.connected?.sessionId === 'notif-b';
      });
      if (!notif) await new Promise((r) => setTimeout(r, 50));
    }
    expect(notif).toBeDefined();
    const params = notif!.params as {
      connected: { sessionId?: string | null; isConnected?: boolean };
      all: { sessionId?: string | null }[];
    };
    expect(params.connected.sessionId).toBe('notif-b');
    expect(params.connected.isConnected).toBe(true);
    expect(params.all.map((c) => c.sessionId).sort()).toEqual(['notif-a', 'notif-b']);

    clientA.disconnect();
    clientB.disconnect();
  });
});

// ===== 9.9: OnPluginClientDisconnected notification (auth=required) =====

describe('9.9 Client connected/disconnected notifications', () => {
  let handle: BridgeHandle;
  let wsUrl: string;
  const token = 'notif-secret';

  beforeAll(async () => {
    const config = makeConfig(getTestPort(), token);
    const ctx = await startServer(config);
    handle = ctx.handle;
    wsUrl = ctx.wsUrl;
  });

  afterAll(async () => {
    await handle?.stop();
  });

  it('remaining plugin receives OnPluginClientDisconnected when another plugin leaves', async () => {
    const clientA = await connectStub(wsUrl, { token, instanceId: 'dc-a' });
    await waitForNotification(clientA, ClientFacingMethod.OnInitialClientData);
    const clientB = await connectStub(wsUrl, { token, instanceId: 'dc-b' });
    await waitForNotification(clientA, ClientFacingMethod.OnPluginClientConnected);

    clientB.disconnect();

    const got = await waitForNotification(clientA, ClientFacingMethod.OnPluginClientDisconnected);
    expect(got).toBe(true);

    const notif = clientA.notifications.find((n) => n.method === ClientFacingMethod.OnPluginClientDisconnected);
    expect(notif).toBeDefined();
    const params = notif!.params as {
      disconnected: { sessionId?: string | null; isConnected?: boolean };
      remaining: { sessionId?: string | null }[];
    };
    expect(params.disconnected.sessionId).toBe('dc-b');
    expect(params.disconnected.isConnected).toBe(false);
    expect(params.remaining.map((c) => c.sessionId)).toEqual(['dc-a']);

    clientA.disconnect();
  });
});
