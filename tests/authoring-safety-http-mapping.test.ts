import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
import { runTool } from '../src/devops/lib/run-tool.js';

interface CapturedCall {
  envelopeId: string | number;
  method: string;
  params: Record<string, unknown>;
}

/**
 * Plugin-side fixture for task 6.6. The tool name selects which Unity safety
 * code the fake plugin answers with, so every mapping row can be exercised
 * through the real Node forwarding hop. The fixture never treats a call as a
 * mutation: it records the request and answers with the structured error the
 * Unity policy would have produced, echoing the logical ids it received.
 */
class SafetyErrorPlugin {
  private ws: WebSocket | undefined;
  private nextId = 0;
  private readonly pending = new Map<string, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  readonly calls: CapturedCall[] = [];

  async connect(url: string): Promise<void> {
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.on('message', (raw: Buffer | Buffer[]) => this.handleMessage(raw));
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', (error: Error) => reject(error));
    });
    await this.sendServerRequest(ServerFacingMethod.PerformVersionHandshake, {
      apiVersion: DEFAULT_SERVER_API_VERSION,
      pluginVersion: 'safety-error-plugin',
      environment: 'vitest',
    });
    await this.sendServerRequest(ServerFacingMethod.NotifyAboutUpdatedTools, { tools: [] });
  }

  disconnect(): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error('Safety error plugin disconnected.'));
    }
    this.pending.clear();
    this.ws?.close();
    this.ws = undefined;
  }

  private sendServerRequest(method: string, params: unknown): Promise<unknown> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('Safety error plugin is not connected.'));
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
    const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : Buffer.concat(raw as Buffer[]).toString('utf8');
    const parsed = parseMessage(text);
    if (!parsed.ok) return;
    const message = parsed.message;
    if (isResponse(message)) {
      const entry = this.pending.get(String(message.id));
      if (!entry) return;
      this.pending.delete(String(message.id));
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

    if (request.method === ClientFacingMethod.RunCallTool || request.method === ClientFacingMethod.RunSystemTool) {
      const params = request.params !== null && typeof request.params === 'object' && !Array.isArray(request.params)
        ? request.params as Record<string, unknown>
        : {};
      this.calls.push({ envelopeId: request.id, method: request.method, params });
      const control = params['control'] !== null && typeof params['control'] === 'object' && !Array.isArray(params['control'])
        ? params['control'] as Record<string, unknown>
        : undefined;
      const name = String(params['name'] ?? '');
      const code = name.replace(/^tool-/, '');
      const legacy = control === undefined;

      if (code === 'plan') {
        // A successful dry-run plan travels back through the ordinary
        // success envelope with structured content.
        ws.send(serializeMessage(makeResponse(request.id, {
          requestID: params['requestID'],
          status: 'success',
          value: {
            requestID: params['requestID'],
            status: 'success',
            structuredContent: {
              result: {
                dryRun: 'plan',
                valid: true,
                confirmationPlan: {
                  planId: 'plan-abc',
                  planHash: 'sha256-def',
                  expiresAtUnixMs: Date.now() + 60_000,
                },
              },
            },
          },
        })));
        return;
      }

      const confirmationDetails = {
        reason: 'fixture',
        root: 'Assets',
        confirmationPlan: {
          planId: 'plan-record',
          planHash: 'sha256-record',
          expiresAtUnixMs: 1234,
          policyVersion: 2,
          argumentsHash: 'sha256-args',
          tool: name,
          requestID: params['requestID'],
          callId: control?.['callId'],
          correlationId: control?.['correlationId'],
          risk: 'unknown',
          undo: 'none',
          planLevel: 'none',
          targets: [],
          predictedEffects: ['undeclared'],
        },
        retryWith: {
          requestID: params['requestID'],
          control: {
            ...control,
            version: 1,
            callId: control?.['callId'],
            correlationId: control?.['correlationId'],
            confirm: true,
            dryRun: 'none',
            confirmation: {
              planId: 'plan-record',
              planHash: 'sha256-record',
              expiresAtUnixMs: 1234,
            },
          },
        },
      };
      const structuredError = {
        code,
        message: `Rejected with ${code}.`,
        retryable: false,
        ...(typeof control?.['callId'] === 'string' ? { callId: control['callId'] } : {}),
        ...(typeof control?.['correlationId'] === 'string' ? { correlationId: control['correlationId'] } : {}),
        details: code === 'confirmation_required'
          ? confirmationDetails
          : { reason: 'fixture', root: 'Assets' },
      };
      ws.send(serializeMessage(makeResponse(request.id, {
        requestID: params['requestID'],
        status: 'error',
        message: legacy ? `[${code}] Rejected with ${code}.` : structuredError.message,
        ...(legacy ? {} : { error: structuredError }),
        value: {
          requestID: params['requestID'],
          status: 'error',
          content: [{ type: 'text', text: `[${code}] Rejected with ${code}.` }],
          ...(legacy ? {} : { error: structuredError }),
        },
      })));
      return;
    }

    const result = request.method === ServerFacingMethod.PerformVersionHandshake
      ? { apiVersion: DEFAULT_SERVER_API_VERSION, serverVersion: 'test-node', compatible: true, message: 'compatible' }
      : { status: 'success' };
    ws.send(serializeMessage(makeResponse(request.id, result)));
  }
}

