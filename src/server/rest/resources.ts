/**
 * REST routes: GET /api/resources, GET /api/resources/content?uri=, GET /api/resources/templates
 *
 * Response shapes match the .NET ResourceEndpoints.cs exactly.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { URL } from 'node:url';
import type { RestContext } from './context.js';
import { sendJson } from './context.js';
import { forwardToPlugin, generateRequestID } from './forward.js';
import { restAuthMiddleware, extractSessionId } from './auth.js';
import type {
  ResponseData,
  ResponseListResource,
  ResponseResourceContent,
  ResponseResourceTemplate,
} from '../types.js';
import { ClientFacingMethod as Methods } from '../types.js';

/** GET /api/resources — list all registered resources. */
export async function handleListResources(req: IncomingMessage, res: ServerResponse, ctx: RestContext): Promise<void> {
  if (!restAuthMiddleware(req, res, { token: ctx.authToken })) return;

  const sessionId = extractSessionId(req);
  const state = ctx.sessionStore.getOrCreate(sessionId);

  let response: ResponseData<ResponseListResource[]>;
  try {
    response = (await forwardToPlugin(ctx, Methods.RunListResources, {
      requestID: generateRequestID(),
    } as never, {
      instanceId: state.activeInstanceId,
    })) as ResponseData<ResponseListResource[]>;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Plugin forwarding failed.';
    sendJson(res, 500, { error: message });
    return;
  }

  if (!response) {
    sendJson(res, 500, { error: 'Resource hub returned a null response.' });
    return;
  }
  if (response.status === 'error') {
    sendJson(res, 500, { error: response.message ?? 'Failed to list resources.' });
    return;
  }

  const resources: Record<string, unknown>[] = [];
  if (response.value) {
    for (const r of response.value) {
      if (!r) continue;
      const entry: Record<string, unknown> = {
        uri: r.uri,
        name: r.name,
        enabled: r.enabled,
      };
      if (r.mimeType != null) entry.mimeType = r.mimeType;
      if (r.description != null) entry.description = r.description;
      if (r.size != null) entry.size = r.size;
      resources.push(entry);
    }
  }

  sendJson(res, 200, resources);
}

/** GET /api/resources/content?uri= — read a single resource by URI. */
export async function handleResourceContent(req: IncomingMessage, res: ServerResponse, ctx: RestContext): Promise<void> {
  if (!restAuthMiddleware(req, res, { token: ctx.authToken })) return;

  const url = new URL(req.url ?? '', 'http://localhost');
  const uri = url.searchParams.get('uri') ?? '';

  if (!uri || uri.trim().length === 0) {
    sendJson(res, 400, { error: "Missing required query parameter 'uri'." });
    return;
  }

  const sessionId = extractSessionId(req);
  const state = ctx.sessionStore.getOrCreate(sessionId);

  let response: ResponseData<ResponseResourceContent[]>;
  try {
    response = (await forwardToPlugin(ctx, Methods.RunResourceContent, {
      uri,
      requestID: generateRequestID(),
    }, {
      instanceId: state.activeInstanceId,
    })) as ResponseData<ResponseResourceContent[]>;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Plugin forwarding failed.';
    sendJson(res, 500, { error: message });
    return;
  }

  if (!response) {
    sendJson(res, 500, { error: 'Resource hub returned a null response.' });
    return;
  }
  if (response.status === 'error') {
    sendJson(res, 500, { error: response.message ?? `Resource '${uri}' returned an error.` });
    return;
  }

  const contents: Record<string, unknown>[] = [];
  if (response.value) {
    for (const c of response.value) {
      if (!c) continue;
      const entry: Record<string, unknown> = { uri: c.uri };
      if (c.mimeType != null) entry.mimeType = c.mimeType;
      if (c.text != null) entry.text = c.text;
      if (c.blob != null) entry.blob = c.blob;
      contents.push(entry);
    }
  }

  sendJson(res, 200, contents);
}

/** GET /api/resources/templates — list resource URI templates. */
export async function handleResourceTemplates(req: IncomingMessage, res: ServerResponse, ctx: RestContext): Promise<void> {
  if (!restAuthMiddleware(req, res, { token: ctx.authToken })) return;

  const sessionId = extractSessionId(req);
  const state = ctx.sessionStore.getOrCreate(sessionId);

  let response: ResponseData<ResponseResourceTemplate[]>;
  try {
    response = (await forwardToPlugin(ctx, Methods.RunResourceTemplates, {
      requestID: generateRequestID(),
    } as never, {
      instanceId: state.activeInstanceId,
    })) as ResponseData<ResponseResourceTemplate[]>;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Plugin forwarding failed.';
    sendJson(res, 500, { error: message });
    return;
  }

  if (!response) {
    sendJson(res, 500, { error: 'Resource hub returned a null response.' });
    return;
  }
  if (response.status === 'error') {
    sendJson(res, 500, { error: response.message ?? 'Failed to list resource templates.' });
    return;
  }

  const templates: Record<string, unknown>[] = [];
  if (response.value) {
    for (const t of response.value) {
      if (!t) continue;
      const entry: Record<string, unknown> = {
        uriTemplate: t.uriTemplate,
        name: t.name,
        enabled: t.enabled,
      };
      if (t.mimeType != null) entry.mimeType = t.mimeType;
      if (t.description != null) entry.description = t.description;
      templates.push(entry);
    }
  }

  sendJson(res, 200, templates);
}
