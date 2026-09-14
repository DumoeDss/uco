/**
 * Bearer-token auth middleware + session-ID resolution.
 *
 * When `token` is configured:
 *   - REST: validate `Authorization: Bearer {token}` → 401 on mismatch
 *   - WS: validate `?access_token=` query param or `Authorization` header
 *
 * When `token` is empty: all endpoints open (auth=none).
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { SESSION_ID_HEADER, STDIO_SESSION_ID } from '../types.js';
import { sendError } from './context.js';

export interface AuthOptions {
  token?: string;
}

/**
 * REST auth middleware. Returns true if the request is authorized, false if
 * a 401 response was sent.
 */
export function restAuthMiddleware(
  req: IncomingMessage,
  res: ServerResponse,
  opts: AuthOptions,
): boolean {
  if (!opts.token) return true; // auth=none

  const auth = req.headers['authorization'];
  if (!auth) {
    sendUnauthorized(res, 'Missing Authorization header.');
    return false;
  }

  const match = /^Bearer\s+(.+)$/i.exec(auth);
  if (!match || !tokensMatch(match[1], opts.token)) {
    sendUnauthorized(res, 'Invalid or mismatched bearer token.');
    return false;
  }

  return true;
}

/**
 * Extract the session ID from the Mcp-Session-Id header.
 * Returns the stdio sentinel when the header is absent.
 */
export function extractSessionId(req: IncomingMessage): string {
  const raw = req.headers[SESSION_ID_HEADER];
  if (typeof raw === 'string' && raw.length > 0) return raw;
  return STDIO_SESSION_ID;
}

function sendUnauthorized(res: ServerResponse, message: string): void {
  sendError(res, 401, 'unauthorized', message, false);
}

/**
 * Constant-time string comparison to mitigate timing attacks on auth tokens.
 * Returns true when the strings are equal. When lengths differ, returns
 * false immediately (timingSafeEqual throws on unequal-length buffers).
 */
function tokensMatch(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}
