/**
 * Method dispatch table for the 7 server-facing RPC methods.
 *
 * Each handler receives (params, context) and returns the result value that
 * will be placed in the RpcResponse `result` field.
 *
 * @see design.md §D3 for the full method table.
 */

import type {
  RequestVersionHandshake,
  RequestToolsUpdated,
  RequestPromptsUpdated,
  RequestResourcesUpdated,
  RequestToolCompletedData,
  ResponseData,
  VersionHandshakeResponse,
  McpClientData,
  McpServerData,
} from '../types.js';
import { ServerFacingMethod } from '../types.js';
import type { PendingTracker } from './pending.js';
import type { ConnectionRegistry } from './registry.js';

export interface RpcContext {
  connectionId: string;
  registry: ConnectionRegistry;
  pending: PendingTracker;
  /** Server API version for handshake compatibility check. */
  serverApiVersion: string;
  /** Server version string. */
  serverVersion: string;
  /** Callbacks for tool/prompt/resource update events. */
  onToolsUpdated?: (connectionId: string, tools: unknown[]) => void;
  onPromptsUpdated?: (connectionId: string, prompts: unknown) => void;
  onResourcesUpdated?: (connectionId: string, resources: unknown[]) => void;
  onPluginConnected?: (connectionId: string, token: string | undefined, environment: unknown, pluginVersion: string) => void;
  onPluginDisconnected?: (connectionId: string) => void;
  /**
   * Durable completion observer for deferred tool calls. Invoked for every
   * NotifyToolRequestCompleted — including late arrivals whose pending entry
   * already settled — so the call-record store stays authoritative even when
   * the tracker no longer correlates the request.
   */
  onCallRecordCompleted?: (requestId: string, operationId: string | undefined, result: unknown, isError: boolean) => void;
  /** Connected MCP client metadata for GetMcpClientData. */
  clientData?: McpClientData[];
}

type RpcHandler = (params: unknown, ctx: RpcContext) => unknown | Promise<unknown>;

function asRecord(params: unknown): Record<string, unknown> {
  if (typeof params === 'object' && params !== null && !Array.isArray(params)) {
    return params as Record<string, unknown>;
  }
  return {};
}

function successResponse(requestId?: string | null, message?: string): ResponseData {
  const res: ResponseData = { status: 'success' };
  if (requestId) res.requestID = requestId;
  if (message !== undefined) res.message = message;
  return res;
}

// ===== Handlers =====

const PerformVersionHandshakeHandler: RpcHandler = (params, ctx) => {
  const p = asRecord(params) as Partial<RequestVersionHandshake>;
  const pluginApiVersion = p.apiVersion ?? '';
  const serverApiVersion = ctx.serverApiVersion;
  const compatible = pluginApiVersion.toLowerCase() === serverApiVersion.toLowerCase();

  const response: VersionHandshakeResponse = {
    apiVersion: serverApiVersion,
    serverVersion: ctx.serverVersion,
    compatible,
    message: compatible
      ? 'API version is compatible.'
      : `API version mismatch. Plugin: ${pluginApiVersion}, Server: ${serverApiVersion}. Please update to compatible versions.`,
  };

  const capabilities = Array.isArray(p.capabilities) ? p.capabilities : [];
  // bridge-identity-v1 members ride the handshake payload; the registry keeps
  // them only for peers that advertised the capability.
  const identity = capabilities.includes('bridge-identity-v1')
    ? {
        projectPath: p.projectPath ?? undefined,
        editorPid: p.editorPid ?? undefined,
        unityVersion: p.unityVersion ?? undefined,
      }
    : undefined;

  ctx.registry.markHandshake(
    ctx.connectionId,
    compatible,
    capabilities,
    typeof p.generation === 'number' ? p.generation : undefined,
    identity,
  );

  // Plugins may report their instanceId inside the handshake payload even when
  // the connect query/header did not carry it; adopt it as a fallback so
  // identity tuples and routing assertions are not needlessly unavailable.
  if (typeof p.instanceId === 'string' && p.instanceId.trim().length > 0) {
    ctx.registry.setInstanceId(ctx.connectionId, p.instanceId);
  }

  if (compatible) {
    const entry = ctx.registry.get(ctx.connectionId);
    ctx.onPluginConnected?.(ctx.connectionId, entry?.token, p.environment, p.pluginVersion ?? '');
  }

  return response;
};

const GetMcpClientDataHandler: RpcHandler = (_params, ctx) => {
  return ctx.clientData ?? [];
};

