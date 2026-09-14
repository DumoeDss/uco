import type { IncomingMessage } from 'node:http';

/** Any non-empty browser Origin is forbidden until uco has an allowlist. */
export function hasForbiddenOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (Array.isArray(origin)) return origin.some((value) => value.length > 0);
  return typeof origin === 'string' && origin.length > 0;
}
