/**
 * JSON envelope types and helpers for the WebSocket RPC protocol.
 *
 * @see design.md §D2 for the full specification.
 *
 * Three message types over a single WebSocket connection (all UTF-8 JSON text frames):
 *   Request:       { id, method, params? }
 *   Response:      { id, result? } | { id, error: { code, message, data? } }
 *   Notification:  { method, params? }  (no id → fire-and-forget)
 */

import { ALL_METHODS } from '../types.js';

// ===== Envelope types =====

export interface RpcRequest {
  id: string | number;
  method: string;
  params?: unknown;
}

export interface RpcResponse {
  id: string | number;
  result?: unknown;
  error?: RpcError;
}

export interface RpcNotification {
  method: string;
  params?: unknown;
}

export interface RpcError {
  code: number;
  message: string;
  data?: unknown;
}

export type RpcMessage = RpcRequest | RpcResponse | RpcNotification;

// ===== Error codes (JSON-RPC-like, per design.md §D2) =====

export const ErrorCode = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  PLUGIN_NOT_CONNECTED: -32000,
  PLUGIN_TIMEOUT: -32001,
  AUTH_REJECTED: -32002,
  CALL_CANCELLED: -32003,
  CALL_DEADLINE_EXCEEDED: -32004,
  MIDDLEWARE_REJECTED: -32005,
  PENDING_CAPACITY_EXCEEDED: -32006,
  CANCELLATION_UNAVAILABLE: -32007,
} as const;

// ===== Type guards =====

export function isRequest(msg: unknown): msg is RpcRequest {
  return (
    typeof msg === 'object' && msg !== null &&
    'id' in msg &&
    'method' in msg && typeof (msg as Record<string, unknown>).method === 'string'
  );
}

export function isResponse(msg: unknown): msg is RpcResponse {
  return (
    typeof msg === 'object' && msg !== null &&
    'id' in msg &&
    ('result' in msg || 'error' in msg)
  );
}

export function isNotification(msg: unknown): msg is RpcNotification {
  return (
    typeof msg === 'object' && msg !== null &&
    !('id' in msg) &&
    'method' in msg && typeof (msg as Record<string, unknown>).method === 'string'
  );
}

// ===== Parse / serialize =====

export type ParseResult =
  | { ok: true; message: RpcMessage }
  | { ok: false; error: RpcError };

/**
 * Parse a raw WebSocket text frame into an RpcMessage, or return a parse/error.
 * Never throws — invalid JSON returns { ok: false, error: { code: -32700 } }.
 */
export function parseMessage(data: string): ParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return { ok: false, error: { code: ErrorCode.PARSE_ERROR, message: 'Parse error: malformed JSON' } };
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: { code: ErrorCode.INVALID_REQUEST, message: 'Invalid request: message must be a JSON object' } };
  }

  const obj = parsed as Record<string, unknown>;

  // Response: has id and (result or error), no method
  if ('id' in obj && ('result' in obj || 'error' in obj) && !('method' in obj)) {
    return { ok: true, message: obj as unknown as RpcResponse };
  }

  // Request: has id and method
  if ('id' in obj && 'method' in obj && typeof obj.method === 'string') {
    return { ok: true, message: obj as unknown as RpcRequest };
  }

  // Notification: has method but no id
  if (!('id' in obj) && 'method' in obj && typeof obj.method === 'string') {
    return { ok: true, message: obj as unknown as RpcNotification };
  }

  return { ok: false, error: { code: ErrorCode.INVALID_REQUEST, message: 'Invalid request: unrecognized message structure' } };
}

/** Serialize a message to a UTF-8 JSON string. */
export function serializeMessage(msg: RpcMessage): string {
  return JSON.stringify(msg);
}

/** Build an error response echoing the request id. */
export function makeErrorResponse(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown,
): RpcResponse {
  const error: RpcError = { code, message };
  if (data !== undefined) error.data = data;
  return { id: id ?? 0, error };
}

/** Build a success response echoing the request id. */
export function makeResponse(id: string | number, result: unknown): RpcResponse {
  return { id, result };
}

/** Build a request message. */
export function makeRequest(id: string | number, method: string, params?: unknown): RpcRequest {
  const req: RpcRequest = { id, method };
  if (params !== undefined) req.params = params;
  return req;
}

/** Build a notification message (no id). */
export function makeNotification(method: string, params?: unknown): RpcNotification {
  const notif: RpcNotification = { method };
  if (params !== undefined) notif.params = params;
  return notif;
}

/** Check if a method name is one of the 21 valid RPC methods. */
export function isValidMethod(method: string): boolean {
  return ALL_METHODS.has(method);
}

// ===== Result payload helpers =====

/**
 * Extract a durable operation id from an RPC response payload.
 *
 * Scans a bounded object graph (32 nodes) for the first `operationId`-shaped
 * string, unwrapping the common payload shapes (value / structuredContent /
 * structured / result). Returns the trimmed id capped at 160 chars, or
 * undefined when no durable handle is present.
 */
export function extractDurableOperationId(value: unknown): string | undefined {
  const queue: unknown[] = [value];
  const seen = new Set<object>();
  for (let index = 0; index < queue.length && index < 32; index++) {
    const current = queue[index];
    if (!current || typeof current !== 'object' || Array.isArray(current)) continue;
    if (seen.has(current)) continue;
    seen.add(current);
    const record = current as Record<string, unknown>;
    const operationId = record['operationId'] ?? record['OperationId']
      ?? record['operationID'] ?? record['OperationID'];
    if (typeof operationId === 'string' && operationId.trim())
      return operationId.trim().slice(0, 160);
    for (const key of ['value', 'structuredContent', 'structured', 'result']) {
      if (record[key] !== undefined) queue.push(record[key]);
    }
  }
  return undefined;
}
