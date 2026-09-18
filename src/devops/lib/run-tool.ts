// Library-safe `runTool` / `runSystemTool` implementations.
//
// Constraints (same contract as the rest of `lib/*.ts`):
// - No commander, no spinners, no process.exit, no console output.
// - Errors are returned in `{ kind: 'failure', success: false, ... }`,
//   never thrown past the public boundary.

import { readConfig, resolveConnectionFromConfig } from '../utils/config.js';
import { generatePortFromDirectory } from '../utils/port.js';
import { requireProjectPath } from './validation.js';
import type {
  RunToolFailure,
  RunToolFailureReason,
  RunToolOptions,
  RunToolResult,
  RunToolSuccess,
} from './types.js';
import {
  createToolCallError,
  isToolCallContext,
  linkAbortSignals,
  resolveToolCallControl,
  serializeToolCallBody,
  ToolCallControlError,
  type ToolCallContext,
  type ToolCallStructuredError,
} from '../../tool-call-control.js';

const DEFAULT_TIMEOUT_MS = 60_000;

interface ErrorCause {
  code?: string;
  message?: string;
}

/**
 * Invoke a regular tool over the Unity plugin's HTTP API.
 *
 * URL/token resolution priority: explicit override → project config →
 * deterministic localhost port. POSTs to `/api/tools/{name}`. No
 * console output, no `process.exit`; errors are returned in the
 * `kind: 'failure'` variant.
 */
export async function runTool(opts: RunToolOptions): Promise<RunToolResult> {
  return invokeTool('/api/tools', opts);
}

/**
 * Invoke a system tool (internal tool not exposed in the regular tool list) over
 * the Unity plugin's HTTP API. POSTs to `/api/system-tools/{name}`.
 */
export async function runSystemTool(opts: RunToolOptions): Promise<RunToolResult> {
  return invokeTool('/api/system-tools', opts);
}

async function invokeTool(routePrefix: string, opts: RunToolOptions): Promise<RunToolResult> {
  const validationFailure = validateOptions(opts);
  if (validationFailure) return validationFailure;

  const resolved = resolveConnection(opts);
  if (resolved.kind === 'failure') return resolved;
  const { url, token } = resolved;

  const legacyBody = serializeInput(opts.input);
  if ('error' in legacyBody) {
    return makeFailure({
      endpoint: '',
      reason: 'invalid-input',
      message: legacyBody.error.message,
      error: legacyBody.error,
    });
  }

  const endpoint = `${url}${routePrefix}/${encodeURIComponent(opts.toolName)}`;

  const contextSource = opts.context
    ?? (opts.control !== undefined && isToolCallContext(opts.control) ? opts.control : undefined);
  const linkedSignals = linkAbortSignals(opts.signal, contextSource?.signal);
  const runtimeSignal = linkedSignals.signal;
  try {
    let requestBody = legacyBody.json;
    let context: ToolCallContext | undefined;
    let controlled = false;

    try {
      const control = resolveToolCallControl(opts);
      controlled = control !== undefined;
      if (controlled) {
        const arguments_ = parseControlledArguments(opts.input, legacyBody.json);
        const serialized = serializeToolCallBody(opts.toolName, arguments_, control!, {
          signal: runtimeSignal,
          requestID: opts.requestID,
        });
        context = serialized.context;
        requestBody = JSON.stringify(serialized.body);
      }
    } catch (err: unknown) {
      const controlError = err instanceof ToolCallControlError
        ? err
        : new ToolCallControlError('invalid_control', undefined, { cause: err });
      const structuredError = controlError.toStructuredError();
      return makeFailure({
        endpoint,
        reason: 'invalid-input',
        message: controlError.message,
        data: structuredError,
        structuredError,
        error: controlError,
      });
    }

    const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    const configuredTimeoutMs =
      typeof opts.timeoutMs === 'number' && Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0
        ? opts.timeoutMs
        : DEFAULT_TIMEOUT_MS;
    let timeoutMs = configuredTimeoutMs;
    if (context?.deadlineUnixMs !== undefined) {
      const remainingMs = context.deadlineUnixMs - Date.now();
      if (remainingMs <= 0) {
        return controlledFailure(
          endpoint,
          'deadline_exceeded',
          context,
          new Error('Tool call deadline expired.'),
        );
      }
      timeoutMs = Math.min(timeoutMs, remainingMs);
    }
    if (runtimeSignal?.aborted) {
      if (controlled && context) return controlledFailure(endpoint, 'cancelled', context);
      return makeFailure({
        endpoint,
        reason: 'timeout',
        message: `Tool call timed out after ${timeoutMs}ms.`,
      });
    }

    const controller = new AbortController();
    let timerExpired = false;
    let externallyCancelled = false;
    const timer = setTimeout(() => {
      timerExpired = true;
      controller.abort();
    }, timeoutMs);
    const externalAbort = (): void => {
      externallyCancelled = true;
      controller.abort();
    };
    if (runtimeSignal) {
      if (runtimeSignal.aborted) externalAbort();
      else runtimeSignal.addEventListener('abort', externalAbort, { once: true });
    }

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    try {
      const response = await fetchImpl(endpoint, {
        method: 'POST',
        headers,
        body: requestBody,
        signal: controller.signal,
      });

      const text = await safeReadText(response);
      const data = parseJsonOrText(text);

      if (!response.ok) {
        return makeFailure({
          endpoint,
          reason: 'http-error',
          httpStatus: response.status,
          data,
          ...(controlled && extractStructuredError(data)
            ? { structuredError: extractStructuredError(data) }
            : {}),
          message: response.statusText || `HTTP ${response.status}`,
        });
      }

      const success: RunToolSuccess = {
        kind: 'success',
        success: true,
        endpoint,
        httpStatus: response.status,
        data,
      };
      return success;
    } catch (err) {
      return classifyFetchError(err, endpoint, timeoutMs, {
        context,
        controlled,
        timerExpired,
        externallyCancelled,
      });
    } finally {
      clearTimeout(timer);
      runtimeSignal?.removeEventListener('abort', externalAbort);
    }
  } finally {
    linkedSignals.dispose();
  }
}

