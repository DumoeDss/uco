/**
 * REST→WebSocket forwarding helper.
 *
 * Sends an RPC request to the connected plugin over WebSocket and awaits the
 * response via the pending tracker, with retry and deferred-completion support.
 *
 * @see design.md §D5 for the forwarding model.
 */

import type { ConnectionEntry, ConnectionRegistry } from '../ws/registry.js';
import type { PendingTracker } from '../ws/pending.js';
import {
  extractDurableOperationId,
  makeRequest,
  type RpcError,
} from '../ws/envelope.js';
import { ErrorCode } from '../ws/envelope.js';
import {
  DEFAULT_PLUGIN_TIMEOUT_MS,
  TOOL_CALL_TIMEOUT_MS,
  MAX_RETRIES,
  RETRY_DELAY_MS,
  ClientFacingMethod,
} from '../types.js';
import type { PluginHub } from '../ws/hub.js';
import {
  createToolCallError,
  linkAbortSignals,
  type ToolCallContext,
  type ToolCallStructuredError,
} from '../../tool-call-control.js';

export interface ForwardOptions {
  /** The active session's instanceId pin (takes priority for routing). */
  instanceId?: string | null;
  /** Auth token for token-based routing. */
  token?: string | null;
  /** Timeout in ms (default 10s; 5min for tool calls). */
  timeoutMs?: number;
  /** Enable deferred completion (for RunCallTool / RunSystemTool). */
  deferredRequestID?: string;
  /** Override max retries (default 0). Honored only for an explicitly safe read. */
  maxRetries?: number;
  /** Explicit safe-read classification required before any forwarding retry. */
  retrySafeRead?: boolean;
  /** Caller cancellation signal for the local forwarding wait. */
  signal?: AbortSignal;
  /** Absolute deadline to bound every forwarding attempt. */
  deadlineUnixMs?: number;
  /** Normalized logical context used for controlled error correlation. */
  context?: ToolCallContext;
  /**
   * Invoked with the connection entry whose response is being returned — the
   * Editor identity that actually served the call. REST handlers use it to
   * echo the served-identity tuple on matched constrained calls (COCli-01).
   */
  onServed?: (entry: ConnectionEntry) => void;
  /**
   * Invoked synchronously once the request has actually been sent to the
   * plugin connection (COCli-09). Async REST callers wait for this before
   * answering 202; pre-dispatch failures never fire it.
   */
  onDispatched?: () => void;
}

export interface ForwardDeps {
  registry: ConnectionRegistry;
  pending: PendingTracker;
  hub: PluginHub;
  pluginTimeoutMs: number;
}

let forwardIdCounter = 0;

/**
 * Forward an RPC call to the connected plugin and await the response.
 *
 * Retry behavior is opt-in. Automatic retries are disabled by default because tool calls
 * can have side effects and because retrying would multiply the configured timeout.
 */
