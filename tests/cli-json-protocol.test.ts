// CLI JSON protocol contract (COCli-02) — stream purity, retry continuity,
// and the documented exit-code map.
//
// The stream matrix runs the real CLI as a subprocess (tsx over src/index.ts)
// against a local stub HTTP server so stdout/stderr byte layout and exit codes
// are asserted end-to-end, not through mocks.

import * as http from 'node:http';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { serializeError } from '../src/util/output.js';
import { CliError, TransportError } from '../src/util/errors.js';
import { ToolCallControlError } from '../src/tool-call-control.js';
import { RestTransport } from '../src/transport/rest.js';
import { waitForEditorIdle } from '../src/util/idle-wait.js';

const PACKAGE_ROOT = process.cwd();
const TSX = path.join(PACKAGE_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');

// Async spawn so this process's event loop (and any stub server living in it)
// keeps serving while the CLI child runs.
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

function countJsonDocuments(text: string): number {
  const trimmed = text.trim();
  if (trimmed.length === 0) return 0;
  try {
    JSON.parse(trimmed);
    return 1;
  } catch {
    return 0;
  }
}

function countStderrErrorObjects(text: string): number {
  const trimmed = text.trim();
  if (trimmed.length === 0) return 0;
  // The canonical envelope is pretty-printed (multi-line); parse the whole
  // stream first, then fall back to single-line objects for mixed output.
  try {
    const whole = JSON.parse(trimmed) as { ok?: unknown };
    return whole['ok'] === false ? 1 : 0;
  } catch {
    // fall through to line scan
  }
  let count = 0;
  for (const line of trimmed.split('\n')) {
    const candidate = line.trim();
    if (!candidate.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(candidate) as { ok?: unknown };
      if (parsed['ok'] === false) count++;
    } catch {
      // not JSON — ignore
    }
  }
  return count;
}

interface StubServer {
  url: string;
  close(): Promise<void>;
}

function startStubServer(routes: Record<string, (body: unknown) => { status: number; body: unknown }>): Promise<StubServer> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let body: unknown = null;
        try {
          body = raw.length === 0 ? null : JSON.parse(raw);
        } catch {
          body = null;
        }
        const handler = routes[`${req.method} ${req.url}`];
        const response = handler
          ? handler(body)
          : { status: 404, body: { error: 'not found' } };
        res.statusCode = response.status;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(response.body));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as { port: number };
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

