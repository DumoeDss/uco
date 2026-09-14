/**
 * REST routes: POST /api/session/instance, DELETE /api/session/instance, GET /api/instances
 *
 * Response shapes match the .NET InstanceEndpoints.cs exactly.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RestContext } from './context.js';
import { sendJson, readJsonBody } from './context.js';
import { restAuthMiddleware, extractSessionId } from './auth.js';

/** POST /api/session/instance — pin session to an instanceId. */
export async function handleSetInstance(req: IncomingMessage, res: ServerResponse, ctx: RestContext): Promise<void> {
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

  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    sendJson(res, 400, { error: 'Request body must be a JSON object of the form { "instanceId": "..." }.' });
    return;
  }

  const obj = body as Record<string, unknown>;
  if (!('instanceId' in obj)) {
    sendJson(res, 400, { error: "Missing required field 'instanceId'." });
    return;
  }
  if (typeof obj.instanceId !== 'string') {
    sendJson(res, 400, { error: "Field 'instanceId' must be a string." });
    return;
  }

  const instanceId = obj.instanceId as string;
  if (!instanceId || instanceId.trim().length === 0) {
    sendJson(res, 400, { error: "Field 'instanceId' must be a non-empty string." });
    return;
  }

  const entry = ctx.registry.getByInstanceId(instanceId);
  if (!entry) {
    sendJson(res, 404, {
      error: `No connected plugin advertises instanceId '${instanceId}'. Use GET /api/instances to see live instances.`,
    });
    return;
  }

  state.activeInstanceId = instanceId;
  ctx.sessionStore.touch(sessionId);

  sendJson(res, 200, {
    sessionId: state.sessionId,
    activeInstanceId: state.activeInstanceId,
    connectedUtc: entry.connectedUtc.toISOString(),
  });
}

/** DELETE /api/session/instance — clear the instance pin. */
export async function handleClearInstance(req: IncomingMessage, res: ServerResponse, ctx: RestContext): Promise<void> {
  if (!restAuthMiddleware(req, res, { token: ctx.authToken })) return;

  const sessionId = extractSessionId(req);
  const state = ctx.sessionStore.getOrCreate(sessionId);
  state.activeInstanceId = null;
  ctx.sessionStore.touch(sessionId);

  sendJson(res, 200, {
    sessionId: state.sessionId,
    activeInstanceId: null,
  });
}

/** GET /api/instances — list connected instances. */
export async function handleListInstances(req: IncomingMessage, res: ServerResponse, ctx: RestContext): Promise<void> {
  if (!restAuthMiddleware(req, res, { token: ctx.authToken })) return;

  const sessionId = extractSessionId(req);
  const state = ctx.sessionStore.getOrCreate(sessionId);

  const instances = ctx.registry.snapshot().map((entry) => ({
    instanceId: entry.instanceId ?? '',
    connectionId: entry.connectionId,
    connectedAtUtc: entry.connectedUtc.toISOString(),
    currentForSession: entry.instanceId === state.activeInstanceId,
  }));

  sendJson(res, 200, {
    sessionId: state.sessionId,
    activeInstanceId: state.activeInstanceId,
    count: instances.length,
    instances,
  });
}
