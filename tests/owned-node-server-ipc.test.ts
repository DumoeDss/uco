import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { spawn as spawnRuntime } from 'node:child_process';
import * as fs from 'node:fs';
import { createServer } from 'node:http';
import { createServer as createNetServer, type AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';
import type { ChildProcess, spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { prepareOwnedNodeServer } from '../src/devops/lib/owned-node-server.js';

const temporaryDirectories: string[] = [];
const servers: Array<ReturnType<typeof createServer>> = [];
const ownedServerIdentities: ExactServerIdentity[] = [];
const STATE_NAME = '.uco-owned-node-server.state.json';
const LEGACY_LOCK_NAME = '.uco-owned-node-server.lock';
const TOKEN_FINGERPRINT_DOMAIN = 'uco-owned-node-server:v3:token\0';

function temporaryProject(): string {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'uco-owned-ipc-'));
  temporaryDirectories.push(project);
  return project;
}

async function listen(handler: Parameters<typeof createServer>[0]): Promise<{
  server: ReturnType<typeof createServer>;
  baseUrl: string;
  port: number;
}> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  return { server, port: address.port, baseUrl: `http://127.0.0.1:${address.port}` };
}

function authenticatedHealth(
  token: string,
  instance?: { serverInstanceId: string; handoffPhase: 'precommit' | 'committed' },
): Parameters<typeof createServer>[0] {
  return (request, response) => {
    if (request.headers.authorization !== `Bearer ${token}`) {
      response.writeHead(401).end();
      return;
    }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({
      ok: true,
      stages: { http: { ready: true, authenticated: true } },
      ...(instance ?? {}),
    }));
  };
}

function tokenFingerprint(token: string): string {
  return createHash('sha256')
    .update(TOKEN_FINGERPRINT_DOMAIN)
    .update(token)
    .digest('base64url');
}

function writeOwnedStateRecord(
  project: string,
  details: {
    endpoint: string;
    port: number;
    token: string;
    serverInstanceId: string;
    phase: 'prepared' | 'commit-intent' | 'committed';
    pid?: number;
    processStartedAt?: number;
  },
): string {
  const userSettings = path.join(project, 'UserSettings');
  fs.mkdirSync(userSettings, { recursive: true });
  const statePath = path.join(userSettings, STATE_NAME);
  const record: Record<string, unknown> = {
    protocolVersion: 3,
    endpoint: details.endpoint,
    listenHost: '127.0.0.1',
    port: details.port,
    authorization: 'required',
    tokenFingerprint: tokenFingerprint(details.token),
    serverInstanceId: details.serverInstanceId,
    phase: details.phase,
    updatedAt: '2026-09-01T00:00:00.000Z',
  };
  if (details.pid !== undefined) record.pid = details.pid;
  if (details.processStartedAt !== undefined) record.processStartedAt = details.processStartedAt;
  fs.writeFileSync(statePath, JSON.stringify(record, null, 2), 'utf8');
  return statePath;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForExactProcessExit(pid: number, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (processIsAlive(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  if (processIsAlive(pid)) throw new Error(`Exact process ${pid} did not exit within ${timeoutMs}ms.`);
}

async function reserveFreePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function expectEndpointReservable(port: number, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const server = createNetServer();
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => {
          server.removeAllListeners('error');
          resolve();
        });
      });
      await new Promise<void>((resolve) => server.close(() => resolve()));
      return;
    } catch (error) {
      server.close();
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE' || Date.now() >= deadline) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

function mockChild(pid: number, connected = false): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  Object.defineProperty(child, 'pid', { value: pid, configurable: true });
  Object.defineProperty(child, 'exitCode', { value: null, writable: true, configurable: true });
  Object.defineProperty(child, 'signalCode', { value: null, writable: true, configurable: true });
  Object.defineProperty(child, 'stderr', { value: new PassThrough(), configurable: true });
  Object.defineProperty(child, 'connected', { value: connected, writable: true, configurable: true });
  child.unref = vi.fn();
  child.disconnect = vi.fn(() => {
    Object.defineProperty(child, 'connected', { value: false, writable: true, configurable: true });
  });
  child.kill = vi.fn(() => true);
  return child;
}

interface ExactProcessHandle {
  child: ChildProcess;
  pid: number;
  expectedArgs: readonly string[];
}

function captureExactProcessHandle(
  child: ChildProcess,
  expectedArgs: readonly string[],
): ExactProcessHandle {
  const pid = child.pid;
  if (!Number.isInteger(pid) || (pid as number) <= 0) {
    throw new Error('The test could not capture a valid process handle PID; refusing cleanup.');
  }
  const actualArgs = child.spawnargs ?? [];
  if (!expectedArgs.every((argument) => actualArgs.includes(argument))) {
    throw new Error('The captured process handle arguments did not match this test; refusing cleanup.');
  }
  return { child, pid: pid as number, expectedArgs };
}

function assertExactProcessHandle(handle: ExactProcessHandle): void {
  if (handle.child.pid !== handle.pid || !handle.expectedArgs.every((argument) =>
    (handle.child.spawnargs ?? []).includes(argument))) {
    throw new Error('The captured process handle no longer identifies this test process.');
  }
}

function processHandleExited(child: ChildProcess): boolean {
  return (child.exitCode !== null && child.exitCode !== undefined) ||
    (child.signalCode !== null && child.signalCode !== undefined);
}

async function waitForProcessHandleExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (processHandleExited(child)) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('Tracked process did not exit within the test deadline.')), timeoutMs);
    const finish = (error?: Error): void => {
      clearTimeout(timer);
      child.removeListener('exit', onExit);
      child.removeListener('error', onError);
      if (error) reject(error);
      else resolve();
    };
    const onExit = (): void => finish();
    const onError = (error: Error): void => finish(error);
    child.once('exit', onExit);
    child.once('error', onError);
  });
}

async function terminateExactProcessHandle(
  handle: ExactProcessHandle,
  timeoutMs = 5_000,
): Promise<void> {
  assertExactProcessHandle(handle);
  if (!processHandleExited(handle.child)) {
    if (!handle.child.kill('SIGTERM')) {
      throw new Error('The exact tracked process handle refused termination.');
    }
    await waitForProcessHandleExit(handle.child, timeoutMs);
  }
}

async function waitForWorkerMessage(
  child: ChildProcess,
  predicate: (message: Record<string, unknown>) => boolean,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('Worker did not report the expected bounded result.')), timeoutMs);
    const finish = (error?: Error, message?: Record<string, unknown>): void => {
      clearTimeout(timer);
      child.removeListener('message', onMessage);
      child.removeListener('exit', onExit);
      child.removeListener('error', onError);
      if (error) reject(error);
      else resolve(message as Record<string, unknown>);
    };
    const onMessage = (raw: unknown): void => {
      if (typeof raw === 'object' && raw !== null && predicate(raw as Record<string, unknown>)) {
        finish(undefined, raw as Record<string, unknown>);
      }
    };
    const onExit = (): void => finish(new Error('Worker exited before reporting its bounded result.'));
    const onError = (error: Error): void => finish(error);
    child.on('message', onMessage);
    child.once('exit', onExit);
    child.once('error', onError);
  });
}

async function sendWorkerControl(
  child: ChildProcess,
  message: Record<string, unknown>,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    if (!child.connected || child.send === undefined) {
      reject(new Error('The tracked worker IPC channel is unavailable.'));
      return;
    }
    try {
      child.send(message, (error: Error | null) => {
        if (error) reject(error);
        else resolve();
      });
    } catch (error) {
      reject(error);
    }
  });
}

async function waitForFile(filePath: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(filePath) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  if (!fs.existsSync(filePath)) {
    throw new Error(`Expected bounded marker was not written: ${path.basename(filePath)}.`);
  }
}

interface ExactServerIdentity {
  baseUrl: string;
  token: string;
  serverInstanceId: string;
  pid: number;
}

async function exactServerHealth(identity: ExactServerIdentity): Promise<Record<string, unknown> | undefined> {
  try {
    const response = await fetch(`${identity.baseUrl}/api/health`, {
      headers: { Authorization: `Bearer ${identity.token}` },
    });
    if (!response.ok) return undefined;
    const payload = await response.json() as Record<string, unknown>;
    const stages = payload.stages as Record<string, unknown> | undefined;
    const processStage = stages?.process as Record<string, unknown> | undefined;
    if (payload.serverInstanceId !== identity.serverInstanceId || processStage?.pid !== identity.pid) {
      return undefined;
    }
    return payload;
  } catch {
    return undefined;
  }
}