export async function forwardToPlugin(
  deps: ForwardDeps,
  method: string,
  params: unknown,
  opts?: ForwardOptions,
): Promise<unknown> {
  const { registry, pending, hub } = deps;
  const maxRetries = opts?.retrySafeRead === true
    ? (opts.maxRetries ?? MAX_RETRIES)
    : 0;
  const linkedSignals = linkAbortSignals(opts?.signal, opts?.context?.signal);
  const callerSignal = linkedSignals.signal;
  try {
    const isToolCall = method === ClientFacingMethod.RunCallTool
      || method === ClientFacingMethod.RunSystemTool;
    // Preserve the historical five-minute budget for tool calls unless the
    // caller explicitly supplies a timeout. Ordinary RPCs continue to use the
    // server's configured plugin timeout.
    const configuredTimeout = opts?.timeoutMs
      ?? (isToolCall
        ? TOOL_CALL_TIMEOUT_MS
        : (deps.pluginTimeoutMs ?? DEFAULT_PLUGIN_TIMEOUT_MS));
    const deadlineUnixMs = opts?.deadlineUnixMs ?? opts?.context?.deadlineUnixMs;
    if (callerSignal?.aborted) throw cancelledRpcError(opts?.context);
    if (deadlineUnixMs !== undefined && deadlineUnixMs <= Date.now()) {
      throw deadlineRpcError(opts?.context);
    }

    let lastError: RpcError | null = null;
    // Identity of the eligible connection that served the first attempt. A
    // retry must never forward under a different generation than the original
    // authority, so every later attempt is guarded against these.
    let pinnedConnectionId: string | undefined;
    let pinnedGeneration: number | undefined;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (callerSignal?.aborted) throw cancelledRpcError(opts?.context);
      const remainingMs = deadlineUnixMs === undefined
        ? configuredTimeout
        : Math.min(configuredTimeout, deadlineUnixMs - Date.now());
      if (remainingMs <= 0) throw deadlineRpcError(opts?.context);

      const entry = registry.resolve({
        instanceId: opts?.instanceId,
        token: opts?.token,
      });

      if (!entry) {
        lastError = {
          code: ErrorCode.PLUGIN_NOT_CONNECTED,
          message: 'No eligible plugin connection available (compatible handshake and tool registration required).',
        };
        // There is no destination to retry. A later REST request can use a
        // connection once Unity has reconnected; holding this one open only
        // turns a definitive state into an avoidable multi-second stall.
        break;
      }

      if (attempt === 0) {
        pinnedConnectionId = entry.connectionId;
        pinnedGeneration = entry.generation;
      } else if (entry.connectionId !== pinnedConnectionId
        || entry.generation !== pinnedGeneration) {
        // The eligible connection changed between attempts. Retrying on the
        // new generation would replay this call under the original authority
        // across a generation boundary; surface the original failure instead.
        break;
      }

      // Caller-asserted identity constraints are evaluated after connection
      // resolution and before anything is forwarded: the wrong Editor must
      // never receive the request, and an unavailable member must never pass.
      enforceIdentityConstraints(entry, opts?.context);

      const envelopeId = `r-${++forwardIdCounter}`;
      const req = makeRequest(envelopeId, method, params);

      // Start tracking the response.
      const responsePromise = pending.track(envelopeId, remainingMs, method, entry.connectionId, {
        signal: callerSignal,
        abortError: cancelledRpcError(opts?.context),
        requestID: opts?.deferredRequestID ?? opts?.context?.requestID,
        callId: opts?.context?.callId,
        cancellationId: opts?.context?.cancellationId,
        generation: entry.generation,
        onResolved: isToolCall && method === ClientFacingMethod.RunCallTool
          ? (result) => {
              const readiness = extractEditorReadiness(result);
              if (readiness) registry.updateEditorReadiness(entry.connectionId, readiness);
              if (extractDurableOperationId(result))
                registry.noteDurableOperationAccepted(entry.connectionId);
            }
          : undefined,
        onAbortAfterDispatch: isToolCall && entry.capabilities?.has('cancel-tool-call-v1') === true
          ? (identity) => {
              hub.sendToConnection(entry.connectionId, makeRequest(
                `cancel-${++forwardIdCounter}`,
                ClientFacingMethod.CancelToolCall,
                {
                  requestID: identity.requestID ?? '',
                  callId: identity.callId ?? '',
                  cancellationId: identity.cancellationId ?? '',
                  generation: entry.generation ?? 0,
                  reason: 'caller-aborted-in-flight-immediate-call',
                },
              ));
            }
          : undefined,
        // A regular plugin timeout remains a transport timeout when it fires
        // before the absolute deadline. Only map the tracker timeout to a
        // deadline error when that deadline is the controlling bound.
        timeoutError: deadlineUnixMs !== undefined
          && deadlineUnixMs - Date.now() <= configuredTimeout
          ? deadlineRpcError(opts?.context)
          : undefined,
      });
      if (callerSignal?.aborted) {
        return await responsePromise;
      }
      if (opts?.deferredRequestID) {
        pending.trackDeferred(opts.deferredRequestID, envelopeId);
      }

      // Send the RPC to the plugin. No await occurs between the final abort
      // check and this synchronous send decision, so pre-dispatch abort is zero-send.
      const sent = hub.sendToConnection(entry.connectionId, req);
      if (sent) {
        pending.markDispatched(envelopeId);
        // COCli-09: async REST callers wait only for dispatch (202) while the
        // forward promise keeps updating the durable call record in the
        // background.
        opts?.onDispatched?.();
      }
      if (!sent) {
        pending.reject(envelopeId, {
          code: ErrorCode.PLUGIN_NOT_CONNECTED,
          message: 'Failed to send to plugin (connection not open).',
        });
        lastError = {
          code: ErrorCode.PLUGIN_NOT_CONNECTED,
          message: 'Failed to send to plugin.',
        };
        if (attempt < maxRetries) {
          const delayMs = deadlineUnixMs === undefined
            ? RETRY_DELAY_MS
            : Math.min(RETRY_DELAY_MS, Math.max(0, deadlineUnixMs - Date.now()));
          if (delayMs <= 0) throw deadlineRpcError(opts?.context);
          const completed = await delay(delayMs, callerSignal);
          if (!completed) {
            if (callerSignal?.aborted) throw cancelledRpcError(opts?.context);
            throw deadlineRpcError(opts?.context);
          }
          continue;
        }
        break;
      }

      try {
        const result = await responsePromise;
        opts?.onServed?.(entry);
        return result;
      } catch (err: unknown) {
        lastError = err as RpcError;
        if (isControlError(lastError)) throw lastError;
        if (attempt < maxRetries) {
          const delayMs = deadlineUnixMs === undefined
            ? RETRY_DELAY_MS
            : Math.min(RETRY_DELAY_MS, Math.max(0, deadlineUnixMs - Date.now()));
          if (delayMs <= 0) throw deadlineRpcError(opts?.context);
          const completed = await delay(delayMs, callerSignal);
          if (!completed) {
            if (callerSignal?.aborted) throw cancelledRpcError(opts?.context);
            throw deadlineRpcError(opts?.context);
          }
          continue;
        }
        break;
      }
    }

    throw lastError ?? { code: ErrorCode.INTERNAL_ERROR, message: 'Forwarding failed for unknown reason.' };
  } finally {
    linkedSignals.dispose();
  }
}

