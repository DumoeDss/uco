import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import WebSocket from 'ws';
import { createServer, type BridgeHandle } from '../src/server/app.js';
import { DEFAULT_SERVER_API_VERSION, parseServerConfig } from '../src/server/config.js';
import { ClientFacingMethod, ServerFacingMethod } from '../src/server/types.js';
import {
  isRequest,
  isResponse,
  makeRequest,
  makeResponse,
  parseMessage,
  serializeMessage,
  type RpcRequest,
} from '../src/server/ws/envelope.js';
import { RestTransport } from '../src/transport/rest.js';
import { runSystemTool, runTool } from '../src/devops/lib/run-tool.js';
import { registerCall } from '../src/commands/call.js';
import { registerExec } from '../src/commands/exec.js';
import { registerGeneratedTools } from '../src/generated/tools.js';

interface CapturedToolCall {
  envelopeId: string | number;
  method: string;
  params: Record<string, unknown>;
}

/**
 * A tiny plugin-side integration fixture. Its middleware records every tool
 * request and rejects it before the fake runner branch can execute. The
 * fixture speaks the real Node server envelope, so REST and command adapters
 * are tested through the forwarding hop rather than by mocking forwardToPlugin.
 */
class RejectingMiddlewarePlugin {
  private ws: WebSocket | undefined;
  private nextId = 0;
  private readonly pending = new Map<string, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  readonly calls: CapturedToolCall[] = [];
  middlewareInvocations = 0;
  fakeRunnerExecutions = 0;

  async connect(url: string): Promise<void> {
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.on('message', (raw: Buffer | Buffer[]) => this.handleMessage(raw));

    await new Promise<void>((resolve, reject) => {
      const onOpen = (): void => {
        ws.off('error', onError);
        resolve();
      };
      const onError = (error: Error): void => {
        ws.off('open', onOpen);
        reject(error);
      };
      ws.once('open', onOpen);
      ws.once('error', onError);
    });

    await this.sendServerRequest(ServerFacingMethod.PerformVersionHandshake, {
      apiVersion: DEFAULT_SERVER_API_VERSION,
      pluginVersion: 'rejecting-test-plugin',
      environment: 'vitest',
    });
    await this.sendServerRequest(ServerFacingMethod.NotifyAboutUpdatedTools, { tools: [] });
  }

  disconnect(): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error('Rejecting test plugin disconnected.'));
    }
    this.pending.clear();
    this.ws?.close();
    this.ws = undefined;
  }

  private sendServerRequest(method: string, params: unknown): Promise<unknown> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('Rejecting test plugin is not connected.'));
    }

    const id = `plugin-${++this.nextId}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for ${method}.`));
      }, 2_000);
      this.pending.set(id, { resolve, reject, timer });
      ws.send(serializeMessage(makeRequest(id, method, params)));
    });
  }

  private handleMessage(raw: Buffer | Buffer[]): void {
    const text = Buffer.isBuffer(raw)
      ? raw.toString('utf8')
      : Buffer.concat(raw as Buffer[]).toString('utf8');
    const parsed = parseMessage(text);
    if (!parsed.ok) return;

    const message = parsed.message;
    if (isResponse(message)) {
      const id = String(message.id);
      const entry = this.pending.get(id);
      if (!entry) return;
      this.pending.delete(id);
      clearTimeout(entry.timer);
      if (message.error) entry.reject(new Error(message.error.message));
      else entry.resolve(message.result);
      return;
    }
    if (isRequest(message)) this.handleRequest(message);
  }

  private handleRequest(request: RpcRequest): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    if (request.method === ClientFacingMethod.RunCallTool
      || request.method === ClientFacingMethod.RunSystemTool) {
      const params = request.params !== null && typeof request.params === 'object'
        && !Array.isArray(request.params)
        ? request.params as Record<string, unknown>
        : {};
      this.calls.push({ envelopeId: request.id, method: request.method, params });
      this.middlewareInvocations++;

      // This is the rejecting middleware terminal: no fake runner is reached.
      const control = params['control'] !== null && typeof params['control'] === 'object'
        && !Array.isArray(params['control'])
        ? params['control'] as Record<string, unknown>
        : {};
      const structuredError = {
        code: 'middleware_rejected',
        message: 'Rejected by recording middleware.',
        retryable: false,
        ...(typeof control['callId'] === 'string' ? { callId: control['callId'] } : {}),
        ...(typeof control['correlationId'] === 'string' ? { correlationId: control['correlationId'] } : {}),
      };
      ws.send(serializeMessage(makeResponse(request.id, {
        requestID: params['requestID'],
        status: 'error',
        message: structuredError.message,
        error: structuredError,
      })));
      return;
    }

    // Handshake/registration requests are server-facing and need ordinary
    // responses so the real registry promotes this connection to eligible.
    const result = request.method === ServerFacingMethod.PerformVersionHandshake
      ? {
        apiVersion: DEFAULT_SERVER_API_VERSION,
        serverVersion: 'test-node',
        compatible: true,
        message: 'compatible',
      }
      : { status: 'success' };
    ws.send(serializeMessage(makeResponse(request.id, result)));
  }
}

