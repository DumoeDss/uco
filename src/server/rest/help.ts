/**
 * REST route: GET /help — text/plain info message.
 * Matches the .NET Program.cs inline endpoint.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { HUB_PATH } from '../types.js';
import { sendText } from './context.js';

/** GET /help — informational message listing REST endpoints and WebSocket hub path. */
export function handleHelp(req: IncomingMessage, res: ServerResponse): void {
  // Help is always accessible even with auth configured (informational only).
  void req;

  const header =
    'Node MCP Server\n' +
    '\n' +
    'REST endpoints:\n' +
    '  GET  /api/tools                      — list all available tools\n' +
    '  POST /api/tools/{name}               — invoke a named tool\n' +
    '  GET  /api/system-tools               — list all system tools\n' +
    '  POST /api/system-tools/{name}        — invoke a system tool\n' +
    '  GET  /api/prompts                    — list all prompts\n' +
    '  POST /api/prompts/{name}             — resolve a prompt\n' +
    '  GET  /api/resources                  — list all resources\n' +
    '  GET  /api/resources/content?uri=     — read a resource\n' +
    '  GET  /api/resources/templates        — list resource templates\n' +
    '  GET  /api/session                    — get current session state\n' +
    '  POST /api/session/enabled-tools      — set enabled tools\n' +
    '  DELETE /api/session/enabled-tools    — disable all tools\n' +
    '  GET  /api/session/all                — list all sessions\n' +
    '  POST /api/session/instance           — pin session to instance\n' +
    '  DELETE /api/session/instance         — clear instance pin\n' +
    '  GET  /api/instances                  — list connected instances\n' +
    `WebSocket Hub: ${HUB_PATH}\n`;

  sendText(res, 200, header, 'text/plain');
}