/** Generate a unique requestID for tool calls (used in deferred completion). */
export function generateRequestID(): string {
  return `t-${++forwardIdCounter}`;
}

function delay(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    let settled = false;
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve(false);
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      resolve(true);
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function cancelledRpcError(context?: ToolCallContext): RpcError {
  return {
    code: ErrorCode.CALL_CANCELLED,
    message: 'Tool call was cancelled by the caller.',
    data: createToolCallError('cancelled', {
      callId: context?.callId,
      correlationId: context?.correlationId,
    }),
  };
}

function deadlineRpcError(context?: ToolCallContext): RpcError {
  return {
    code: ErrorCode.CALL_DEADLINE_EXCEEDED,
    message: 'Tool call deadline expired.',
    data: createToolCallError('deadline_exceeded', {
      callId: context?.callId,
      correlationId: context?.correlationId,
    }),
  };
}

interface IdentityViolation {
  field: string;
  expected: unknown;
  observed: unknown;
}

/**
 * Evaluate caller-asserted identity constraints against the resolved
 * connection's handshake identity. Paths compare case-insensitively on
 * Windows; instance ids and PIDs compare exactly. Throws the structured,
 * non-retryable rejection the CLI/REST surfaces translate into their
 * identity-mismatch / identity-unavailable error codes.
 */
function enforceIdentityConstraints(
  entry: ConnectionEntry,
  context?: ToolCallContext,
): void {
  const constraints = context?.identity;
  if (constraints === undefined) return;

  const violations: IdentityViolation[] = [];
  const unavailable: string[] = [];
  const identity = entry.identity;
  if (constraints.instanceId !== undefined) {
    const reported = entry.instanceId;
    if (reported === undefined || reported === null) {
      unavailable.push('expectedInstanceId');
    } else if (reported !== constraints.instanceId) {
      violations.push({ field: 'expectedInstanceId', expected: constraints.instanceId, observed: reported });
    }
  }
  if (constraints.projectPath !== undefined) {
    const reported = identity?.projectPath;
    if (reported === undefined) {
      unavailable.push('expectedProjectPath');
    } else if (!pathsEqual(constraints.projectPath, reported)) {
      violations.push({ field: 'expectedProjectPath', expected: constraints.projectPath, observed: reported });
    }
  }
  if (constraints.pid !== undefined) {
    const reported = identity?.editorPid;
    if (reported === undefined) {
      unavailable.push('expectedPid');
    } else if (reported !== constraints.pid) {
      violations.push({ field: 'expectedPid', expected: constraints.pid, observed: reported });
    }
  }

  if (violations.length === 0 && unavailable.length === 0) return;

  const observedTuple = identityTuple(entry);
  if (unavailable.length > 0) {
    throw {
      code: ErrorCode.MIDDLEWARE_REJECTED,
      message: `Connection ${entry.connectionId} did not report the asserted identity member(s): ${unavailable.join(', ')}. ` +
        'A reachable server or successful ping never satisfies an identity constraint.',
      data: createToolCallError('identity_unavailable', {
        callId: context?.callId,
        correlationId: context?.correlationId,
        details: {
          unavailable,
          observed: observedTuple,
        },
      }),
    } satisfies RpcError;
  }

  throw {
    code: ErrorCode.MIDDLEWARE_REJECTED,
    message: `Routed Editor does not match the asserted identity constraints: ${violations
      .map((violation) => `${violation.field} expected ${JSON.stringify(violation.expected)}, observed ${JSON.stringify(violation.observed)}`)
      .join('; ')}.`,
    data: createToolCallError('identity_mismatch', {
      callId: context?.callId,
      correlationId: context?.correlationId,
      details: {
        violations,
        observed: observedTuple,
      },
    }),
  } satisfies RpcError;
}

/**
 * The connection's full Editor identity tuple (bridge-identity-v1) — the same
 * members the mismatch/unavailable errors report as `observed`, the readiness
 * health connection block exposes, and a matched constrained call echoes as
 * its `servedBy` tuple.
 */
export function identityTuple(entry: ConnectionEntry): Record<string, unknown> {
  return {
    instanceId: entry.instanceId ?? null,
    projectPath: entry.identity?.projectPath ?? null,
    editorPid: entry.identity?.editorPid ?? null,
    unityVersion: entry.identity?.unityVersion ?? null,
    generation: entry.generation,
  };
}

function pathsEqual(expected: string, observed: string): boolean {
  if (expected === observed) return true;
  if (process.platform !== 'win32') return false;
  return expected.toLowerCase() === observed.toLowerCase();
}

function extractEditorReadiness(value: unknown): unknown | undefined {
  const queue: unknown[] = [value];
  const seen = new Set<object>();
  for (let index = 0; index < queue.length && index < 32; index++) {
    const current = queue[index];
    if (!current || typeof current !== 'object' || Array.isArray(current)) continue;
    if (seen.has(current)) continue;
    seen.add(current);
    const record = current as Record<string, unknown>;
    const readiness = record['readiness'] ?? record['Readiness'];
    if (readiness && typeof readiness === 'object' && !Array.isArray(readiness))
      return readiness;
    for (const key of ['value', 'structuredContent', 'structured', 'result']) {
      if (record[key] !== undefined) queue.push(record[key]);
    }
  }
  return undefined;
}

function isControlAbortError(error: RpcError): boolean {
  const data = error.data as Partial<ToolCallStructuredError> | undefined;
  return data?.code === 'cancelled'
    || data?.code === 'deadline_exceeded'
    || error.code === ErrorCode.CALL_CANCELLED
    || error.code === ErrorCode.CALL_DEADLINE_EXCEEDED;
}

function isControlError(error: RpcError): boolean {
  const data = error.data as Partial<ToolCallStructuredError> | undefined;
  return isControlAbortError(error)
    || data?.code === 'invalid_control'
    || data?.code === 'unsupported_control_version'
    || data?.code === 'middleware_rejected'
    || data?.code === 'tool_execution_failed'
    || data?.code === 'validation_failed'
    || data?.code === 'confirmation_required'
    || data?.code === 'confirmation_invalid'
    || data?.code === 'confirmation_expired'
    || data?.code === 'confirmation_stale'
    || data?.code === 'dry_run_unsupported'
    || data?.code === 'path_policy_violation'
    || data?.code === 'safety_unsupported'
    || data?.code === 'undo_unavailable'
    || data?.code === 'authoring_transaction_failed'
    || data?.code === 'editor_not_ready'
    || data?.code === 'editor_settling'
    || data?.code === 'operation_capacity_exceeded'
    || data?.code === 'operation_not_found'
    || data?.code === 'operation_owner_missing'
    || data?.code === 'operation_interrupted'
    || data?.code === 'cancellation_unavailable'
    || data?.code === 'scheduling_metadata_invalid'
    || data?.code === 'identity_mismatch'
    || data?.code === 'identity_unavailable';
}
