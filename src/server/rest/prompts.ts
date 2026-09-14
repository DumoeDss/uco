/**
 * REST routes: GET /api/prompts, POST /api/prompts/{name}
 *
 * Response shapes match the .NET PromptEndpoints.cs exactly.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RestContext } from './context.js';
import { sendJson, readJsonBody } from './context.js';
import { forwardToPlugin, generateRequestID } from './forward.js';
import { restAuthMiddleware, extractSessionId } from './auth.js';
import type { ResponseData, ResponseListPrompts, ResponseGetPrompt } from '../types.js';
import { ClientFacingMethod as Methods } from '../types.js';

/** GET /api/prompts — list all registered prompts. */
export async function handleListPrompts(req: IncomingMessage, res: ServerResponse, ctx: RestContext): Promise<void> {
  if (!restAuthMiddleware(req, res, { token: ctx.authToken })) return;

  const sessionId = extractSessionId(req);
  const state = ctx.sessionStore.getOrCreate(sessionId);

  let response: ResponseData<ResponseListPrompts>;
  try {
    response = (await forwardToPlugin(ctx, Methods.RunListPrompts, {
      requestID: generateRequestID(),
    } as never, {
      instanceId: state.activeInstanceId,
    })) as ResponseData<ResponseListPrompts>;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Plugin forwarding failed.';
    sendJson(res, 500, { error: message });
    return;
  }

  if (!response) {
    sendJson(res, 500, { error: 'Prompt hub returned a null response.' });
    return;
  }
  if (response.status === 'error') {
    sendJson(res, 500, { error: response.message ?? 'Failed to list prompts.' });
    return;
  }

  const prompts: Record<string, unknown>[] = [];
  if (response.value?.prompts) {
    for (const p of response.value.prompts) {
      if (!p) continue;
      const entry: Record<string, unknown> = {
        name: p.name,
        enabled: p.enabled,
      };
      if (p.title != null) entry.title = p.title;
      if (p.description != null) entry.description = p.description;
      if (p.arguments) {
        entry.arguments = p.arguments.map((a) => {
          const arg: Record<string, unknown> = { name: a.name };
          if (a.description != null) arg.description = a.description;
          if (a.required != null) arg.required = a.required;
          return arg;
        });
      }
      prompts.push(entry);
    }
  }

  sendJson(res, 200, prompts);
}

/** POST /api/prompts/{name} — resolve a prompt by name with JSON arguments. */
export async function handleGetPrompt(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RestContext,
  promptName: string,
): Promise<void> {
  if (!restAuthMiddleware(req, res, { token: ctx.authToken })) return;

  if (!promptName || promptName.trim().length === 0) {
    sendJson(res, 400, { error: 'Prompt name must not be empty.' });
    return;
  }

  let arguments_: Record<string, unknown>;
  try {
    const body = await readJsonBody(req);
    if (body === null) {
      arguments_ = {};
    } else if (typeof body === 'object' && !Array.isArray(body)) {
      arguments_ = body as Record<string, unknown>;
    } else {
      arguments_ = {};
    }
  } catch {
    arguments_ = {};
  }

  const sessionId = extractSessionId(req);
  const state = ctx.sessionStore.getOrCreate(sessionId);

  let response: ResponseData<ResponseGetPrompt>;
  try {
    response = (await forwardToPlugin(ctx, Methods.RunGetPrompt, {
      name: promptName,
      arguments: arguments_,
      requestID: generateRequestID(),
    }, {
      instanceId: state.activeInstanceId,
    })) as ResponseData<ResponseGetPrompt>;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Plugin forwarding failed.';
    sendJson(res, 500, { error: message });
    return;
  }

  if (!response) {
    sendJson(res, 500, { error: 'Prompt hub returned a null response.' });
    return;
  }
  if (response.status === 'error') {
    sendJson(res, 500, { error: response.message ?? `Prompt '${promptName}' returned an error.` });
    return;
  }

  const prompt = response.value;
  if (!prompt) {
    sendJson(res, 200, { status: 'success' });
    return;
  }

  const result: Record<string, unknown> = {};
  if (prompt.description != null) result.description = prompt.description;

  const messages = (prompt.messages ?? []).map((m) => {
    const msgObj: Record<string, unknown> = { role: m.role };
    if (m.content != null) msgObj.content = m.content;
    return msgObj;
  });
  result.messages = messages;

  sendJson(res, 200, result);
}