const MAPPING: ReadonlyArray<{ code: string; status: number }> = [
  { code: 'path_policy_violation', status: 400 },
  { code: 'validation_failed', status: 400 },
  { code: 'invalid_control', status: 400 },
  { code: 'confirmation_required', status: 409 },
  { code: 'confirmation_invalid', status: 409 },
  { code: 'confirmation_expired', status: 409 },
  { code: 'confirmation_stale', status: 409 },
  { code: 'undo_unavailable', status: 409 },
  { code: 'authoring_transaction_failed', status: 409 },
  { code: 'dry_run_unsupported', status: 422 },
  { code: 'safety_unsupported', status: 422 },
];

describe('g-005 Node safety error mapping', () => {
  let handle: BridgeHandle;
  let baseUrl: string;
  let plugin: SafetyErrorPlugin;

  beforeAll(async () => {
    const config = parseServerConfig(['--port', '0', '--authorization', 'none'], {});
    handle = createServer(config);
    const address = await handle.start();
    baseUrl = `http://127.0.0.1:${address.port}`;
    plugin = new SafetyErrorPlugin();
    await plugin.connect(`ws://127.0.0.1:${address.port}/hub/plugin`);
  });

  afterAll(async () => {
    plugin?.disconnect();
    await handle?.stop();
  });

  it.each(MAPPING)('maps $code to HTTP $status on regular and system routes', async ({ code, status }) => {
    for (const route of ['tools', 'system-tools']) {
      const callId = `${route}-${code}-call`;
      const correlationId = `${route}-${code}-trace`;
      const response = await fetch(`${baseUrl}/api/${route}/tool-${code}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          arguments: { name: 'Block' },
          control: { callId, correlationId, confirm: true, confirmation: { planId: 'p', planHash: 'h', expiresAtUnixMs: 1 } },
        }),
      });
      expect(response.status, `${route}/${code}`).toBe(status);
      const body = await response.json() as { ok: boolean; error: Record<string, unknown> };
      expect(body.ok).toBe(false);
      expect(body.error).toMatchObject({ code, retryable: false, callId, correlationId });
      expect(body.error['details']).toMatchObject({ reason: 'fixture', root: 'Assets' });
      if (code === 'confirmation_required') {
        expect(body.error['details']).toMatchObject({
          confirmationPlan: {
            planId: 'plan-record',
            planLevel: 'none',
            undo: 'none',
            targets: [],
            predictedEffects: ['undeclared'],
          },
          retryWith: {
            requestID: expect.any(String),
            control: {
              callId,
              correlationId,
              confirm: true,
              dryRun: 'none',
              confirmation: {
                planId: 'plan-record',
                planHash: 'sha256-record',
                expiresAtUnixMs: 1234,
              },
            },
          },
        });
      }
      expect(JSON.stringify(body)).not.toContain('Exception');

      // The logical ids are the plugin's, never the per-hop envelope id.
      const captured = plugin.calls.at(-1)!;
      expect(String(captured.envelopeId)).toMatch(/^r-\d+$/);
      expect(body.error['callId']).not.toBe(String(captured.envelopeId));
      const forwardedControl = captured.params['control'] as Record<string, unknown>;
      expect(forwardedControl['callId']).toBe(callId);
      expect(forwardedControl['confirm']).toBe(true);
      expect(forwardedControl['confirmation']).toMatchObject({ planId: 'p', planHash: 'h', expiresAtUnixMs: 1 });
    }
  });

  it('forwards dryRun=plan unchanged and returns the plan through the success envelope', async () => {
    const response = await fetch(`${baseUrl}/api/tools/tool-plan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        arguments: { name: 'Block' },
        control: { version: 1, callId: 'plan-call', correlationId: 'plan-trace', dryRun: 'plan', confirm: false, futureFlag: 7 },
      }),
    });
    expect(response.status).toBe(200);
    const body = await response.json() as { status: string; structured: { result: { confirmationPlan: { planId: string } } } };
    expect(body.status).toBe('success');
    expect(body.structured.result.confirmationPlan.planId).toBe('plan-abc');
    const control = plugin.calls.at(-1)!.params['control'] as Record<string, unknown>;
    expect(control).toMatchObject({ callId: 'plan-call', correlationId: 'plan-trace', dryRun: 'plan', confirm: false, futureFlag: 7 });
  });

  it('keeps the legacy envelope for a legacy rejection and never reports success', async () => {
    const response = await fetch(`${baseUrl}/api/tools/tool-confirmation_required`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Block', control: 'this is a tool argument, not g-005 control' }),
    });
    expect(response.status).not.toBe(200);
    const body = await response.json() as { ok: boolean; error: { code: string; message: string } };
    expect(body.ok).toBe(false);
    expect(body.error.message).toContain('[confirmation_required]');
    expect(body.error.code).not.toBe('confirmation_required'); // legacy shape: no structured safety code
    const forwarded = plugin.calls.at(-1)!;
    expect(forwarded.params['control']).toBeUndefined();
    expect((forwarded.params['arguments'] as Record<string, unknown>)['control'])
      .toBe('this is a tool argument, not g-005 control');
  });

  it('preserves the code and logical ids for the transport and library callers', async () => {
    const transport = new RestTransport({ baseUrl });
    await expect(transport.callTool('tool-confirmation_stale', { name: 'Block' }, {
      control: { callId: 'transport-stale', correlationId: 'transport-stale-trace' },
    })).rejects.toMatchObject({
      code: 'confirmation_stale',
      callId: 'transport-stale',
      correlationId: 'transport-stale-trace',
    });

    const library = await runTool({
      url: baseUrl,
      toolName: 'tool-dry_run_unsupported',
      input: { name: 'Block' },
      control: { callId: 'library-unsupported', correlationId: 'library-unsupported-trace', dryRun: 'validate' },
    });
    expect(library).toMatchObject({
      kind: 'failure',
      structuredError: {
        code: 'dry_run_unsupported',
        callId: 'library-unsupported',
        correlationId: 'library-unsupported-trace',
      },
    });
    const forwardedControl = plugin.calls.at(-1)!.params['control'] as Record<string, unknown>;
    expect(forwardedControl['dryRun']).toBe('validate');
  });

  it('rejects an invalid dryRun or malformed confirmation before forwarding', async () => {
    const before = plugin.calls.length;
    for (const control of [
      { callId: 'bad-1', dryRun: 'preview' },
      { callId: 'bad-2', dryRun: true },
      { callId: 'bad-3', confirm: 'yes' },
      { callId: 'bad-4', confirmation: { planId: 1, planHash: 'h', expiresAtUnixMs: 'soon' } },
    ]) {
      const response = await fetch(`${baseUrl}/api/tools/tool-confirmation_required`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ arguments: {}, control }),
      });
      expect(response.status).toBe(400);
      const body = await response.json() as { error: { code: string } };
      expect(body.error.code).toBe('invalid_control');
    }
    expect(plugin.calls.length).toBe(before);
  });
});
