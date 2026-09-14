/**
 * REST routes: GET /api/calls, GET /api/calls/{callId} (COCli-09).
 *
 * Bounded query surface over the durable call-record store so an observed
 * transport timeout ("result unknown") can be resolved to a terminal state
 * afterwards, including late completions from NotifyToolRequestCompleted.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RestContext } from './context.js';
import { sendJson } from './context.js';
import { restAuthMiddleware } from './auth.js';
import type { CallRecordState } from '../calls/call-record-store.js';

const VALID_STATES: readonly CallRecordState[] = [
  'pending', 'processing', 'succeeded', 'failed', 'cancelled', 'abandoned',
];

/** GET /api/calls?limit=&state= — most recent call records. */
export async function handleListCalls(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RestContext,
): Promise<void> {
  if (!restAuthMiddleware(req, res, { token: ctx.authToken })) return;

  const url = new URL(req.url ?? '', 'http://localhost');
  const limitRaw = url.searchParams.get('limit');
  const stateRaw = url.searchParams.get('state');

  let limit = 50;
  if (limitRaw !== null) {
    const parsed = Number.parseInt(limitRaw, 10);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 200) {
      sendJson(res, 400, { error: 'limit must be an integer between 1 and 200.' });
      return;
    }
    limit = parsed;
  }
  let state: CallRecordState | undefined;
  if (stateRaw !== null && stateRaw.length > 0) {
    if (!VALID_STATES.includes(stateRaw as CallRecordState)) {
      sendJson(res, 400, { error: `state must be one of: ${VALID_STATES.join(', ')}.` });
      return;
    }
    state = stateRaw as CallRecordState;
  }

  const calls = ctx.callRecords.list({ limit, state });
  sendJson(res, 200, { count: calls.length, calls });
}

/** GET /api/calls/{callId} — one call record. */
export async function handleGetCall(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RestContext,
  callId: string,
): Promise<void> {
  if (!restAuthMiddleware(req, res, { token: ctx.authToken })) return;

  const decoded = decodeURIComponent(callId);
  const record = ctx.callRecords.get(decoded);
  if (record === undefined) {
    sendJson(res, 404, {
      error: `No call record '${decoded}'. Records are bounded (256 entries / 30 minutes) — list recent calls via GET /api/calls.`,
    });
    return;
  }
  sendJson(res, 200, { call: record });
}
