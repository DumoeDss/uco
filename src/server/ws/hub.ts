/**
 * WebSocket hub — accepts plugin connections at /hub/mcp-server.
 *
 * Responsibilities:
 *   - Validate auth token from query param (?access_token=) or header
 *   - Register connection in registry
 *   - Dispatch incoming messages: parse envelope → route to RPC handler or
 *     resolve pending REST-forwarded request
 *   - Handle close/error: unregister connection, reject pending requests
 *   - Send OnInitialClientData notification on connect
 *   - Broadcast OnMcpClientConnected / OnMcpClientDisconnected notifications
 */

import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'node:http';
import type { Server } from 'node:http';
import { URL } from 'node:url';
import { timingSafeEqual } from 'node:crypto';
import { hasForbiddenOrigin } from '../origin.js';
import type { OwnedServerRuntime } from '../app.js';

import type { ConnectionRegistry, ConnectionEntry } from './registry.js';
import type { PendingTracker } from './pending.js';
import { serverRpcHandlers, type RpcContext } from './rpc.js';
import {
  parseMessage,
  makeErrorResponse,
  makeResponse,
  makeNotification,
  serializeMessage,
  ErrorCode,
  isRequest,
  isResponse,
  isNotification,
  extractDurableOperationId,
} from './envelope.js';
import {
  isToolCallControlError,
  toStructuredToolCallError,
  type ToolCallStructuredError,
} from '../../tool-call-control.js';
import {
  HUB_PATH,
  ClientFacingMethod,
  HEARTBEAT_METHOD,
  type McpClientData,
} from '../types.js';

export interface HubOptions {
  registry: ConnectionRegistry;
  pending: PendingTracker;
  authToken?: string;
  serverApiVersion: string;
  serverVersion: string;
  heartbeatIntervalMs: number;
  clientData?: McpClientData[];
  onToolsUpdated?: (connectionId: string, tools: unknown[]) => void;
  onPromptsUpdated?: (connectionId: string, prompts: unknown) => void;
  onResourcesUpdated?: (connectionId: string, resources: unknown[]) => void;
  onPluginConnected?: (connectionId: string, token: string | undefined, environment: unknown, pluginVersion: string) => void;
  onPluginDisconnected?: (connectionId: string) => void;
  /** Durable call-record completion observer (COCli-09), fed from NotifyToolRequestCompleted. */
  onCallRecordCompleted?: (requestId: string, operationId: string | undefined, result: unknown, isError: boolean) => void;
  ownedRuntime?: OwnedServerRuntime;
}

export class McpHub {
  private wss: WebSocketServer | null = null;
  private readonly registry: ConnectionRegistry;
  private readonly pending: PendingTracker;
  private readonly authToken?: string;
  private readonly serverApiVersion: string;
  private readonly serverVersion: string;
  private readonly heartbeatIntervalMs: number;
  private readonly clientData: McpClientData[];
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  private readonly onToolsUpdated?: (connectionId: string, tools: unknown[]) => void;
  private readonly onPromptsUpdated?: (connectionId: string, prompts: unknown) => void;
  private readonly onResourcesUpdated?: (connectionId: string, resources: unknown[]) => void;
  private readonly onPluginConnected?: (connectionId: string, token: string | undefined, environment: unknown, pluginVersion: string) => void;
  private readonly onPluginDisconnected?: (connectionId: string) => void;
  private readonly onCallRecordCompleted?: (requestId: string, operationId: string | undefined, result: unknown, isError: boolean) => void;
  private readonly ownedRuntime?: OwnedServerRuntime;

  constructor(opts: HubOptions) {
    this.registry = opts.registry;
    this.pending = opts.pending;
    this.authToken = opts.authToken;
    this.serverApiVersion = opts.serverApiVersion;
    this.serverVersion = opts.serverVersion;
    this.heartbeatIntervalMs = opts.heartbeatIntervalMs;
    this.clientData = opts.clientData ?? [];
    this.onToolsUpdated = opts.onToolsUpdated;
    this.onPromptsUpdated = opts.onPromptsUpdated;
    this.onResourcesUpdated = opts.onResourcesUpdated;
    this.onPluginConnected = opts.onPluginConnected;
    this.onPluginDisconnected = opts.onPluginDisconnected;
    this.onCallRecordCompleted = opts.onCallRecordCompleted;
    this.ownedRuntime = opts.ownedRuntime;
  }

