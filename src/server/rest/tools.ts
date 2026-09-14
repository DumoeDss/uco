/**
 * REST routes: GET /api/tools, POST /api/tools/{name}
 *
 * Response shapes match the .NET DirectToolCallEndpoints.cs exactly.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RestContext } from './context.js';
import {
  sendJson,
  readJsonBody,
  isExplicitToolCallWrapper,
  sendStructuredToolCallError,
  createRestRequestSignal,
} from './context.js';
import { forwardToPlugin, generateRequestID, identityTuple } from './forward.js';
import { restAuthMiddleware, extractSessionId } from './auth.js';
import type { ResponseData, ResponseListTool, ResponseCallTool } from '../types.js';
import { ClientFacingMethod as Methods } from '../types.js';
import { ErrorCode } from '../ws/envelope.js';
import { normalizeToolCatalog } from '../../catalog.js';
import { normalizeRestToolCall, type NormalizedToolCall } from '../../tool-call-control.js';

/** Whether the caller asked for fire-and-forget semantics (?async=1). */
function isAsyncRequest(req: IncomingMessage): boolean {
  try {
    const query = new URL(req.url ?? '', 'http://localhost').searchParams;
    return query.get('async') === '1' || query.get('async') === 'true';
  } catch {
    return false;
  }
}

/** GET /api/tools — list all available tools with session filter. */
export async function handleListTools(req: IncomingMessage, res: ServerResponse, ctx: RestContext): Promise<void> {
  if (!restAuthMiddleware(req, res, { token: ctx.authToken })) return;

  const sessionId = extractSessionId(req);
  const state = ctx.sessionStore.getOrCreate(sessionId);
  ctx.sessionStore.touch(sessionId);

  let response: ResponseData<ResponseListTool[]>;
  try {
    response = (await forwardToPlugin(ctx, Methods.RunListTool, {
      requestID: generateRequestID(),
    } as never, {
      instanceId: state.activeInstanceId,
    })) as ResponseData<ResponseListTool[]>;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Plugin forwarding failed.';
    sendJson(res, 500, { error: message });
    return;
  }

  if (!response) {
    sendJson(res, 500, { error: 'Tool hub returned a null response.' });
    return;
  }

  if (response.status === 'error') {
    sendJson(res, 500, { error: response.message ?? 'Failed to list tools.', retryable: false });
    return;
  }

  const enabledTools = state.enabledTools;
  const tools: ResponseListTool[] = [];

  if (response.value) {
    for (const tool of response.value) {
      if (!tool) continue;
      if (enabledTools != null && !enabledTools.has(tool.name)) continue;

      tools.push(tool);
    }
  }

  sendJson(res, 200, normalizeToolCatalog(tools));
}

