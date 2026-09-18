import { afterEach, describe, expect, it, vi } from 'vitest';
import { RestTransport } from '../src/transport/rest.js';
import { runSystemTool, runTool } from '../src/devops/lib/run-tool.js';
import { toolCallOptionsFromCli } from '../src/util/call-control.js';
import { emitToolCommands } from '../src/codegen/emit.js';
import { forwardToPlugin, type ForwardDeps } from '../src/server/rest/forward.js';
import { PendingTracker } from '../src/server/ws/pending.js';
import {
  ToolCallControlError,
  linkAbortSignals,
  normalizeToolCall,
} from '../src/tool-call-control.js';

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('tool-call control REST transport', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps legacy regular calls as a bare arguments body', async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl: typeof fetch = vi.fn(async (url, init) => {
      requests.push({ url: String(url), init: init! });
      return jsonResponse({ status: 'success', content: [] });
    });
    const transport = new RestTransport({ baseUrl: 'http://127.0.0.1:23456', fetchImpl });

    await transport.callTool('regular-tool', { control: { toolArgument: true }, value: 2 });

    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe('http://127.0.0.1:23456/api/tools/regular-tool');
    expect(JSON.parse(String(requests[0]!.init.body))).toEqual({
      control: { toolArgument: true },
      value: 2,
    });
  });

  it('uses the same controlled wrapper for regular and system calls', async () => {
    const bodies: unknown[] = [];
    const fetchImpl: typeof fetch = vi.fn(async (_url, init) => {
      bodies.push(JSON.parse(String(init!.body)));
      return jsonResponse({ status: 'success', content: [] });
    });
    const transport = new RestTransport({ baseUrl: 'http://127.0.0.1:23456', fetchImpl });

    const options = {
      requestID: 'request-1',
      control: {
        callId: 'call-1',
        correlationId: 'trace-1',
        idempotencyKey: 'opaque-key',
        futureFlag: { enabled: true },
      },
    } as const;
    await transport.callTool('regular-tool', { value: 1 }, options);
    await transport.callSystemTool('system-tool', { value: 2 }, {
      ...options,
      requestID: 'request-2',
    });

    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toEqual({
      arguments: { value: 1 },
      control: {
        version: 1,
        callId: 'call-1',
        correlationId: 'trace-1',
        idempotencyKey: 'opaque-key',
        futureFlag: { enabled: true },
      },
      requestID: 'request-1',
    });
    expect(bodies[1]).toEqual({
      arguments: { value: 2 },
      control: {
        version: 1,
        callId: 'call-1',
        correlationId: 'trace-1',
        idempotencyKey: 'opaque-key',
        futureFlag: { enabled: true },
      },
      requestID: 'request-2',
    });
  });

  it('links independent caller and context signals and cleans up listeners', () => {
    const caller = new AbortController();
    const runtime = new AbortController();
    const callerAdd = vi.spyOn(caller.signal, 'addEventListener');
    const callerRemove = vi.spyOn(caller.signal, 'removeEventListener');
    const runtimeAdd = vi.spyOn(runtime.signal, 'addEventListener');
    const runtimeRemove = vi.spyOn(runtime.signal, 'removeEventListener');
    const linked = linkAbortSignals(caller.signal, runtime.signal);

    expect(linked.signal?.aborted).toBe(false);
    caller.abort();
    expect(linked.signal?.aborted).toBe(true);
    linked.dispose();
    linked.dispose();
    expect(callerAdd).toHaveBeenCalledTimes(1);
    expect(runtimeAdd).toHaveBeenCalledTimes(1);
    expect(callerRemove).toHaveBeenCalledTimes(1);
    expect(runtimeRemove).toHaveBeenCalledTimes(1);
  });

  it('rejects a pre-expired controlled deadline before fetch', async () => {
    const fetchImpl: typeof fetch = vi.fn(async () => jsonResponse({ status: 'success' }));
    const transport = new RestTransport({ baseUrl: 'http://127.0.0.1:23456', fetchImpl });

    await expect(transport.callTool('regular-tool', {}, {
      control: { callId: 'expired-call', deadlineUnixMs: Date.now() - 1 },
    })).rejects.toMatchObject<ToolCallControlError>({
      code: 'deadline_exceeded',
      callId: 'expired-call',
      correlationId: 'expired-call',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('turns a future deadline into a controlled deadline error and aborts fetch', async () => {
    const fetchImpl: typeof fetch = vi.fn(async (_url, init) => new Promise<Response>((_resolve, reject) => {
      const signal = init!.signal!;
      const onAbort = (): void => reject(new DOMException('Aborted', 'AbortError'));
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }));
    const transport = new RestTransport({ baseUrl: 'http://127.0.0.1:23456', fetchImpl });

    await expect(transport.callTool('regular-tool', {}, {
      control: { callId: 'deadline-call', deadlineUnixMs: Date.now() + 25 },
    })).rejects.toMatchObject<ToolCallControlError>({
      code: 'deadline_exceeded',
      callId: 'deadline-call',
      correlationId: 'deadline-call',
    });
  });

  it('maps caller abort to a controlled cancelled error and removes the fetch listener', async () => {
    const caller = new AbortController();
    let observedSignal: AbortSignal | undefined;
    const fetchImpl: typeof fetch = vi.fn(async (_url, init) => new Promise<Response>((_resolve, reject) => {
      observedSignal = init!.signal!;
      const onAbort = (): void => reject(new DOMException('Aborted', 'AbortError'));
      observedSignal.addEventListener('abort', onAbort, { once: true });
    }));
    const transport = new RestTransport({ baseUrl: 'http://127.0.0.1:23456', fetchImpl });
    const pending = transport.callTool('regular-tool', {}, {
      signal: caller.signal,
      control: { callId: 'cancel-call' },
    });
    caller.abort();

    await expect(pending).rejects.toMatchObject<ToolCallControlError>({
      code: 'cancelled',
      callId: 'cancel-call',
      correlationId: 'cancel-call',
    });
    expect(observedSignal?.aborted).toBe(true);
  });

  it('preserves controlled structured errors returned by REST', async () => {
    const fetchImpl: typeof fetch = vi.fn(async () => jsonResponse({
      ok: false,
      error: {
        code: 'middleware_rejected',
        message: 'Rejected by test middleware.',
        retryable: false,
        callId: 'call-rejected',
        correlationId: 'trace-rejected',
        details: { reason: 'test' },
      },
    }, 409));
    const transport = new RestTransport({ baseUrl: 'http://127.0.0.1:23456', fetchImpl });

    await expect(transport.callTool('regular-tool', {}, {
      control: { callId: 'call-rejected', correlationId: 'trace-rejected' },
    })).rejects.toMatchObject<ToolCallControlError>({
      code: 'middleware_rejected',
      callId: 'call-rejected',
      correlationId: 'trace-rejected',
    });
  });

  it('keeps logical control ids stable when a normalized request is serialized again', () => {
    const first = normalizeToolCall({
      name: 'regular-tool',
      arguments: {},
      requestID: 'request-1',
      control: { callId: 'call-1', correlationId: 'trace-1', idempotencyKey: 'opaque-key' },
    });
    const second = normalizeToolCall({
      ...first.request,
      control: first.request.control,
    });

    expect(second.context).toMatchObject({
      requestID: 'request-1',
      callId: 'call-1',
      correlationId: 'trace-1',
      idempotencyKey: 'opaque-key',
    });
  });

  it('forwards the controlled wrapper through library regular and system helpers', async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl: typeof fetch = vi.fn(async (url, init) => {
      requests.push({ url: String(url), init: init! });
      return jsonResponse({ status: 'success', content: [] });
    });

    const regular = await runTool({
      url: 'http://127.0.0.1:23456',
      toolName: 'regular-tool',
      input: { value: 1 },
      requestID: 'request-library',
      control: { callId: 'call-library', correlationId: 'trace-library' },
      fetchImpl,
    });
    const system = await runSystemTool({
      url: 'http://127.0.0.1:23456',
      toolName: 'system-tool',
      input: { value: 2 },
      control: { callId: 'call-system-library', correlationId: 'trace-library' },
      fetchImpl,
    });

    expect(regular.kind).toBe('success');
    expect(system.kind).toBe('success');
    expect(requests.map((entry) => entry.url)).toEqual([
      'http://127.0.0.1:23456/api/tools/regular-tool',
      'http://127.0.0.1:23456/api/system-tools/system-tool',
    ]);
    expect(JSON.parse(String(requests[0]!.init.body))).toMatchObject({
      arguments: { value: 1 },
      control: { version: 1, callId: 'call-library', correlationId: 'trace-library' },
      requestID: 'request-library',
    });
    expect(JSON.parse(String(requests[1]!.init.body))).toMatchObject({
      arguments: { value: 2 },
      control: { version: 1, callId: 'call-system-library', correlationId: 'trace-library' },
    });
  });

  it('builds CLI control options and emits them for generated commands', () => {
    const options = toolCallOptionsFromCli({
      callId: 'cli-call',
      correlationId: 'cli-trace',
      deadlineUnixMs: '1788268800000',
      idempotencyKey: 'cli-key',
    });
    expect(options).toMatchObject({
      control: {
        callId: 'cli-call',
        correlationId: 'cli-trace',
        deadlineUnixMs: 1788268800000,
        idempotencyKey: 'cli-key',
      },
    });

    const generated = emitToolCommands([{
      name: 'generated-tool',
      title: 'Generated Tool',
      description: 'test',
      inputSchema: { type: 'object', properties: {} },
    }]);
    expect(generated).toContain('addToolCallControlOptions(cmd);');
    expect(generated).toContain('toolCallOptionsFromCli(opts)');
  });

  it('does not retry a side-effecting tool call when the retry budget is omitted', async () => {
    vi.useFakeTimers();
    const pending = new PendingTracker();
    const sent: Array<{ id: string | number; params: unknown }> = [];
    const entry = { connectionId: 'connection-no-retry' };
    const deps: ForwardDeps = {
      registry: { resolve: () => entry } as unknown as ForwardDeps['registry'],
      pending,
      hub: {
        sendToConnection: (_connectionId, request) => {
          sent.push({ id: request.id, params: request.params });
          // This deliberately side-effecting call never receives a plugin
          // response, so the forwarding timeout is the only completion path.
          return true;
        },
      } as unknown as ForwardDeps['hub'],
      pluginTimeoutMs: 5,
    };
    const normalized = normalizeToolCall({
      name: 'side-effecting-tool',
      arguments: { value: 1 },
      requestID: 'request-no-retry',
      control: {
        callId: 'call-no-retry',
        correlationId: 'trace-no-retry',
        idempotencyKey: 'opaque-side-effect-key',
      },
    });

    const resultPromise = forwardToPlugin(deps, 'RunCallTool', normalized.request, {
      timeoutMs: 5,
      context: normalized.context,
    });
    const rejection = expect(resultPromise).rejects.toMatchObject({
      code: -32001,
    });
    await vi.advanceTimersByTimeAsync(5);
    await rejection;

    expect(sent).toHaveLength(1);
    expect(sent[0]!.params).toEqual(normalized.request);
    expect(pending.size).toBe(0);
  });

  it('reuses one logical idempotency context across explicit forwarding retries', async () => {
    vi.useFakeTimers();
    const pending = new PendingTracker();
    const sent: Array<{ id: string | number; params: unknown }> = [];
    const entry = { connectionId: 'connection-1' };
    const deps: ForwardDeps = {
      registry: { resolve: () => entry } as unknown as ForwardDeps['registry'],
      pending,
      hub: {
        sendToConnection: (_connectionId, request) => {
          sent.push({ id: request.id, params: request.params });
          if (sent.length === 2) queueMicrotask(() => pending.resolve(request.id, { ok: true }));
          return true;
        },
      } as unknown as ForwardDeps['hub'],
      pluginTimeoutMs: 5,
    };
    const normalized = normalizeToolCall({
      name: 'retryable-tool',
      arguments: {},
      requestID: 'request-retry',
      control: {
        callId: 'call-retry',
        correlationId: 'trace-retry',
        idempotencyKey: 'opaque-retry-key',
      },
    });

    const resultPromise = forwardToPlugin(deps, 'RunCallTool', normalized.request, {
      timeoutMs: 5,
      maxRetries: 1,
      retrySafeRead: true,
      deferredRequestID: normalized.request.requestID,
      context: normalized.context,
    });
    await vi.advanceTimersByTimeAsync(1_005);
    await expect(resultPromise).resolves.toEqual({ ok: true });

    expect(sent).toHaveLength(2);
    expect(sent[0]!.id).not.toBe(sent[1]!.id);
    expect(sent.map((request) => request.params)).toEqual([
      normalized.request,
      normalized.request,
    ]);
    const forwardedRequests = sent.map((request) => request.params as {
      requestID: string;
      control?: {
        callId?: string;
        correlationId?: string;
        idempotencyKey?: string;
      };
    });
    expect(forwardedRequests.map((request) => request.requestID)).toEqual([
      'request-retry',
      'request-retry',
    ]);
    expect(forwardedRequests.map((request) => request.control)).toEqual([
      {
        version: 1,
        callId: 'call-retry',
        correlationId: 'trace-retry',
        idempotencyKey: 'opaque-retry-key',
      },
      {
        version: 1,
        callId: 'call-retry',
        correlationId: 'trace-retry',
        idempotencyKey: 'opaque-retry-key',
      },
    ]);
    expect(pending.size).toBe(0);
  });

  it('bounds an explicit retry delay by the absolute deadline', async () => {
    vi.useFakeTimers();
    const pending = new PendingTracker();
    const entry = { connectionId: 'connection-deadline' };
    const deps: ForwardDeps = {
      registry: { resolve: () => entry } as unknown as ForwardDeps['registry'],
      pending,
      hub: {
        sendToConnection: () => true,
      } as unknown as ForwardDeps['hub'],
      pluginTimeoutMs: 100,
    };
    const deadlineUnixMs = Date.now() + 25;
    const normalized = normalizeToolCall({
      name: 'deadline-retry-tool',
      arguments: {},
      control: {
        callId: 'call-deadline-retry',
        correlationId: 'trace-deadline-retry',
        deadlineUnixMs,
      },
    });

    const resultPromise = forwardToPlugin(deps, 'RunCallTool', normalized.request, {
      timeoutMs: 100,
      maxRetries: 1,
      deadlineUnixMs,
      context: normalized.context,
    });

    const rejection = expect(resultPromise).rejects.toMatchObject({
      code: -32004,
      data: {
        code: 'deadline_exceeded',
        callId: 'call-deadline-retry',
        correlationId: 'trace-deadline-retry',
      },
    });
    await vi.advanceTimersByTimeAsync(25);
    await rejection;
    expect(pending.size).toBe(0);
  });
});
