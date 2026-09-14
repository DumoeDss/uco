/**
 * REST routes: GET /api/session, POST /api/session/enabled-tools,
 * DELETE /api/session/enabled-tools, GET /api/session/all
 *
 * Response shapes match the .NET SessionEndpoints.cs exactly.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RestContext } from './context.js';
import { sendJson, readJsonBody } from './context.js';
import { restAuthMiddleware, extractSessionId } from './auth.js';

/** Convert a Set<string> | null to a sorted array or null (null = all enabled). */
function enabledToolsToJson(tools: Set<string> | null): string[] | null {
  if (tools === null) return null;
  return Array.from(tools).sort((a, b) => a.localeCompare(b));
}

/** GET /api/session — return current session state. */
export async function handleGetSession(req: IncomingMessage, res: ServerResponse, ctx: RestContext): Promise<void> {
  if (!restAuthMiddleware(req, res, { token: ctx.authToken })) return;

  const sessionId = extractSessionId(req);
  const state = ctx.sessionStore.getOrCreate(sessionId);
  ctx.sessionStore.touch(sessionId);

  sendJson(res, 200, {
    sessionId: state.sessionId,
    activeInstanceId: state.activeInstanceId,
    enabledTools: enabledToolsToJson(state.enabledTools),
    lastSeenUtc: state.lastSeenUtc.toISOString(),
  });
}

/** POST /api/session/enabled-tools — body { toolIds: string[] }. */
export async function handleEnableTools(req: IncomingMessage, res: ServerResponse, ctx: RestContext): Promise<void> {
  if (!restAuthMiddleware(req, res, { token: ctx.authToken })) return;

  const sessionId = extractSessionId(req);
  const state = ctx.sessionStore.getOrCreate(sessionId);

  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    sendJson(res, 400, { error: `Invalid JSON body: ${message}` });
    return;
  }

  if (body === null) {
    state.enabledTools = null;
  } else if (typeof body !== 'object' || Array.isArray(body)) {
    sendJson(res, 400, { error: 'Request body must be a JSON object of the form { "toolIds": [...] }.' });
    return;
  } else {
    const obj = body as Record<string, unknown>;
    if (!('toolIds' in obj)) {
      sendJson(res, 400, { error: "Missing required field 'toolIds'." });
      return;
    }
    if (!Array.isArray(obj.toolIds)) {
      sendJson(res, 400, { error: "Field 'toolIds' must be an array of strings." });
      return;
    }
    const ids = new Set<string>();
    for (const item of obj.toolIds) {
      if (typeof item !== 'string') {
        sendJson(res, 400, { error: "Every entry in 'toolIds' must be a string." });
        return;
      }
      if (item.length > 0) ids.add(item);
    }
    // Empty array = all tools enabled (null).
    state.enabledTools = ids.size > 0 ? ids : null;
  }

  ctx.sessionStore.touch(sessionId);

  sendJson(res, 200, {
    sessionId: state.sessionId,
    enabledTools: enabledToolsToJson(state.enabledTools),
  });
}

/** DELETE /api/session/enabled-tools — disable all tools. */
export async function handleDisableAllTools(req: IncomingMessage, res: ServerResponse, ctx: RestContext): Promise<void> {
  if (!restAuthMiddleware(req, res, { token: ctx.authToken })) return;

  const sessionId = extractSessionId(req);
  const state = ctx.sessionStore.getOrCreate(sessionId);
  state.enabledTools = new Set<string>();
  ctx.sessionStore.touch(sessionId);

  sendJson(res, 200, {
    sessionId: state.sessionId,
    enabledTools: [],
  });
}

/** GET /api/session/all — list all sessions. */
export async function handleListSessions(req: IncomingMessage, res: ServerResponse, ctx: RestContext): Promise<void> {
  if (!restAuthMiddleware(req, res, { token: ctx.authToken })) return;

  const snapshot = ctx.sessionStore.snapshot();
  const sessions = snapshot.map((s) => ({
    sessionId: s.sessionId,
    activeInstanceId: s.activeInstanceId,
    enabledTools: enabledToolsToJson(s.enabledTools),
    lastSeenUtc: s.lastSeenUtc.toISOString(),
  }));

  sendJson(res, 200, {
    count: snapshot.length,
    sessions,
  });
}
