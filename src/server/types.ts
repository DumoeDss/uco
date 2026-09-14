/**
 * Shared TypeScript types for the Node MCP server.
 *
 * These mirror the C# model types in uco-framework/Uco.Framework.Common/src/Data/.
 * The JSON wire format must match the .NET server exactly (camelCase).
 *
 * @see design.md §D4 for the envelope contract.
 */

import type { ToolCallControl, ToolCallStructuredError } from '../tool-call-control.js';

export type { ToolCallControl } from '../tool-call-control.js';

// ===== Response status (mirrors C# ResponseStatus enum, lowercase on wire) =====

export type ResponseStatus = 'error' | 'success' | 'processing';

// ===== Content block (mirrors C# ContentBlock) =====

export interface ContentBlock {
  type: string;
  text?: string | null;
  data?: string | null;
  mimeType?: string | null;
  resource?: ResponseResourceContent | null;
}

// ===== Request types (mirrors C# Data/Request/) =====

export interface RequestCallTool {
  name: string;
  arguments: Record<string, unknown>;
  requestID: string;
  control?: ToolCallControl;
}

export interface RequestListTool {
  requestID: string;
}

export interface RequestGetPrompt {
  name: string;
  arguments?: Record<string, unknown> | null;
  requestID: string;
}

export interface RequestListPrompts {
  requestID: string;
}

export interface RequestResourceContent {
  uri: string;
  requestID: string;
}

export interface RequestListResources {
  requestID: string;
}

export interface RequestListResourceTemplates {
  requestID: string;
}

export interface RequestVersionHandshake {
  pluginVersion: string;
  apiVersion: string;
  environment?: Record<string, unknown> | string | null;
  capabilities?: string[];
  generation?: number;
  /** bridge-identity-v1 members (capability-gated, additive). */
  projectPath?: string | null;
  editorPid?: number | null;
  unityVersion?: string | null;
  instanceId?: string | null;
}

export interface RequestToolsUpdated {
  requestId?: string | null;
  tools: ResponseListTool[];
}

export interface RequestPromptsUpdated {
  requestId?: string | null;
  prompts: ResponseListPrompts;
}

export interface RequestResourcesUpdated {
  requestId?: string | null;
  resources: ResponseListResource[];
}

export interface RequestToolCompletedData {
  requestId: string;
  operationId?: string;
  result: ResponseCallTool;
}

export interface RequestCancelToolCall {
  requestID: string;
  callId: string;
  cancellationId: string;
  generation: number;
  reason: string;
}

export interface ResponseCancelToolCall {
  accepted: boolean;
  code: string;
  message: string;
}

// ===== Response wrapper (mirrors C# ResponseData<T>) =====

export interface ResponseData<T = unknown> {
  requestID?: string;
  status: ResponseStatus;
  message?: string | null;
  value?: T;
  /** Optional additive structured error for controlled calls. */
  error?: ToolCallStructuredError | null;
}

// ===== Value types (mirrors C# Data/Response/) =====

export interface ResponseCallTool {
  requestID?: string;
  status?: ResponseStatus;
  content: ContentBlock[];
  structuredContent?: unknown;
  /** Optional immediate authoring transaction report. */
  transaction?: unknown;
  /** Optional additive structured error for controlled execution failures. */
  error?: ToolCallStructuredError | null;
}

export interface ResponseListTool {
  name: string;
  enabled: boolean;
  title?: string | null;
  description?: string | null;
  inputSchema?: unknown;
  outputSchema?: unknown;
  readOnlyHint?: boolean | null;
  destructiveHint?: boolean | null;
  idempotentHint?: boolean | null;
  openWorldHint?: boolean | null;
  executionAffinity?: 'main-thread' | 'background' | 'either';
  threadSafeRead?: boolean;
  [member: string]: unknown;
}

export interface ResponsePromptMessage {
  role: string;
  content: ContentBlock | ContentBlock[] | string;
}

