/**
 * Bounded pending request correlation. Unity owns durable operations; every map
 * here is ephemeral and is removed by one atomic settle path.
 */

import type { RpcError } from './envelope.js';
import { ErrorCode } from './envelope.js';

export const MAX_PENDING_PROCESS = 1024;
export const MAX_PENDING_PER_CONNECTION = 256;

interface PendingEntry {
  id: string | number;
  resolve: (result: unknown) => void;
  reject: (error: RpcError) => void;
  timer: ReturnType<typeof setTimeout>;
  requestID?: string;
  operationID?: string;
  callId?: string;
  cancellationId?: string;
  method: string;
  connectionId?: string;
  generation?: number;
  signal?: AbortSignal;
  onAbort?: () => void;
  onAbortAfterDispatch?: (entry: PendingIdentity) => void;
  onResolved?: (result: unknown, entry: PendingIdentity) => void;
  dispatched: boolean;
  cancellationSent: boolean;
}

export interface PendingIdentity {
  envelopeId: string | number;
  requestID?: string;
  operationID?: string;
  callId?: string;
  cancellationId?: string;
  connectionId?: string;
  generation?: number;
}

export interface PendingTrackOptions {
  signal?: AbortSignal;
  timeoutError?: RpcError;
  abortError?: RpcError;
  requestID?: string;
  operationID?: string;
  callId?: string;
  cancellationId?: string;
  generation?: number;
  onAbortAfterDispatch?: (entry: PendingIdentity) => void;
  onResolved?: (result: unknown, entry: PendingIdentity) => void;
}

type Settlement =
  | { type: 'resolve'; result: unknown }
  | { type: 'reject'; error: RpcError };

export class PendingTracker {
  private readonly byEnvelopeId = new Map<string | number, PendingEntry>();
  private readonly byRequestID = new Map<string, Set<string | number>>();
  private readonly byOperationID = new Map<string, Set<string | number>>();
  private readonly byConnection = new Map<string, Set<string | number>>();