  /**
   * Attach to an existing HTTP server. Handles WebSocket upgrades at HUB_PATH only.
   */
  attach(server: Server): void {
    this.wss = new WebSocketServer({ noServer: true });
    this.heartbeatTimer = setInterval(() => {
      this.broadcastNotification(HEARTBEAT_METHOD, {
        timestampUtc: new Date().toISOString(),
      });
    }, this.heartbeatIntervalMs);

    server.on('upgrade', (req: IncomingMessage, socket, head) => {
      const { pathname, searchParams } = this.parseUrl(req);
      if (pathname !== HUB_PATH) {
        // Not our route — let other upgrade handlers deal with it (or destroy).
        return;
      }

      if (hasForbiddenOrigin(req)) {
        const body = JSON.stringify({
          ok: false,
          error: {
            code: 'forbidden-origin',
            message: 'Browser Origin requests are not allowed.',
            retryable: false,
          },
        });
        socket.write(
          'HTTP/1.1 403 Forbidden\r\n' +
          'Connection: close\r\n' +
          'Content-Type: application/json\r\n' +
          `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
        );
        socket.destroy();
        return;
      }

      if (this.ownedRuntime?.phase === 'precommit') {
        const body = JSON.stringify({
          ok: false,
          error: {
            code: 'owned-server-precommit',
            message: 'The uco-owned server is awaiting handoff commit.',
            retryable: true,
          },
        });
        socket.write(
          'HTTP/1.1 503 Service Unavailable\r\n' +
          'Connection: close\r\n' +
          'Content-Type: application/json\r\n' +
          `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
        );
        socket.destroy();
        return;
      }

      // Auth check.
      if (this.authToken) {
        const token = searchParams.get('access_token') ?? this.extractBearerToken(req);
        if (!tokensMatch(token, this.authToken)) {
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
          socket.destroy();
          return;
        }
      }

      this.wss!.handleUpgrade(req, socket, head, (ws: WebSocket) => {
        // Extract instanceId from query or header.
        const instanceId = searchParams.get('instanceId')
          ?? req.headers['mcp-instance-id']?.toString()
          ?? undefined;
        const token = this.authToken
          ? (searchParams.get('access_token') ?? this.extractBearerToken(req) ?? undefined)
          : undefined;

        this.onConnection(ws, token, instanceId);
      });
    });
  }

  private onConnection(ws: WebSocket, token: string | undefined, instanceId: string | undefined): void {
    const connectionId = this.registry.register(ws, { token, instanceId });

    // Send OnInitialClientData notification.
    const notif = makeNotification(ClientFacingMethod.OnInitialClientData, {
      clients: this.clientData,
    });
    this.safeSend(ws, notif);

    // Tell every connection (this one included) that a new plugin joined.
    // Params shape mirrors the C# OnMcpClientConnectedParams wrapper (camelCase):
    // { connected: McpClientData, all: McpClientData[] }.
    const connectedData = this.clientDataFor(this.registry.get(connectionId));
    if (connectedData) {
      this.broadcastNotification(ClientFacingMethod.OnMcpClientConnected, {
        connected: connectedData,
        all: this.connectionsClientData(),
      });
    }

    // Track whether the disconnect callback has already fired (socket error
    // is typically followed by close — guard against double-fire).
    let disconnected = false;
    const onDisconnect = (reason: string): void => {
      if (disconnected) return;
      disconnected = true;
      // Capture the leaving client's data before unregistering — the registry
      // entry is gone afterwards.
      const leaving = this.clientDataFor(this.registry.get(connectionId));
      this.registry.unregister(connectionId);
      this.pending.rejectAllForConnection(connectionId, {
        code: ErrorCode.PLUGIN_NOT_CONNECTED,
        message: reason,
      });
      this.onPluginDisconnected?.(connectionId);
      // Tell the remaining connections this plugin went away. When the entry
      // is already gone (e.g. ForceDisconnect-replaced in single-plugin mode)
      // there is nothing meaningful to report — skip.
      // Params shape mirrors the C# OnMcpClientDisconnectedParams wrapper:
      // { disconnected: McpClientData, remaining: McpClientData[] }.
      if (leaving) {
        this.broadcastNotification(ClientFacingMethod.OnMcpClientDisconnected, {
          disconnected: { ...leaving, isConnected: false },
          remaining: this.connectionsClientData(),
        });
      }
    };

    ws.on('message', (data: Buffer | Buffer[], isBinary: boolean) => {
      const text = Buffer.isBuffer(data)
        ? data.toString('utf8')
        : Array.isArray(data)
          ? Buffer.concat(data).toString('utf8')
          : String(data);
      this.onMessage(ws, connectionId, text);
    });

    ws.on('close', () => {
      onDisconnect('Plugin connection closed.');
    });

    ws.on('error', () => {
      onDisconnect('Plugin connection error.');
    });
  }

