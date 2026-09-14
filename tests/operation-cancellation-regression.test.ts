import { afterEach, describe, expect, it, vi } from 'vitest';
import { normalizeToolCall } from '../src/tool-call-control.js';
import { forwardToPlugin, type ForwardDeps } from '../src/server/rest/forward.js';
import {
  MAX_PENDING_PER_CONNECTION,
  MAX_PENDING_PROCESS,
  PendingTracker,
} from '../src/server/ws/pending.js';
import { ClientFacingMethod } from '../src/server/types.js';

function entry(capabilities: string[] = ['cancel-tool-call-v1']) {
  return {
    connectionId: 'connection-1',
    generation: 7,
    capabilities: new Set(capabilities),
  };
}

function deps(
  pending: PendingTracker,
  sent: Array<{ connectionId: string; request: any }>,
  capabilities?: string[],
): ForwardDeps {
  const connection = entry(capabilities);
  return {
    registry: { resolve: () => connection } as unknown as ForwardDeps['registry'],
    pending,
    hub: {
      sendToConnection: (connectionId: string, request: any) => {
        sent.push({ connectionId, request });
        return true;
      },
    } as unknown as ForwardDeps['hub'],
    pluginTimeoutMs: 100,
  };
}

describe('bounded pending and cancellation propagation', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('sends nothing for an already-aborted call', async () => {
    const pending = new PendingTracker();
    const sent: Array<{ connectionId: string; request: any }> = [];
    const controller = new AbortController();
    controller.abort();
    const normalized = normalizeToolCall({
      name: 'fixture',
      arguments: {},
      requestID: 'request-pre-abort',
      control: { callId: 'call-pre-abort' },
    }, { signal: controller.signal });

    await expect(forwardToPlugin(deps(pending, sent), ClientFacingMethod.RunCallTool,
      normalized.request, {
        signal: controller.signal,
        context: normalized.context,
      })).rejects.toMatchObject({ code: -32003 });
    expect(sent).toHaveLength(0);
    expect(pending.size).toBe(0);
  });

  it('sends at most one same-generation cancel after immediate-call dispatch', async () => {
    const pending = new PendingTracker();
    const sent: Array<{ connectionId: string; request: any }> = [];
    const controller = new AbortController();
    const normalized = normalizeToolCall({
      name: 'fixture',
      arguments: {},
      requestID: 'request-post-abort',
      control: {
        callId: 'call-post-abort',
        cancellationId: 'cancel-post-abort',
      },
    }, { signal: controller.signal });

    const result = forwardToPlugin(deps(pending, sent), ClientFacingMethod.RunCallTool,
      normalized.request, {
        signal: controller.signal,
        deferredRequestID: normalized.request.requestID,
        context: normalized.context,
      });
    controller.abort();
    controller.abort();

    await expect(result).rejects.toMatchObject({ code: -32003 });
    expect(sent.map((item) => item.request.method)).toEqual([
      ClientFacingMethod.RunCallTool,
      ClientFacingMethod.CancelToolCall,
    ]);
    expect(sent[1]!.request.params).toMatchObject({
      requestID: 'request-post-abort',
      callId: 'call-post-abort',
      cancellationId: 'cancel-post-abort',
      generation: 7,
    });
    expect(pending.size).toBe(0);
  });

  it('reports local abort without fabricating propagation for a legacy peer', async () => {
    const pending = new PendingTracker();
    const sent: Array<{ connectionId: string; request: any }> = [];
    const controller = new AbortController();
    const normalized = normalizeToolCall({
      name: 'fixture', arguments: {}, control: { callId: 'legacy-abort' },
    }, { signal: controller.signal });

    const result = forwardToPlugin(deps(pending, sent, []), ClientFacingMethod.RunCallTool,
      normalized.request, { signal: controller.signal, context: normalized.context });
    controller.abort();

    await expect(result).rejects.toMatchObject({ code: -32003 });
    expect(sent.map((item) => item.request.method)).toEqual([ClientFacingMethod.RunCallTool]);
    expect(pending.size).toBe(0);
  });

  it('does not send an implicit cancel after a durable handle has settled', async () => {
    const pending = new PendingTracker();
    const sent: Array<{ connectionId: string; request: any }> = [];
    const controller = new AbortController();
    const normalized = normalizeToolCall({
      name: 'tests-run', arguments: {}, requestID: 'request-durable',
      control: { callId: 'call-durable', cancellationId: 'cancel-durable' },
    }, { signal: controller.signal });
    const forwardDeps = deps(pending, sent);
    (forwardDeps.hub as any).sendToConnection = (connectionId: string, request: any) => {
      sent.push({ connectionId, request });
      if (request.method === ClientFacingMethod.RunCallTool) {
        queueMicrotask(() => pending.resolve(request.id, {
          requestID: 'request-durable',
          status: 'processing',
          value: { structuredContent: { OperationId: 'operation-durable' } },
        }));
      }
      return true;
    };

    await expect(forwardToPlugin(forwardDeps, ClientFacingMethod.RunCallTool,
      normalized.request, {
        signal: controller.signal,
        deferredRequestID: normalized.request.requestID,
        context: normalized.context,
      })).resolves.toMatchObject({ status: 'processing' });
    controller.abort();

    expect(sent.map((item) => item.request.method)).toEqual([ClientFacingMethod.RunCallTool]);
    expect(pending.size).toBe(0);
  });

  it('settles direct/deferred races once and requires unambiguous legacy correlation', async () => {
    const pending = new PendingTracker();
    const first = pending.track('e-1', 1_000, 'RunCallTool', 'c-1', {
      requestID: 'request-race', operationID: 'operation-race',
    });
    expect(pending.resolveDeferred('request-race', { source: 'deferred' }, 'operation-race')).toBe(true);
    expect(pending.resolve('e-1', { source: 'direct' })).toBe(false);
    await expect(first).resolves.toEqual({ source: 'deferred' });

    const introduced = pending.track('e-introduced', 1_000, 'RunCallTool', 'c-1', {
      requestID: 'request-introduced',
    });
    expect(pending.resolveDeferred(
      'request-introduced', { source: 'deferred-with-operation' }, 'operation-introduced',
    )).toBe(true);
    await expect(introduced).resolves.toEqual({ source: 'deferred-with-operation' });

    const a = pending.track('e-2', 1_000, 'RunCallTool', 'c-1', { requestID: 'ambiguous' });
    const b = pending.track('e-3', 1_000, 'RunCallTool', 'c-1', { requestID: 'ambiguous' });
    expect(pending.resolveDeferred('ambiguous', { wrong: true })).toBe(false);
    pending.rejectAllForConnection('c-1', { code: -32000, message: 'disconnect' });
    await expect(a).rejects.toMatchObject({ code: -32000 });
    await expect(b).rejects.toMatchObject({ code: -32000 });
    expect(pending.size).toBe(0);
  });

  it('removes abort listeners and enforces process/per-connection quotas', async () => {
    vi.useFakeTimers();
    const pending = new PendingTracker();
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const listenerPromise = pending.track('listener', 1_000, 'RunCallTool', 'listener-connection', {
      signal: controller.signal,
    });
    pending.resolve('listener', { ok: true });
    await expect(listenerPromise).resolves.toEqual({ ok: true });
    expect(remove).toHaveBeenCalledTimes(1);

    const connectionPromises: Promise<unknown>[] = [];
    for (let index = 0; index < MAX_PENDING_PER_CONNECTION; index++) {
      const promise = pending.track(`connection-${index}`, 60_000, 'RunCallTool', 'bounded');
      promise.catch(() => undefined);
      connectionPromises.push(promise);
    }
    expect(() => pending.track('connection-over', 60_000, 'RunCallTool', 'bounded'))
      .toThrow(expect.objectContaining({ code: -32006 }));
    pending.rejectAllForConnection('bounded', { code: -32000, message: 'cleanup' });
    await Promise.allSettled(connectionPromises);

    const processPromises: Promise<unknown>[] = [];
    for (let index = 0; index < MAX_PENDING_PROCESS; index++) {
      const promise = pending.track(`process-${index}`, 60_000, 'RunCallTool', `c-${index}`);
      promise.catch(() => undefined);
      processPromises.push(promise);
    }
    expect(() => pending.track('process-over', 60_000, 'RunCallTool', 'last'))
      .toThrow(expect.objectContaining({ code: -32006 }));
    for (let index = 0; index < MAX_PENDING_PROCESS; index++) {
      pending.rejectAllForConnection(`c-${index}`, { code: -32000, message: 'cleanup' });
    }
    await Promise.allSettled(processPromises);
    expect(pending.size).toBe(0);
  });
});
