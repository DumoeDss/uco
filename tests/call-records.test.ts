// COCli-09 durable call records — store bounds/TTL/late-completion semantics
// plus the end-to-end async REST surface (?async=1 → 202 → deferred
// completion updates the record even after the pending tracker settled).

import { afterEach, describe, expect, it, beforeAll, afterAll, vi } from 'vitest';
import WebSocket from 'ws';
import {
  CallRecordStore,
  MAX_CALL_RECORDS,
} from '../src/server/calls/call-record-store.js';
import { createServer, type McpServerHandle } from '../src/server/app.js';
import { DEFAULT_SERVER_API_VERSION, parseServerConfig } from '../src/server/config.js';
import { ClientFacingMethod, ServerFacingMethod } from '../src/server/types.js';
import {
  makeRequest,
  makeResponse,
  serializeMessage,
  parseMessage,
} from '../src/server/ws/envelope.js';

describe('CallRecordStore unit semantics', () => {
  it('settles from a response envelope with bounded preview', () => {
    const store = new CallRecordStore();
    store.begin({ callId: 'c-1', requestId: 't-1', tool: 'script-execute', mode: 'sync' });
    store.markDispatched('c-1', { instanceId: 'inst' });
    store.settleFromResponse('c-1', {
      status: 'success',
      value: { content: [{ type: 'text', text: 'ok '.repeat(600) }] },
    });
    const record = store.get('c-1')!;
    expect(record.state).toBe('succeeded');
    expect(record.identity).toEqual({ instanceId: 'inst' });
    expect(record.resultPreview!.length).toBeLessThanOrEqual(1025);
    expect(record.settledAtUtc).toBeDefined();
  });

  it('maps an error envelope to a failed record with message fallbacks', () => {
    const store = new CallRecordStore();
    store.begin({ callId: 'c-2', requestId: 't-2', tool: 'tests-run', mode: 'sync' });
    store.settleFromResponse('c-2', {
      status: 'error',
      message: null,
      value: { content: [{ type: 'text', text: 'CS0103: Newtonsoft does not exist' }] },
      error: { code: 'tool_execution_failed', message: 'Tool execution failed.', retryable: false },
    });
    const record = store.get('c-2')!;
    expect(record.state).toBe('failed');
    expect(record.error!.code).toBe('tool_execution_failed');
    expect(record.error!.message).toContain('CS0103');
    expect(record.error!.retryable).toBe(false);
  });

  it('a late completion after abandonment flips the record terminal with lateCompletion', () => {
    const store = new CallRecordStore();
    store.begin({ callId: 'c-3', requestId: 't-3', tool: 'script-execute', mode: 'sync' });
    store.settleAbandoned('c-3', 'server-wait-timeout');
    expect(store.get('c-3')!.state).toBe('abandoned');

    store.completeByRequestId('t-3', 'op-9', {
      status: 'success',
      value: { content: [{ type: 'text', text: 'written: 23 clips' }] },
    }, false);
    const record = store.get('c-3')!;
    expect(record.state).toBe('succeeded');
    expect(record.lateCompletion).toBe(true);
    expect(record.operationId).toBe('op-9');
    expect(record.resultPreview).toContain('23 clips');
  });

  it('a late failure notification marks the record failed', () => {
    const store = new CallRecordStore();
    store.begin({ callId: 'c-4', requestId: 't-4', tool: 'tests-run', mode: 'async' });
    store.completeByRequestId('t-4', undefined, {
      status: 'error',
      value: { content: [{ type: 'text', text: 'No tests found matching class X.' }] },
    }, true);
    const record = store.get('c-4')!;
    expect(record.state).toBe('failed');
    expect(record.error!.message).toContain('No tests found');
  });

  it('keeps processing records non-terminal and bounds the record count', () => {
    const store = new CallRecordStore();
    store.begin({ callId: 'c-5', requestId: 't-5', tool: 'tests-run', mode: 'sync' });
    store.settleFromResponse('c-5', { status: 'processing', value: { content: [] } });
    expect(store.get('c-5')!.state).toBe('processing');

    for (let i = 0; i < MAX_CALL_RECORDS + 10; i++) {
      store.begin({ callId: `bulk-${i}`, requestId: `bulk-r-${i}`, tool: 'ping', mode: 'sync' });
    }
    // Insertion-order eviction removes the oldest entries (c-5, bulk-0...)
    // and keeps the newest.
    expect(store.list({ limit: 200 }).length).toBeLessThanOrEqual(MAX_CALL_RECORDS);
    expect(store.get('c-5')).toBeUndefined();
    expect(store.get('bulk-0')).toBeUndefined();
    expect(store.get(`bulk-${MAX_CALL_RECORDS + 9}`)).toBeDefined();
  });

  it('sweeps settled records past the TTL and keeps fresh ones', () => {
    const store = new CallRecordStore();
    store.begin({ callId: 'old-1', requestId: 'old-r-1', tool: 'ping', mode: 'sync' });
    store.settleFromResponse('old-1', { status: 'success', value: { content: [] } });
    const removed = store.sweep(Date.now() + 31 * 60_000);
    expect(removed).toBe(1);
    expect(store.get('old-1')).toBeUndefined();
  });
});