describe('JSON stream purity contract', () => {
  let server: StubServer | undefined;

  beforeAll(async () => {
    // Warm the tsx loader once: a cold tsx start can abort at process exit on
    // Windows while its compile cache closes (0xC0000409), which would flake
    // the first subprocess case without touching the contract under test.
    await runCli(['--help']).catch(() => undefined);
  });

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it('emits exactly one stdout document on success and no stderr error object', async () => {
    server = await startStubServer({
      'POST /api/system-tools/ping': () => ({ status: 200, body: { status: 'success', value: 'pong' } }),
    });
    const result = await runCli(['--json', '--url', server.url, 'ping']);

    expect(result.status).toBe(0);
    expect(countJsonDocuments(result.stdout)).toBe(1);
    expect(countStderrErrorObjects(result.stderr)).toBe(0);
    expect((JSON.parse(result.stdout) as { ok: boolean }).ok).toBe(true);
  });

  it('keeps stdout empty for a connection failure and emits one stderr error object', async () => {
    // Bind an ephemeral port and close it again so the port is genuinely
    // refused (low ports like :1 are rejected by the fetch client itself).
    const probe = http.createServer(() => { /* never serves */ });
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', () => resolve()));
    const deadPort = (probe.address() as { port: number }).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));

    const result = await runCli(['--json', '--url', `http://127.0.0.1:${deadPort}`, 'ping']);

    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(countStderrErrorObjects(result.stderr)).toBe(1);
    const envelope = JSON.parse(result.stderr) as { ok: boolean; error: { code: string; retryable: boolean } };
    expect(envelope.ok).toBe(false);
    expect(envelope.error.code).toBe('transport-connection-refused');
  });

  it('keeps stdout empty for confirmation_required and surfaces retry continuity fields', async () => {
    const retryControl = {
      version: 1,
      callId: 'call-confirm-1',
      correlationId: 'trace-confirm-1',
      confirm: true,
      dryRun: 'none',
      confirmation: { planId: 'plan-1', planHash: 'hash-1', expiresAtUnixMs: 4102444800000 },
    };
    server = await startStubServer({
      'POST /api/tools/scene-save': () => ({
        status: 409,
        body: {
          ok: false,
          error: {
            code: 'confirmation_required',
            message: 'Saving the scene requires confirmation.',
            retryable: true,
            details: { retryWith: { requestID: 't-77', control: retryControl } },
          },
        },
      }),
    });
    const result = await runCli(['--json', '--url', server.url, 'call', 'scene-save', '--args', '{}', '--call-id', 'call-confirm-1']);

    expect(result.status).toBe(4);
    expect(result.stdout).toBe('');
    expect(countStderrErrorObjects(result.stderr)).toBe(1);
    const envelope = JSON.parse(result.stderr) as {
      ok: boolean;
      error: { code: string; requestId?: string; details?: { retryWith?: { requestID: string; control: unknown } } };
    };
    expect(envelope.ok).toBe(false);
    expect(envelope.error.code).toBe('confirmation_required');
    expect(envelope.error.requestId).toBe('t-77');
    expect(envelope.error.details?.retryWith?.requestID).toBe('t-77');
    expect(envelope.error.details?.retryWith?.control).toEqual(retryControl);
  });

  it('exits 5 with the canonical envelope for a tool-reported failure', async () => {
    server = await startStubServer({
      'POST /api/tools/probe': () => ({
        status: 200,
        body: { status: 'success', structured: { ok: false, message: 'inner boom' } },
      }),
    });
    const result = await runCli(['--json', '--url', server.url, 'call', 'probe', '--args', '{}']);

    expect(result.status).toBe(5);
    expect(result.stdout).toBe('');
    expect(countStderrErrorObjects(result.stderr)).toBe(1);
    const envelope = JSON.parse(result.stderr) as { ok: boolean; error: { code: string; message: string } };
    expect(envelope.ok).toBe(false);
    expect(envelope.error.code).toBe('tool-reported-failure');
    expect(envelope.error.message).toContain('inner boom');
  });

  it('exits 6 for a cancelled controlled call and names the logical call', async () => {
    server = await startStubServer({
      'POST /api/tools/scene-save': () => ({
        status: 408,
        body: {
          ok: false,
          error: {
            code: 'cancelled',
            message: 'Tool call was cancelled by the caller.',
            retryable: false,
            callId: 'call-cancelled-1',
          },
        },
      }),
    });
    const result = await runCli(['--json', '--url', server.url, 'call', 'scene-save', '--args', '{}', '--call-id', 'call-cancelled-1']);

    expect(result.status).toBe(6);
    expect(result.stdout).toBe('');
    const envelope = JSON.parse(result.stderr) as { error: { code: string; callId?: string } };
    expect(envelope.error.code).toBe('cancelled');
    expect(envelope.error.callId).toBe('call-cancelled-1');
  });

  it('exits 3 for a transport timeout against an unresponsive server', async () => {
    // A server that accepts the connection but never answers.
    const silent = http.createServer(() => { /* never responds */ });
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', () => resolve()));
    const address = silent.address() as { port: number };
    try {
      const result = await runCli(['--json', '--url', `http://127.0.0.1:${address.port}`, '--timeout-ms', '400', 'ping']);
      expect(result.status).toBe(3);
      expect(result.stdout).toBe('');
      expect(countStderrErrorObjects(result.stderr)).toBe(1);
      const envelope = JSON.parse(result.stderr) as { error: { code: string } };
      expect(envelope.error.code).toBe('transport-timeout');
    } finally {
      silent.closeAllConnections?.();
      silent.close();
    }
  });

  it('exits 3 for an expired controlled deadline before any request is sent', async () => {
    server = await startStubServer({
      'POST /api/tools/ping': () => ({ status: 200, body: { status: 'success' } }),
    });
    const result = await runCli(['--json', '--url', server.url, 'call', 'ping', '--args', '{}', '--deadline-unix-ms', '1']);

    expect(result.status).toBe(3);
    expect(result.stdout).toBe('');
    const envelope = JSON.parse(result.stderr) as { error: { code: string } };
    expect(envelope.error.code).toBe('deadline_exceeded');
  });

  it('keeps help output off the error channel', async () => {
    const result = await runCli(['call', '--help']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Usage: uco call');
    expect(countStderrErrorObjects(result.stderr)).toBe(0);
    expect(countJsonDocuments(result.stderr)).toBe(0);
  });
});

