/**
 * REST routes: GET /api/system-tools, POST /api/system-tools/{name}
 *
 * Response shapes match the .NET SystemToolEndpoints.cs exactly.
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
import { forwardToPlugin, generateRequestID } from './forward.js';
import { restAuthMiddleware, extractSessionId } from './auth.js';
import type { ResponseData, ResponseListTool, ResponseCallTool } from '../types.js';
import { ClientFacingMethod as Methods } from '../types.js';
import { normalizeRestToolCall, type NormalizedToolCall } from '../../tool-call-control.js';

/** GET /api/system-tools — list all available system tools. */
export async function handleListSystemTools(req: IncomingMessage, res: ServerResponse, ctx: RestContext): Promise<void> {
  if (!restAuthMiddleware(req, res, { token: ctx.authToken })) return;

  const sessionId = extractSessionId(req);
  const state = ctx.sessionStore.getOrCreate(sessionId);

  let response: ResponseData<ResponseListTool[]>;
  try {
    response = (await forwardToPlugin(ctx, Methods.RunListSystemTool, {
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
    sendJson(res, 500, { error: 'System tool hub returned a null response.' });
    return;
  }

  if (response.status === 'error') {
    sendJson(res, 500, { error: response.message ?? 'Failed to list system tools.' });
    return;
  }

  const tools: Record<string, unknown>[] = [];
  if (response.value) {
    for (const tool of response.value) {
      if (!tool) continue;
      const entry: Record<string, unknown> = {
        name: tool.name,
        enabled: tool.enabled,
      };
      if (tool.title != null) entry.title = tool.title;
      if (tool.description != null) entry.description = tool.description;
      if (tool.inputSchema !== undefined && tool.inputSchema !== null) entry.inputSchema = tool.inputSchema;
      if (tool.outputSchema !== undefined && tool.outputSchema !== null) entry.outputSchema = tool.outputSchema;
      tools.push(entry);
    }
  }

  sendJson(res, 200, tools);
}

/** POST /api/system-tools/{name} — invoke a system tool by name. */
export async function handleCallSystemTool(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RestContext,
  toolName: string,
): Promise<void> {
  if (!restAuthMiddleware(req, res, { token: ctx.authToken })) return;

  if (!toolName || toolName.trim().length === 0) {
    sendJson(res, 400, { error: 'System tool name must not be empty.' });
    return;
  }

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

  const controlled = !normalized.context.legacy;
  if (normalized.context.deadlineUnixMs !== undefined && normalized.context.deadlineUnixMs <= Date.now()) {
    if (controlled) sendStructuredToolCallError(res, {
      code: 'deadline_exceeded',
      message: 'Tool call deadline expired.',
      retryable: false,
    }, normalized.context);
    else sendJson(res, 500, { error: 'Tool call deadline expired.' });
    return;
  }

  const requestSignal = createRestRequestSignal(req, res);

  let response: ResponseData<ResponseCallTool> | null;
  try {
    response = (await forwardToPlugin(ctx, Methods.RunSystemTool, normalized.request, {
      instanceId: state.activeInstanceId,
      deferredRequestID: normalized.request.requestID,
      signal: requestSignal.signal,
      deadlineUnixMs: normalized.context.deadlineUnixMs,
      context: normalized.context,
    })) as ResponseData<ResponseCallTool>;
  } catch (err: unknown) {
    requestSignal.dispose();
    if (controlled) {
      sendStructuredToolCallError(res, err, normalized.context);
      return;
    }
    const message = err instanceof Error ? err.message : 'Plugin forwarding failed.';
    sendJson(res, 500, { error: message });
    return;
  }
  requestSignal.dispose();

  ctx.sessionStore.touch(sessionId);

  if (!response) {
    sendJson(res, 500, { error: 'System tool hub returned a null response.' });
    return;
  }

  if (response.status === 'error') {
    if (controlled) {
      sendStructuredToolCallError(res, response.error ?? response.message, normalized.context);
      return;
    }
    sendJson(res, 500, { error: response.message ?? `System tool '${toolName}' returned an error.` });
    return;
  }

  if (!response.value) {
    sendJson(res, 200, { status: 'success', content: [] });
    return;
  }

  if (response.value.structuredContent != null) {
    sendJson(res, 200, {
      status: 'success',
      structured: response.value.structuredContent,
      ...(response.value.transaction == null ? {} : { transaction: response.value.transaction }),
    });
    return;
  }

  sendJson(res, 200, {
    status: 'success',
    content: response.value.content,
    ...(response.value.transaction == null ? {} : { transaction: response.value.transaction }),
  });
}
