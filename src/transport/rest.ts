// REST transport — plain HTTP against Unity-MCP-Server's /api side-channel.
//
// Endpoints (defined upstream):
//   POST /api/tools/{name}            — invoke a registered tool
//   POST /api/system-tools/{name}     — invoke an internal system tool
//   POST /api/system-tools/ping       — health check
//   GET  /api/tools                   — list available tools
//
// We do not use @modelcontextprotocol/sdk; we do not speak JSON-RPC.
// This keeps the CLI footprint tiny and lets `curl` debug everything.

import type { UnityCoTransport, ToolInfo, PromptInfo, ResourceInfo, CallOptions } from './index.js';
import { TransportError } from '../util/errors.js';
import { normalizeCatalogResponse } from '../catalog.js';
import { normalizeLoopbackUrl, isLoopbackUrl, looksRefused } from './loopback.js';
import {
  isToolCallContext,
  linkAbortSignals,
  resolveToolCallControl,
  serializeToolCallBody,
  ToolCallControlError,
  type ToolCallErrorCode,
  type ToolCallContext,
} from '../tool-call-control.js';

export interface RestTransportConfig {
  /** Server base URL, e.g. http://localhost:23456 — no trailing slash. */
  baseUrl: string;
  /** Optional bearer token (sent as `Authorization: Bearer <token>`). */
  token?: string;
  /** Default per-request timeout in milliseconds. */
  defaultTimeoutMs?: number;
  /** Override the fetch implementation (for tests). */
  fetchImpl?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 60_000;

export class RestTransport implements UnityCoTransport {
  private readonly baseUrl: string;
  private readonly token: string | undefined;
  private readonly defaultTimeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(cfg: RestTransportConfig) {
    // `localhost` is rewritten to 127.0.0.1: Node's fetch may resolve it to
    // ::1 while our servers bind IPv4 loopback only, and per-process proxy
    // rules frequently hijack the ::1 path (see transport/loopback.ts).
    this.baseUrl = normalizeLoopbackUrl(cfg.baseUrl.replace(/\/+$/, ''));
    this.token = cfg.token;
    this.defaultTimeoutMs = cfg.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = cfg.fetchImpl ?? globalThis.fetch;
  }

  ping(opts?: CallOptions): Promise<unknown> {
    return this.post('/api/system-tools/ping', {}, opts);
  }

  health(opts?: CallOptions): Promise<unknown> {
    return this.get('/api/health', opts);
  }

  async listTools(opts?: CallOptions): Promise<ToolInfo[]> {
    const data = await this.get('/api/tools', opts);
    return normalizeCatalogResponse(data);
  }

  async callTool(name: string, args: Record<string, unknown>, opts?: CallOptions): Promise<unknown> {
    const prepared = prepareToolCall(name, args, opts, this.defaultTimeoutMs);
    const asyncSuffix = opts?.asyncRequest === true ? '?async=1' : '';
    try {
      return await this.post(`/api/tools/${encodeURIComponent(name)}${asyncSuffix}`, prepared.body, prepared.options);
    } finally {
      prepared.dispose?.();
    }
  }

  getCall(callId: string, opts?: CallOptions): Promise<unknown> {
    return this.get(`/api/calls/${encodeURIComponent(callId)}`, opts);
  }

  listCalls(query?: { limit?: number; state?: string }, opts?: CallOptions): Promise<unknown> {
    const params = new URLSearchParams();
    if (query?.limit !== undefined) params.set('limit', String(query.limit));
    if (query?.state !== undefined && query.state.length > 0) params.set('state', query.state);
    const suffix = params.size > 0 ? `?${params.toString()}` : '';
    return this.get(`/api/calls${suffix}`, opts);
  }

  async callSystemTool(name: string, args: Record<string, unknown>, opts?: CallOptions): Promise<unknown> {
    const prepared = prepareToolCall(name, args, opts, this.defaultTimeoutMs);
    try {
      return await this.post(`/api/system-tools/${encodeURIComponent(name)}`, prepared.body, prepared.options);
    } finally {
      prepared.dispose?.();
    }
  }

  async listPrompts(opts?: CallOptions): Promise<PromptInfo[]> {
    const data = await this.get('/api/prompts', opts);
    if (Array.isArray(data)) return data as PromptInfo[];
    if (data && typeof data === 'object' && Array.isArray((data as { prompts?: unknown }).prompts)) {
      return (data as { prompts: PromptInfo[] }).prompts;
    }
    return [];
  }