function validateOptions(opts: RunToolOptions): RunToolFailure | null {
  if (!opts || typeof opts !== 'object') {
    return makeFailure({
      endpoint: '',
      reason: 'invalid-input',
      message: 'options object is required.',
    });
  }
  if (typeof opts.toolName !== 'string' || opts.toolName.trim().length === 0) {
    return makeFailure({
      endpoint: '',
      reason: 'invalid-input',
      message: 'toolName is required and must be a non-empty string.',
    });
  }
  const hasUrl = typeof opts.url === 'string' && opts.url.length > 0;
  const hasProjectPath =
    typeof opts.unityProjectPath === 'string' && opts.unityProjectPath.trim().length > 0;
  if (!hasUrl && !hasProjectPath) {
    return makeFailure({
      endpoint: '',
      reason: 'invalid-input',
      message: 'Either unityProjectPath or url must be provided.',
    });
  }
  return null;
}

function resolveConnection(
  opts: RunToolOptions,
): { kind: 'success'; url: string; token: string | undefined } | RunToolFailure {
  if (opts.url) {
    return { kind: 'success', url: opts.url.replace(/\/$/, ''), token: opts.token };
  }

  // `unityProjectPath` is library-only — does NOT require an `Assets/`
  // folder, unlike the CLI's `resolveAndValidateProjectPath`. The
  // deterministic-port fallback works against the path string alone.
  const validated = requireProjectPath(opts.unityProjectPath);
  if (!validated.ok) {
    return makeFailure({
      endpoint: '',
      reason: 'invalid-input',
      message: validated.error.message,
      error: validated.error,
    });
  }
  const projectPath = validated.projectPath;

  const config = readConfig(projectPath);
  const fromConfig = config
    ? resolveConnectionFromConfig(config)
    : { url: undefined, token: undefined };

  const url = fromConfig.url
    ? fromConfig.url.replace(/\/$/, '')
    : `http://127.0.0.1:${generatePortFromDirectory(projectPath)}`;

  return { kind: 'success', url, token: opts.token ?? fromConfig.token };
}