const GetMcpServerDataHandler: RpcHandler = (_params, ctx) => {
  const serverData: McpServerData = {
    isAiAgentConnected: true,
    serverVersion: ctx.serverVersion,
    serverApiVersion: ctx.serverApiVersion,
  };
  return serverData;
};

const NotifyAboutUpdatedToolsHandler: RpcHandler = (params, ctx) => {
  const p = asRecord(params) as Partial<RequestToolsUpdated>;
  ctx.onToolsUpdated?.(ctx.connectionId, p.tools ?? []);
  ctx.registry.markToolsRegistered(ctx.connectionId);
  return successResponse(p.requestId ?? undefined, 'Received tools update notification');
};

const NotifyAboutUpdatedPromptsHandler: RpcHandler = (params, ctx) => {
  const p = asRecord(params) as Partial<RequestPromptsUpdated>;
  ctx.onPromptsUpdated?.(ctx.connectionId, p.prompts);
  ctx.registry.markPromptsRegistered(ctx.connectionId);
  return successResponse(p.requestId ?? undefined, 'Received prompts update notification');
};

const NotifyAboutUpdatedResourcesHandler: RpcHandler = (params, ctx) => {
  const p = asRecord(params) as Partial<RequestResourcesUpdated>;
  ctx.onResourcesUpdated?.(ctx.connectionId, p.resources ?? []);
  ctx.registry.markResourcesRegistered(ctx.connectionId);
  return successResponse(p.requestId ?? undefined, 'Received resources update notification');
};

const NotifyToolRequestCompletedHandler: RpcHandler = (params, ctx) => {
  const p = asRecord(params) as Partial<RequestToolCompletedData>;
  const requestId = p.requestId ?? '';
  // A deferred completion may carry a failed tool result; classify it from the
  // payload instead of unconditionally resolving as success.
  const isError = readCompletedStatus(p.result) === 'error';
  // Resolve the deferred pending tool call (if any).
  // Wrap in ResponseData so the shape matches the direct RPC response path
  // (forwardToPlugin always yields ResponseData<T> to the REST handler).
  if (p.result !== undefined) {
    ctx.pending.resolveDeferred(requestId, isError
      ? {
          requestID: requestId,
          operationID: p.operationId,
          status: 'error',
          message: firstCompletedErrorText(p.result) ?? 'Deferred tool call failed.',
          value: p.result,
        }
      : {
          requestID: requestId,
          operationID: p.operationId,
          status: 'success',
          value: p.result,
        }, p.operationId);
  }
  // Always observe the completion, even when the tracker no longer correlates
  // the request (settled/expired): the durable call-record store keys by
  // requestId independently and must learn about late terminal states.
  ctx.onCallRecordCompleted?.(requestId, p.operationId, p.result, isError);
  return successResponse(requestId, '');
};

function readCompletedStatus(result: unknown): string | undefined {
  if (result === null || typeof result !== 'object' || Array.isArray(result)) return undefined;
  const status = (result as Record<string, unknown>)['status'];
  return typeof status === 'string' ? status.toLowerCase() : undefined;
}

/** Bounded first text block of a completed tool result (error diagnostics). */
function firstCompletedErrorText(result: unknown, maxLen = 1024): string | undefined {
  if (result === null || typeof result !== 'object' || Array.isArray(result)) return undefined;
  const content = (result as Record<string, unknown>)['content'];
  if (!Array.isArray(content)) return undefined;
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue;
    const record = block as Record<string, unknown>;
    if (record['type'] !== 'text' || typeof record['text'] !== 'string') continue;
    const trimmed = record['text'].trim();
    if (trimmed.length === 0) continue;
    return trimmed.length <= maxLen ? trimmed : `${trimmed.slice(0, maxLen)}…`;
  }
  return undefined;
}

// ===== Dispatch table =====

export const serverRpcHandlers: Record<string, RpcHandler> = {
  [ServerFacingMethod.PerformVersionHandshake]: PerformVersionHandshakeHandler,
  [ServerFacingMethod.GetMcpClientData]: GetMcpClientDataHandler,
  [ServerFacingMethod.GetMcpServerData]: GetMcpServerDataHandler,
  [ServerFacingMethod.NotifyAboutUpdatedTools]: NotifyAboutUpdatedToolsHandler,
  [ServerFacingMethod.NotifyAboutUpdatedPrompts]: NotifyAboutUpdatedPromptsHandler,
  [ServerFacingMethod.NotifyAboutUpdatedResources]: NotifyAboutUpdatedResourcesHandler,
  [ServerFacingMethod.NotifyToolRequestCompleted]: NotifyToolRequestCompletedHandler,
};
