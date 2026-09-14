// COCli-09 diagnostic passthrough — the plugin puts the actionable failure
// text (compile errors, exception messages) into ResponseData.message and the
// first text content block; the REST layer must never let a generic
// "Tool execution failed." placeholder shadow it, and a tool-level failure
// must classify as a structured, non-retryable failure (a tool decision, not
// a transient transport condition) on both the legacy and controlled paths.

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import WebSocket from 'ws';
import { createServer, type McpServerHandle } from '../src/server/app.js';
import { DEFAULT_SERVER_API_VERSION, parseServerConfig } from '../src/server/config.js';
import { ClientFacingMethod, ServerFacingMethod } from '../src/server/types.js';
import {
  makeRequest,
  makeResponse,
  serializeMessage,
  parseMessage,
} from '../src/server/ws/envelope.js';

let nextPort = 18360;

describe('tool failure diagnostics reach the REST response', () => {
  let handle: McpServerHandle;
  let baseUrl: string;
  let ws: WebSocket;
  let latestToolResponse: Record<string, unknown> | undefined;

  beforeAll(async () => {
    const config = parseServerConfig([
      '--port', String(nextPort++),
      '--authorization', 'none',
    ], {});
    handle = createServer(config);
    await handle.start();
    baseUrl = `http://localhost:${config.port}`;

    ws = new WebSocket(`ws://localhost:${config.port}/hub/mcp-server`);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    ws.on('message', (data) => {
      const parsed = parseMessage(data.toString('utf8'));
      if (!parsed.ok || !('id' in parsed.message) || !('method' in parsed.message)) return;
      const msg = parsed.message as { id: string | number; method: string; params: unknown };
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
        ws.send(serializeMessage(makeResponse(msg.id, latestToolResponse ?? {
          requestID: 'stub', status: 'success', value: { content: [] },
        })));
      }
    });

    ws.send(serializeMessage(makeRequest('h1', ServerFacingMethod.PerformVersionHandshake, {
      apiVersion: DEFAULT_SERVER_API_VERSION,
      pluginVersion: 'stub',
      environment: 'vitest',
    })));
    await new Promise((r) => setTimeout(r, 100));
    ws.send(serializeMessage(makeRequest('t1', ServerFacingMethod.NotifyAboutUpdatedTools, { tools: [] })));
    ws.send(serializeMessage(makeRequest('p1', ServerFacingMethod.NotifyAboutUpdatedPrompts, { prompts: [] })));
    ws.send(serializeMessage(makeRequest('r1', ServerFacingMethod.NotifyAboutUpdatedResources, { resources: [] })));
    await new Promise((r) => setTimeout(r, 200));
  });

  afterAll(async () => {
    ws?.close();
    await handle.stop();
  });

  async function callTool(body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await fetch(`${baseUrl}/api/tools/scene-save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() as Record<string, unknown> };
  }

  function errorOf(body: Record<string, unknown>): Record<string, unknown> {
    return body['error'] as Record<string, unknown>;
  }

  it('a legacy tool failure carries the plugin message as a non-retryable structured failure', async () => {
    latestToolResponse = {
      requestID: 't-1',
      status: 'error',
      message: 'Cannot run tests: 1 open scene(s) have unsaved changes: Assets/SampleScene.unity.',
    };
    const { status, body } = await callTool({});
    expect(status).toBe(500);
    expect(body['ok']).toBe(false);
    const error = errorOf(body);
    expect(error['code']).toBe('tool_execution_failed');
    expect(error['message']).toBe('Cannot run tests: 1 open scene(s) have unsaved changes: Assets/SampleScene.unity.');
    // A tool-level decision is deterministic: direct retries cannot fix it.
    expect(error['retryable']).toBe(false);
  });

  it('a generic structured error does not shadow the first content diagnostic', async () => {
    latestToolResponse = {
      requestID: 't-2',
      status: 'error',
      message: null,
      value: {
        content: [{ type: 'text', text: '(53,114): error CS0619: SerializedProperty.objectReferenceInstanceIDValue is obsolete' }],
      },
      error: { code: 'tool_execution_failed', message: 'Tool execution failed.', retryable: false },
    };
    const { status, body } = await callTool({});
    expect(status).toBe(500);
    const error = errorOf(body);
    expect(error['code']).toBe('tool_execution_failed');
    expect(error['message']).toContain('CS0619');
    expect(error['retryable']).toBe(false);
  });

  it('a controlled call keeps the structured code but surfaces the content diagnostic', async () => {
    latestToolResponse = {
      requestID: 't-3',
      status: 'error',
      value: {
        content: [{ type: 'text', text: 'Compilation failed: 2 error(s). (27,16): error CS0019: Color32 cannot use !=' }],
      },
      error: { code: 'tool_execution_failed', message: 'Tool execution failed.', retryable: false, callId: 'diag-1' },
    };
    const { status, body } = await callTool({
      arguments: {},
      control: { callId: 'diag-1' },
    });
    expect(status).toBe(500);
    const error = errorOf(body);
    expect(error['code']).toBe('tool_execution_failed');
    expect(error['message']).toContain('CS0019');
    expect(error['retryable']).toBe(false);
    expect(error['callId']).toBe('diag-1');
  });

  it('a structured error with its own message keeps that message', async () => {
    latestToolResponse = {
      requestID: 't-4',
      status: 'error',
      value: { content: [{ type: 'text', text: 'inner detail' }] },
      error: { code: 'validation_failed', message: 'openedSceneName must match an open scene.', retryable: false },
    };
    const { status, body } = await callTool({
      arguments: {},
      control: { callId: 'diag-2' },
    });
    expect(status).toBe(400);
    const error = errorOf(body);
    expect(error['message']).toBe('openedSceneName must match an open scene.');
  });

  it('a tool-not-found failure carries an upgrade hint', async () => {
    latestToolResponse = {
      requestID: 't-5',
      status: 'error',
      message: "Tool with Name 'tests-job-list' not found.",
    };
    const { body } = await callTool({});
    const error = errorOf(body);
    expect(error['message']).toContain('tests-job-list');
    const details = error['details'] as Record<string, unknown>;
    expect(String(details?.['hint'])).toContain('Upgrade the project plugin');
    expect(error['retryable']).toBe(false);
  });

  it('a forwarding failure without a plugin stays transient and retryable', async () => {
    ws.close();
    await new Promise((r) => setTimeout(r, 150));
    const { status, body } = await callTool({});
    expect(status).toBe(500);
    expect(body['ok']).toBe(false);
    const error = errorOf(body);
    expect(error['retryable']).toBe(true);
    expect(error['code']).toBe('http-500');
  });
});
