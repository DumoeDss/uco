/**
 * Stub-plugin client — connects to the WS hub and responds to all 14 client-facing
 * methods with canned/realistic data. Used to validate the JSON envelope contract
 * end-to-end before the C# plugin rewrite (child 2).
 *
 * Can also send the 7 server-facing methods to the server (see scenarios.ts).
 */

import WebSocket from 'ws';
import {
  parseMessage,
  makeResponse,
  makeRequest,
  serializeMessage,
  isRequest,
  isNotification,
  type RpcRequest,
} from '../ws/envelope.js';
import type {
  ResponseData,
  ResponseListTool,
  ResponseCallTool,
  ContentBlock,
  ResponseGetPrompt,
  ResponseListPrompts,
  ResponsePrompt,
  ResponseResourceContent,
  ResponseListResource,
  ResponseResourceTemplate,
} from '../types.js';
import { ClientFacingMethod as Methods } from '../types.js';

export interface StubClientOptions {
  url: string;
  token?: string;
  instanceId?: string;
  /** Delay before responding to requests (ms), to simulate plugin latency. */
  responseDelayMs?: number;
}

export interface StubPluginData {
  tools: ResponseListTool[];
  prompts: ResponsePrompt[];
  resources: ResponseListResource[];
  resourceTemplates: ResponseResourceTemplate[];
}

/** Default canned data returned by the stub client. */
export const DEFAULT_STUB_DATA: StubPluginData = {
  tools: [
    {
      name: 'ping',
      title: 'Ping',
      description: 'Returns pong',
      enabled: true,
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'echo',
      title: 'Echo',
      description: 'Echoes the input arguments',
      enabled: true,
      inputSchema: {
        type: 'object',
        properties: {
          message: { type: 'string', description: 'Message to echo' },
        },
      },
    },
  ],
  prompts: [
    {
      name: 'greeting',
      title: 'Greeting',
      description: 'A greeting prompt',
      enabled: true,
      arguments: [{ name: 'name', description: 'Name to greet', required: true }],
    },
  ],
  resources: [
    {
      uri: 'config://app/settings',
      name: 'App Settings',
      enabled: true,
      mimeType: 'application/json',
      description: 'Application settings',
    },
  ],
  resourceTemplates: [
    {
      uriTemplate: 'file:///{path}',
      name: 'File',
      enabled: true,
      mimeType: 'text/plain',
      description: 'Read a file by path',
    },
  ],
};

export class StubPluginClient {
  private ws: WebSocket | null = null;
  private nextId = 0;
  private readonly options: StubClientOptions;
  private readonly data: StubPluginData;
  public readonly notifications: { method: string; params: unknown }[] = [];

  constructor(options: StubClientOptions, data: StubPluginData = DEFAULT_STUB_DATA) {
    this.options = options;
    this.data = data;
  }

  /** Connect to the WebSocket hub. Returns a promise that resolves on open. */
  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const urlObj = new URL(this.options.url);
      if (this.options.token) {
        urlObj.searchParams.set('access_token', this.options.token);
      }
      if (this.options.instanceId) {
        urlObj.searchParams.set('instanceId', this.options.instanceId);
      }

      this.ws = new WebSocket(urlObj.toString());

      this.ws.on('open', () => resolve());
      this.ws.on('error', (err: Error) => reject(err));

      this.ws.on('message', (raw: Buffer | Buffer[]) => {
        const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : Buffer.concat(raw as Buffer[]).toString('utf8');
        this.handleMessage(text);
      });