export interface ResponseGetPrompt {
  description?: string | null;
  messages: ResponsePromptMessage[];
}

export interface ResponsePromptArgument {
  name: string;
  title?: string | null;
  description?: string | null;
  required?: boolean | null;
}

export interface ResponsePrompt {
  name: string;
  enabled: boolean;
  title?: string | null;
  description?: string | null;
  arguments?: ResponsePromptArgument[] | null;
}

export interface ResponseListPrompts {
  prompts: ResponsePrompt[];
}

export interface ResponseResourceContent {
  uri: string;
  mimeType?: string | null;
  text?: string | null;
  blob?: string | null;
}

export interface ResponseListResource {
  uri: string;
  name: string;
  enabled: boolean;
  mimeType?: string | null;
  description?: string | null;
  size?: number | null;
}

export interface ResponseResourceTemplate {
  uriTemplate: string;
  name: string;
  enabled: boolean;
  mimeType?: string | null;
  description?: string | null;
}

export interface VersionHandshakeResponse {
  apiVersion: string;
  serverVersion: string;
  compatible: boolean;
  message: string;
}

export interface McpClientData {
  isConnected: boolean;
  sessionId?: string | null;
  clientTitle?: string | null;
  clientName?: string | null;
  clientVersion?: string | null;
  clientDescription?: string | null;
  clientWebsiteUrl?: string | null;
}

export interface McpServerData {
  serverVersion?: string;
  serverApiVersion?: string;
  isAiAgentConnected: boolean;
}

// ===== Method name constants (the 21 RPC methods) =====

export const ServerFacingMethod = {
  PerformVersionHandshake: 'PerformVersionHandshake',
  GetMcpClientData: 'GetMcpClientData',
  GetMcpServerData: 'GetMcpServerData',
  NotifyAboutUpdatedTools: 'NotifyAboutUpdatedTools',
  NotifyAboutUpdatedPrompts: 'NotifyAboutUpdatedPrompts',
  NotifyAboutUpdatedResources: 'NotifyAboutUpdatedResources',
  NotifyToolRequestCompleted: 'NotifyToolRequestCompleted',
} as const;

export const ClientFacingMethod = {
  RunCallTool: 'RunCallTool',
  CancelToolCall: 'CancelToolCall',
  RunListTool: 'RunListTool',
  RunGetPrompt: 'RunGetPrompt',
  RunListPrompts: 'RunListPrompts',
  RunResourceContent: 'RunResourceContent',
  RunListResources: 'RunListResources',
  RunResourceTemplates: 'RunResourceTemplates',
  RunSystemTool: 'RunSystemTool',
  RunListSystemTool: 'RunListSystemTool',
  ForceDisconnect: 'ForceDisconnect',
  OnInitialClientData: 'OnInitialClientData',
  OnMcpClientConnected: 'OnMcpClientConnected',
  OnMcpClientDisconnected: 'OnMcpClientDisconnected',
} as const;

/** All additive and legacy valid method names. */
export const ALL_METHODS: ReadonlySet<string> = new Set<string>([
  ...Object.values(ServerFacingMethod),
  ...Object.values(ClientFacingMethod),
]);

// ===== Hub path and defaults =====

export const HUB_PATH = '/hub/mcp-server';
export const DEFAULT_PORT = 8080;
export const HEARTBEAT_METHOD = 'Heartbeat';
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 20_000;
export const DEFAULT_PLUGIN_TIMEOUT_MS = 10_000;
export const TOOL_CALL_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
export const MAX_RETRIES = 0;
export const RETRY_DELAY_MS = 1000;
export const SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
export const STDIO_SESSION_ID = 'stdio';
export const SESSION_ID_HEADER = 'mcp-session-id';
export const INSTANCE_ID_HEADER = 'mcp-instance-id';
export const WS_AUTH_CLOSE_CODE = 4001;
