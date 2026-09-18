// Transport abstraction for uco.
//
// The CLI's commands depend only on the UnityCoTransport interface.
// Today there is a single REST implementation that talks to the
// upstream bridge-Server's /api/tools/{name} side-channel — the
// same HTTP API the legacy `run-tool` used, which
// means there is no protocol baggage on this wire.
//
// If we ever need a different wire format (e.g. our own forked
// server, gRPC, in-process testing), we drop in a new implementation
// behind this interface and command code stays untouched.

import type {
  ToolCallControl,
  ToolCallConfirmation,
  ToolCallContext,
  ToolCallDryRun,
} from '../tool-call-control.js';

export interface ToolSafetyHints {
  readOnlyHint?: boolean | null;
  destructiveHint?: boolean | null;
  idempotentHint?: boolean | null;
  openWorldHint?: boolean | null;
}

export interface ToolInfo extends ToolSafetyHints {
  name: string;
  enabled?: boolean;
  title?: string | null;
  description?: string | null;
  inputSchema?: unknown;
  outputSchema?: unknown;
  [member: string]: unknown;
}

export interface PromptInfo {
  name: string;
  enabled?: boolean;
  title?: string;
  description?: string;
  arguments?: Array<{
    name: string;
    description?: string;
    required?: boolean;
  }>;
}

export interface ResourceInfo {
  uri: string;
  name?: string;
  enabled?: boolean;
  title?: string;
  description?: string;
  mimeType?: string;
}

export interface CallOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Optional versioned control metadata for a regular/system tool call. */
  control?: ToolCallControl | ToolCallContext | null;
  /** Alias for `control` when the caller already has a runtime context. */
  context?: ToolCallContext | null;
  /** Compatibility/deferred-completion id when it differs from callId. */
  requestID?: string | null;
  /** COCli-09 fire-and-forget: POST ?async=1 and return the 202 accepted envelope. */
  asyncRequest?: boolean;
  /** Convenience fields merged into `control` by the shared adapter. */
  callId?: string | null;
  correlationId?: string | null;
  parentCallId?: string | null;
  deadlineUnixMs?: number | null;
  cancellationId?: string | null;
  idempotencyKey?: string | null;
  controlVersion?: number | null;
  /** Authoring approval directive (serialized under `control`). */
  confirm?: boolean | null;
  /** Exact g-005 dry-run mode. */
  dryRun?: ToolCallDryRun | null;
  /** Opaque plan token returned by a Unity plan response. */
  confirmation?: ToolCallConfirmation | null;
}

export interface UnityCoTransport {
  /** Query Node-local and bridge registration readiness without forwarding to Unity. */
  health(opts?: CallOptions): Promise<unknown>;
  /** Liveness probe. Resolves with whatever the server returns; rejects on network / HTTP failure. */
  ping(opts?: CallOptions): Promise<unknown>;

  /** Enumerate the regular tool catalog the server exposes. */
  listTools(opts?: CallOptions): Promise<ToolInfo[]>;

  /** Invoke a registered tool by name. */
  callTool(name: string, args: Record<string, unknown>, opts?: CallOptions): Promise<unknown>;

  /** Invoke a system tool (e.g. ping, skill-generate) — not exposed in the regular tool list. */
  callSystemTool(name: string, args: Record<string, unknown>, opts?: CallOptions): Promise<unknown>;

  /** Enumerate the prompt catalog (preset instruction templates). */
  listPrompts(opts?: CallOptions): Promise<PromptInfo[]>;

  /** Resolve a named prompt with JSON arguments; returns the prompt's messages. */
  callPrompt(name: string, args: Record<string, unknown>, opts?: CallOptions): Promise<unknown>;

  /** Enumerate the resource catalog (read-only state providers). */
  listResources(opts?: CallOptions): Promise<ResourceInfo[]>;

  /** Read a single resource by URI; returns the resource content blocks. */
  readResource(uri: string, opts?: CallOptions): Promise<unknown>;

  /** COCli-09: fetch one durable call record by id. */
  getCall(callId: string, opts?: CallOptions): Promise<unknown>;
  /** COCli-09: list recent durable call records. */
  listCalls(query?: { limit?: number; state?: string }, opts?: CallOptions): Promise<unknown>;
}

export { RestTransport } from './rest.js';
export type { RestTransportConfig } from './rest.js';