describe('canonical error envelope — retry continuity normalization', () => {
  it('exposes requestId and bounded retryWith for a confirmation-retryable CliError', () => {
    const control = {
      version: 1,
      callId: 'call-x',
      confirm: true,
      dryRun: 'none',
      confirmation: { planId: 'p1', planHash: 'h1', expiresAtUnixMs: 4102444800000 },
    };
    const envelope = serializeError(new CliError(
      'Confirmation required.',
      'confirmation_required',
      4,
      true,
      { retryWith: { requestID: 't-9', control } },
    )) as { ok: boolean; error: { requestId?: string; details?: { retryWith?: { requestID: string } } } };

    expect(envelope.ok).toBe(false);
    expect(envelope.error.requestId).toBe('t-9');
    expect(envelope.error.details?.retryWith?.requestID).toBe('t-9');
  });

  it('exposes retry continuity for a ToolCallControlError with nested details', () => {
    const control = {
      version: 1,
      callId: 'call-y',
      confirm: true,
      confirmation: { planId: 'p2', planHash: 'h2', expiresAtUnixMs: 4102444800000 },
    };
    const error = new ToolCallControlError('confirmation_required', 'Plan confirmation required.', {
      retryable: true,
      details: { retryWith: { requestID: 't-10', control } },
    });
    const envelope = serializeError(error) as { error: { requestId?: string; details?: { retryWith?: { requestID: string; control: typeof control } } } };

    expect(envelope.error.requestId).toBe('t-10');
    expect(envelope.error.details?.retryWith?.requestID).toBe('t-10');
    expect(envelope.error.details?.retryWith?.control).toEqual(control);
  });

  it('drops an oversized retryWith control payload but keeps the request id', () => {
    const hugeControl = {
      version: 1,
      callId: 'c',
      blob: 'x'.repeat(400),
      nested: Array.from({ length: 64 }, (_, i) => ({ i })),
    };
    const envelope = serializeError(new CliError(
      'Confirmation required.',
      'confirmation_required',
      4,
      true,
      { retryWith: { requestID: 't-11', control: hugeControl } },
    )) as { error: { requestId?: string; details?: { retryWith?: { requestID: string; control: { omitted?: string } } } } };

    expect(envelope.error.requestId).toBe('t-11');
    expect(envelope.error.details?.retryWith?.requestID).toBe('t-11');
    expect(envelope.error.details?.retryWith?.control.omitted).toBe('size-exceeded');
  });

  it('keeps the envelope uniform across transport and non-retryable failures', () => {
    const transport = serializeError(new TransportError({
      kind: 'timeout',
      url: 'http://localhost:1/x',
      method: 'POST',
      message: 'Request timed out after 5ms',
    })) as { error: { code: string; message: string; retryable: boolean; requestId?: unknown; details?: { retryWith?: unknown } } };
    expect(transport.error).toMatchObject({ code: 'transport-timeout', retryable: true });
    expect(transport.error.requestId).toBeUndefined();
    expect(transport.error.details?.retryWith).toBeUndefined();

    const plain = serializeError(new CliError('Nope.', 'cli-error', 1, false)) as { error: { code: string; retryable: boolean; requestId?: unknown } };
    expect(plain.error).toMatchObject({ code: 'cli-error', retryable: false });
    expect(plain.error.requestId).toBeUndefined();
  });

  it('marks a transport timeout as result-unknown and points at the call record', () => {
    const withCallId = serializeError(new TransportError({
      kind: 'timeout',
      url: 'http://localhost:1/api/tools/script-execute',
      method: 'POST',
      message: 'Request timed out after 60000ms',
      callId: 'c-ab12cd34',
    })) as { error: { code: string; message: string; retryable: boolean; details?: { callId?: string; resultUnknown?: boolean } } };
    expect(withCallId.error.code).toBe('transport-timeout');
    expect(withCallId.error.retryable).toBe(true);
    expect(withCallId.error.details?.resultUnknown).toBe(true);
    expect(withCallId.error.details?.callId).toBe('c-ab12cd34');
    expect(withCallId.error.message).toContain('result unknown');
    expect(withCallId.error.message).toContain('uco call get c-ab12cd34');

    const withoutCallId = serializeError(new TransportError({
      kind: 'timeout',
      url: 'http://localhost:1/api/tools/script-execute',
      method: 'POST',
      message: 'Request timed out after 60000ms',
    })) as { error: { message: string } };
    expect(withoutCallId.error.message).toContain('uco call list');
  });

  it('omits promoted retry continuity for a non-confirmation failure that merely has a retryWith-shaped detail', () => {
    const envelope = serializeError(new CliError(
      'Something else.',
      'editor_not_ready',
      4,
      true,
      { retryWith: { requestID: 't-12', control: {} } },
    )) as { error: { requestId?: unknown; details?: unknown } };
    expect(envelope.error.requestId).toBeUndefined();
    // The raw detail is preserved verbatim for diagnostics but the documented
    // continuity positions are not promoted for non-retryable-code failures.
    expect((envelope.error.details as { requestId?: unknown }).requestId).toBeUndefined();
  });
});

