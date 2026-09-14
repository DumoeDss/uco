// Fetch the tool catalog from a live Unity-MCP server.
//
// Uses uco's own transport so it inherits port resolution, auth, and
// timeout handling. The catalog is written verbatim to
// src/generated/tools.json — agnostic to schema changes upstream.

import { writeFileSync } from 'node:fs';
import { resolveConnection } from '../config/resolve.js';
import type { ToolCatalogEntry } from './types.js';
import { canonicalCatalogJson, normalizeCatalogResponse } from '../catalog.js';

export interface FetchOptions {
  projectPath?: string;
  url?: string;
  token?: string;
  timeoutMs?: number;
}

export async function fetchTools(opts: FetchOptions): Promise<ToolCatalogEntry[]> {
  const resolved = resolveConnection({
    ...(opts.projectPath ? { projectPath: opts.projectPath } : {}),
    ...(opts.url ? { url: opts.url } : {}),
    ...(opts.token ? { token: opts.token } : {}),
  });
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (resolved.token) headers['Authorization'] = `Bearer ${resolved.token}`;
  const res = await fetch(`${resolved.baseUrl}/api/tools`, {
    headers,
    ...(opts.timeoutMs ? { signal: AbortSignal.timeout(opts.timeoutMs) } : {}),
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch /api/tools: HTTP ${res.status} ${res.statusText}`);
  }
  return normalizeCatalogResponse(await res.json());
}

export function writeCatalog(tools: ToolCatalogEntry[], outPath: string): void {
  writeFileSync(outPath, canonicalCatalogJson(tools), 'utf8');
}