  private onMessage(ws: WebSocket, connectionId: string, text: string): void {
    // Debug: log every incoming raw frame (truncated) to diagnose wire-format mismatches.
    // Set WS_DEBUG to any non-empty value to enable.
    if (process.env.WS_DEBUG) {
      console.log(`[WS>server] ${connectionId.slice(0, 8)}: ${text.slice(0, 500)}`);
    }
    const parsed = parseMessage(text);

    if (!parsed.ok) {
      // Parse error — respond with error code (no id → use 0).
      this.safeSend(ws, makeErrorResponse(0, parsed.error.code, parsed.error.message));
      return;
    }

    const msg = parsed.message;

    // Response: resolve pending REST-forwarded request.
    if (isResponse(msg)) {
      if (msg.error) {
        this.pending.reject(msg.id, msg.error);
      } else {
        const operationId = extractDurableOperationId(msg.result);
        if (operationId) this.pending.bindOperation(msg.id, operationId);
        this.pending.resolve(msg.id, msg.result);
      }
      return;
    }

    // Request: dispatch to server-facing RPC handler.
    if (isRequest(msg)) {
      this.dispatchRequest(ws, connectionId, msg.id, msg.method, msg.params);
      return;
    }

    // Notification (no id): process but don't respond.
    if (isNotification(msg)) {
      this.handleNotification(connectionId, msg.method, msg.params);
      return;
    }
  }

  private dispatchRequest(
    ws: WebSocket,
    connectionId: string,
    id: string | number,
    method: string,
    params: unknown,
  ): void {
    const handler = serverRpcHandlers[method];
    if (!handler) {
      this.safeSend(ws, makeErrorResponse(id, ErrorCode.METHOD_NOT_FOUND, `Method not found: ${method}`));
      return;
    }

    const ctx: RpcContext = {
      connectionId,
      registry: this.registry,
      pending: this.pending,
      serverApiVersion: this.serverApiVersion,
      serverVersion: this.serverVersion,
      clientData: this.clientData,
      onToolsUpdated: this.onToolsUpdated,
      onPromptsUpdated: this.onPromptsUpdated,
      onResourcesUpdated: this.onResourcesUpdated,
      onPluginConnected: this.onPluginConnected,
      onPluginDisconnected: this.onPluginDisconnected,
      onCallRecordCompleted: this.onCallRecordCompleted,
    };

    try {
      const result = handler(params, ctx);
      if (result instanceof Promise) {
        result
          .then((val) => this.safeSend(ws, makeResponse(id, val)))
          .catch((err: unknown) => {
            this.safeSend(ws, makeHandlerErrorResponse(id, err));
          });
      } else {
        this.safeSend(ws, makeResponse(id, result));
      }
    } catch (err: unknown) {
      this.safeSend(ws, makeHandlerErrorResponse(id, err));
    }
  }

  private handleNotification(connectionId: string, method: string, _params: unknown): void {
    // Notifications from the plugin are handled here (currently none of the 21 methods
    // are plugin→server notifications — all 7 server-facing methods are request-response).
    // This is a no-op for unknown notifications.
    void connectionId;
    void method;
    void _params;
  }