      this.ws.on('close', () => {
        // Connection closed.
      });
    });
  }

  /** Disconnect from the hub. */
  disconnect(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  /** Whether the client is connected. */
  get isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /**
   * Send a server-facing request and await the response.
   * Used by scenarios.ts to exercise the 7 server-facing methods.
   */
  sendServerRequest(method: string, params?: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error('Not connected'));
        return;
      }
      const id = `stub-${++this.nextId}`;
      const req = makeRequest(id, method, params);

      const handler = (raw: Buffer | Buffer[]): void => {
        const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : Buffer.concat(raw as Buffer[]).toString('utf8');
        const parsed = parseMessage(text);
        if (parsed.ok && 'id' in parsed.message && parsed.message.id === id && ('result' in parsed.message || 'error' in parsed.message)) {
          this.ws!.off('message', handler);
          const resp = parsed.message as { id: string | number; result?: unknown; error?: { code: number; message: string } };
          if (resp.error) {
            reject(new Error(resp.error.message));
          } else {
            resolve(resp.result);
          }
        }
      };

      this.ws.on('message', handler);
      this.ws.send(serializeMessage(req));

      // Timeout after 10s.
      setTimeout(() => {
        this.ws?.off('message', handler);
        reject(new Error(`Timeout waiting for response to ${method}`));
      }, 10_000);
    });
  }

  // ===== Message handling =====

  private handleMessage(text: string): void {
    const parsed = parseMessage(text);
    if (!parsed.ok) return; // Ignore unparseable messages.

    const msg = parsed.message;

    if (isRequest(msg)) {
      this.handleRequest(msg);
      return;
    }

    if (isNotification(msg)) {
      this.notifications.push({ method: msg.method, params: msg.params });
      // Notifications are handled silently (no response).
      return;
    }
  }

  private handleRequest(req: RpcRequest): void {
    const respond = (result: unknown): void => {
      const delay = this.options.responseDelayMs ?? 0;
      setTimeout(() => {
        if (this.ws?.readyState === WebSocket.OPEN) {
          this.ws.send(serializeMessage(makeResponse(req.id, result)));
        }
      }, delay);
    };

    switch (req.method) {
      case Methods.RunListTool:
        respond(this.makeListToolResponse(req.params));
        break;
      case Methods.RunCallTool:
        respond(this.makeCallToolResponse(req.params));
        break;
      case Methods.RunGetPrompt:
        respond(this.makeGetPromptResponse(req.params));
        break;
      case Methods.RunListPrompts:
        respond(this.makeListPromptsResponse(req.params));
        break;
      case Methods.RunResourceContent:
        respond(this.makeResourceContentResponse(req.params));
        break;
      case Methods.RunListResources:
        respond(this.makeListResourcesResponse(req.params));
        break;
      case Methods.RunResourceTemplates:
        respond(this.makeResourceTemplatesResponse(req.params));
        break;
      case Methods.RunSystemTool:
        respond(this.makeCallToolResponse(req.params));
        break;
      case Methods.RunListSystemTool:
        respond(this.makeListToolResponse(req.params));
        break;
      default:
        // Unknown method — respond with empty success.
        respond({ status: 'success' });
        break;
    }
  }

  // ===== Canned response builders =====

  private makeListToolResponse(params: unknown): ResponseData<ResponseListTool[]> {
    const p = (params ?? {}) as { requestID?: string };
    return {
      requestID: p.requestID ?? '',
      status: 'success',
      value: this.data.tools,
    };
  }

  private makeCallToolResponse(params: unknown): ResponseData<ResponseCallTool> {
    const p = (params ?? {}) as { name?: string; arguments?: Record<string, unknown>; requestID?: string };
    const name = p.name ?? '';

    const content: ContentBlock[] = [
      { type: 'text', text: `Stub result for tool '${name}' with args: ${JSON.stringify(p.arguments ?? {})}` },
    ];

    return {
      requestID: p.requestID ?? '',
      status: 'success',
      value: {
        content,
        structuredContent: { result: `pong from ${name}` },
      },
    };
  }

  private makeGetPromptResponse(params: unknown): ResponseData<ResponseGetPrompt> {
    const p = (params ?? {}) as { name?: string; requestID?: string };
    return {
      requestID: p.requestID ?? '',
      status: 'success',
      value: {
        description: `Stub prompt '${p.name ?? ''}'`,
        messages: [
          { role: 'user', content: `Hello from stub prompt ${p.name ?? ''}!` },
        ],
      },
    };
  }

  private makeListPromptsResponse(params: unknown): ResponseData<ResponseListPrompts> {
    const p = (params ?? {}) as { requestID?: string };
    return {
      requestID: p.requestID ?? '',
      status: 'success',
      value: { prompts: this.data.prompts },
    };
  }

  private makeResourceContentResponse(params: unknown): ResponseData<ResponseResourceContent[]> {
    const p = (params ?? {}) as { uri?: string; requestID?: string };
    return {
      requestID: p.requestID ?? '',
      status: 'success',
      value: [
        {
          uri: p.uri ?? '',
          mimeType: 'text/plain',
          text: `Stub content for resource '${p.uri ?? ''}'`,
        },
      ],
    };
  }

  private makeListResourcesResponse(params: unknown): ResponseData<ResponseListResource[]> {
    const p = (params ?? {}) as { requestID?: string };
    return {
      requestID: p.requestID ?? '',
      status: 'success',
      value: this.data.resources,
    };
  }

  private makeResourceTemplatesResponse(params: unknown): ResponseData<ResponseResourceTemplate[]> {
    const p = (params ?? {}) as { requestID?: string };
    return {
      requestID: p.requestID ?? '',
      status: 'success',
      value: this.data.resourceTemplates,
    };
  }
}