  callPrompt(name: string, args: Record<string, unknown>, opts?: CallOptions): Promise<unknown> {
    return this.post(`/api/prompts/${encodeURIComponent(name)}`, args, opts);
  }

  async listResources(opts?: CallOptions): Promise<ResourceInfo[]> {
    const data = await this.get('/api/resources', opts);
    if (Array.isArray(data)) return data as ResourceInfo[];
    if (data && typeof data === 'object' && Array.isArray((data as { resources?: unknown }).resources)) {
      return (data as { resources: ResourceInfo[] }).resources;
    }
    return [];
  }

  readResource(uri: string, opts?: CallOptions): Promise<unknown> {
    return this.get(`/api/resources/content?uri=${encodeURIComponent(uri)}`, opts);
  }

  // --- internals -------------------------------------------------------

  private async post(path: string, body: unknown, opts?: CallOptions): Promise<unknown> {
    return this.request('POST', path, JSON.stringify(body ?? {}), opts);
  }

  private async get(path: string, opts?: CallOptions): Promise<unknown> {
    return this.request('GET', path, undefined, opts);
  }

  private async request(
    method: 'GET' | 'POST',
    path: string,
    body: string | undefined,
    opts?: CallOptions,
  ): Promise<unknown> {
    const url = `${this.baseUrl}${path}`;
    const configuredTimeoutMs = opts?.timeoutMs ?? this.defaultTimeoutMs;
    const absoluteDeadline = opts?.deadlineUnixMs ?? opts?.context?.deadlineUnixMs;
    const remainingDeadlineMs = absoluteDeadline === undefined
      ? undefined
      : absoluteDeadline - Date.now();
    if (remainingDeadlineMs !== undefined && remainingDeadlineMs <= 0 && opts?.context) {
      throw new ToolCallControlError('deadline_exceeded', undefined, {
        callId: opts.context.callId,
        correlationId: opts.context.correlationId,
      });
    }
    const timeoutMs = remainingDeadlineMs === undefined
      ? configuredTimeoutMs
      : Math.min(configuredTimeoutMs, Math.max(0, remainingDeadlineMs));

    const linkedSignals = linkAbortSignals(opts?.signal, opts?.context?.signal);
    const callerSignal = linkedSignals.signal;

    const controller = new AbortController();
    let timerExpired = false;
    let externallyAborted = false;
    const timer = setTimeout(() => {
      timerExpired = true;
      controller.abort();
    }, timeoutMs);
    const externalAbort = (): void => {
      externallyAborted = true;
      controller.abort();
    };
    if (callerSignal) {
      if (callerSignal.aborted) externalAbort();
      else callerSignal.addEventListener('abort', externalAbort, { once: true });
    }

    const headers: Record<string, string> = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (this.token) headers['Authorization'] = `Bearer ${this.token}`;

    try {
      const res = await this.fetchImpl(url, {
        method,
        headers,
        body,
        signal: controller.signal,
      });

      const text = await safeText(res);
      const parsed = parseJsonOrText(text);

      if (!res.ok) {
        const requestContext = opts?.context;
        const structuredError = requestContext ? extractStructuredHttpError(parsed) : undefined;
        if (structuredError && requestContext) {
          throw new ToolCallControlError(
            structuredError.code,
            structuredError.message,
            {
              retryable: structuredError.retryable,
              callId: structuredError.callId ?? requestContext.callId,
              correlationId: structuredError.correlationId ?? requestContext.correlationId,
              details: structuredError.details,
            },
          );
        }
        throw new TransportError({
          kind: 'http',
          url,
          method,
          status: res.status,
          statusText: res.statusText,
          body: parsed,
          message: `HTTP ${res.status} ${res.statusText || ''}`.trim(),
        });
      }

      return parsed;
    } catch (err) {
      if (err instanceof TransportError) throw err;
      if (err instanceof ToolCallControlError) throw err;
      if (err instanceof Error && err.name === 'AbortError' && opts?.context) {
        if (externallyAborted) {
          throw new ToolCallControlError('cancelled', undefined, {
            callId: opts.context.callId,
            correlationId: opts.context.correlationId,
            cause: err,
          });
        }
        if (timerExpired && absoluteDeadline !== undefined
          && absoluteDeadline <= Date.now()) {
          throw new ToolCallControlError('deadline_exceeded', undefined, {
            callId: opts.context.callId,
            correlationId: opts.context.correlationId,
            cause: err,
          });
        }
      }
      throw await classifyError(err, url, method, timeoutMs, opts?.context?.callId);
    } finally {
      clearTimeout(timer);
      callerSignal?.removeEventListener('abort', externalAbort);
      linkedSignals.dispose();
    }
  }
}

interface PreparedToolCall {
  body: Record<string, unknown>;
  options: CallOptions;
  context?: ToolCallContext;
  dispose?: () => void;
}

/**
 * Build a tool body once at the transport boundary. Calls without control
 * metadata intentionally retain the historical bare-arguments JSON body.
 */
function prepareToolCall(
  name: string,
  args: Record<string, unknown>,
  opts: CallOptions | undefined,
  defaultTimeoutMs: number,
): PreparedToolCall {
  const control = opts ? resolveToolCallControl(opts) : undefined;
  const context = opts?.context
    ?? (opts?.control !== undefined && isToolCallContext(opts.control) ? opts.control : undefined);
  const linkedSignals = linkAbortSignals(opts?.signal, context?.signal);
  const signal = linkedSignals.signal;

  try {
    if (control === undefined) {
      // A requestID without other control fields is still represented as a
      // controlled request so the compatibility id is not silently discarded.
      if (opts?.requestID === undefined) {
        return {
          body: args,
          options: {
            ...(opts ?? {}),
            ...(signal === undefined ? {} : { signal }),
          },
          dispose: linkedSignals.dispose,
        };
      }
    }

    const serialized = serializeToolCallBody(
      name,
      args,
      control ?? { callId: opts?.requestID },
      {
        ...(signal === undefined ? {} : { signal }),
        ...(opts?.requestID === undefined ? {} : { requestID: opts.requestID }),
      },
    );

    const timeoutMs = opts?.timeoutMs ?? defaultTimeoutMs;
    const boundedTimeoutMs = boundTimeoutByDeadline(timeoutMs, serialized.context);
    if (signal?.aborted) {
      throw new ToolCallControlError('cancelled', undefined, {
        callId: serialized.context.callId,
        correlationId: serialized.context.correlationId,
      });
    }
    return {
      body: serialized.body,
      options: {
        ...(opts ?? {}),
        timeoutMs: boundedTimeoutMs,
        ...(signal === undefined ? {} : { signal }),
        context: serialized.context,
        ...(serialized.context.deadlineUnixMs === undefined
          ? {}
          : { deadlineUnixMs: serialized.context.deadlineUnixMs }),
      },
      context: serialized.context,
      dispose: linkedSignals.dispose,
    };
  } catch (error) {
    linkedSignals.dispose();
    throw error;
  }
}

function boundTimeoutByDeadline(timeoutMs: number, context: ToolCallContext): number {
  if (context.deadlineUnixMs === undefined) return timeoutMs;
  const remainingMs = context.deadlineUnixMs - Date.now();
  if (remainingMs <= 0) {
    throw new ToolCallControlError('deadline_exceeded', undefined, {
      callId: context.callId,
      correlationId: context.correlationId,
    });
  }
  return Math.min(timeoutMs, remainingMs);
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
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

async function classifyError(err: unknown, url: string, method: string, timeoutMs: number, callId?: string): Promise<TransportError> {
  if (err instanceof Error && err.name === 'AbortError') {
    return new TransportError({
      kind: 'timeout',
      url,
      method,
      message: `Request timed out after ${timeoutMs}ms`,
      ...(callId !== undefined ? { callId } : {}),
      cause: err,
    });
  }
  const code = extractErrorCode(err);
  if (code === 'ECONNREFUSED') {
    return new TransportError({
      kind: 'connection-refused',
      url,
      method,
      message: `Connection refused — is the Unity Editor (with AI Game Developer plugin) running?`,
      cause: err as Error,
    });
  }
  if (code === 'ECONNRESET') {
    return new TransportError({
      kind: 'connection-reset',
      url,
      method,
      message: `Connection reset (server may have restarted during domain reload)`,
      cause: err as Error,
    });
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return new TransportError({
      kind: 'dns',
      url,
      method,
      message: `Host not found: ${url}`,
      cause: err as Error,
    });
  }
  // A per-process proxy rule (matching node.exe) answers the TCP handshake
  // for ANY loopback port and closes dead ones right after accept, so
  // ECONNREFUSED never surfaces and the branch above never fires — users on
  // proxified machines lose the actionable "is the Unity Editor running?"
  // diagnosis to a bare `unknown / fetch failed`. The raw-TCP discriminator
  // restores it; this only ever runs on the error path of an already-failed
  // request (see transport/loopback.ts).
  if (isLoopbackUrl(url)) {
    try {
      const { hostname, port: rawPort } = new URL(url);
      const port = Number(rawPort);
      if (Number.isInteger(port) && port > 0 && await looksRefused(hostname, port)) {
        return new TransportError({
          kind: 'connection-refused',
          url,
          method,
          message: `Connection refused — is the Unity Editor (with AI Game Developer plugin) running?`,
          cause: err as Error,
        });
      }
    } catch {
      // The discriminator is best-effort; fall through to `unknown`.
    }
  }
  const msg = err instanceof Error ? err.message : String(err);
  return new TransportError({
    kind: 'unknown',
    url,
    method,
    message: msg,
    cause: err as Error,
  });
}

interface StructuredHttpError {
  code: ToolCallErrorCode;
  message: string;
  retryable?: boolean;
  callId?: string;
  correlationId?: string;
  details?: Record<string, unknown>;
}

function extractStructuredHttpError(value: unknown): StructuredHttpError | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const root = value as Record<string, unknown>;
  const candidate = root['error'] && typeof root['error'] === 'object' && !Array.isArray(root['error'])
    ? root['error'] as Record<string, unknown>
    : root;
  const code = candidate['code'];
  if (!isToolCallErrorCode(code)) return undefined;
  const message = candidate['message'];
  if (typeof message !== 'string' || message.length === 0) return undefined;
  const details = candidate['details'];
  return {
    code,
    message,
    retryable: typeof candidate['retryable'] === 'boolean' ? candidate['retryable'] : undefined,
    callId: typeof candidate['callId'] === 'string' ? candidate['callId'] : undefined,
    correlationId: typeof candidate['correlationId'] === 'string' ? candidate['correlationId'] : undefined,
    details: details !== null && typeof details === 'object' && !Array.isArray(details)
      ? details as Record<string, unknown>
      : undefined,
  };
}

function isToolCallErrorCode(value: unknown): value is ToolCallErrorCode {
  return value === 'invalid_control'
    || value === 'unsupported_control_version'
    || value === 'deadline_exceeded'
    || value === 'cancelled'
    || value === 'middleware_rejected'
    || value === 'tool_execution_failed'
    || value === 'validation_failed'
    || value === 'confirmation_required'
    || value === 'confirmation_invalid'
    || value === 'confirmation_expired'
    || value === 'confirmation_stale'
    || value === 'dry_run_unsupported'
    || value === 'path_policy_violation'
    || value === 'safety_unsupported'
    || value === 'undo_unavailable'
    || value === 'authoring_transaction_failed'
    || value === 'editor_not_ready'
    || value === 'editor_settling'
    || value === 'operation_capacity_exceeded'
    || value === 'operation_not_found'
    || value === 'operation_owner_missing'
    || value === 'operation_interrupted'
    || value === 'cancellation_unavailable'
    || value === 'scheduling_metadata_invalid'
    || value === 'identity_mismatch'
    || value === 'identity_unavailable';
}

/**
 * undici (Node's fetch) wraps low-level errors in three shapes:
 *   1. err.cause.code              — simple single connect error
 *   2. err.cause.errors[i].code    — AggregateError (IPv4 + IPv6 both failed)
 *   3. err.code                    — bare net error (rare)
 * Probe all three.
 */
function extractErrorCode(err: unknown): string | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const e = err as { code?: string; cause?: { code?: string; errors?: Array<{ code?: string }> } };
  if (typeof e.code === 'string') return e.code;
  const cause = e.cause;
  if (!cause) return undefined;
  if (typeof cause.code === 'string') return cause.code;
  if (Array.isArray(cause.errors)) {
    for (const inner of cause.errors) {
      if (inner && typeof inner.code === 'string') return inner.code;
    }
  }
  return undefined;
}
