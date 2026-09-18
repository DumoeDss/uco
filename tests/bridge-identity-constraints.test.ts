// Bridge identity constraints (COCli-01) — fail-closed routing-time enforcement.
//
// Covers the three spec scenarios for the constraint requirement: matching
// identity proceeds (with the served-identity echo on the response), wrong
// project is rejected before forwarding with a structured non-retryable
// error, and pre-capability peers (identity members unavailable) are rejected
// rather than passed. Also pins the registry snapshot gating and the
// readiness health connection tuple.

import { afterEach, beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { normalizeToolCall, ToolCallControlError } from '../src/tool-call-control.js';
import { forwardToPlugin, type ForwardDeps } from '../src/server/rest/forward.js';
import { PendingTracker } from '../src/server/ws/pending.js';
import { ConnectionRegistry } from '../src/server/ws/registry.js';
import { ClientFacingMethod, ServerFacingMethod } from '../src/server/types.js';
import { createServer, type McpServerHandle } from '../src/server/app.js';
import { DEFAULT_SERVER_API_VERSION, parseServerConfig } from '../src/server/config.js';
import { makeRequest, makeResponse, serializeMessage, parseMessage } from '../src/server/ws/envelope.js';

function identityEntry(overrides: Record<string, unknown> = {}) {
  return {
    connectionId: 'connection-identity',
    generation: 11,
    capabilities: new Set(['cancel-tool-call-v1', 'operation-identity-v1', 'bridge-identity-v1']),
    instanceId: 'ProjectA@abcd1234',
    identity: {
      projectPath: 'D:\\work\\ProjectA',
      editorPid: 4242,
      unityVersion: '6000.5.6f1',
    },
    ...overrides,
  };
}

function legacyEntry() {
  return {
    connectionId: 'connection-legacy',
    generation: 3,
    capabilities: new Set(['cancel-tool-call-v1']),
    instanceId: 'ProjectB@ffff0000',
  };
}

function deps(connection: unknown, sent: Array<{ connectionId: string; request: any }>, pending = new PendingTracker()): ForwardDeps {
  return {
    registry: { resolve: () => connection } as unknown as ForwardDeps['registry'],
    pending,
    hub: {
      sendToConnection: (connectionId: string, request: any) => {
        sent.push({ connectionId, request });
        return true;
      },
    } as unknown as ForwardDeps['hub'],
    pluginTimeoutMs: 5_000,
  };
}

function constrainedCall(identity: Record<string, unknown>) {
  const normalized = normalizeToolCall({
    name: 'scene-save',
    arguments: { scenePath: 'Assets/Main.unity' },
    requestID: 'request-identity',
    control: {
      callId: 'call-identity',
      correlationId: 'trace-identity',
      ...identity,
    },
  });
  return normalized;
}

describe('bridge identity constraints — routing-time enforcement', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('forwards normally when every constraint matches the routed identity', async () => {
    const pending = new PendingTracker();
    const sent: Array<{ connectionId: string; request: any }> = [];
    const connection = identityEntry();
    const normalized = constrainedCall({
      expectedProjectPath: 'D:\\work\\ProjectA',
      expectedInstanceId: 'ProjectA@abcd1234',
      expectedPid: 4242,
    });

    // The forwarder reports the entry that served the call so the REST layer
    // can echo the identity tuple (COCli-01 matching-identity scenario).
    const served: Array<{ connectionId: string; instanceId?: string }> = [];
    const resultPromise = forwardToPlugin(
      deps(connection, sent, pending),
      ClientFacingMethod.RunCallTool,
      normalized.request,
      {
        context: normalized.context,
        onServed: (entry) => {
          served.push({ connectionId: entry.connectionId, instanceId: entry.instanceId ?? undefined });
        },
      },
    );
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    queueMicrotask(() => pending.resolve(sent[0]!.request.id, { status: 'success' }));
    await expect(resultPromise).resolves.toEqual({ status: 'success' });
    expect(sent[0]!.connectionId).toBe('connection-identity');
    expect(served).toEqual([
      { connectionId: 'connection-identity', instanceId: 'ProjectA@abcd1234' },
    ]);
  });

  it('compares project paths case-insensitively on Windows', async () => {
    const originalPlatform = process.platform;
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32' as NodeJS.Platform);
    try {
      const pending = new PendingTracker();
      const sent: Array<{ connectionId: string; request: any }> = [];
      const normalized = constrainedCall({ expectedProjectPath: 'd:\\WORK\\projecta' });

      const resultPromise = forwardToPlugin(
        deps(identityEntry(), sent, pending),
        ClientFacingMethod.RunCallTool,
        normalized.request,
        { context: normalized.context },
      );
      await vi.waitFor(() => expect(sent).toHaveLength(1));
      queueMicrotask(() => pending.resolve(sent[0]!.request.id, { status: 'success' }));
      await expect(resultPromise).resolves.toEqual({ status: 'success' });
      expect(sent).toHaveLength(1);
    } finally {
      vi.spyOn(process, 'platform', 'get').mockReturnValue(originalPlatform as NodeJS.Platform);
    }
  });

  it('rejects a wrong-project call before forwarding with a structured non-retryable mismatch error', async () => {
    const pending = new PendingTracker();
    const sent: Array<{ connectionId: string; request: any }> = [];
    const normalized = constrainedCall({ expectedProjectPath: 'D:\\work\\ProjectB' });

    const rejection = expect(forwardToPlugin(
      deps(identityEntry(), sent, pending),
      ClientFacingMethod.RunCallTool,
      normalized.request,
      { context: normalized.context },
    )).rejects.toMatchObject({
      data: {
        code: 'identity_mismatch',
        retryable: false,
        callId: 'call-identity',
        correlationId: 'trace-identity',
      },
    });
    await rejection;

    // The wrong Editor never receives the forwarded request.
    expect(sent).toHaveLength(0);
    expect(pending.size).toBe(0);
  });

  it('rejects wrong instance id and wrong pid constraints with expected/observed values', async () => {
    for (const constraint of [
      { expectedInstanceId: 'ProjectZ@0000' },
      { expectedPid: 9999 },
    ]) {
      const sent: Array<{ connectionId: string; request: any }> = [];
      const normalized = constrainedCall(constraint);

      await expect(forwardToPlugin(
        deps(identityEntry(), sent),
        ClientFacingMethod.RunCallTool,
        normalized.request,
        { context: normalized.context },
      )).rejects.toMatchObject({
        data: {
          code: 'identity_mismatch',
          details: {
            violations: [expect.objectContaining({ expected: expect.anything(), observed: expect.anything() })],
            observed: expect.objectContaining({ editorPid: 4242 }),
          },
        },
      });
      expect(sent).toHaveLength(0);
    }
  });

  it('rejects constrained calls against a pre-capability peer with identity_unavailable', async () => {
    const sent: Array<{ connectionId: string; request: any }> = [];
    const normalized = constrainedCall({ expectedProjectPath: 'D:\\work\\ProjectA' });

    await expect(forwardToPlugin(
      deps(legacyEntry(), sent),
      ClientFacingMethod.RunCallTool,
      normalized.request,
      { context: normalized.context },
    )).rejects.toMatchObject({
      data: {
        code: 'identity_unavailable',
        retryable: false,
        details: {
          unavailable: ['expectedProjectPath'],
          observed: expect.objectContaining({ projectPath: null }),
        },
      },
    });
    expect(sent).toHaveLength(0);
  });

  it('leaves unconstrained calls untouched on pre-capability peers', async () => {
    const pending = new PendingTracker();
    const sent: Array<{ connectionId: string; request: any }> = [];
    const normalized = normalizeToolCall({
      name: 'scene-list-opened',
      arguments: {},
      requestID: 'request-legacy',
      control: { callId: 'call-legacy' },
    });

    const resultPromise = forwardToPlugin(
      deps(legacyEntry(), sent, pending),
      ClientFacingMethod.RunCallTool,
      normalized.request,
      { context: normalized.context },
    );
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    queueMicrotask(() => pending.resolve(sent[0]!.request.id, { status: 'success' }));
    await expect(resultPromise).resolves.toEqual({ status: 'success' });
    expect(sent).toHaveLength(1);
  });

  it('validates malformed constraint members with invalid_control', () => {
    expect(() => normalizeToolCall({
      name: 'scene-save',
      arguments: {},
      control: { callId: 'c1', expectedPid: 0 },
    })).toThrowError(ToolCallControlError);

    expect(() => normalizeToolCall({
      name: 'scene-save',
      arguments: {},
      control: { callId: 'c1', expectedInstanceId: '  ' },
    })).toThrowError(ToolCallControlError);

    expect(() => normalizeToolCall({
      name: 'scene-save',
      arguments: {},
      control: { callId: 'c1', expectedProjectPath: 42 },
    })).toThrowError(ToolCallControlError);
  });

  it('serializes identity constraints through the controlled wire body', () => {
    const normalized = constrainedCall({
      expectedProjectPath: 'D:\\work\\ProjectA',
      expectedInstanceId: 'ProjectA@abcd1234',
      expectedPid: 4242,
    });
    expect(normalized.request.control).toMatchObject({
      expectedProjectPath: 'D:\\work\\ProjectA',
      expectedInstanceId: 'ProjectA@abcd1234',
      expectedPid: 4242,
    });
    expect(normalized.context.identity).toEqual({
      projectPath: 'D:\\work\\ProjectA',
      instanceId: 'ProjectA@abcd1234',
      pid: 4242,
    });
  });
});