function cliProgram(): Command {
  return new Command()
    .exitOverride()
    .option('-u, --url <url>')
    .option('-j, --json');
}

async function expectCliRejection(program: Command, args: string[]): Promise<void> {
  const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`cli-exit:${code ?? 0}`);
  }) as never);
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  try {
    await expect(program.parseAsync(['node', 'uco', ...args])).rejects.toThrow('cli-exit:');
  } finally {
    stderr.mockRestore();
    exit.mockRestore();
  }
}

describe('tool-call control no-bypass integration', () => {
  let handle: BridgeHandle;
  let baseUrl: string;
  let plugin: RejectingMiddlewarePlugin;

  beforeAll(async () => {
    const config = parseServerConfig(['--port', '0', '--authorization', 'none'], {});
    handle = createServer(config);
    const address = await handle.start();
    baseUrl = `http://127.0.0.1:${address.port}`;
    plugin = new RejectingMiddlewarePlugin();
    await plugin.connect(`ws://127.0.0.1:${address.port}/hub/plugin`);
  });

  afterAll(async () => {
    plugin?.disconnect();
    await handle?.stop();
  });

  it('rejects REST, WebSocket, library, CLI, and generated paths before a fake runner', async () => {
    const regularRest = await fetch(`${baseUrl}/api/tools/rest-regular`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        arguments: { value: 1 },
        control: {
          callId: 'rest-regular-call',
          correlationId: 'rest-regular-trace',
          futureFlag: { preserved: true },
        },
      }),
    });
    expect(regularRest.status).toBe(409);
    await expect(regularRest.json()).resolves.toMatchObject({
      ok: false,
      error: {
        code: 'middleware_rejected',
        callId: 'rest-regular-call',
        correlationId: 'rest-regular-trace',
      },
    });

    const systemRest = await fetch(`${baseUrl}/api/system-tools/rest-system`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        arguments: { value: 2 },
        control: {
          callId: 'rest-system-call',
          correlationId: 'rest-system-trace',
        },
      }),
    });
    expect(systemRest.status).toBe(409);

    const transport = new RestTransport({ baseUrl });
    await expect(transport.callTool('transport-regular', { value: 3 }, {
      control: { callId: 'transport-call', correlationId: 'transport-trace' },
    })).rejects.toMatchObject({
      code: 'middleware_rejected',
      callId: 'transport-call',
      correlationId: 'transport-trace',
    });

    const libraryRegular = await runTool({
      url: baseUrl,
      toolName: 'library-regular',
      input: { value: 4 },
      control: { callId: 'library-call', correlationId: 'library-trace' },
    });
    expect(libraryRegular).toMatchObject({
      kind: 'failure',
      structuredError: {
        code: 'middleware_rejected',
        callId: 'library-call',
        correlationId: 'library-trace',
      },
    });

    const librarySystem = await runSystemTool({
      url: baseUrl,
      toolName: 'library-system',
      input: { value: 5 },
      control: { callId: 'library-system-call', correlationId: 'library-system-trace' },
    });
    expect(librarySystem).toMatchObject({
      kind: 'failure',
      structuredError: {
        code: 'middleware_rejected',
        callId: 'library-system-call',
        correlationId: 'library-system-trace',
      },
    });

    const callProgram = cliProgram();
    registerCall(callProgram);
    await expectCliRejection(
      callProgram,
      ['--url', baseUrl, 'call', 'cli-regular', '--call-id', 'cli-call'],
    );
    const execProgram = cliProgram();
    registerExec(execProgram);
    await expectCliRejection(
      execProgram,
      ['--url', baseUrl, 'exec', '--code', 'return 1;', '--call-id', 'exec-call'],
    );
    const generatedProgram = cliProgram();
    registerGeneratedTools(generatedProgram);
    await expectCliRejection(
      generatedProgram,
      ['--url', baseUrl, 'assets-refresh', '--call-id', 'generated-call'],
    );

    expect(plugin.middlewareInvocations).toBe(plugin.calls.length);
    expect(plugin.fakeRunnerExecutions).toBe(0);
    expect(plugin.calls).toHaveLength(8);

    const logicalIds = plugin.calls.map((call) => {
      const control = call.params['control'] as Record<string, unknown> | undefined;
      return control?.['callId'];
    });
    expect(logicalIds).toEqual([
      'rest-regular-call',
      'rest-system-call',
      'transport-call',
      'library-call',
      'library-system-call',
      'cli-call',
      'exec-call',
      'generated-call',
    ]);
    expect(new Set(plugin.calls.map((call) => String(call.envelopeId))).size)
      .toBe(plugin.calls.length);
    expect(plugin.calls.every((call) => {
      const control = call.params['control'] as Record<string, unknown> | undefined;
      return control?.['callId'] !== call.envelopeId;
    })).toBe(true);
    expect((plugin.calls[0]!.params['control'] as Record<string, unknown>)['futureFlag'])
      .toEqual({ preserved: true });
  });
});