describe('post-call idle wait (COCli-05)', () => {
  const readyHealth = {
    ok: true,
    stages: {
      process: { ready: true },
      http: { ready: true },
      webSocket: { ready: true, connections: 1 },
      handshake: { ready: true, compatibleConnections: 1 },
      capabilities: { ready: true },
      toolRunner: { ready: true, registeredConnections: 1 },
    },
  };
  const idleEditor = { status: 'success', structured: { isPlaying: false, isPaused: false, isCompiling: false, isUpdating: false, isPlayingOrWillChangePlaymode: false } };
  const compilingEditor = { status: 'success', structured: { isPlaying: false, isPaused: false, isCompiling: true, isUpdating: false, isPlayingOrWillChangePlaymode: false } };

  function stubTransport(health: unknown, editorState: unknown): RestTransport {
    const fetchImpl: typeof fetch = vi.fn(async (_url, init) => {
      const url = String(_url);
      if (url.endsWith('/api/health')) {
        return new Response(JSON.stringify(health), { status: 200 });
      }
      void init;
      return new Response(JSON.stringify(editorState), { status: 200 });
    });
    return new RestTransport({ baseUrl: 'http://localhost:23456', fetchImpl });
  }

  it('returns promptly after one probe when the Editor is already idle', async () => {
    const transport = stubTransport(readyHealth, idleEditor);
    const start = Date.now();
    await waitForEditorIdle(transport, { timeoutMs: 5_000, intervalMs: 50 });
    expect(Date.now() - start).toBeLessThan(2_000);
  });

  it('waits through a compiling window until the Editor goes idle', async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = vi.fn(async (_url) => {
      const url = String(_url);
      if (url.endsWith('/api/health')) return new Response(JSON.stringify(readyHealth), { status: 200 });
      calls++;
      return new Response(JSON.stringify(calls < 3 ? compilingEditor : idleEditor), { status: 200 });
    });
    const transport = new RestTransport({ baseUrl: 'http://localhost:23456', fetchImpl });

    await waitForEditorIdle(transport, { timeoutMs: 5_000, intervalMs: 50 });
    expect(calls).toBeGreaterThanOrEqual(3);
  });

  it('fails with the wait-timeout code naming the last blocking stage and cause', async () => {
    const transport = stubTransport(readyHealth, compilingEditor);
    await expect(waitForEditorIdle(transport, { timeoutMs: 250, intervalMs: 80 }))
      .rejects.toMatchObject({
        code: 'idle-wait-timeout',
        exitCode: 3,
        details: { stage: 'editor', cause: 'compiling' },
      });
  });
});