function serializeInput(input: unknown): { json: string } | { error: Error } {
  if (input === undefined || input === null) return { json: '{}' };
  if (typeof input === 'string') {
    // Validate the round-trip so the server never sees malformed bodies.
    try {
      JSON.parse(input);
      return { json: input };
    } catch (err) {
      return {
        error: new Error(
          `input string is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
        ),
      };
    }
  }
  if (typeof input !== 'object') {
    return {
      error: new Error('input must be a plain object, JSON string, undefined, or null.'),
    };
  }
  try {
    return { json: JSON.stringify(input) };
  } catch (err) {
    return {
      error: new Error(
        `input could not be serialized to JSON: ${err instanceof Error ? err.message : String(err)}`,
      ),
    };
  }
}

/**
 * Controlled calls always carry an arguments object. Legacy callers retain
 * their exact JSON string/body, so this parser is intentionally only used
 * after the shared control serializer has been selected.
 */
function parseControlledArguments(input: unknown, serializedLegacyBody: string): Record<string, unknown> {
  const value = input === undefined || input === null
    ? {}
    : typeof input === 'string'
      ? JSON.parse(serializedLegacyBody)
      : input;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ToolCallControlError('invalid_control', 'Controlled tool input must be a JSON object.');
  }
  return value as Record<string, unknown>;
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

function parseJsonOrText(text: string): unknown {
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function getCause(err: unknown): ErrorCause | undefined {
  if (!(err instanceof Error) || !('cause' in err)) return undefined;
  return err.cause as ErrorCause | undefined;
}

function classifyFetchError(
  err: unknown,
  endpoint: string,
  timeoutMs: number,
  state: {
    context?: ToolCallContext;
    controlled: boolean;
    timerExpired: boolean;
    externallyCancelled: boolean;
  } = { controlled: false, timerExpired: false, externallyCancelled: false },
): RunToolFailure {
  if (err instanceof Error && err.name === 'AbortError') {
    if (state.controlled && state.context) {
      if (state.externallyCancelled) return controlledFailure(endpoint, 'cancelled', state.context, err);
      if (state.timerExpired && state.context.deadlineUnixMs !== undefined
        && state.context.deadlineUnixMs <= Date.now()) {
        return controlledFailure(endpoint, 'deadline_exceeded', state.context, err);
      }
    }
    return makeFailure({
      endpoint,
      reason: 'timeout',
      message: `Tool call timed out after ${timeoutMs}ms.`,
      error: err,
    });
  }

  const error = err instanceof Error ? err : new Error(String(err));
  const causeCode = getCause(err)?.code;

  let reason: RunToolFailureReason = 'unknown';
  if (causeCode === 'ECONNREFUSED') reason = 'connection-refused';
  else if (causeCode === 'ECONNRESET') reason = 'connection-reset';
  else if (causeCode === 'ENOTFOUND' || causeCode === 'EAI_AGAIN') reason = 'network-error';

  return makeFailure({
    endpoint,
    reason,
    message: error.message,
    error,
  });
}

function controlledFailure(
  endpoint: string,
  code: 'cancelled' | 'deadline_exceeded',
  context: ToolCallContext,
  error?: Error,
): RunToolFailure {
  const structuredError = createToolCallError(code, {
    callId: context.callId,
    correlationId: context.correlationId,
  });
  return makeFailure({
    endpoint,
    reason: 'timeout',
    message: structuredError.message,
    data: structuredError,
    structuredError,
    ...(error === undefined ? {} : { error }),
  });
}

function extractStructuredError(value: unknown): ToolCallStructuredError | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const candidate = record['error'] !== null && typeof record['error'] === 'object'
    ? record['error']
    : record;
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) return undefined;
  const error = candidate as Partial<ToolCallStructuredError>;
  if (typeof error.code !== 'string' || typeof error.message !== 'string'
    || typeof error.retryable !== 'boolean') return undefined;
  return error as ToolCallStructuredError;
}

function makeFailure(
  fields: Omit<RunToolFailure, 'kind' | 'success'>,
): RunToolFailure {
  return { kind: 'failure', success: false, ...fields };
}