describe('bridge identity constraints — registry snapshot gating', () => {
  const fakeWs = (): unknown => ({ readyState: 1, OPEN: 1, send: () => undefined, close: () => undefined });

  it('retains identity members only for capability-advertising peers', () => {
    const registry = new ConnectionRegistry(false);
    const capabilityId = registry.register(fakeWs() as never, { instanceId: 'ProjectA@abcd1234' });
    const legacyId = registry.register(fakeWs() as never, { instanceId: 'ProjectB@ffff0000' });

    registry.markHandshake(capabilityId, true,
      ['cancel-tool-call-v1', 'operation-identity-v1', 'bridge-identity-v1'], 21, {
        projectPath: 'D:\\work\\ProjectA',
        editorPid: 4242,
        unityVersion: '6000.5.6f1',
      });
    registry.markHandshake(legacyId, true,
      ['cancel-tool-call-v1'], 3, {
        projectPath: 'D:\\work\\ProjectB',
        editorPid: 1111,
        unityVersion: '2022.3.62f3',
      });

    expect(registry.get(capabilityId)!.identity).toEqual({
      projectPath: 'D:\\work\\ProjectA',
      editorPid: 4242,
      unityVersion: '6000.5.6f1',
    });
    // The legacy peer did not advertise the capability: members stay unavailable.
    expect(registry.get(legacyId)!.identity).toBeUndefined();
  });

  it('drops malformed identity members instead of storing them', () => {
    const registry = new ConnectionRegistry(false);
    const connectionId = registry.register(fakeWs() as never, { instanceId: 'ProjectA@abcd1234' });

    registry.markHandshake(connectionId, true, ['bridge-identity-v1'], 1, {
      projectPath: '   ',
      editorPid: -5,
      unityVersion: 12345,
    });

    expect(registry.get(connectionId)!.identity).toBeUndefined();
  });
});

