// Tool-result envelope contract (COCli-04) — transportStatus/operationStatus
// REST positions, bounded inner-failure detection, and the benign-payload
// corpus that must never be flagged.

import { afterEach, describe, expect, it, beforeAll, afterAll } from 'vitest';
import WebSocket from 'ws';
import { createServer, type McpServerHandle } from '../src/server/app.js';
import { DEFAULT_SERVER_API_VERSION, parseServerConfig } from '../src/server/config.js';
import { ClientFacingMethod, ServerFacingMethod } from '../src/server/types.js';
import {
  makeRequest,
  makeResponse,
  serializeMessage,
  parseMessage,
} from '../src/server/ws/envelope.js';
import { runCommand } from '../src/util/cli-context.js';
import { Command } from 'commander';

// ===== REST envelope positions (4.1) ========================================

let nextPort = 18260;

describe('tool-call REST envelope positions', () => {
  let handle: McpServerHandle;
  let baseUrl: string;
  let ws: WebSocket;
  let latestToolResponse: { structuredContent?: unknown; content?: unknown } | undefined;

  beforeAll(async () => {
    const config = parseServerConfig([
      '--port', String(nextPort++),
      '--authorization', 'none',
    ], {});
    handle = createServer(config);
    await handle.start();
    baseUrl = `http://127.0.0.1:${config.port}`;

    ws = new WebSocket(`ws://127.0.0.1:${config.port}/hub/mcp-server`);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    ws.on('message', (data) => {
      const text = data.toString('utf8');
      const parsed = parseMessage(text);
      if (!parsed.ok || !('id' in parsed.message) || !('method' in parsed.message)) return;
      const msg = parsed.message as { id: string | number; method: string; params: unknown };
      if (msg.method === ServerFacingMethod.PerformVersionHandshake) {
        ws.send(serializeMessage(makeResponse(msg.id, { apiVersion: DEFAULT_SERVER_API_VERSION, compatible: true })));
        return;
      }
      if (msg.method === ServerFacingMethod.NotifyAboutUpdatedTools
        || msg.method === ServerFacingMethod.NotifyAboutUpdatedPrompts
        || msg.method === ServerFacingMethod.NotifyAboutUpdatedResources) {
        ws.send(serializeMessage(makeResponse(msg.id, { status: 'success' })));
        return;
      }
      if (msg.method === ClientFacingMethod.RunCallTool) {
        // Reply with whatever the test staged for this round.
        ws.send(serializeMessage(makeResponse(msg.id, {
          requestID: 'stub',
          status: 'success',
          value: latestToolResponse ?? { content: [] },
        })));
      }
    });

    const handshake = makeRequest('h1', ServerFacingMethod.PerformVersionHandshake, {
      apiVersion: DEFAULT_SERVER_API_VERSION,
      pluginVersion: 'stub',
      environment: 'vitest',
    });
    ws.send(serializeMessage(handshake));
    await new Promise((r) => setTimeout(r, 100));
    ws.send(serializeMessage(makeRequest('t1', ServerFacingMethod.NotifyAboutUpdatedTools, { tools: [] })));
    ws.send(serializeMessage(makeRequest('p1', ServerFacingMethod.NotifyAboutUpdatedPrompts, { prompts: [] })));
    ws.send(serializeMessage(makeRequest('r1', ServerFacingMethod.NotifyAboutUpdatedResources, { resources: [] })));
    await new Promise((r) => setTimeout(r, 200));
  });

  afterAll(async () => {
    ws?.close();
    await handle?.stop();
  });

  afterEach(() => {
    latestToolResponse = undefined;
  });

  it('exposes transportStatus and omits operationStatus for an immediate tool', async () => {
    latestToolResponse = { structuredContent: { value: 42 } };
    const res = await fetch(`${baseUrl}/api/tools/object-get-data`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ arguments: {}, control: { callId: 'envelope-immediate' } }),
    });
    expect(res.status).toBe(200);
    const data = await res.json() as Record<string, unknown>;
    expect(data['transportStatus']).toBe('forwarded');
    expect(data['status']).toBe('success');
    expect('operationStatus' in data).toBe(false);
  });

  it('projects operationStatus from a durable tool handle', async () => {
    latestToolResponse = {
      structuredContent: {
        OperationId: 'op-envelope-1',
        Status: 'queued',
        Phase: 'queued',
        Execution: 'fresh',
      },
    };
    const res = await fetch(`${baseUrl}/api/tools/tests-run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ arguments: {}, control: { callId: 'envelope-durable' } }),
    });
    expect(res.status).toBe(200);
    const data = await res.json() as Record<string, unknown>;
    expect(data['transportStatus']).toBe('forwarded');
    expect(data['operationStatus']).toEqual({
      operationId: 'op-envelope-1',
      state: 'queued',
      phase: 'queued',
    });
    // Existing members keep their positions.
    expect((data['structured'] as Record<string, unknown>)['OperationId']).toBe('op-envelope-1');
  });

  it('adds transportStatus to the empty-value success shape', async () => {
    latestToolResponse = undefined;
    const res = await fetch(`${baseUrl}/api/tools/tools-list`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ arguments: {}, control: { callId: 'envelope-empty' } }),
    });
    expect(res.status).toBe(200);
    const data = await res.json() as Record<string, unknown>;
    expect(data['transportStatus']).toBe('forwarded');
    expect(data['content']).toEqual([]);
  });
});

// ===== Inner-failure detection + benign corpus (4.2 / 4.3) ==================

/**
 * Drive the CLI shell (runCommand → toolReportedFailure → exit mapping) with
 * a canned result and no transport. `--url` satisfies connection resolution;
 * the handler returns the payload synchronously so nothing dials out.
 */
async function runFixtureShell(
  payload: unknown,
): Promise<{ exited: boolean; exitCode: number | null }> {
  const program = new Command()
    .exitOverride(() => {
      throw new Error('commander-exit');
    })
    .option('--url <url>', 'stub', 'http://127.0.0.1:9')
    .option('--json', 'json mode');
  const command = program
    .command('fixture')
    .action(() => runCommand(command, async () => payload)());

  let exited = false;
  let exitCode: number | null = null;
  const originalExit = process.exit;
  (process as { exit?: unknown }).exit = ((code?: number) => {
    exited = true;
    exitCode = code ?? null;
    throw new Error(`shell-exit:${code ?? 0}`);
  }) as typeof process.exit;

  const originalWrite = process.stdout.write.bind(process.stdout);
  const originalErrWrite = process.stderr.write.bind(process.stderr);
  process.stdout.write = (() => true) as typeof process.stdout.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
  try {
    await program.parseAsync(['fixture'], { from: 'user' });
  } catch {
    // exit paths throw through the patched process.exit / exitOverride
  } finally {
    (process as { exit?: unknown }).exit = originalExit;
    process.stdout.write = originalWrite;
    process.stderr.write = originalErrWrite;
  }
  return { exited, exitCode };
}

describe('wrapper failure predicates', () => {
  const cases: Array<{ name: string; payload: unknown }> = [
    { name: 'ok=false (existing rule)', payload: { structured: { ok: false, message: 'classic failure' } } },
    { name: 'Ok=false PascalCase', payload: { structured: { Ok: false, Message: 'pascal failure' } } },
    { name: 'isError=true with inner message', payload: { structured: { isError: true, message: 'probe exploded' } } },
    { name: 'IsError=true', payload: { structured: { IsError: true, Message: 'capital probe exploded' } } },
    { name: 'status=error', payload: { structured: { status: 'error', message: 'status said error' } } },
    { name: 'Status=Failed', payload: { structured: { Status: 'Failed', Message: 'status said failed' } } },
    { name: 'nested error object with message and code', payload: { structured: { error: { message: 'inner boom', code: 'E_X' } } } },
    { name: 'nested error object with code only', payload: { structured: { error: { code: 'E_ONLY' } } } },
    { name: 'error member string', payload: { structured: { error: 'plain string failure' } } },
    { name: 'deep wrapper nesting', payload: { structured: { result: { value: { ok: false, message: 'deep failure' } } } } },
  ];

  for (const testCase of cases) {
    it(`flags ${testCase.name} as a tool-reported failure with exit 5`, async () => {
      const outcome = await runFixtureShell(testCase.payload);
      expect(outcome.exited).toBe(true);
      expect(outcome.exitCode).toBe(5);
    });
  }
});

describe('benign payload corpus (never flagged)', () => {
  const benign: Array<{ name: string; payload: unknown }> = [
    {
      name: 'application object with a status member outside wrapper positions',
      payload: { structured: { value: { items: [{ status: 'error', name: 'Enemy' }] } } },
    },
    {
      name: 'wrapper status outside the failure vocabulary',
      payload: { structured: { status: 'queued', message: 'still running' } },
    },
    {
      name: 'wrapper status success with app-level error data deeper inside value arrays',
      payload: { structured: { status: 'success', value: { log: [{ level: 'error' }] } } },
    },
    {
      name: 'empty error string member',
      payload: { structured: { status: 'success', error: '' } },
    },
    {
      name: 'error object without message or code',
      payload: { structured: { status: 'running', error: { detail: 'just diagnostics' } } },
    },
    {
      name: 'camelCase isError false',
      payload: { structured: { isError: false, message: 'healthy' } },
    },
    {
      name: 'status pending with error member in nested app data (outside wrapper keys)',
      payload: { structured: { status: 'pending', data: { error: 'not a wrapper' } } },
    },
  ];

  for (const entry of benign) {
    it(`exits clean for ${entry.name}`, async () => {
      const outcome = await runFixtureShell(entry.payload);
      expect(outcome.exited).toBe(false);
    });
  }
});
