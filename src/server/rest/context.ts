/**
 * Shared REST handler context — carries all server dependencies
 * needed by route handlers.
 */

import type { ConnectionRegistry } from '../ws/registry.js';
import type { PendingTracker } from '../ws/pending.js';
import type { PluginHub } from '../ws/hub.js';
import type { SessionStateStore } from '../session/store.js';
import type { CallRecordStore } from '../calls/call-record-store.js';
import type { OwnedServerRuntime } from '../app.js';
import {
  ToolCallControlError,
  type ToolCallContext,
  type ToolCallStructuredError,
} from '../../tool-call-control.js';
import type { RpcError } from '../ws/envelope.js';

export interface RestContext {
  registry: ConnectionRegistry;
  pending: PendingTracker;
  hub: PluginHub;
  sessionStore: SessionStateStore;
  /** Bounded durable call records (COCli-09); queryable after a timeout. */
  callRecords: CallRecordStore;
  pluginTimeoutMs: number;
  authToken?: string;
  ownedRuntime?: OwnedServerRuntime;
}

/** Helper to send a JSON response with the correct content type. */
export function sendJson(res: import('node:http').ServerResponse, statusCode: number, body: unknown): void {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(normalizeHttpBody(statusCode, body)));
}

export function sendError(
  res: import('node:http').ServerResponse,
  statusCode: number,
  code: string,
  message: string,
  retryable = statusCode >= 500,
  details?: unknown,
): void {
  sendJson(res, statusCode, {
    ok: false,
    error: { code, message, retryable, ...(details === undefined ? {} : { details }) },
  });
}

function normalizeHttpBody(statusCode: number, body: unknown): unknown {
  if (statusCode < 400 || body === null || typeof body !== 'object' || Array.isArray(body)) return body;
  const record = body as Record<string, unknown>;
  if (record['ok'] === false && record['error'] && typeof record['error'] === 'object') return body;
  if (typeof record['error'] !== 'string') return body;
  return {
    ok: false,
    error: {
      code: `http-${statusCode}`,
      message: record['error'],
      // A handler may classify its failure explicitly (e.g. a tool-level
      // execution failure is never transient); only fall back to the
      // mechanical 5xx-is-retryable rule when it did not.
      retryable: typeof record['retryable'] === 'boolean' ? record['retryable'] : statusCode >= 500,
      ...(Object.keys(record).length > 1 ? { details: record } : {}),
    },
  };
}

/** Whether a REST body is the explicit `{ arguments, control }` form. */
export function isExplicitToolCallWrapper(body: unknown): boolean {
  if (!isRecord(body)) return false;
  // Once both wrapper members are present, treat the body as controlled so a
  // malformed control cannot be reinterpreted as a legacy tool argument.
  // A legacy body containing only `control` remains untouched.
  return hasOwn(body, 'arguments') && hasOwn(body, 'control');
}

/**
 * Send a stable controlled-call error. Legacy route failures continue to use
 * the existing string-oriented `{ error: string }` path in their handlers.
 */
export function sendStructuredToolCallError(
  res: import('node:http').ServerResponse,
  error: unknown,
  context?: Pick<ToolCallContext, 'callId' | 'correlationId'>,
  fallback: Partial<ToolCallStructuredError> = {},
): void {
  const structured = structuredToolCallError(error, context, fallback);
  sendJson(res, toolCallErrorStatus(structured.code), { ok: false, error: structured });
}

/** Build an abort signal that follows a REST caller while it is in flight. */
export function createRestRequestSignal(
  req: import('node:http').IncomingMessage,
  res: import('node:http').ServerResponse,
): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const abortIfOpen = (): void => {
    if (!res.writableFinished) controller.abort();
  };
  const onRequestAbort = (): void => controller.abort();
  const onRequestClose = (): void => {
    if (!req.complete) controller.abort();
  };
  req.on('aborted', onRequestAbort);
  req.on('close', onRequestClose);
  res.on('close', abortIfOpen);
  return {
    signal: controller.signal,
    dispose: (): void => {
      req.off('aborted', onRequestAbort);
      req.off('close', onRequestClose);
      res.off('close', abortIfOpen);
    },
  };
}

function structuredToolCallError(
  error: unknown,
  context?: Pick<ToolCallContext, 'callId' | 'correlationId'>,
  fallback: Partial<ToolCallStructuredError> = {},
): ToolCallStructuredError {
  const candidate = error instanceof ToolCallControlError
    ? error.toStructuredError()
    : error && typeof error === 'object' && 'data' in error
      ? (error as RpcError).data
      : error;
  // A structured error normally carries a stable `code`; a bare record with
  // an actionable `message` (e.g. a merged diagnostic without a code) is
  // accepted for the message while the code falls back to the default.
  const value = isRecord(candidate)
    && (typeof candidate.code === 'string'
      || (typeof candidate.message === 'string' && candidate.message.trim().length > 0))
    ? candidate as Partial<ToolCallStructuredError>
    : undefined;
  const code = value?.code ?? fallback.code ?? 'tool_execution_failed';
  const message = value?.message
    ?? fallback.message
    ?? (typeof error === 'string' && error.trim().length > 0 ? error : undefined)
    ?? safeErrorMessage(error);
  const retryable = typeof value?.retryable === 'boolean'
    ? value.retryable
    : fallback.retryable ?? false;
  const result: ToolCallStructuredError = {
    code: code as ToolCallStructuredError['code'],
    message,
    retryable,
  };
  const callId = value?.callId ?? fallback.callId ?? context?.callId;
  const correlationId = value?.correlationId ?? fallback.correlationId ?? context?.correlationId;
  if (callId !== undefined) result.callId = callId;
  if (correlationId !== undefined) result.correlationId = correlationId;
  const details = value?.details ?? fallback.details;
  if (details !== undefined && isRecord(details)) result.details = details;
  return result;
}

function toolCallErrorStatus(code: string): number {
  switch (code) {
    case 'invalid_control':
    case 'unsupported_control_version':
    case 'path_policy_violation':
    case 'validation_failed':
      return 400;
    case 'deadline_exceeded':
    case 'cancelled':
      return 408;
    case 'middleware_rejected':
    case 'confirmation_required':
    case 'confirmation_invalid':
    case 'confirmation_expired':
    case 'confirmation_stale':
    case 'undo_unavailable':
    case 'identity_mismatch':
    case 'identity_unavailable':
      return 409;
    case 'dry_run_unsupported':
    case 'safety_unsupported':
      return 422;
    case 'authoring_transaction_failed':
    case 'operation_interrupted':
    case 'operation_owner_missing':
      return 409;
    case 'editor_not_ready':
    case 'editor_settling':
    case 'operation_capacity_exceeded':
      return 503;
    case 'operation_not_found':
      return 404;
    case 'cancellation_unavailable':
      return 501;
    case 'scheduling_metadata_invalid':
      return 422;
    default:
      return 500;
  }
}

function safeErrorMessage(error: unknown): string {
  return error instanceof ToolCallControlError ? error.message : 'Tool call failed.';
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Helper to send a plain text response. */
export function sendText(res: import('node:http').ServerResponse, statusCode: number, body: string, contentType = 'text/plain'): void {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', contentType);
  res.end(body);
}

/** Read and parse a JSON body from the request. Returns null for empty/non-JSON. */
export function readJsonBody(req: import('node:http').IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('error', reject);
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (raw.length === 0) {
        resolve(null);
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
  });
}
