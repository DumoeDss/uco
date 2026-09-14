// Terminal-state wait for durable operations (COCli-03) — the CLI polls the
// authoritative record to a terminal state and exits by the documented map.

import * as http from 'node:http';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { RestTransport } from '../src/transport/rest.js';
import {
  extractOperationHandle,
  waitForDurableOperation,
} from '../src/util/operation-wait.js';

const PACKAGE_ROOT = process.cwd();
const TSX = path.join(PACKAGE_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');

function runCli(args: readonly string[]): Promise<{ status: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [TSX, 'src/index.ts', ...args], {
      cwd: PACKAGE_ROOT,
      shell: false,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status: status ?? -1, stdout, stderr }));
  });
}

/** A transport whose editor-operation-get walks a scripted status sequence. */
function scriptedTransport(statuses: string[], operationId = 'op-scripted'): RestTransport {
  let calls = 0;
  const fetchImpl: typeof fetch = vi.fn(async (_url, init) => {
    const url = String(_url);
    if (url.endsWith(`/api/tools/tests-run`)) {
      void init;
      return new Response(JSON.stringify({
        status: 'success',
        structured: { OperationId: operationId, Status: 'queued', Phase: 'queued' },
      }), { status: 200 });
    }
    if (url.endsWith('/api/tools/editor-operation-get')) {
      const status = statuses[Math.min(calls, statuses.length - 1)]!;
      calls++;
      return new Response(JSON.stringify({
        status: 'success',
        structured: {
          OperationId: operationId,
          Status: status,
          Phase: status,
          CreatedAtUtc: '2026-09-08T00:00:00.0000000Z',
          CompletedAtUtc: status === 'queued' ? null : '2026-09-08T00:00:05.0000000Z',
        },
      }), { status: 200 });
    }
    return new Response(JSON.stringify({ error: `unexpected ${url}` }), { status: 404 });
  });
  return new RestTransport({ baseUrl: 'http://localhost:23456', fetchImpl });
}

const initialHandle = { status: 'success', structured: { OperationId: 'op-scripted', Status: 'queued', Phase: 'queued' } };

describe('durable operation terminal wait', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('extracts the operation handle from a durable tool response', () => {
    expect(extractOperationHandle(initialHandle)).toEqual({ operationId: 'op-scripted' });
    expect(extractOperationHandle({ structured: { operationId: 'op-lower', status: 'running' } }))
      .toEqual({ operationId: 'op-lower' });
    expect(extractOperationHandle({ status: 'success', structured: { value: 7 } })).toBeUndefined();
  });

  it('resolves with the terminal record on success', async () => {
    const transport = scriptedTransport(['running', 'succeeded']);
    const terminal = await waitForDurableOperation(transport, initialHandle, {
      timeoutMs: 5_000,
      intervalMs: 20,
    });
    expect(terminal.status).toBe('succeeded');
    expect(terminal.operationId).toBe('op-scripted');
    expect(terminal.record['CompletedAtUtc']).toBe('2026-09-08T00:00:05.0000000Z');
  });

  it('resolves with the failed terminal record for the caller to map to exit 5', async () => {
    const transport = scriptedTransport(['failed']);
    const terminal = await waitForDurableOperation(transport, initialHandle, {
      timeoutMs: 5_000,
      intervalMs: 20,
    });
    expect(terminal.status).toBe('failed');
  });

  it('resolves with the cancelled terminal record for the caller to map to exit 6', async () => {
    const transport = scriptedTransport(['cancelled']);
    const terminal = await waitForDurableOperation(transport, initialHandle, {
      timeoutMs: 5_000,
      intervalMs: 20,
    });
    expect(terminal.status).toBe('cancelled');
  });

  it('resolves with the interrupted terminal record for the caller to map to exit 7', async () => {
    const transport = scriptedTransport(['interrupted']);
    const terminal = await waitForDurableOperation(transport, initialHandle, {
      timeoutMs: 5_000,
      intervalMs: 20,
    });
    expect(terminal.status).toBe('interrupted');
  });

  it('times out with the wait-timeout code, the operation id, and the last status', async () => {
    const transport = scriptedTransport(['running']);
    await expect(waitForDurableOperation(transport, initialHandle, {
      timeoutMs: 120,
      intervalMs: 40,
    })).rejects.toMatchObject({
      code: 'operation-wait-timeout',
      exitCode: 3,
      retryable: true,
      details: {
        operationId: 'op-scripted',
        lastStatus: 'running',
        lastPhase: 'running',
      },
    });
  });

  it('refuses --wait on a response without an operation handle', async () => {
    const transport = scriptedTransport(['succeeded']);
    await expect(waitForDurableOperation(transport, { status: 'success', structured: { value: 1 } }, {
      timeoutMs: 1_000,
    })).rejects.toMatchObject({
      code: 'operation-wait-invalid',
      exitCode: 1,
    });
  });
});

describe('durable operation wait — CLI end-to-end', () => {
  let server: http.Server | undefined;

  beforeAll(async () => {
    // Warm the tsx loader (see cli-json-protocol.test.ts for the rationale).
    await runCli(['--help']).catch(() => undefined);
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server ? server.close(() => resolve()) : resolve());
    server = undefined;
  });

  function startOperationServer(terminalStatus: 'succeeded' | 'failed'): Promise<{ port: number; polls: () => number }> {
    let polls = 0;
    return new Promise((resolve) => {
      server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => {
          res.setHeader('Content-Type', 'application/json');
          if (req.url === '/api/tools/tests-run') {
            res.end(JSON.stringify({
              status: 'success',
              structured: { OperationId: 'op-e2e', Status: 'queued', Phase: 'queued' },
            }));
            return;
          }
          if (req.url === '/api/tools/editor-operation-get') {
            polls++;
            const terminal = polls >= 2;
            res.end(JSON.stringify({
              status: 'success',
              structured: terminal
                ? { OperationId: 'op-e2e', Status: terminalStatus, Phase: terminalStatus === 'succeeded' ? 'completed' : 'failed', Execution: 'fresh' }
                : { OperationId: 'op-e2e', Status: 'running', Phase: 'executing' },
            }));
            return;
          }
          res.statusCode = 404;
          res.end(JSON.stringify({ error: 'not found' }));
        });
      });
      server.listen(0, '127.0.0.1', () => {
        const address = server!.address() as { port: number };
        resolve({ port: address.port, polls: () => polls });
      });
    });
  }

  it('prints the terminal envelope and exits 0 when a waited run succeeds', async () => {
    const { port, polls } = await startOperationServer('succeeded');

    const result = await runCli([
      '--json', '--url', `http://127.0.0.1:${port}`,
      'call', 'tests-run', '--args', '{}', '--wait', '--wait-timeout-ms', '15000',
    ]);

    expect(result.status).toBe(0);
    const printed = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(printed['Status']).toBe('succeeded');
    expect(printed['Execution']).toBe('fresh');
    expect(polls()).toBeGreaterThanOrEqual(2);
  });

  it('exits 5 with the canonical envelope when a waited run fails', async () => {
    const { port } = await startOperationServer('failed');

    const result = await runCli([
      '--json', '--url', `http://127.0.0.1:${port}`,
      'call', 'tests-run', '--args', '{}', '--wait', '--wait-timeout-ms', '15000',
    ]);

    expect(result.status).toBe(5);
    expect(result.stdout).toBe('');
    const envelope = JSON.parse(result.stderr) as { ok: boolean; error: { code: string; details: { Status: string } } };
    expect(envelope.ok).toBe(false);
    expect(envelope.error.code).toBe('operation-failed');
    expect(envelope.error.details['Status']).toBe('failed');
  });
});