  track(
    id: string | number,
    timeoutMs: number,
    method: string,
    connectionId?: string,
    options?: PendingTrackOptions | AbortSignal,
  ): Promise<unknown> {
    const trackOptions: PendingTrackOptions = isAbortSignal(options)
      ? { signal: options }
      : (options ?? {});

    if (this.byEnvelopeId.has(id)) {
      throw capacityError('Duplicate pending envelope identity.');
    }
    if (this.byEnvelopeId.size >= MAX_PENDING_PROCESS) {
      throw capacityError('Process pending request capacity is full.');
    }
    if (connectionId && (this.byConnection.get(connectionId)?.size ?? 0) >= MAX_PENDING_PER_CONNECTION) {
      throw capacityError('Connection pending request capacity is full.');
    }

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.settle(id, {
          type: 'reject',
          error: trackOptions.timeoutError ?? {
            code: ErrorCode.PLUGIN_TIMEOUT,
            message: `Plugin timed out after ${timeoutMs}ms for method '${method}'`,
          },
        });
      }, timeoutMs);

      const entry: PendingEntry = {
        id,
        resolve: resolve as (result: unknown) => void,
        reject: reject as (error: RpcError) => void,
        timer,
        method,
        connectionId,
        requestID: boundIdentity(trackOptions.requestID),
        operationID: boundIdentity(trackOptions.operationID),
        callId: boundIdentity(trackOptions.callId),
        cancellationId: boundIdentity(trackOptions.cancellationId),
        generation: trackOptions.generation,
        signal: trackOptions.signal,
        onAbortAfterDispatch: trackOptions.onAbortAfterDispatch,
        onResolved: trackOptions.onResolved,
        dispatched: false,
        cancellationSent: false,
      };
      this.byEnvelopeId.set(id, entry);
      this.addIndex(this.byConnection, connectionId, id);
      this.addIndex(this.byRequestID, entry.requestID, id);
      this.addIndex(this.byOperationID, entry.operationID, id);

      if (trackOptions.signal) {
        const onAbort = (): void => {
          const current = this.byEnvelopeId.get(id);
          if (!current) return;
          if (current.dispatched && !current.cancellationSent && current.onAbortAfterDispatch) {
            current.cancellationSent = true;
            current.onAbortAfterDispatch(identity(current));
          }
          this.settle(id, {
            type: 'reject',
            error: trackOptions.abortError ?? {
              code: ErrorCode.CALL_CANCELLED,
              message: 'Tool call was cancelled by the caller.',
            },
          });
        };
        entry.onAbort = onAbort;
        if (trackOptions.signal.aborted) onAbort();
        else trackOptions.signal.addEventListener('abort', onAbort, { once: true });
      }
    });
  }

  markDispatched(id: string | number): boolean {
    const entry = this.byEnvelopeId.get(id);
    if (!entry) return false;
    entry.dispatched = true;
    return true;
  }

  trackDeferred(
    requestID: string,
    envelopeId: string | number,
    operationID?: string,
  ): void {
    const entry = this.byEnvelopeId.get(envelopeId);
    if (!entry) return;
    const nextRequest = boundIdentity(requestID);
    const nextOperation = boundIdentity(operationID);
    if (entry.requestID !== nextRequest) {
      this.removeIndex(this.byRequestID, entry.requestID, envelopeId);
      entry.requestID = nextRequest;
      this.addIndex(this.byRequestID, entry.requestID, envelopeId);
    }
    if (entry.operationID !== nextOperation) {
      this.removeIndex(this.byOperationID, entry.operationID, envelopeId);
      entry.operationID = nextOperation;
      this.addIndex(this.byOperationID, entry.operationID, envelopeId);
    }
  }

  resolve(id: string | number, result: unknown): boolean {
    return this.settle(id, { type: 'resolve', result });
  }

  bindOperation(id: string | number, operationID: string): boolean {
    const entry = this.byEnvelopeId.get(id);
    const bounded = boundIdentity(operationID);
    if (!entry || !bounded) return false;
    if (entry.operationID === bounded) return true;
    this.removeIndex(this.byOperationID, entry.operationID, id);
    entry.operationID = bounded;
    this.addIndex(this.byOperationID, bounded, id);
    return true;
  }

  resolveDeferred(
    requestID: string,
    result: unknown,
    operationID?: string,
  ): boolean {
    const requestMatches = this.byRequestID.get(requestID);
    let candidates = requestMatches ? [...requestMatches] : [];
    if (operationID) {
      candidates = candidates.filter((id) => {
        const entry = this.byEnvelopeId.get(id);
        return entry !== undefined
          && (entry.operationID === undefined || entry.operationID === operationID);
      });
    }
    // Request-only legacy completion is accepted only when it maps uniquely.
    // A new peer may introduce operation identity on this completion; bind it
    // atomically only after the request mapping itself is unambiguous.
    if (candidates.length !== 1) return false;
    const entry = this.byEnvelopeId.get(candidates[0]!);
    if (!entry) return false;
    if (operationID) {
      if (entry.operationID && entry.operationID !== operationID) return false;
      if (!entry.operationID) this.bindOperation(entry.id, operationID);
    }
    return this.resolve(entry.id, result);
  }

  reject(id: string | number, error: RpcError): boolean {
    return this.settle(id, { type: 'reject', error });
  }

  rejectAllForConnection(connectionId: string, error: RpcError): void {
    const ids = [...(this.byConnection.get(connectionId) ?? [])];
    for (const id of ids) this.reject(id, error);
  }

  get size(): number {
    return this.byEnvelopeId.size;
  }

  private settle(id: string | number, settlement: Settlement): boolean {
    const entry = this.removeEntry(id);
    if (!entry) return false;
    if (settlement.type === 'resolve') {
      try { entry.onResolved?.(settlement.result, identity(entry)); }
      catch { /* observational cache hooks must never block settlement */ }
      entry.resolve(settlement.result);
    } else {
      entry.reject(settlement.error);
    }
    return true;
  }

  private removeEntry(id: string | number): PendingEntry | undefined {
    const entry = this.byEnvelopeId.get(id);
    if (!entry) return undefined;
    this.byEnvelopeId.delete(id);
    clearTimeout(entry.timer);
    if (entry.signal && entry.onAbort) entry.signal.removeEventListener('abort', entry.onAbort);
    this.removeIndex(this.byRequestID, entry.requestID, id);
    this.removeIndex(this.byOperationID, entry.operationID, id);
    this.removeIndex(this.byConnection, entry.connectionId, id);
    return entry;
  }

  private addIndex(
    index: Map<string, Set<string | number>>,
    key: string | undefined,
    id: string | number,
  ): void {
    if (!key) return;
    let values = index.get(key);
    if (!values) {
      values = new Set();
      index.set(key, values);
    }
    values.add(id);
  }

  private removeIndex(
    index: Map<string, Set<string | number>>,
    key: string | undefined,
    id: string | number,
  ): void {
    if (!key) return;
    const values = index.get(key);
    if (!values) return;
    values.delete(id);
    if (values.size === 0) index.delete(key);
  }
}

function identity(entry: PendingEntry): PendingIdentity {
  return {
    envelopeId: entry.id,
    requestID: entry.requestID,
    operationID: entry.operationID,
    callId: entry.callId,
    cancellationId: entry.cancellationId,
    connectionId: entry.connectionId,
    generation: entry.generation,
  };
}

function capacityError(message: string): RpcError {
  return {
    code: ErrorCode.PENDING_CAPACITY_EXCEEDED,
    message,
    data: {
      code: 'operation_capacity_exceeded',
      message,
      retryable: true,
      details: { retryAfterMs: 250 },
    },
  };
}

function boundIdentity(value: string | undefined): string | undefined {
  if (!value?.trim()) return undefined;
  const trimmed = value.trim();
  return trimmed.length <= 160 ? trimmed : trimmed.slice(0, 160);
}

function isAbortSignal(value: PendingTrackOptions | AbortSignal | undefined): value is AbortSignal {
  return value !== undefined && typeof value === 'object'
    && 'aborted' in value && 'addEventListener' in value;
}