describe('async call records over REST + deferred completions', () => {
  let handle: McpServerHandle;
  let baseUrl: string;
  let ws: WebSocket;
  let calls = 0;
  let deferredReply: 'processing' | 'hang' = 'processing';

  beforeAll(async () => {
    const config = parseServerConfig([
      '--port', '18410',
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
        calls++;
        if (deferredReply === 'processing') {
          ws.send(serializeMessage(makeResponse(msg.id, {
            requestID: 'stub',
            status: 'processing',
            value: { content: [], structuredContent: { result: { operationId: 'op-async-1', status: 'queued' } } },
          })));
        }
        // 'hang': never reply — the server-side wait will exceed the test.
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

  afterEach(() => {
    calls = 0;
  });

  it('answers 202 with the callId and records the deferred failure completion', async () => {
    const res = await fetch(`${baseUrl}/api/tools/scene-save?async=1`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        arguments: {},
        control: { callId: 'async-fail-1' },
      }),
    });
    expect(res.status).toBe(202);
    const accepted = await res.json() as Record<string, unknown>;
    expect(accepted['status']).toBe('processing');
    expect(accepted['callId']).toBe('async-fail-1');
    expect(String(accepted['queryHint'])).toContain('uco call get async-fail-1');

    // The tracker settled on the immediate 'processing'; a late failure
    // completion (the plugin sends NotifyToolRequestCompleted as a request —
    // notifications without an id are dropped by the hub) must still update
    // the record.
    ws.send(serializeMessage(makeRequest('late-1', ServerFacingMethod.NotifyToolRequestCompleted, {
      requestId: accepted['requestId'],
      operationId: 'op-async-1',
      result: {
        status: 'error',
        content: [{ type: 'text', text: 'Cannot run tests: 1 open scene(s) have unsaved changes.' }],
      },
    })));
    await new Promise((r) => setTimeout(r, 150));

    const recordRes = await fetch(`${baseUrl}/api/calls/async-fail-1`);
    expect(recordRes.status).toBe(200);
    const body = await recordRes.json() as { call: Record<string, unknown> };
    expect(body.call['state']).toBe('failed');
    expect(body.call['lateCompletion']).toBe(true);
    expect(body.call['operationId']).toBe('op-async-1');
    const error = body.call['error'] as Record<string, unknown>;
    expect(String(error['message'])).toContain('unsaved changes');
  });

  it('lists records and answers 404 for unknown ids', async () => {
    const listRes = await fetch(`${baseUrl}/api/calls?limit=10&state=failed`);
    expect(listRes.status).toBe(200);
    const body = await listRes.json() as { count: number; calls: { callId: string }[] };
    expect(body.count).toBeGreaterThanOrEqual(1);
    expect(body.calls.some((entry) => entry.callId === 'async-fail-1')).toBe(true);

    const missingRes = await fetch(`${baseUrl}/api/calls/never-existed`);
    expect(missingRes.status).toBe(404);
  });

  it('a sync success response settles the record without lateCompletion', async () => {
    const res = await fetch(`${baseUrl}/api/tools/ping`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ arguments: {}, control: { callId: 'sync-ok-1' } }),
    });
    expect(res.status).toBe(200);
    // 'processing' keeps the record non-terminal.
    const recordRes = await fetch(`${baseUrl}/api/calls/sync-ok-1`);
    const body = await recordRes.json() as { call: Record<string, unknown> };
    expect(body.call['state']).toBe('processing');
    expect(body.call['lateCompletion']).toBeUndefined();
  });
});

describe('uco call get exit mapping', () => {
  it('exits 5 for a failed record, 6 for cancelled, 0 for succeeded', async () => {
    const { buildProgram } = await import('../src/program.js');
    const { RestTransport } = await import('../src/transport/rest.js');
    const record = (state: string): unknown => ({ call: { callId: 'x', state } });

    const run = async (args: string[], getCallImpl: () => Promise<unknown>): Promise<number> => {
      const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
        throw new Error(`exit:${code ?? 0}`);
      }) as never);
      vi.spyOn(RestTransport.prototype, 'getCall').mockImplementation(getCallImpl);
      const program = buildProgram().exitOverride();
      try {
        await program.parseAsync(['node', 'uco', 'call', ...args]);
        return 0;
      } catch (err) {
        const match = /exit:(\d+)/.exec(String(err));
        return match ? Number.parseInt(match[1]!, 10) : -1;
      } finally {
        vi.restoreAllMocks();
        void stdout;
        void stderr;
        void exit;
      }
    };

    expect(await run(['get', 'failed-1', '--json'], () => Promise.resolve(record('failed')))).toBe(5);
    expect(await run(['get', 'cancelled-1', '--json'], () => Promise.resolve(record('cancelled')))).toBe(6);
    expect(await run(['get', 'succeeded-1', '--json'], () => Promise.resolve(record('succeeded')))).toBe(0);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});