// ===== Served-identity echo on matched constrained calls =====================

// An in-process server with a capability-advertising stub plugin proves the
// REST tool-call response echoes the identity tuple that served a matched
// constrained call (and stays absent otherwise).
describe('bridge identity constraints — served-identity echo', () => {
  const instanceId = 'ProjectA@abcd1234';
  const identity = {
    projectPath: 'D:\\work\\ProjectA',
    editorPid: 4242,
    unityVersion: '6000.5.6f1',
  };
  const generation = 21;

  let handle: McpServerHandle;
  let baseUrl: string;
  let ws: WebSocket;

  beforeAll(async () => {
    const config = parseServerConfig([
      '--port', '18340',
      '--authorization', 'none',
    ], {});
    handle = createServer(config);
    await handle.start();
    baseUrl = `http://127.0.0.1:${config.port}`;

    ws = new WebSocket(`ws://127.0.0.1:${config.port}/hub/mcp-server?instanceId=${encodeURIComponent(instanceId)}`);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    ws.on('message', (data) => {
      const text = data.toString('utf8');
      const parsed = parseMessage(text);
      if (!parsed.ok || !('id' in parsed.message) || !('method' in parsed.message)) return;
      const msg = parsed.message as { id: string | number; method: string };
      if (msg.method === ServerFacingMethod.PerformVersionHandshake) {
        ws.send(serializeMessage(makeResponse(msg.id, { apiVersion: DEFAULT_SERVER_API_VERSION, compatible: true })));
        return;
      }
      if (msg.method === ServerFacingMethod.NotifyAboutUpdatedTools
        || msg.method === ServerFacingMethod.NotifyAboutUpdatedPrompts
        || msg.method === ServerFacingMethod.NotifyAboutUpdatedResources) {
        ws.send(serializeMessage(makeResponse(msg.id, { status: 'success' })));
        return;
      }
      if (msg.method === ClientFacingMethod.RunCallTool) {
        ws.send(serializeMessage(makeResponse(msg.id, {
          requestID: 'stub',
          status: 'success',
          value: { content: [] },
        })));
      }
    });

    const handshake = makeRequest('h1', ServerFacingMethod.PerformVersionHandshake, {
      apiVersion: DEFAULT_SERVER_API_VERSION,
      pluginVersion: 'stub',
      environment: 'vitest',
      capabilities: ['cancel-tool-call-v1', 'operation-identity-v1', 'bridge-identity-v1'],
      generation,
      ...identity,
    });
    ws.send(serializeMessage(handshake));
    await new Promise((r) => setTimeout(r, 100));
    ws.send(serializeMessage(makeRequest('t1', ServerFacingMethod.NotifyAboutUpdatedTools, { tools: [] })));
    ws.send(serializeMessage(makeRequest('p1', ServerFacingMethod.NotifyAboutUpdatedPrompts, { prompts: [] })));
    ws.send(serializeMessage(makeRequest('r1', ServerFacingMethod.NotifyAboutUpdatedResources, { resources: [] })));
    await new Promise((r) => setTimeout(r, 200));
  });

  afterAll(async () => {
    ws?.close();
    await handle?.stop();
  });

  it('echoes the served identity tuple on a matched constrained call', async () => {
    const res = await fetch(`${baseUrl}/api/tools/scene-save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        arguments: {},
        control: {
          callId: 'echo-matched',
          expectedProjectPath: identity.projectPath,
          expectedInstanceId: instanceId,
          expectedPid: identity.editorPid,
        },
      }),
    });
    expect(res.status).toBe(200);
    const data = await res.json() as Record<string, unknown>;
    expect(data['status']).toBe('success');
    expect(data['transportStatus']).toBe('forwarded');
    expect(data['servedBy']).toEqual({
      instanceId,
      projectPath: identity.projectPath,
      editorPid: identity.editorPid,
      unityVersion: identity.unityVersion,
      generation,
    });
  });

  it('echoes the serving identity for unconstrained calls when the peer reports it', async () => {
    const res = await fetch(`${baseUrl}/api/tools/scene-save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        arguments: {},
        control: { callId: 'echo-unconstrained' },
      }),
    });
    expect(res.status).toBe(200);
    const data = await res.json() as Record<string, unknown>;
    expect(data['transportStatus']).toBe('forwarded');
    // COCli-01 relaxation: the served-identity echo is no longer gated on
    // caller-asserted constraints — any response served by an
    // identity-reporting peer carries the tuple.
    const servedBy = data['servedBy'] as Record<string, unknown>;
    expect(servedBy).toEqual(expect.objectContaining({ projectPath: identity.projectPath }));
  });

  it('rejects a mismatched constrained call with 409 and no echo', async () => {
    const res = await fetch(`${baseUrl}/api/tools/scene-save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        arguments: {},
        control: {
          callId: 'echo-mismatch',
          expectedProjectPath: 'D:\\work\\ProjectB',
        },
      }),
    });
    expect(res.status).toBe(409);
    const data = await res.json() as Record<string, unknown>;
    const error = data['error'] as Record<string, unknown>;
    expect(error['code']).toBe('identity_mismatch');
    expect('servedBy' in data).toBe(false);
    const details = error['details'] as Record<string, unknown>;
    expect(details['observed']).toEqual(expect.objectContaining({ projectPath: identity.projectPath }));
  });
});