  /** Send a message to a specific connection by connectionId. */
  sendToConnection(connectionId: string, msg: unknown): boolean {
    const entry = this.registry.get(connectionId);
    if (!entry || entry.ws.readyState !== entry.ws.OPEN) return false;
    entry.ws.send(serializeMessage(msg as never));
    return true;
  }

  /** Close the WebSocket server. */
  close(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.wss) {
      for (const client of this.wss.clients) {
        client.close();
      }
      this.wss.close();
      this.wss = null;
    }
  }

  // ===== Helpers =====

  /**
   * Map a registry entry to the client-facing McpClientData shape
   * (camelCase, mirrors the C# McpClientData [JsonPropertyName] attributes).
   */
  private clientDataFor(entry: ConnectionEntry | undefined): McpClientData | undefined {
    if (!entry) return undefined;
    return {
      isConnected: true,
      // instanceId is the stable identity plugins know; fall back to the
      // server-assigned connection id.
      sessionId: entry.instanceId ?? entry.connectionId,
    };
  }

  /** Snapshot of all live connections as McpClientData. */
  private connectionsClientData(): McpClientData[] {
    const out: McpClientData[] = [];
    for (const entry of this.registry.snapshot()) {
      const data = this.clientDataFor(entry);
      if (data) out.push(data);
    }
    return out;
  }

  /** Send a notification to every open connection. */
  private broadcastNotification(method: string, params: unknown): void {
    const notif = makeNotification(method, params);
    for (const entry of this.registry.snapshot()) {
      this.safeSend(entry.ws, notif);
    }
  }

  private safeSend(ws: WebSocket, msg: unknown): void {
    if (ws.readyState === ws.OPEN) {
      const text = serializeMessage(msg as never);
      // Debug: log every outgoing frame (truncated) to diagnose wire-format mismatches.
      // Set WS_DEBUG to any non-empty value to enable.
      if (process.env.WS_DEBUG) {
        console.log(`[server>WS] ${text.slice(0, 500)}`);
      }
      ws.send(text);
    }
  }

  private parseUrl(req: IncomingMessage): { pathname: string; searchParams: URLSearchParams } {
    const fullUrl = req.url ?? '';
    try {
      const parsed = new URL(fullUrl, 'http://localhost');
      return { pathname: parsed.pathname, searchParams: parsed.searchParams };
    } catch {
      return { pathname: fullUrl, searchParams: new URLSearchParams() };
    }
  }

  private extractBearerToken(req: IncomingMessage): string | null {
    const auth = req.headers['authorization'];
    if (!auth) return null;
    const match = /^Bearer\s+(.+)$/i.exec(auth);
    return match ? match[1] : null;
  }
}

function makeHandlerErrorResponse(id: string | number, error: unknown) {
  if (!isToolCallControlError(error)) {
    const message = error instanceof Error ? error.message : String(error);
    return makeErrorResponse(id, ErrorCode.INTERNAL_ERROR, message);
  }

  const structured = toStructuredToolCallError(error);
  return makeErrorResponse(
    id,
    structuredRpcCode(structured),
    structured.message,
    structured,
  );
}

function structuredRpcCode(error: ToolCallStructuredError): number {
  switch (error.code) {
    case 'invalid_control':
    case 'unsupported_control_version':
      return ErrorCode.INVALID_PARAMS;
    case 'cancelled':
      return ErrorCode.CALL_CANCELLED;
    case 'deadline_exceeded':
      return ErrorCode.CALL_DEADLINE_EXCEEDED;
    case 'middleware_rejected':
      return ErrorCode.MIDDLEWARE_REJECTED;
    case 'tool_execution_failed':
    default:
      return ErrorCode.INTERNAL_ERROR;
  }
}

/**
 * Constant-time string comparison to mitigate timing attacks on auth tokens.
 * Returns true when the strings are equal. When lengths differ, returns
 * false immediately (timingSafeEqual throws on unequal-length buffers).
 */
function tokensMatch(a: string | null, b: string): boolean {
  if (a === null) return false;
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}
