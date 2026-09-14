/**
 * REST router — assembles all 16 route handlers into a single http.RequestListener.
 *
 * Path matching is explicit (no framework). Routes are checked in order of
 * specificity (more specific paths before less specific ones).
 */

import type { IncomingMessage, ServerResponse, RequestListener } from 'node:http';
import { URL } from 'node:url';
import type { RestContext } from './context.js';
import { handleListTools, handleCallTool } from './tools.js';
import { handleListCalls, handleGetCall } from './calls.js';
import { handleListSystemTools, handleCallSystemTool } from './system-tools.js';
import { handleListPrompts, handleGetPrompt } from './prompts.js';
import { handleListResources, handleResourceContent, handleResourceTemplates } from './resources.js';
import {
  handleGetSession,
  handleEnableTools,
  handleDisableAllTools,
  handleListSessions,
} from './session.js';
import { handleSetInstance, handleClearInstance, handleListInstances } from './instances.js';
import { handleHelp } from './help.js';
import { handleLocalHealth, handleReadinessHealth } from './health.js';
import { sendError } from './context.js';
import { hasForbiddenOrigin } from '../origin.js';

/** Create the HTTP request listener that routes to all handlers. */
export function createRestRouter(ctx: RestContext): RequestListener {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '', 'http://localhost');
    const path = url.pathname;
    const method = req.method ?? 'GET';

    try {
      // This guard intentionally precedes public-route dispatch and bearer
      // authentication so browser requests cannot probe either surface.
      if (hasForbiddenOrigin(req)) {
        sendError(res, 403, 'forbidden-origin', 'Browser Origin requests are not allowed.', false);
        return;
      }

      // A handed-off listener is deliberately not a normal tool server until
      // its parent has durably published commit intent and committed this exact
      // instance over the same IPC channel.
      if (ctx.ownedRuntime?.phase === 'precommit' &&
          !(path === '/api/health' && method === 'GET')) {
        sendError(
          res,
          503,
          'owned-server-precommit',
          'The uco-owned server is awaiting handoff commit.',
          true,
        );
        return;
      }

      // GET /help — no auth required.
      if (path === '/help' && method === 'GET') {
        handleHelp(req, res);
        return;
      }

      if (path === '/health' && method === 'GET') {
        handleLocalHealth(req, res);
        return;
      }

      if (path === '/api/health' && method === 'GET') {
        handleReadinessHealth(req, res, ctx);
        return;
      }

      // GET /api/tools
      if (path === '/api/tools' && method === 'GET') {
        await handleListTools(req, res, ctx);
        return;
      }

      // POST /api/tools/{name}
      if (path.startsWith('/api/tools/') && method === 'POST') {
        const name = decodeURIComponent(path.slice('/api/tools/'.length));
        await handleCallTool(req, res, ctx, name);
        return;
      }

      // GET /api/calls/{callId} (before the /api/calls collection)
      if (path.startsWith('/api/calls/') && method === 'GET') {
        const callId = path.slice('/api/calls/'.length);
        await handleGetCall(req, res, ctx, callId);
        return;
      }

      // GET /api/calls
      if (path === '/api/calls' && method === 'GET') {
        await handleListCalls(req, res, ctx);
        return;
      }

      // GET /api/system-tools
      if (path === '/api/system-tools' && method === 'GET') {
        await handleListSystemTools(req, res, ctx);
        return;
      }

      // POST /api/system-tools/{name}
      if (path.startsWith('/api/system-tools/') && method === 'POST') {
        const name = decodeURIComponent(path.slice('/api/system-tools/'.length));
        await handleCallSystemTool(req, res, ctx, name);
        return;
      }

      // GET /api/prompts
      if (path === '/api/prompts' && method === 'GET') {
        await handleListPrompts(req, res, ctx);
        return;
      }

      // POST /api/prompts/{name}
      if (path.startsWith('/api/prompts/') && method === 'POST') {
        const name = decodeURIComponent(path.slice('/api/prompts/'.length));
        await handleGetPrompt(req, res, ctx, name);
        return;
      }

      // GET /api/resources/content?uri=
      if (path === '/api/resources/content' && method === 'GET') {
        await handleResourceContent(req, res, ctx);
        return;
      }

      // GET /api/resources/templates
      if (path === '/api/resources/templates' && method === 'GET') {
        await handleResourceTemplates(req, res, ctx);
        return;
      }

      // GET /api/resources
      if (path === '/api/resources' && method === 'GET') {
        await handleListResources(req, res, ctx);
        return;
      }

      // GET /api/session/all (before /api/session)
      if (path === '/api/session/all' && method === 'GET') {
        await handleListSessions(req, res, ctx);
        return;
      }

      // POST /api/session/enabled-tools
      if (path === '/api/session/enabled-tools' && method === 'POST') {
        await handleEnableTools(req, res, ctx);
        return;
      }

      // DELETE /api/session/enabled-tools
      if (path === '/api/session/enabled-tools' && method === 'DELETE') {
        await handleDisableAllTools(req, res, ctx);
        return;
      }

      // POST /api/session/instance
      if (path === '/api/session/instance' && method === 'POST') {
        await handleSetInstance(req, res, ctx);
        return;
      }

      // DELETE /api/session/instance
      if (path === '/api/session/instance' && method === 'DELETE') {
        await handleClearInstance(req, res, ctx);
        return;
      }

      // GET /api/session
      if (path === '/api/session' && method === 'GET') {
        await handleGetSession(req, res, ctx);
        return;
      }

      // GET /api/instances
      if (path === '/api/instances' && method === 'GET') {
        await handleListInstances(req, res, ctx);
        return;
      }

      // No route matched.
      sendError(res, 404, 'not-found', `Not found: ${method} ${path}`, false);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (!res.headersSent) {
        sendError(res, 500, 'internal-error', message, false);
      }
    }
  };
}