/** POST /api/tools/{name} — invoke a tool by name. */
export async function handleCallTool(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RestContext,
  toolName: string,
): Promise<void> {
  if (!restAuthMiddleware(req, res, { token: ctx.authToken })) return;

  if (!toolName || toolName.trim().length === 0) {
    sendJson(res, 400, { error: 'Tool name must not be empty.' });
    return;
  }

  // Parse and normalize exactly once. A bare body remains the legacy
  // arguments object; the explicit wrapper is unwrapped only when both
  // `arguments` and `control` are object members.
  let body: unknown;
  let normalized: NormalizedToolCall;
  try {
    body = await readJsonBody(req);
    normalized = normalizeRestToolCall(toolName, body);
  } catch (err: unknown) {
    if (isExplicitToolCallWrapper(body)) {
      sendStructuredToolCallError(res, err);
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    sendJson(res, 400, { error: `Invalid JSON body: ${message}` });
    return;
  }

  const sessionId = extractSessionId(req);
  const state = ctx.sessionStore.getOrCreate(sessionId);

  // Session tool-group gate.
  if (state.enabledTools != null && !state.enabledTools.has(toolName)) {
    sendJson(res, 403, {
      error: `Tool '${toolName}' is not enabled in this session. Use POST /api/session/enabled-tools to enable it.`,
    });
    return;
  }

  const controlled = !normalized.context.legacy;
  if (normalized.context.deadlineUnixMs !== undefined && normalized.context.deadlineUnixMs <= Date.now()) {
    sendStructuredToolCallError(res, {
      code: 'deadline_exceeded',
      message: 'Tool call deadline expired.',
      retryable: false,
    }, normalized.context);
    return;
  }

  // COCli-09: every forwarded call gets a bounded durable record so an
  // observed transport timeout ("result unknown") can be resolved later.
  // Async mode (?async=1) additionally answers 202 with the record id after
  // dispatch; the REST request signal is deliberately NOT linked there —
  // closing the HTTP response must not abort the plugin call (and must not
  // send cancel-tool-call-v1 on capable plugins).
  const asyncMode = isAsyncRequest(req);
  const callId = normalized.context.callId ?? normalized.request.requestID;
  const record = { callId };
  ctx.callRecords.begin({
    callId: record.callId,
    requestId: normalized.request.requestID,
    tool: toolName,
    mode: asyncMode ? 'async' : 'sync',
  });

  const requestSignal = asyncMode ? null : createRestRequestSignal(req, res);

  // Served-identity echo (COCli-01, relaxed): every success response whose
  // serving connection reported any identity member echoes the tuple, so the
  // executor is verifiable even without caller-asserted constraints. The echo
  // is omitted when the tuple is identity-empty (older plugins) to avoid
  // pure-null noise. Rejections keep carrying `observed` in error details.
  const served: { identity?: Record<string, unknown> } = {};

  const settleRecordFromError = (err: unknown): void => {
    if (record === undefined) return;
    const rpc = (err && typeof err === 'object' && 'code' in err ? err : undefined) as { code?: number; message?: unknown } | undefined;
    const message = err instanceof Error ? err.message : (typeof rpc?.message === 'string' ? rpc.message : 'Forwarding failed.');
    if (rpc?.code === ErrorCode.CALL_CANCELLED) {
      ctx.callRecords.settleAbandoned(record.callId, 'caller-disconnect');
      return;
    }
    if (rpc?.code === ErrorCode.PLUGIN_TIMEOUT) {
      ctx.callRecords.settleAbandoned(record.callId, 'server-wait-timeout');
      return;
    }
    ctx.callRecords.settleFailed(record.callId, {
      code: 'tool_execution_failed',
      message,
      retryable: false,
    });
  };

  const forwardPromise = (asyncMode
    ? forwardToPlugin(ctx, Methods.RunCallTool, normalized.request, {
        instanceId: state.activeInstanceId,
        deferredRequestID: normalized.request.requestID,
        deadlineUnixMs: normalized.context.deadlineUnixMs,
        context: normalized.context,
        onServed: (entry) => {
          if (served.identity === undefined) served.identity = identityTuple(entry);
          if (record !== undefined) ctx.callRecords.markDispatched(record.callId, identityTuple(entry));
        },
        onDispatched: () => {
          if (record !== undefined) ctx.callRecords.markDispatched(record.callId);
        },
      })
    : forwardToPlugin(ctx, Methods.RunCallTool, normalized.request, {
        instanceId: state.activeInstanceId,
        deferredRequestID: normalized.request.requestID,
        signal: requestSignal!.signal,
        deadlineUnixMs: normalized.context.deadlineUnixMs,
        context: normalized.context,
        onServed: (entry) => {
          if (served.identity === undefined) served.identity = identityTuple(entry);
        },
      })
  ).then(
    (value) => {
      if (record !== undefined) ctx.callRecords.settleFromResponse(record.callId, value as ResponseData<ResponseCallTool> | null);
      return value;
    },
    (err: unknown) => {
      settleRecordFromError(err);
      throw err;
    },
  );

  if (asyncMode) {
    // Wait (bounded) until the forwarder either dispatched to the plugin or
    // failed pre-dispatch, then answer 202 with the durable record id.
    if (record !== undefined) {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const current = ctx.callRecords.get(record.callId);
        if (current === undefined) break;
        if (current.dispatchedAtUtc !== undefined) break;
        if (current.state === 'failed' || current.state === 'abandoned') break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    const current = record !== undefined ? ctx.callRecords.get(record.callId) : undefined;
    if (current && (current.state === 'failed' || current.state === 'abandoned')) {
      // Pre-dispatch failure (no eligible connection, etc.) — nothing is
      // running; report it as a definitive failure.
      sendJson(res, 502, {
        error: current.error?.message ?? 'Async dispatch failed.',
        retryable: current.error?.retryable ?? true,
      });
      return;
    }
    sendJson(res, 202, {
      status: 'processing',
      callId: record?.callId,
      requestId: normalized.request.requestID,
      tool: toolName,
      transportStatus: 'accepted',
      queryHint: `uco call get ${record?.callId ?? '<callId>'}`,
    });
    return;
  }

  let response: ResponseData<ResponseCallTool> | null;
  try {
    response = (await forwardPromise) as ResponseData<ResponseCallTool>;
  } catch (err: unknown) {
    requestSignal!.dispose();
    if (controlled) {
      sendStructuredToolCallError(res, err, normalized.context);
      return;
    }
    const message = err instanceof Error ? err.message : 'Plugin forwarding failed.';
    sendJson(res, 500, { error: message });
    return;
  }
  requestSignal!.dispose();

  ctx.sessionStore.touch(sessionId);

  if (!response) {
    sendJson(res, 500, { error: 'Tool hub returned a null response.' });
    return;
  }

  if (response.status === 'error') {
    // Diagnostic passthrough: the plugin puts the real failure text (compile
    // errors, exception messages) into the first text content block and into
    // the outer ResponseData.message, while the structured error may carry
    // only the generic "Tool execution failed." — never let that placeholder
    // shadow the actionable text.
    const contentText = firstContentText(response.value);
    const hint = toolNotFoundHint(response.message ?? contentText);
    const diagnostic = contentText ?? response.message ?? undefined;
    const error = mergeStructuredError(
      response.error ?? undefined,
      diagnostic,
      hint,
    );
    if (!controlled) {
      // Legacy callers get the same structured failure (message, code,
      // retryability) the controlled path reports, so the CLI can exit by
      // the documented map instead of treating a tool decision as a bare
      // HTTP-500 transport error.
      sendStructuredToolCallError(res, error === undefined
        ? {
            code: 'tool_execution_failed',
            message: `Tool '${toolName}' returned an error.`,
            retryable: false,
          }
        : error, normalized.context);
      return;
    }
    sendStructuredToolCallError(res, error, normalized.context);
    return;
  }

  const servedBy = served.identity !== undefined && hasIdentityMember(served.identity)
    ? { servedBy: served.identity }
    : {};

  if (!response.value) {
    sendJson(res, 200, {
      status: 'success',
      content: [],
      transportStatus: 'forwarded',
      ...servedBy,
    });
    return;
  }

  // Durable-operation projection (COCli-04): when the tool reported a durable
  // operation handle, expose its authoritative identity/state/phase at the
  // documented envelope position alongside the forwarding outcome.
  const operationStatus = projectOperationStatus(response.value.structuredContent ?? response.value.content);

  // Return structured content if available, otherwise return the text content blocks.
  if (response.value.structuredContent != null) {
    sendJson(res, 200, {
      status: response.status,
      structured: response.value.structuredContent,
      ...(response.value.transaction == null ? {} : { transaction: response.value.transaction }),
      transportStatus: 'forwarded',
      ...(operationStatus === undefined ? {} : { operationStatus }),
      ...servedBy,
    });
    return;
  }

  sendJson(res, 200, {
    status: response.status,
    content: response.value.content,
    ...(response.value.transaction == null ? {} : { transaction: response.value.transaction }),
    transportStatus: 'forwarded',
    ...(operationStatus === undefined ? {} : { operationStatus }),
    ...servedBy,
  });
}

const GENERIC_TOOL_FAILURE_MESSAGES = new Set(['Tool call failed.', 'Tool execution failed.']);

/** First bounded text content block of a plugin tool response, if any. */
function firstContentText(value: ResponseCallTool | undefined | null, maxLen = 1024): string | undefined {
  const text = value?.content?.find((block) => block?.type === 'text' && typeof block.text === 'string' && block.text.length > 0)?.text;
  if (typeof text !== 'string') return undefined;
  const trimmed = text.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.length <= maxLen ? trimmed : `${trimmed.slice(0, maxLen)}…`;
}

/**
 * Replace a generic structured-error message with the actionable diagnostic
 * text the plugin also returned, and attach the upgrade hint when present.
 * Keeps the structured code/retryable/callId members intact.
 */
function mergeStructuredError(
  structured: ResponseData<ResponseCallTool>['error'] | undefined,
  diagnostic: string | undefined,
  hint: string | undefined,
): unknown {
  if (structured === null || typeof structured !== 'object') {
    if (diagnostic === undefined) return undefined;
    return hint === undefined ? diagnostic : { message: diagnostic, details: { hint } };
  }
  const merged: Record<string, unknown> = { ...structured };
  if (diagnostic !== undefined
    && (typeof merged.message !== 'string' || merged.message.length === 0 || GENERIC_TOOL_FAILURE_MESSAGES.has(merged.message))) {
    merged.message = diagnostic;
  }
  if (hint !== undefined) {
    merged.details = typeof merged.details === 'object' && merged.details !== null
      ? { ...merged.details as Record<string, unknown>, hint }
      : { hint };
  }
  return merged;
}

/** Upgrade guidance when the connected plugin lacks a CLI-advertised tool. */
function toolNotFoundHint(message: string | undefined): string | undefined {
  if (message === undefined || !/Tool with Name '.+' not found/i.test(message)) return undefined;
  return "The connected plugin does not expose this tool — it is likely older than the CLI's generated command snapshot. Upgrade the project plugin (e.g. `uco install-plugin <project>`) and re-run `uco gen` if needed.";
}

/** Whether any identity member (besides the always-present generation) is set. */
function hasIdentityMember(identity: Record<string, unknown>): boolean {
  return ['instanceId', 'projectPath', 'editorPid', 'unityVersion']
    .some((key) => {
      const value = identity[key];
      return value !== null && value !== undefined && value !== '';
    });
}

const OPERATION_WRAPPER_KEYS = ['structured', 'structuredContent', 'result', 'value'] as const;

/** Project { operationId, state, phase } from a durable tool payload. */
function projectOperationStatus(payload: unknown): { operationId: string; state: string; phase: string } | undefined {
  const queue: unknown[] = [payload];
  const seen = new WeakSet<object>();
  for (let depth = 0; depth < queue.length && depth < 8; depth++) {
    const current = queue[depth];
    if (!current || typeof current !== 'object' || Array.isArray(current)) continue;
    if (seen.has(current)) continue;
    seen.add(current);
    const record = current as Record<string, unknown>;
    const operationId = record['OperationId'] ?? record['operationId'];
    const state = record['Status'] ?? record['status'];
    if (typeof operationId === 'string' && operationId.length > 0 && typeof state === 'string') {
      const phase = record['Phase'] ?? record['phase'];
      return {
        operationId,
        state,
        phase: typeof phase === 'string' ? phase : state,
      };
    }
    for (const key of OPERATION_WRAPPER_KEYS) {
      const nested = record[key];
      if (nested !== null && typeof nested === 'object' && !Array.isArray(nested)) queue.push(nested);
    }
  }
  return undefined;
}