async function waitForExactServerHealth(
  identity: ExactServerIdentity,
  phase: 'precommit' | 'committed',
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const health = await exactServerHealth(identity);
    if (health?.handoffPhase === phase) return health;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Exact test server did not report bounded ${phase} health.`);
}

async function terminateVerifiedServer(identity: ExactServerIdentity): Promise<void> {
  const proof = await exactServerHealth(identity);
  if (proof === undefined) return;
  if (!processIsAlive(identity.pid)) return;
  try { process.kill(identity.pid, 'SIGTERM'); } catch { return; }
  await waitForExactProcessExit(identity.pid, 5_000).catch(() => undefined);
}

afterEach(async () => {
  for (const identity of ownedServerIdentities.splice(0)) await terminateVerifiedServer(identity);
  for (const server of servers.splice(0)) {
    if (!server.listening) continue;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  // Detached Windows workers can hold their temporary cwd briefly after the
  // exit event. Give the OS a bounded release window before removing it.
  await new Promise((resolve) => setTimeout(resolve, 250));
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

describe('owned endpoint reservation and exact-instance IPC', () => {
  it('ignores legacy v2 lock artifacts without deleting or creating claim paths', async () => {
    const project = temporaryProject();
    const userSettings = path.join(project, 'UserSettings');
    fs.mkdirSync(userSettings, { recursive: true });
    const lockPath = path.join(userSettings, LEGACY_LOCK_NAME);
    const claimingPath = `${lockPath}.claiming`;
    fs.writeFileSync(lockPath, '{"protocolVersion":2,"pid":1}', 'utf8');
    fs.writeFileSync(claimingPath, 'legacy-transition', 'utf8');
    const token = 'fixture-token';
    const running = await listen(authenticatedHealth(token));

    await expect(prepareOwnedNodeServer({
      projectPath: project,
      url: running.baseUrl,
      token,
      lockTimeoutMs: 20,
      lockPollIntervalMs: 1,
    })).resolves.toMatchObject({ alreadyRunning: true, token });

    expect(fs.readFileSync(lockPath, 'utf8')).toBe('{"protocolVersion":2,"pid":1}');
    expect(fs.readFileSync(claimingPath, 'utf8')).toBe('legacy-transition');
    expect(fs.readdirSync(userSettings).filter((name) => name.startsWith(LEGACY_LOCK_NAME)))
      .toEqual([LEGACY_LOCK_NAME, `${LEGACY_LOCK_NAME}.claiming`]);
  });

  it('does not persist credentials or spawn when another listener owns the endpoint', async () => {
    const project = temporaryProject();
    const running = await listen((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({
        ok: true,
        stages: { http: { ready: true, authenticated: false } },
      }));
    });
    const spawnImpl = vi.fn(() => { throw new Error('reservation loser spawned'); }) as unknown as typeof spawn;

    await expect(prepareOwnedNodeServer({
      projectPath: project,
      url: running.baseUrl,
      lockTimeoutMs: 20,
      lockPollIntervalMs: 1,
    }, { spawnImpl })).rejects.toThrow(/occupied|incompatible listener/i);

    expect(spawnImpl).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(
      project,
      'UserSettings',
      'AI-Game-Developer-Config.json',
    ))).toBe(false);
  });

  it('rejects a live instance that disagrees with state regardless of PID metadata', async () => {
    const project = temporaryProject();
    const token = 'fixture-token';
    const running = await listen(authenticatedHealth(token, {
      serverInstanceId: 'live-other-instance',
      handoffPhase: 'committed',
    }));
    const userSettings = path.join(project, 'UserSettings');
    fs.mkdirSync(userSettings, { recursive: true });
    fs.writeFileSync(path.join(userSettings, STATE_NAME), JSON.stringify({
      protocolVersion: 3,
      endpoint: running.baseUrl,
      listenHost: '127.0.0.1',
      port: running.port,
      authorization: 'required',
      tokenFingerprint: tokenFingerprint(token),
      serverInstanceId: 'recorded-instance',
      phase: 'committed',
      pid: process.pid,
      processStartedAt: 1,
      updatedAt: '2026-09-01T00:00:00.000Z',
    }, null, 2), 'utf8');
    const spawnImpl = vi.fn() as unknown as typeof spawn;

    await expect(prepareOwnedNodeServer({
      projectPath: project,
      url: running.baseUrl,
      token,
      lockTimeoutMs: 20,
      lockPollIntervalMs: 1,
    }, { spawnImpl })).rejects.toThrow(/occupied|incompatible listener/i);
    expect(spawnImpl).not.toHaveBeenCalled();
    expect(running.server.listening).toBe(true);
  });

  it('reconciles commit intent only when authenticated health proves the exact committed instance', async () => {
    const project = temporaryProject();
    const token = 'commit-intent-recovery-token';
    const instanceId = 'committed-after-parent-loss';
    const running = await listen(authenticatedHealth(token, {
      serverInstanceId: instanceId,
      handoffPhase: 'committed',
    }));
    const statePath = writeOwnedStateRecord(project, {
      endpoint: running.baseUrl,
      port: running.port,
      token,
      serverInstanceId: instanceId,
      phase: 'commit-intent',
      pid: process.pid,
    });
    const spawnImpl = vi.fn() as unknown as typeof spawn;

    await expect(prepareOwnedNodeServer({
      projectPath: project,
      url: running.baseUrl,
      token,
      lockTimeoutMs: 50,
      lockPollIntervalMs: 1,
    }, { spawnImpl })).resolves.toMatchObject({
      alreadyRunning: true,
      token,
      serverInstanceId: instanceId,
    });

    expect(spawnImpl).not.toHaveBeenCalled();
    expect(JSON.parse(fs.readFileSync(statePath, 'utf8'))).toMatchObject({
      protocolVersion: 3,
      phase: 'committed',
      serverInstanceId: instanceId,
      pid: process.pid,
    });
  });

  it('does not reconcile commit intent while the exact live instance remains precommit', async () => {
    const project = temporaryProject();
    const token = 'precommit-recovery-token';
    const instanceId = 'still-precommit-instance';
    const running = await listen(authenticatedHealth(token, {
      serverInstanceId: instanceId,
      handoffPhase: 'precommit',
    }));
    const statePath = writeOwnedStateRecord(project, {
      endpoint: running.baseUrl,
      port: running.port,
      token,
      serverInstanceId: instanceId,
      phase: 'commit-intent',
      pid: process.pid,
    });
    const stateBefore = fs.readFileSync(statePath, 'utf8');
    const spawnImpl = vi.fn(() => { throw new Error('precommit recovery spawned'); }) as unknown as typeof spawn;

    await expect(prepareOwnedNodeServer({
      projectPath: project,
      url: running.baseUrl,
      token,
      lockTimeoutMs: 35,
      lockPollIntervalMs: 1,
    }, { spawnImpl })).rejects.toThrow(/occupied|incompatible listener/i);

    expect(spawnImpl).not.toHaveBeenCalled();
    expect(fs.readFileSync(statePath, 'utf8')).toBe(stateBefore);
    expect(running.server.listening).toBe(true);
  });

  it('replaces a stale exact-instance record only after reserving a free endpoint', async () => {
    const project = temporaryProject();
    const port = await reserveFreePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const staleInstanceId = 'stale-free-endpoint-instance';
    const token = 'new-free-endpoint-token';
    const statePath = writeOwnedStateRecord(project, {
      endpoint: baseUrl,
      port,
      token: 'old-token-that-must-not-authorize',
      serverInstanceId: staleInstanceId,
      phase: 'committed',
      pid: process.pid,
      processStartedAt: 1,
    });
    let liveInstanceId: string | undefined;
    let phase: 'offline' | 'precommit' | 'committed' = 'offline';
    const child = mockChild(5521, true);
    child.send = vi.fn((raw: unknown, ...args: unknown[]) => {
      const message = raw as { type: string; serverInstanceId: string };
      const callback = args.find((arg): arg is (error: Error | null) => void =>
        typeof arg === 'function');
      liveInstanceId = message.serverInstanceId;
      if (message.type === 'uco-owned-handoff') {
        phase = 'precommit';
        queueMicrotask(() => child.emit('message', {
          type: 'uco-owned-attached',
          serverInstanceId: liveInstanceId,
        }));
      } else if (message.type === 'uco-owned-commit') {
        phase = 'committed';
        queueMicrotask(() => child.emit('message', {
          type: 'uco-owned-committed',
          serverInstanceId: liveInstanceId,
        }));
      }
      callback?.(null);
      return true;
    }) as ChildProcess['send'];
    const fetchImpl = vi.fn(async () => {
      if (!liveInstanceId || phase === 'offline') throw new Error('free endpoint has no child yet');
      return new Response(JSON.stringify({
        ok: true,
        serverInstanceId: liveInstanceId,
        handoffPhase: phase,
        stages: { http: { ready: true, authenticated: true } },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    const spawnImpl = vi.fn((_command, args, options) => {
      expect(args).not.toContain(token);
      expect(options?.env?.UCO_SERVER_TOKEN).toBe(token);
      return child;
    }) as unknown as typeof spawn;

    const result = await prepareOwnedNodeServer({
      projectPath: project,
      url: baseUrl,
      token,
      startupTimeoutMs: 500,
      pollIntervalMs: 1,
      cleanupTimeoutMs: 100,
    }, { fetchImpl, spawnImpl });

    expect(result).toMatchObject({
      alreadyRunning: false,
      token,
      serverInstanceId: liveInstanceId,
      pid: 5521,
    });
    expect(spawnImpl).toHaveBeenCalledTimes(1);
    expect(child.kill).not.toHaveBeenCalled();
    const stateText = fs.readFileSync(statePath, 'utf8');
    const state = JSON.parse(stateText) as Record<string, unknown>;
    expect(state).toMatchObject({
      protocolVersion: 3,
      endpoint: baseUrl,
      tokenFingerprint: tokenFingerprint(token),
      serverInstanceId: liveInstanceId,
      phase: 'committed',
      pid: 5521,
    });
    expect(state).not.toHaveProperty('processStartedAt');
    expect(state.serverInstanceId).not.toBe(staleInstanceId);
  });

  it('ignores a reused unrelated PID when exact authenticated instance health matches', async () => {
    const project = temporaryProject();
    const token = 'pid-reuse-token';
    const instanceId = 'exact-instance-over-pid';
    const running = await listen(authenticatedHealth(token, {
      serverInstanceId: instanceId,
      handoffPhase: 'committed',
    }));
    const statePath = writeOwnedStateRecord(project, {
      endpoint: running.baseUrl,
      port: running.port,
      token,
      serverInstanceId: instanceId,
      phase: 'committed',
      // This is the test runner's unrelated live process, not the server.
      pid: process.pid,
      processStartedAt: 1,
    });
    const killSpy = vi.spyOn(process, 'kill');
    try {
      await expect(prepareOwnedNodeServer({
        projectPath: project,
        url: running.baseUrl,
        token,
        lockTimeoutMs: 50,
        lockPollIntervalMs: 1,
      })).resolves.toMatchObject({
        alreadyRunning: true,
        token,
        serverInstanceId: instanceId,
      });
      expect(killSpy).not.toHaveBeenCalled();
    } finally {
      killSpy.mockRestore();
    }
    expect(processIsAlive(process.pid)).toBe(true);
    expect(fs.readFileSync(statePath, 'utf8')).toContain('processStartedAt');
  });

  it('fails closed for incompatible explicit credentials without spawning or mutating state', async () => {
    const project = temporaryProject();
    const actualToken = 'actual-listener-token';
    const incompatibleToken = 'different-explicit-token';
    const instanceId = 'listener-with-other-credentials';
    const running = await listen(authenticatedHealth(actualToken, {
      serverInstanceId: instanceId,
      handoffPhase: 'committed',
    }));
    const statePath = writeOwnedStateRecord(project, {
      endpoint: running.baseUrl,
      port: running.port,
      token: actualToken,
      serverInstanceId: instanceId,
      phase: 'committed',
      pid: 987654,
    });
    const stateBefore = fs.readFileSync(statePath, 'utf8');
    const spawnImpl = vi.fn(() => { throw new Error('incompatible listener spawned'); }) as unknown as typeof spawn;

    const error = await prepareOwnedNodeServer({
      projectPath: project,
      url: running.baseUrl,
      token: incompatibleToken,
      lockTimeoutMs: 35,
      lockPollIntervalMs: 1,
    }, { spawnImpl }).catch((caught: unknown) => caught as Error);

    expect(error.message).toMatch(/occupied|incompatible listener/i);
    expect(error.message).not.toContain(actualToken);
    expect(error.message).not.toContain(incompatibleToken);
    expect(spawnImpl).not.toHaveBeenCalled();
    expect(fs.readFileSync(statePath, 'utf8')).toBe(stateBefore);
    expect(running.server.listening).toBe(true);
  });

  it('contains no approximate process-start identity in owned records or decisions', async () => {
    const sourcePath = path.resolve('src/devops/lib/owned-node-server.ts');
    const source = fs.readFileSync(sourcePath, 'utf8');
    expect(source).not.toMatch(/PROCESS_STARTED_AT_MS|process\.uptime\(\)|processStartedAt/);
    expect(source).not.toMatch(/process\.kill\(|taskkill/);
  });

  it('hands the reserved socket to one exact child and commits only after exact health', async () => {
    const project = temporaryProject();
    const free = await listen((_request, response) => response.writeHead(503).end());
    const port = free.port;
    await new Promise<void>((resolve) => free.server.close(() => resolve()));
    const token = 'handoff-secret';
    let instanceId: string | undefined;
    let phase: 'offline' | 'precommit' | 'committed' = 'offline';
    const child = new EventEmitter() as ChildProcess;
    Object.defineProperty(child, 'pid', { value: 4242, configurable: true });
    Object.defineProperty(child, 'exitCode', { value: null, writable: true, configurable: true });
    Object.defineProperty(child, 'signalCode', { value: null, writable: true, configurable: true });
    Object.defineProperty(child, 'stderr', { value: new PassThrough(), configurable: true });
    Object.defineProperty(child, 'connected', { value: true, writable: true, configurable: true });
    child.unref = vi.fn();
    child.disconnect = vi.fn(() => {
      Object.defineProperty(child, 'connected', { value: false, writable: true, configurable: true });
    });
    child.kill = vi.fn(() => true);
    child.send = vi.fn((message: unknown, ...args: unknown[]) => {
      const record = message as { type: string; serverInstanceId: string };
      const callback = args.find((arg): arg is (error: Error | null) => void => typeof arg === 'function');
      instanceId = record.serverInstanceId;
      if (record.type === 'uco-owned-handoff') {
        phase = 'precommit';
        queueMicrotask(() => child.emit('message', {
          type: 'uco-owned-attached',
          serverInstanceId: instanceId,
        }));
      } else if (record.type === 'uco-owned-commit') {
        phase = 'committed';
        queueMicrotask(() => child.emit('message', {
          type: 'uco-owned-committed',
          serverInstanceId: instanceId,
        }));
      }
      callback?.(null);
      return true;
    }) as ChildProcess['send'];

    const spawnImpl = vi.fn((_command, args, options) => {
      expect(args).toContain('--owned-ipc-handoff');
      expect(args).not.toContain(token);
      expect(options?.stdio).toEqual(['ignore', 'ignore', 'pipe', 'ipc']);
      instanceId = options?.env?.COCLI_SERVER_INSTANCE_ID;
      expect(instanceId).toMatch(/^[A-Za-z0-9_-]{32}$/);
      expect(options?.env?.UCO_SERVER_TOKEN).toBe(token);
      return child;
    }) as unknown as typeof spawn;
    const fetchImpl = vi.fn(async () => {
      if (phase === 'offline' || !instanceId) throw new Error('not ready');
      return new Response(JSON.stringify({
        ok: true,
        serverInstanceId: instanceId,
        handoffPhase: phase,
        stages: { http: { ready: true, authenticated: true } },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });

    const result = await prepareOwnedNodeServer({
      projectPath: project,
      url: `http://127.0.0.1:${port}`,
      token,
      startupTimeoutMs: 250,
      pollIntervalMs: 1,
      cleanupTimeoutMs: 50,
    }, { fetchImpl, spawnImpl });

    expect(result).toMatchObject({
      alreadyRunning: false,
      token,
      pid: 4242,
      serverInstanceId: instanceId,
    });
    expect(child.unref).toHaveBeenCalledTimes(1);
    expect(child.disconnect).toHaveBeenCalledTimes(1);
    const stateText = fs.readFileSync(path.join(project, 'UserSettings', STATE_NAME), 'utf8');
    const state = JSON.parse(stateText) as Record<string, unknown>;
    expect(state).toMatchObject({
      protocolVersion: 3,
      serverInstanceId: instanceId,
      phase: 'committed',
      pid: 4242,
    });
    expect(stateText).not.toContain(token);
    expect(state).not.toHaveProperty('processStartedAt');
    expect(fs.readdirSync(path.join(project, 'UserSettings'))
      .some((name) => name.startsWith(LEGACY_LOCK_NAME))).toBe(false);
  });

  it('releases the reservation when the reserved-phase hook fails before spawn', async () => {
    const project = temporaryProject();
    const port = await reserveFreePort();
    const spawnImpl = vi.fn() as unknown as typeof spawn;

    const error = await prepareOwnedNodeServer({
      projectPath: project,
      url: `http://127.0.0.1:${port}`,
      token: 'fixture-token',
      cleanupTimeoutMs: 250,
    }, {
      spawnImpl,
      onHandoffPhase(phase) {
        if (phase === 'reserved') throw new Error('injected reserved-phase failure');
      },
    }).catch((caught: unknown) => caught as Error);

    expect(error.message).toContain('injected reserved-phase failure');
    expect(error.message).toContain('cleanup confirmed exact-child exit and endpoint release');
    expect(spawnImpl).not.toHaveBeenCalled();
    await expectEndpointReservable(port);
  });

  it('fails closed when IPC handle transfer is unavailable and confirms cleanup', async () => {
    const project = temporaryProject();
    const port = await reserveFreePort();
    const child = mockChild(4343);
    child.kill = vi.fn(() => {
      Object.defineProperty(child, 'signalCode', {
        value: 'SIGTERM',
        writable: true,
        configurable: true,
      });
      queueMicrotask(() => child.emit('exit', null, 'SIGTERM'));
      return true;
    });

    const error = await prepareOwnedNodeServer({
      projectPath: project,
      url: `http://127.0.0.1:${port}`,
      token: 'transfer-secret',
      startupTimeoutMs: 100,
      cleanupTimeoutMs: 250,
    }, {
      spawnImpl: vi.fn(() => child) as unknown as typeof spawn,
    }).catch((caught: unknown) => caught as Error);

    expect(error.message).toMatch(/IPC handle transfer is unavailable/i);
    expect(error.message).toContain('cleanup confirmed exact-child exit and endpoint release');
    expect(error.message).not.toContain('transfer-secret');
    expect(child.kill).toHaveBeenCalledTimes(1);
    await expectEndpointReservable(port);
  });

  it('redacts child IPC and stderr diagnostics while confirming exact cleanup', async () => {
    const project = temporaryProject();
    const port = await reserveFreePort();
    const secret = 'child-diagnostic-secret';
    const child = mockChild(4393, true);
    child.send = vi.fn((raw: unknown, ...args: unknown[]) => {
      const message = raw as { type: string; serverInstanceId: string };
      const callback = args.find((arg): arg is (error: Error | null) => void =>
        typeof arg === 'function');
      if (message.type === 'uco-owned-handoff') {
        child.stderr?.emit('data', Buffer.from(`stderr token=${secret}`));
        queueMicrotask(() => child.emit('message', {
          type: 'uco-owned-error',
          serverInstanceId: message.serverInstanceId,
          detail: `rejected Bearer ${secret}`,
        }));
      } else if (message.type === 'uco-owned-abort') {
        Object.defineProperty(child, 'exitCode', {
          value: 1,
          writable: true,
          configurable: true,
        });
        queueMicrotask(() => child.emit('exit', 1, null));
      }
      callback?.(null);
      return true;
    }) as ChildProcess['send'];

    const error = await prepareOwnedNodeServer({
      projectPath: project,
      url: `http://127.0.0.1:${port}`,
      token: secret,
      startupTimeoutMs: 100,
      cleanupTimeoutMs: 250,
    }, {
      spawnImpl: vi.fn(() => child) as unknown as typeof spawn,
    }).catch((caught: unknown) => caught as Error);

    expect(error.message).toContain('[REDACTED]');
    expect(error.message).not.toContain(secret);
    expect(error.message).toContain('cleanup confirmed exact-child exit and endpoint release');
    expect(child.kill).not.toHaveBeenCalled();
    await expectEndpointReservable(port);
  });

  it('reports an unconfirmed exact-child exit truthfully', async () => {
    const project = temporaryProject();
    const port = await reserveFreePort();
    const child = mockChild(4444);
    const spawnImpl = vi.fn(() => child) as unknown as typeof spawn;

    const error = await prepareOwnedNodeServer({
      projectPath: project,
      url: `http://127.0.0.1:${port}`,
      token: 'fixture-token',
      startupTimeoutMs: 50,
      cleanupTimeoutMs: 20,
    }, {
      spawnImpl,
    }).catch((caught: unknown) => caught as Error);

    expect(error.message).toMatch(/cleanup unconfirmed/);
    expect(error.message).toContain('childExit=unconfirmed');
    expect(error.message).toContain('endpointRelease=confirmed');
    expect(error.message).not.toContain('fixture-token');
    expect(spawnImpl).toHaveBeenCalledTimes(1);
    expect(child.kill).toHaveBeenCalledTimes(1);
    await expectEndpointReservable(port);
  });

  it.each([
    {
      interleaving: 'post-link mismatch',
      legacyArtifacts: new Map<string, string>([
        [LEGACY_LOCK_NAME, '{"protocolVersion":2,"nonce":"successor-generation"}'],
        [`${LEGACY_LOCK_NAME}.claiming`, '{"protocolVersion":2,"nonce":"mismatched-post-link"}'],
      ]),
    },
    {
      interleaving: 'post-link existing-claim',
      legacyArtifacts: new Map<string, string>([
        [LEGACY_LOCK_NAME, '{"protocolVersion":2,"nonce":"successor-generation"}'],
        [`${LEGACY_LOCK_NAME}.claiming`, '{"protocolVersion":2,"nonce":"successor-generation"}'],
        [`${LEGACY_LOCK_NAME}.claim.existing`, 'existing-claim-generation'],
      ]),
    },
  ])('keeps the former $interleaving interleaving inert while one healthy winner commits', async ({
    legacyArtifacts,
  }) => {
    const project = temporaryProject();
    const port = await reserveFreePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const userSettings = path.join(project, 'UserSettings');
    fs.mkdirSync(userSettings, { recursive: true });
    for (const [name, content] of legacyArtifacts) {
      fs.writeFileSync(path.join(userSettings, name), content, 'utf8');
    }
    const legacyNamesBefore = fs.readdirSync(userSettings)
      .filter((name) => name.startsWith(LEGACY_LOCK_NAME))
      .sort();

    let releaseWinner!: () => void;
    let reportReserved!: () => void;
    const winnerMayContinue = new Promise<void>((resolve) => { releaseWinner = resolve; });
    const winnerReserved = new Promise<void>((resolve) => { reportReserved = resolve; });
    let releaseLoser!: () => void;
    let reportLoserWait!: () => void;
    const loserMayContinue = new Promise<void>((resolve) => { releaseLoser = resolve; });
    const loserObservedReservation = new Promise<void>((resolve) => { reportLoserWait = resolve; });
    let loserWaitCount = 0;
    const loserSpawn = vi.fn(() => { throw new Error('reservation loser spawned'); }) as unknown as typeof spawn;
    let livePhase: 'offline' | 'precommit' | 'committed' = 'offline';
    let liveToken: string | undefined;
    let liveInstanceId: string | undefined;
    const child = mockChild(4242, true);
    child.send = vi.fn((raw: unknown, ...args: unknown[]) => {
      const message = raw as { type: string; serverInstanceId: string };
      const callback = args.find((arg): arg is (error: Error | null) => void =>
        typeof arg === 'function');
      liveInstanceId = message.serverInstanceId;
      if (message.type === 'uco-owned-handoff') {
        queueMicrotask(() => child.emit('message', {
          type: 'uco-owned-attached',
          serverInstanceId: liveInstanceId,
        }));
      } else if (message.type === 'uco-owned-commit') {
        livePhase = 'committed';
        queueMicrotask(() => child.emit('message', {
          type: 'uco-owned-committed',
          serverInstanceId: liveInstanceId,
        }));
      }
      callback?.(null);
      return true;
    }) as ChildProcess['send'];
    const winnerSpawn = vi.fn((_command, _args, spawnOptions) => {
      liveToken = spawnOptions?.env?.UCO_SERVER_TOKEN;
      liveInstanceId = spawnOptions?.env?.COCLI_SERVER_INSTANCE_ID;
      return child;
    }) as unknown as typeof spawn;
    let healthyWinner: ReturnType<typeof createServer> | undefined;

    try {
      const options = {
        projectPath: project,
        url: baseUrl,
        startupTimeoutMs: 1_000,
        pollIntervalMs: 1,
        cleanupTimeoutMs: 250,
        lockTimeoutMs: 1_000,
        lockPollIntervalMs: 1,
      };
      const winnerPromise = prepareOwnedNodeServer(options, {
        spawnImpl: winnerSpawn,
        async onHandoffPhase(phase) {
          if (phase === 'reserved') {
            reportReserved();
            await winnerMayContinue;
            return;
          }
          if (phase !== 'transferred') return;
          livePhase = 'precommit';
          healthyWinner = createServer((request, response) => {
            if (!liveToken || request.headers.authorization !== `Bearer ${liveToken}`) {
              response.writeHead(401).end();
              return;
            }
            response.writeHead(200, { 'Content-Type': 'application/json' });
            response.end(JSON.stringify({
              ok: true,
              serverInstanceId: liveInstanceId,
              handoffPhase: livePhase,
              stages: { http: { ready: true, authenticated: true } },
            }));
          });
          servers.push(healthyWinner);
          await new Promise<void>((resolve, reject) => {
            healthyWinner?.once('error', reject);
            healthyWinner?.listen(port, '127.0.0.1', () => {
              healthyWinner?.removeListener('error', reject);
              resolve();
            });
          });
        },
      });
      await winnerReserved;

      const loserPromise = prepareOwnedNodeServer(options, {
        spawnImpl: loserSpawn,
        async sleepImpl(ms) {
          loserWaitCount += 1;
          if (loserWaitCount === 1) {
            reportLoserWait();
            await loserMayContinue;
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, ms));
        },
      });
      await loserObservedReservation;

      const descriptorPath = path.join(userSettings, 'AI-Game-Developer-Config.json');
      expect(fs.existsSync(descriptorPath)).toBe(false);
      expect(loserSpawn).not.toHaveBeenCalled();
      expect(fs.readdirSync(userSettings)
        .filter((name) => name.startsWith(LEGACY_LOCK_NAME))
        .sort()).toEqual(legacyNamesBefore);
      for (const [name, content] of legacyArtifacts) {
        expect(fs.readFileSync(path.join(userSettings, name), 'utf8')).toBe(content);
      }

      releaseWinner();
      const winner = await winnerPromise;
      expect(winner).toMatchObject({ alreadyRunning: false });
      expect(winnerSpawn).toHaveBeenCalledTimes(1);
      expect(winner.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      const descriptorText = fs.readFileSync(descriptorPath, 'utf8');
      const descriptor = JSON.parse(descriptorText) as Record<string, unknown>;
      expect(descriptor).toMatchObject({
        host: baseUrl,
        token: winner.token,
        authOption: 'required',
      });
      expect(liveToken).toBe(descriptor.token);

      releaseLoser();
      const loser = await loserPromise;
      expect(loser).toMatchObject({
        alreadyRunning: true,
        token: winner.token,
        serverInstanceId: winner.serverInstanceId,
      });
      expect(loserSpawn).not.toHaveBeenCalled();
      expect(fs.readFileSync(descriptorPath, 'utf8')).toBe(descriptorText);
      expect(fs.readdirSync(userSettings)
        .filter((name) => name.startsWith(LEGACY_LOCK_NAME))
        .sort()).toEqual(legacyNamesBefore);
      for (const [name, content] of legacyArtifacts) {
        expect(fs.readFileSync(path.join(userSettings, name), 'utf8')).toBe(content);
      }
      expect(child.kill).not.toHaveBeenCalled();
      expect(child.send).toHaveBeenCalledTimes(2);
      expect(healthyWinner?.listening).toBe(true);

      const health = await fetch(`${baseUrl}/api/health`, {
        headers: { Authorization: `Bearer ${descriptor.token as string}` },
      });
      expect(health.status).toBe(200);
      await expect(health.json()).resolves.toMatchObject({
        serverInstanceId: winner.serverInstanceId,
        handoffPhase: 'committed',
      });
    } finally {
      releaseWinner();
      releaseLoser();
    }
  }, 5_000);

  it('converges two missing-token cold starts on one real child and descriptor token', async () => {
    const project = temporaryProject();
    const port = await reserveFreePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const wrapperPath = path.join(project, 'owned-server-entry.mjs');
    const serverSourceUrl = pathToFileURL(path.resolve('src/server/index.ts')).href;
    fs.writeFileSync(wrapperPath, [
      `import { main } from ${JSON.stringify(serverSourceUrl)};`,
      'await main(process.argv);',
    ].join('\n'), 'utf8');

    const previousNodeOptions = process.env.NODE_OPTIONS;
    const tsxLoaderUrl = new URL('../node_modules/tsx/dist/loader.mjs', import.meta.url).href;
    process.env.NODE_OPTIONS = [previousNodeOptions, `--import ${tsxLoaderUrl}`]
      .filter(Boolean)
      .join(' ');
    try {
      const options = {
        projectPath: project,
        url: baseUrl,
        startupTimeoutMs: 5_000,
        pollIntervalMs: 10,
        cleanupTimeoutMs: 2_000,
        lockTimeoutMs: 5_000,
        lockPollIntervalMs: 10,
      };
      const [first, second] = await Promise.all([
        prepareOwnedNodeServer(options, { serverEntry: wrapperPath }),
        prepareOwnedNodeServer(options, { serverEntry: wrapperPath }),
      ]);

      const owner = first.alreadyRunning ? second : first;
      const reused = first.alreadyRunning ? first : second;
      expect(owner.alreadyRunning).toBe(false);
      expect(reused.alreadyRunning).toBe(true);
      expect(owner.pid).toBeDefined();
      expect(owner.serverInstanceId).toMatch(/^[A-Za-z0-9_-]{32}$/);
      expect(reused.serverInstanceId).toBe(owner.serverInstanceId);
      expect(reused.token).toBe(owner.token);
      const descriptor = JSON.parse(fs.readFileSync(path.join(
        project,
        'UserSettings',
        'AI-Game-Developer-Config.json',
      ), 'utf8')) as Record<string, unknown>;
      expect(descriptor).toMatchObject({
        host: baseUrl,
        token: owner.token,
        authOption: 'required',
      });
      expect(fs.readdirSync(path.join(project, 'UserSettings'))
        .some((name) => name.startsWith(LEGACY_LOCK_NAME))).toBe(false);

      const health = await fetch(`${baseUrl}/api/health`, {
        headers: { Authorization: `Bearer ${owner.token}` },
      });
      await expect(health.json()).resolves.toMatchObject({
        serverInstanceId: owner.serverInstanceId,
        handoffPhase: 'committed',
      });
      if (owner.pid !== undefined && owner.serverInstanceId !== undefined && owner.token !== undefined) {
        ownedServerIdentities.push({
          baseUrl,
          token: owner.token,
          serverInstanceId: owner.serverInstanceId,
          pid: owner.pid,
        });
      }
    } finally {
      if (previousNodeOptions === undefined) delete process.env.NODE_OPTIONS;
      else process.env.NODE_OPTIONS = previousNodeOptions;
    }
  }, 15_000);

  it('keeps a stalled real owner authoritative beyond the former lease before an exact successor', async () => {
    const project = temporaryProject();
    const port = await reserveFreePort();
    expect(port).not.toBe(8765);
    const baseUrl = `http://127.0.0.1:${port}`;
    const wrapperPath = path.join(project, 'owned-server-entry.mjs');
    const parentWorkerPath = path.join(project, 'precommit-parent.mjs');
    const contenderWorkerPath = path.join(project, 'contender.mjs');
    const serverSourceUrl = new URL('../src/server/index.ts', import.meta.url).href;
    const ownedSourceUrl = new URL('../src/devops/lib/owned-node-server.ts', import.meta.url).href;
    const formerLeaseDurationMs = 5_000;
    const parentMarker = `uco-6-2-parent-${path.basename(project)}`;
    const contenderMarker = `uco-6-2-contender-${path.basename(project)}`;
    fs.writeFileSync(wrapperPath, [
      `import { main } from ${JSON.stringify(serverSourceUrl)};`,
      'await main(process.argv);',
    ].join('\n'), 'utf8');
    fs.writeFileSync(parentWorkerPath, [
      `const { prepareOwnedNodeServer } = await import(${JSON.stringify(ownedSourceUrl)});`,
      'const [projectPath, url, serverEntry, marker] = process.argv.slice(2);',
      'process.on("message", (message) => {',
      '  if (message && message.type === "test-cleanup") process.exit(0);',
      '});',
      'await prepareOwnedNodeServer({',
      '  projectPath, url, startupTimeoutMs: 30000, pollIntervalMs: 10,',
      '  cleanupTimeoutMs: 2000, lockTimeoutMs: 10000, lockPollIntervalMs: 10,',
      '}, {',
      '  serverEntry,',
      '  onHandoffPhase(phase, details) {',
      '    if (phase !== "precommit") return;',
      '    process.send?.({ phase, marker, parentPid: process.pid, ...details });',
      '    return new Promise(() => undefined);',
      '  },',
      '});',
    ].join('\n'), 'utf8');
    fs.writeFileSync(contenderWorkerPath, [
      `const { prepareOwnedNodeServer } = await import(${JSON.stringify(ownedSourceUrl)});`,
      'const [projectPath, url, serverEntry, marker] = process.argv.slice(2);',
      'const notify = (message) => new Promise((resolve) => {',
      '  if (!process.connected || !process.send) { resolve(); return; }',
      '  process.send(message, () => resolve());',
      '});',
      'process.on("message", (message) => {',
      '  if (message && message.type === "test-cleanup") process.exit(0);',
      '});',
      'await notify({ type: "started", marker, pid: process.pid });',
      'const spawnImpl = () => {',
      '  void notify({ type: "spawn-called" });',
      '  throw new Error("unexpected contender spawn");',
      '};',
      'try {',
      '  const result = await prepareOwnedNodeServer({',
      '    projectPath, url, startupTimeoutMs: 1000, pollIntervalMs: 25,',
      `    cleanupTimeoutMs: 1000, lockTimeoutMs: ${formerLeaseDurationMs + 2000}, lockPollIntervalMs: 25,`,
      '  }, { serverEntry, spawnImpl });',
      '  await notify({ type: "outcome", outcome: "reused", alreadyRunning: result.alreadyRunning });',
      '} catch (error) {',
      '  const detail = error instanceof Error ? error.message : String(error);',
      '  await notify({ type: "outcome", outcome: "error", code: detail.includes("occupied") ? "occupied" : "unexpected" });',
      '}',
      'if (process.connected) process.disconnect();',
    ].join('\n'), 'utf8');

    const previousNodeOptions = process.env.NODE_OPTIONS;
    const tsxLoaderUrl = new URL('../node_modules/tsx/dist/loader.mjs', import.meta.url).href;
    const nodeOptions = [previousNodeOptions, `--import ${tsxLoaderUrl}`]
      .filter(Boolean)
      .join(' ');
    let parentHandle: ExactProcessHandle | undefined;
    let contenderHandle: ExactProcessHandle | undefined;
    let parentIdentityVerified = false;
    let contenderIdentityVerified = false;
    let stalledIdentity: ExactServerIdentity | undefined;
    let successorIdentity: ExactServerIdentity | undefined;

    const requestWorkerCleanup = async (handle: ExactProcessHandle | undefined): Promise<void> => {
      if (!handle || processHandleExited(handle.child) || !handle.child.connected ||
          handle.child.send === undefined) return;
      try { handle.child.send({ type: 'test-cleanup' }); } catch { /* process may have exited */ }
      await waitForProcessHandleExit(handle.child, 2_000).catch(() => undefined);
    };

    process.env.NODE_OPTIONS = nodeOptions;
    try {
      const parent = spawnRuntime(process.execPath, [
        parentWorkerPath,
        project,
        baseUrl,
        wrapperPath,
        parentMarker,
      ], {
        cwd: project,
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        env: { ...process.env, NODE_OPTIONS: nodeOptions },
      });
      parentHandle = captureExactProcessHandle(parent, [
        parentWorkerPath,
        project,
        baseUrl,
        wrapperPath,
        parentMarker,
      ]);

      const stalledMessage = await waitForWorkerMessage(parent, (message) =>
        message.phase === 'precommit', 15_000);
      const stalledPid = stalledMessage.pid;
      const serverInstanceId = stalledMessage.serverInstanceId;
      if (!Number.isInteger(stalledPid) || (stalledPid as number) <= 0 ||
          typeof serverInstanceId !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(serverInstanceId) ||
          stalledMessage.parentPid !== parentHandle.pid || stalledMessage.marker !== parentMarker) {
        throw new Error('The first owner did not report a verifiable test-specific process identity.');
      }

      const descriptorPath = path.join(project, 'UserSettings', 'AI-Game-Developer-Config.json');
      const descriptorBefore = fs.readFileSync(descriptorPath, 'utf8');
      const descriptor = JSON.parse(descriptorBefore) as { token?: unknown };
      if (typeof descriptor.token !== 'string' || descriptor.token.length === 0) {
        throw new Error('The first owner did not publish a test credential descriptor.');
      }
      const statePath = path.join(project, 'UserSettings', STATE_NAME);
      const stateBefore = fs.readFileSync(statePath, 'utf8');
      const state = JSON.parse(stateBefore) as Record<string, unknown>;
      if (state.serverInstanceId !== serverInstanceId || state.phase !== 'prepared') {
        throw new Error('The first owner state record did not match the captured instance.');
      }

      const firstHealth = await exactServerHealth({
        baseUrl,
        token: descriptor.token,
        serverInstanceId,
        pid: stalledPid as number,
      });
      if (firstHealth?.handoffPhase !== 'precommit') {
        throw new Error('The first owner endpoint did not prove exact precommit health.');
      }
      stalledIdentity = {
        baseUrl,
        token: descriptor.token,
        serverInstanceId,
        pid: stalledPid as number,
      };

      const contender = spawnRuntime(process.execPath, [
        contenderWorkerPath,
        project,
        baseUrl,
        wrapperPath,
        contenderMarker,
      ], {
        cwd: project,
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        env: { ...process.env, NODE_OPTIONS: nodeOptions },
      });
      contenderHandle = captureExactProcessHandle(contender, [
        contenderWorkerPath,
        project,
        baseUrl,
        wrapperPath,
        contenderMarker,
      ]);
      const contenderStarted = await waitForWorkerMessage(contender, (message) =>
        message.type === 'started', 10_000);
      if (contenderStarted.marker !== contenderMarker || contenderStarted.pid !== contenderHandle.pid) {
        throw new Error('The contender did not report its captured process identity.');
      }
      contenderIdentityVerified = true;
      const contenderOutcomePromise = waitForWorkerMessage(contender, (message) =>
        message.type === 'outcome', formerLeaseDurationMs + 10_000);
      const contenderStartedAt = Date.now();

      // Keep the first parent and its precommit child stalled beyond the old
      // five-second lease window while the real contender is waiting.
      await new Promise((resolve) => setTimeout(resolve, formerLeaseDurationMs + 750));
      if (processHandleExited(parentHandle.child)) {
        throw new Error('The first parent exited during the required stall window.');
      }
      const stillPrecommit = await exactServerHealth(stalledIdentity);
      if (stillPrecommit?.handoffPhase !== 'precommit') {
        throw new Error('The exact precommit child did not remain authoritative beyond the old lease.');
      }
      const contenderOutcome = await contenderOutcomePromise;
      expect(Date.now() - contenderStartedAt).toBeGreaterThanOrEqual(formerLeaseDurationMs);
      expect(contenderOutcome.outcome).toBe('error');
      expect(contenderOutcome.code).toBe('occupied');
      expect(contenderOutcome).not.toHaveProperty('token');
      expect(fs.readFileSync(descriptorPath, 'utf8')).toBe(descriptorBefore);
      expect(fs.readFileSync(statePath, 'utf8')).toBe(stateBefore);
      await waitForProcessHandleExit(contenderHandle.child, 2_000);
      expect(contenderHandle.child.exitCode).not.toBeNull();
      expect(contenderHandle.child.spawnargs).not.toContain(descriptor.token);
      expect(parentHandle.child.spawnargs).not.toContain(descriptor.token);

      // The original parent is terminated only after the process handle,
      // parent PID, state instance, and authenticated socket identity agree.
      assertExactProcessHandle(parentHandle);
      parentIdentityVerified = true;
      await terminateExactProcessHandle(parentHandle, 5_000);
      await waitForExactProcessExit(stalledIdentity.pid, 5_000);
      expect(await exactServerHealth(stalledIdentity)).toBeUndefined();
      await expectEndpointReservable(port, 5_000);

      const successor = await prepareOwnedNodeServer({
        projectPath: project,
        url: baseUrl,
        startupTimeoutMs: 10_000,
        pollIntervalMs: 10,
        cleanupTimeoutMs: 2_000,
        lockTimeoutMs: 5_000,
        lockPollIntervalMs: 10,
      }, { serverEntry: wrapperPath });
      expect(successor).toMatchObject({
        alreadyRunning: false,
        token: descriptor.token,
      });
      if (!Number.isInteger(successor.pid) || successor.pid === stalledIdentity.pid ||
          typeof successor.serverInstanceId !== 'string' || successor.serverInstanceId === serverInstanceId) {
        throw new Error('The successor did not report a distinct exact process instance.');
      }
      successorIdentity = {
        baseUrl,
        token: descriptor.token,
        serverInstanceId: successor.serverInstanceId,
        pid: successor.pid as number,
      };
      const committedHealth = await exactServerHealth(successorIdentity);
      expect(committedHealth?.handoffPhase).toBe('committed');
    } finally {
      if (previousNodeOptions === undefined) delete process.env.NODE_OPTIONS;
      else process.env.NODE_OPTIONS = previousNodeOptions;

      // A proven ChildProcess handle is the only parent/contender cleanup
      // path. If identity was not proven, ask through its own IPC channel and
      // do not signal an unknown PID.
      if (parentHandle && !processHandleExited(parentHandle.child)) {
        if (parentIdentityVerified) {
          await terminateExactProcessHandle(parentHandle, 5_000).catch(() => undefined);
        } else {
          await requestWorkerCleanup(parentHandle);
        }
      }
      if (contenderHandle && !processHandleExited(contenderHandle.child)) {
        if (contenderIdentityVerified) {
          await terminateExactProcessHandle(contenderHandle, 2_000).catch(() => undefined);
        } else {
          await requestWorkerCleanup(contenderHandle);
        }
      }
      if (stalledIdentity && processIsAlive(stalledIdentity.pid)) {
        await terminateVerifiedServer(stalledIdentity);
      }
      if (successorIdentity && processIsAlive(successorIdentity.pid)) {
        await terminateVerifiedServer(successorIdentity);
      }
    }
  }, 35_000);

  it.each([
    { label: 'parent exit before spawn', mode: 'before-spawn', hookPhase: 'prepared' },
    { label: 'parent exit before handle transfer', mode: 'before-transfer', hookPhase: 'spawned' },
    { label: 'parent exit after handle transfer', mode: 'after-transfer', hookPhase: 'transferred' },
    { label: 'parent exit before commit acknowledgement', mode: 'before-commit-ack', hookPhase: 'commit-intent' },
    { label: 'parent exit after commit acknowledgement', mode: 'after-ack', hookPhase: 'commit-acknowledged' },
    { label: 'child reports handle-transfer failure', mode: 'transfer-failure', hookPhase: undefined },
  ] as const)('real owned-server crash matrix: $label', async ({ mode, hookPhase }) => {
    const project = temporaryProject();
    const port = await reserveFreePort();
    expect(port).not.toBe(8765);
    const baseUrl = `http://127.0.0.1:${port}`;
    const wrapperPath = path.join(project, 'owned-server-entry.mjs');
    const delayedAckWrapperPath = path.join(project, 'delayed-ack-server-entry.mjs');
    const transferFailureEntryPath = path.join(project, 'transfer-failure-entry.mjs');
    const parentWorkerPath = path.join(project, 'crash-matrix-parent.mjs');
    const markerPath = path.join(project, `${mode}.marker`);
    const token = `uco-6-4-secret-${mode}-${path.basename(project)}`;
    const parentMarker = `uco-6-4-parent-${mode}-${path.basename(project)}`;
    const serverSourceUrl = pathToFileURL(path.resolve('src/server/index.ts')).href;
    const ownedSourceUrl = pathToFileURL(path.resolve('src/devops/lib/owned-node-server.ts')).href;

    fs.writeFileSync(wrapperPath, [
      `import { main } from ${JSON.stringify(serverSourceUrl)};`,
      'await main(process.argv);',
    ].join('\n'), 'utf8');
    fs.writeFileSync(delayedAckWrapperPath, [
      `import { writeFileSync } from 'node:fs';`,
      `import { main } from ${JSON.stringify(serverSourceUrl)};`,
      'const markerPath = process.env.COCLI_TEST_COMMIT_SENT_PATH;',
      'const originalSend = process.send?.bind(process);',
      'if (originalSend) {',
      '  process.send = (message, ...args) => {',
      '    if (message && message.type === "uco-owned-committed") {',
      '      if (markerPath) writeFileSync(markerPath, JSON.stringify({ serverInstanceId: message.serverInstanceId }), "utf8");',
      '      return true;',
      '    }',
      '    return originalSend(message, ...args);',
      '  };',
      '}',
      'await main(process.argv);',
    ].join('\n'), 'utf8');
    fs.writeFileSync(transferFailureEntryPath, [
      `import { writeFileSync } from 'node:fs';`,
      'const markerPath = process.env.COCLI_TEST_FAILURE_MARKER;',
      'const token = process.env.UCO_SERVER_TOKEN ?? "";',
      'const exit = () => {',
      '  if (process.connected) process.disconnect();',
      '  process.exit(1);',
      '};',
      'process.on("message", (message) => {',
      '  if (!message || typeof message !== "object") return;',
      '  if (message.type === "uco-owned-handoff") {',
      '    if (markerPath) writeFileSync(markerPath, "handoff-received", "utf8");',
      '    process.send?.({',
      '      type: "uco-owned-error",',
      '      serverInstanceId: message.serverInstanceId,',
      '      detail: `simulated handle transfer failure for Bearer ${token}`,',
      '    }, exit);',
      '  } else if (message.type === "uco-owned-abort") {',
      '    exit();',
      '  }',
      '});',
      'process.once("disconnect", exit);',
    ].join('\n'), 'utf8');
    fs.writeFileSync(parentWorkerPath, [
      `const { prepareOwnedNodeServer } = await import(${JSON.stringify(ownedSourceUrl)});`,
      'const { spawn: spawnChild } = await import("node:child_process");',
      'const [projectPath, url, serverEntry, marker, mode, markerPath] = process.argv.slice(2);',
      'const token = process.env.COCLI_TEST_TOKEN;',
      'if (markerPath && markerPath !== "none") process.env.COCLI_TEST_COMMIT_SENT_PATH = markerPath;',
      'if (markerPath && markerPath !== "none") process.env.COCLI_TEST_FAILURE_MARKER = markerPath;',
      'const notify = (message) => new Promise((resolve) => {',
      '  if (!process.connected || !process.send) { resolve(); return; }',
      '  process.send(message, () => resolve());',
      '});',
      'process.on("message", (message) => {',
      '  if (message && message.type === "test-cleanup") process.exit(0);',
      '});',
      'const waitForCommand = (expected) => new Promise((resolve) => {',
      '  const onMessage = (message) => {',
      '    if (!message || message.type !== expected) return;',
      '    process.removeListener("message", onMessage);',
      '    resolve();',
      '  };',
      '  process.on("message", onMessage);',
      '});',
      'const crashPhase = mode === "before-commit-ack" ? "commit-intent" :',
      '  mode === "before-transfer" ? "spawned" :',
      '  mode === "after-transfer" ? "transferred" :',
      '  mode === "after-ack" ? "commit-acknowledged" :',
      '  mode === "before-spawn" ? "prepared" : "";',
      'let spawnCalls = 0;',
      'const spawnImpl = (...args) => {',
      '  spawnCalls += 1;',
      '  return spawnChild(...args);',
      '};',
      'try {',
      '  const result = await prepareOwnedNodeServer({',
      '    projectPath, url, token, startupTimeoutMs: 10000, pollIntervalMs: 10,',
      '    cleanupTimeoutMs: 1500, lockTimeoutMs: 5000, lockPollIntervalMs: 10,',
      '  }, {',
      '    serverEntry,',
      '    spawnImpl,',
      '    async onHandoffPhase(phase, details) {',
      '      if (phase !== crashPhase) return;',
      '      await notify({ type: "phase", label: marker, mode, phase, parentPid: process.pid, spawnCalls, ...details });',
      '      if (mode === "before-commit-ack") {',
      '        await waitForCommand("continue-commit");',
      '        return;',
      '      }',
      '      await waitForCommand("crash");',
      '      process.exit(91);',
      '    },',
      '  });',
      '  await notify({ type: "outcome", outcome: "success", mode, spawnCalls, alreadyRunning: result.alreadyRunning });',
      '} catch (error) {',
      '  const diagnostics = error instanceof Error ? error.message : String(error);',
      '  await notify({ type: "failure", mode, code: "owned-handoff-failed", diagnostics, spawnCalls });',
      '}',
      'if (process.connected) process.disconnect();',
    ].join('\n'), 'utf8');

    const previousNodeOptions = process.env.NODE_OPTIONS;
    const tsxLoaderUrl = new URL('../node_modules/tsx/dist/loader.mjs', import.meta.url).href;
    const nodeOptions = [previousNodeOptions, `--import ${tsxLoaderUrl}`]
      .filter(Boolean)
      .join(' ');
    const entryPath = mode === 'transfer-failure'
      ? transferFailureEntryPath
      : mode === 'before-commit-ack' ? delayedAckWrapperPath : wrapperPath;
    const expectedParentArgs = [
      parentWorkerPath,
      project,
      baseUrl,
      entryPath,
      parentMarker,
      mode,
      markerPath,
    ];
    let parentHandle: ExactProcessHandle | undefined;
    let parentIdentityVerified = false;
    let serverIdentity: ExactServerIdentity | undefined;

    try {
      const parent = spawnRuntime(process.execPath, expectedParentArgs, {
        cwd: project,
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        env: {
          ...process.env,
          NODE_OPTIONS: nodeOptions,
          COCLI_TEST_TOKEN: token,
        },
      });
      parentHandle = captureExactProcessHandle(parent, expectedParentArgs);

      const firstMessage = await waitForWorkerMessage(parent, (message) =>
        mode === 'transfer-failure' ? message.type === 'failure' : message.type === 'phase', 15_000);
      expect(JSON.stringify(firstMessage)).not.toContain(token);

      if (mode === 'transfer-failure') {
        expect(firstMessage).toMatchObject({
          type: 'failure',
          mode,
          code: 'owned-handoff-failed',
          spawnCalls: 1,
        });
        expect(typeof firstMessage.diagnostics).toBe('string');
        expect(firstMessage.diagnostics).toContain('[REDACTED]');
        expect(firstMessage.diagnostics).not.toContain(token);
        await waitForFile(markerPath, 5_000);
        await waitForProcessHandleExit(parentHandle.child, 5_000);
        await expectEndpointReservable(port, 5_000);
        return;
      }

      expect(firstMessage).toMatchObject({
        type: 'phase',
        label: parentMarker,
        mode,
        phase: hookPhase,
        parentPid: parentHandle.pid,
        spawnCalls: mode === 'before-spawn' ? 0 : 1,
      });
      parentIdentityVerified = firstMessage.parentPid === parentHandle.pid;
      const serverInstanceId = firstMessage.serverInstanceId;
      const childPid = firstMessage.pid;
      if (typeof serverInstanceId !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(serverInstanceId)) {
        throw new Error('The crash-matrix parent did not report a verifiable server instance.');
      }
      if (mode !== 'before-spawn' &&
          (!Number.isInteger(childPid) || (childPid as number) <= 0)) {
        throw new Error('The crash-matrix parent did not report a verifiable child PID.');
      }
      if (mode !== 'before-spawn') {
        serverIdentity = {
          baseUrl,
          token,
          serverInstanceId,
          pid: childPid as number,
        };
      }
      const statePath = path.join(project, 'UserSettings', STATE_NAME);
      const stateBeforeCrash = JSON.parse(fs.readFileSync(statePath, 'utf8')) as Record<string, unknown>;
      expect(stateBeforeCrash.serverInstanceId).toBe(serverInstanceId);
      expect(stateBeforeCrash.phase).toBe(mode === 'before-spawn' || mode === 'before-transfer'
        ? 'prepared' : mode === 'after-transfer' ? 'prepared' : 'commit-intent');
      const descriptorPath = path.join(project, 'UserSettings', 'AI-Game-Developer-Config.json');
      expect(fs.existsSync(descriptorPath)).toBe(false);

      if (mode === 'after-transfer' || mode === 'before-commit-ack') {
        await waitForExactServerHealth(serverIdentity as ExactServerIdentity, 'precommit', 5_000);
      }
      if (mode === 'after-ack') {
        await waitForExactServerHealth(serverIdentity as ExactServerIdentity, 'committed', 5_000);
      }

      if (mode === 'before-commit-ack') {
        await sendWorkerControl(parentHandle.child, { type: 'continue-commit' });
        await waitForFile(markerPath, 5_000);
        assertExactProcessHandle(parentHandle);
        await terminateExactProcessHandle(parentHandle, 5_000);
        await waitForExactServerHealth(serverIdentity as ExactServerIdentity, 'committed', 5_000);
        const stateAfterParentExit = JSON.parse(fs.readFileSync(statePath, 'utf8')) as Record<string, unknown>;
        expect(stateAfterParentExit.phase).toBe('commit-intent');
      } else {
        await sendWorkerControl(parentHandle.child, { type: 'crash' });
        await waitForProcessHandleExit(parentHandle.child, 5_000);
        if (mode === 'before-transfer' || mode === 'after-transfer') {
          await waitForExactProcessExit(childPid as number, 5_000);
          expect(await exactServerHealth(serverIdentity as ExactServerIdentity)).toBeUndefined();
        }
        if (mode === 'after-ack') {
          await waitForExactServerHealth(serverIdentity as ExactServerIdentity, 'committed', 5_000);
          const stateAfterParentExit = JSON.parse(fs.readFileSync(statePath, 'utf8')) as Record<string, unknown>;
          expect(stateAfterParentExit.phase).toBe('commit-intent');
        }
      }

      if (mode !== 'before-commit-ack' && mode !== 'after-ack') {
        await expectEndpointReservable(port, 5_000);
      }
      if (mode === 'before-spawn') {
        expect(await exactServerHealth({
          baseUrl,
          token,
          serverInstanceId,
          pid: parentHandle.pid,
        })).toBeUndefined();
      }

      if (mode === 'before-commit-ack' || mode === 'after-ack') {
        const successorSpawn = vi.fn(() => {
          throw new Error('The exact committed crash-matrix child was not reusable.');
        }) as unknown as typeof spawn;
        const successor = await prepareOwnedNodeServer({
          projectPath: project,
          url: baseUrl,
          token,
          startupTimeoutMs: 5_000,
          pollIntervalMs: 10,
          cleanupTimeoutMs: 1_000,
          lockTimeoutMs: 2_000,
          lockPollIntervalMs: 10,
        }, { serverEntry: wrapperPath, spawnImpl: successorSpawn });
        expect(successor).toMatchObject({
          alreadyRunning: true,
          token,
          serverInstanceId,
        });
        expect(successorSpawn).not.toHaveBeenCalled();
        expect(JSON.parse(fs.readFileSync(statePath, 'utf8'))).toMatchObject({
          phase: 'committed',
          serverInstanceId,
        });
        await terminateVerifiedServer(serverIdentity as ExactServerIdentity);
        await expectEndpointReservable(port, 5_000);
      }
    } finally {
      if (parentHandle && !processHandleExited(parentHandle.child)) {
        if (parentIdentityVerified) {
          await terminateExactProcessHandle(parentHandle, 5_000).catch(() => undefined);
        } else {
          assertExactProcessHandle(parentHandle);
          await sendWorkerControl(parentHandle.child, { type: 'test-cleanup' }).catch(() => undefined);
          await waitForProcessHandleExit(parentHandle.child, 2_000).catch(() => undefined);
        }
      }
      if (serverIdentity) ownedServerIdentities.push(serverIdentity);
    }
  }, 35_000);
});
