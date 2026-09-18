import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import { createServer, type Server as NetServer, type Socket } from 'node:net';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generatePortFromDirectory } from '../../config/port.js';
import { normalizeLoopbackUrl } from '../../transport/loopback.js';
import {
  generateConnectionToken,
  readConfig,
  writeConfig,
  type UnityConnectionConfig,
} from '../utils/config.js';
import { redactSensitiveText } from '../../util/redaction.js';

const DEFAULT_STARTUP_TIMEOUT_MS = 10_000;
const DEFAULT_POLL_INTERVAL_MS = 100;
const DEFAULT_CLEANUP_TIMEOUT_MS = 2_000;
const DEFAULT_RESERVATION_WAIT_MS = 12_000;
const MAX_STDERR_BYTES = 8 * 1024;
const OWNED_STATE_NAME = '.uco-owned-node-server.state.json';
const OWNED_STATE_PROTOCOL_VERSION = 3;
const TOKEN_FINGERPRINT_DOMAIN = 'uco-owned-node-server:v3:token\0';
const DEFAULT_SERVER_ENTRY = fileURLToPath(new URL('../../../bin/server.mjs', import.meta.url));

export interface OwnedNodeServerOptions {
  projectPath: string;
  url?: string;
  token?: string;
  auth?: 'none' | 'required';
  startupTimeoutMs?: number;
  pollIntervalMs?: number;
  cleanupTimeoutMs?: number;
  /** Bounded wait for an occupied endpoint. Kept under the old option name for compatibility. */
  lockTimeoutMs?: number;
  /** Poll interval for endpoint reuse/reservation attempts. */
  lockPollIntervalMs?: number;
}

export interface OwnedNodeServerResult {
  baseUrl: string;
  token: string | undefined;
  authorization: 'none' | 'required';
  alreadyRunning: boolean;
  pid?: number;
  serverInstanceId?: string;
}

export type OwnedHandoffPhase =
  | 'reserved'
  | 'prepared'
  | 'spawned'
  | 'transferred'
  | 'precommit'
  | 'commit-intent'
  | 'commit-acknowledged'
  | 'committed';

export interface OwnedNodeServerDependencies {
  fetchImpl?: typeof fetch;
  spawnImpl?: typeof spawn;
  serverEntry?: string;
  sleepImpl?: (ms: number) => Promise<void>;
  onHandoffPhase?: (phase: OwnedHandoffPhase, details: {
    serverInstanceId?: string;
    pid?: number;
  }) => void | Promise<void>;
}

export interface OwnedServerCredentials {
  baseUrl: string;
  listenHost: string;
  port: number;
  token: string | undefined;
  authorization: 'none' | 'required';
  tokenSource: 'explicit' | 'descriptor' | 'generated' | 'none';
}

interface OwnedCredentialPlan extends OwnedServerCredentials {
  persistRequiredNormalization: boolean;
}

interface OwnedHealthProof {
  serverInstanceId?: string;
  phase?: 'precommit' | 'committed';
}

interface OwnedServerState {
  protocolVersion: 3;
  endpoint: string;
  listenHost: string;
  port: number;
  authorization: 'none' | 'required';
  tokenFingerprint: string;
  serverInstanceId: string;
  phase: 'prepared' | 'commit-intent' | 'committed';
  pid?: number;
  updatedAt: string;
}

interface EndpointReservation {
  server: NetServer;
  transferred: boolean;
}

interface OwnedChildMessage {
  type: 'uco-owned-attached' | 'uco-owned-committed' | 'uco-owned-error';
  serverInstanceId: string;
  detail?: string;
}

interface CleanupResult {
  childExited: boolean;
  endpointReleased: boolean;
  detail: string;
}

/**
 * Reserve and hand off the real target socket. No descriptor mutation or
 * child spawn occurs until this process owns that operating-system resource.
 */
export async function prepareOwnedNodeServer(
  options: OwnedNodeServerOptions,
  dependencies: OwnedNodeServerDependencies = {},
): Promise<OwnedNodeServerResult> {
  const fetchImpl = dependencies.fetchImpl ?? globalThis.fetch;
  const spawnImpl = dependencies.spawnImpl ?? spawn;
  const sleepImpl = dependencies.sleepImpl ?? sleep;
  const startupTimeoutMs = positive(options.startupTimeoutMs, DEFAULT_STARTUP_TIMEOUT_MS);
  const pollIntervalMs = positive(options.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS);
  const cleanupTimeoutMs = positive(options.cleanupTimeoutMs, DEFAULT_CLEANUP_TIMEOUT_MS);
  const reservationWaitMs = positive(options.lockTimeoutMs, DEFAULT_RESERVATION_WAIT_MS);
  const reservationPollMs = positive(options.lockPollIntervalMs, DEFAULT_POLL_INTERVAL_MS);

  let plan = planOwnedServerCredentials(options);
  const initialReuse = await probeReusableServer(
    plan,
    options.projectPath,
    fetchImpl,
    true,
  );
  if (initialReuse) return reuseResult(plan, initialReuse);

  const reservationResult = await reserveOrReuseEndpoint(
    options,
    plan,
    reservationWaitMs,
    reservationPollMs,
    fetchImpl,
    sleepImpl,
  );
  if ('proof' in reservationResult) return reuseResult(reservationResult.credentials, reservationResult.proof);

  const reservation = reservationResult.reservation;
  let child: ChildProcess | undefined;
  let stderrCapture: BoundedStderrCapture | undefined;
  let commitSent = false;
  let serverInstanceId = '';
  let state: OwnedServerState | undefined;
  try {
    await dependencies.onHandoffPhase?.('reserved', {});

    // Re-read under the socket mutex. This is the first point at which a
    // missing token may be generated or any descriptor normalization written.
    plan = finalizeOwnedServerCredentials(options, plan.baseUrl);
    serverInstanceId = randomBytes(24).toString('base64url');
    state = makeOwnedState(plan, serverInstanceId, 'prepared');
    writeOwnedState(options.projectPath, state);
    await dependencies.onHandoffPhase?.('prepared', { serverInstanceId });

    const args = [
      dependencies.serverEntry ?? DEFAULT_SERVER_ENTRY,
      '--listen-host', plan.listenHost,
      '--port', String(plan.port),
      '--authorization', plan.authorization,
      '--owned-ipc-handoff',
    ];
    const childEnvironment: NodeJS.ProcessEnv = {
      ...process.env,
      COCLI_SERVER_INSTANCE_ID: serverInstanceId,
    };
    delete childEnvironment.UCO_SERVER_TOKEN;
    if (plan.authorization === 'required' && plan.token) {
      childEnvironment.UCO_SERVER_TOKEN = plan.token;
    }

    child = spawnImpl(process.execPath, args, {
      cwd: options.projectPath,
      detached: true,
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      windowsHide: true,
      env: childEnvironment,
    });
    stderrCapture = captureBoundedStderr(child, plan.token);
    await waitForSpawn(child);
    await dependencies.onHandoffPhase?.('spawned', {
      serverInstanceId,
      ...(child.pid === undefined ? {} : { pid: child.pid }),
    });

    const startupDeadline = Date.now() + startupTimeoutMs;
    const attached = waitForOwnedChildMessage(
      child,
      'uco-owned-attached',
      serverInstanceId,
      remaining(startupDeadline),
      plan.token,
    );
    await Promise.all([
      sendOwnedChildMessage(
        child,
        { type: 'uco-owned-handoff', serverInstanceId },
        reservation.server,
        true,
        plan.token,
      ),
      attached,
    ]);
    reservation.transferred = true;
    // Retain the parent's duplicate until the exact child acknowledges that
    // it attached the transferred handle, then relinquish only this copy.
    await closeServer(reservation.server);
    await dependencies.onHandoffPhase?.('transferred', {
      serverInstanceId,
      ...(child.pid === undefined ? {} : { pid: child.pid }),
    });

    await waitForExactHealth(
      plan,
      serverInstanceId,
      'precommit',
      fetchImpl,
      sleepImpl,
      pollIntervalMs,
      startupDeadline,
      child,
    );
    await dependencies.onHandoffPhase?.('precommit', {
      serverInstanceId,
      ...(child.pid === undefined ? {} : { pid: child.pid }),
    });

    state = { ...state, phase: 'commit-intent', pid: child.pid, updatedAt: new Date().toISOString() };
    writeOwnedState(options.projectPath, state);
    await dependencies.onHandoffPhase?.('commit-intent', {
      serverInstanceId,
      ...(child.pid === undefined ? {} : { pid: child.pid }),
    });

    const committed = waitForOwnedChildMessage(
      child,
      'uco-owned-committed',
      serverInstanceId,
      remaining(startupDeadline),
      plan.token,
    );
    commitSent = true;
    await Promise.all([
      sendOwnedChildMessage(
        child,
        { type: 'uco-owned-commit', serverInstanceId },
        undefined,
        true,
        plan.token,
      ),
      committed,
    ]);
    await dependencies.onHandoffPhase?.('commit-acknowledged', {
      serverInstanceId,
      ...(child.pid === undefined ? {} : { pid: child.pid }),
    });

    await waitForExactHealth(
      plan,
      serverInstanceId,
      'committed',
      fetchImpl,
      sleepImpl,
      pollIntervalMs,
      startupDeadline,
      child,
    );
    state = { ...state, phase: 'committed', updatedAt: new Date().toISOString() };
    writeOwnedState(options.projectPath, state);
    await dependencies.onHandoffPhase?.('committed', {
      serverInstanceId,
      ...(child.pid === undefined ? {} : { pid: child.pid }),
    });

    if (child.connected) child.disconnect();
    child.unref();
    stderrCapture.stop();
    return {
      baseUrl: plan.baseUrl,
      token: plan.token,
      authorization: plan.authorization,
      alreadyRunning: false,
      ...(child.pid === undefined ? {} : { pid: child.pid }),
      serverInstanceId,
    };
  } catch (error) {
    // Commit may have taken effect even if the acknowledgement was lost. The
    // durable intent plus exact live instance is sufficient to reconcile.
    if (commitSent && state) {
      const proof = await probeHealth(plan, fetchImpl);
      if (proof?.serverInstanceId === serverInstanceId && proof.phase === 'committed') {
        writeOwnedState(options.projectPath, {
          ...state,
          phase: 'committed',
          updatedAt: new Date().toISOString(),
        });
        if (child?.connected) child.disconnect();
        child?.unref();
        stderrCapture?.stop();
        return {
          baseUrl: plan.baseUrl,
          token: plan.token,
          authorization: plan.authorization,
          alreadyRunning: false,
          ...(child?.pid === undefined ? {} : { pid: child.pid }),
          serverInstanceId,
        };
      }
    }

    const cleanup = await cleanupFailedAttempt(
      child,
      reservation,
      plan,
      serverInstanceId,
      cleanupTimeoutMs,
      sleepImpl,
    );
    stderrCapture?.stop();
    const reason = redactOwnedDiagnostic(error, plan.token);
    const stderr = stderrCapture?.text() ?? '';
    const cleanupSummary = cleanup.childExited && cleanup.endpointReleased
      ? 'cleanup confirmed exact-child exit and endpoint release'
      : `cleanup unconfirmed (${cleanup.detail})`;
    throw new Error(
      `Unable to complete uco-owned server handoff at ${plan.baseUrl} ` +
      `(${plan.authorization} auth): ${reason}; ${cleanupSummary}${stderr ? `; child stderr: ${stderr}` : ''}.`,
    );
  }
}

/**
 * Compatibility helper for callers that explicitly want immediate credential
 * persistence. The owned lifecycle itself uses read-only planning followed by
 * finalization only after socket reservation.
 */
export function resolveOwnedServerCredentials(options: OwnedNodeServerOptions): OwnedServerCredentials {
  const plan = planOwnedServerCredentials(options);
  return finalizeOwnedServerCredentials(options, plan.baseUrl);
}

/** Read host/auth/token candidates without writing the project descriptor. */
export function planOwnedServerCredentials(options: OwnedNodeServerOptions): OwnedServerCredentials {
  const authorization = options.auth ?? 'required';
  const explicitToken = normalizeToken(options.token);
  if (authorization === 'none' && explicitToken) {
    throw new Error('Explicit auth=none cannot be combined with a bearer token.');
  }

  let descriptor: UnityConnectionConfig | null | undefined;
  const loadDescriptor = (): UnityConnectionConfig | null => {
    if (descriptor === undefined) descriptor = readConfig(options.projectPath);
    return descriptor;
  };
  const configured = options.url === undefined ? loadDescriptor() : null;
  const configuredHost = configured && isCustomMode(configured) && typeof configured.host === 'string'
    ? configured.host
    : undefined;
  // Configured hosts written by older versions say `localhost`; normalize
  // so the handoff health probe dials the IPv4 literal (see transport/loopback.ts).
  const baseUrl = normalizeLoopbackUrl(stripTrailingSlash(
    options.url ?? configuredHost ?? `http://127.0.0.1:${generatePortFromDirectory(options.projectPath)}`,
  ));
  const endpoint = parseLocalEndpoint(baseUrl);

  if (authorization === 'none') {
    return {
      baseUrl,
      ...endpoint,
      token: undefined,
      authorization,
      tokenSource: 'none',
    };
  }
  if (explicitToken) {
    return {
      baseUrl,
      ...endpoint,
      token: explicitToken,
      authorization,
      tokenSource: 'explicit',
    };
  }

  const current = loadDescriptor();
  const descriptorToken = current && isCustomMode(current)
    ? normalizeToken(typeof current.token === 'string' ? current.token : undefined)
    : undefined;
  return {
    baseUrl,
    ...endpoint,
    token: descriptorToken,
    authorization,
    tokenSource: descriptorToken ? 'descriptor' : 'generated',
  };
}

function finalizeOwnedServerCredentials(
  options: OwnedNodeServerOptions,
  baseUrl: string,
): OwnedCredentialPlan {
  const authorization = options.auth ?? 'required';
  const explicitToken = normalizeToken(options.token);
  const endpoint = parseLocalEndpoint(baseUrl);
  if (authorization === 'none') {
    if (explicitToken) throw new Error('Explicit auth=none cannot be combined with a bearer token.');
    return {
      baseUrl,
      ...endpoint,
      token: undefined,
      authorization,
      tokenSource: 'none',
      persistRequiredNormalization: false,
    };
  }
  if (explicitToken) {
    return {
      baseUrl,
      ...endpoint,
      token: explicitToken,
      authorization,
      tokenSource: 'explicit',
      persistRequiredNormalization: false,
    };
  }

  const descriptor = readConfig(options.projectPath);
  const descriptorToken = descriptor && isCustomMode(descriptor)
    ? normalizeToken(typeof descriptor.token === 'string' ? descriptor.token : undefined)
    : undefined;
  if (descriptorToken) {
    const normalizeAuth = descriptor?.authOption !== 'required';
    if (normalizeAuth) writeConfig(options.projectPath, { ...descriptor, authOption: 'required' });
    return {
      baseUrl,
      ...endpoint,
      token: descriptorToken,
      authorization,
      tokenSource: 'descriptor',
      persistRequiredNormalization: normalizeAuth,
    };
  }

  const generated = generateConnectionToken();
  writeConfig(options.projectPath, {
    ...(descriptor ?? {}),
    host: baseUrl,
    token: generated,
    authOption: 'required',
    connectionMode: 'Custom',
  });
  return {
    baseUrl,
    ...endpoint,
    token: generated,
    authorization,
    tokenSource: 'generated',
    persistRequiredNormalization: true,
  };
}

async function reserveOrReuseEndpoint(
  options: OwnedNodeServerOptions,
  initialPlan: OwnedServerCredentials,
  timeoutMs: number,
  pollIntervalMs: number,
  fetchImpl: typeof fetch,
  sleepImpl: (ms: number) => Promise<void>,
): Promise<
  | { reservation: EndpointReservation }
  | { proof: OwnedHealthProof; credentials: OwnedServerCredentials }
> {
  const deadline = Date.now() + timeoutMs;
  let lastPlan = initialPlan;
  while (true) {
    try {
      return { reservation: await reserveEndpoint(initialPlan.listenHost, initialPlan.port) };
    } catch (error) {
      if (!isErrno(error, 'EADDRINUSE')) throw error;
    }

    // The loser only re-reads and probes. It cannot write credentials, spawn,
    // signal, unlink, rename, or otherwise fence the socket owner.
    lastPlan = planForFixedEndpoint(options, initialPlan.baseUrl);
    const proof = await probeReusableServer(lastPlan, options.projectPath, fetchImpl, true);
    if (proof) return { proof, credentials: lastPlan };

    const left = deadline - Date.now();
    if (left <= 0) {
      throw new Error(
        `Timed out after ${timeoutMs}ms because ${initialPlan.baseUrl} remains occupied by ` +
        'a starting or incompatible listener. uco left that listener and its credentials untouched.',
      );
    }
    await sleepImpl(Math.min(pollIntervalMs, left));
  }
}

function planForFixedEndpoint(
  options: OwnedNodeServerOptions,
  baseUrl: string,
): OwnedServerCredentials {
  const authorization = options.auth ?? 'required';
  const explicitToken = normalizeToken(options.token);
  const endpoint = parseLocalEndpoint(baseUrl);
  if (authorization === 'none') {
    return { baseUrl, ...endpoint, token: undefined, authorization, tokenSource: 'none' };
  }
  if (explicitToken) {
    return { baseUrl, ...endpoint, token: explicitToken, authorization, tokenSource: 'explicit' };
  }
  const descriptor = readConfig(options.projectPath);
  const token = descriptor && isCustomMode(descriptor)
    ? normalizeToken(typeof descriptor.token === 'string' ? descriptor.token : undefined)
    : undefined;
  return {
    baseUrl,
    ...endpoint,
    token,
    authorization,
    tokenSource: token ? 'descriptor' : 'generated',
  };
}

async function probeReusableServer(
  credentials: OwnedServerCredentials,
  projectPath: string,
  fetchImpl: typeof fetch,
  reconcileCommitIntent: boolean,
): Promise<OwnedHealthProof | undefined> {
  if (credentials.authorization === 'required' && !credentials.token) return undefined;
  const proof = await probeHealth(credentials, fetchImpl);
  if (!proof || proof.phase === 'precommit') return undefined;
  const state = readOwnedState(projectPath);
  if (!state) {
    // A compatible server without uco v3 ownership metadata remains usable,
    // but it is never claimed as an owned process.
    return proof;
  }
  if (!stateMatches(state, credentials) ||
      proof.serverInstanceId === undefined ||
      proof.serverInstanceId !== state.serverInstanceId ||
      proof.phase !== 'committed' ||
      (state.phase !== 'commit-intent' && state.phase !== 'committed')) {
    return undefined;
  }
  if (state.phase === 'commit-intent' && reconcileCommitIntent) {
    writeOwnedState(projectPath, {
      ...state,
      phase: 'committed',
      updatedAt: new Date().toISOString(),
    });
  }
  return proof;
}

function reuseResult(
  credentials: OwnedServerCredentials,
  proof: OwnedHealthProof,
): OwnedNodeServerResult {
  return {
    baseUrl: credentials.baseUrl,
    token: credentials.token,
    authorization: credentials.authorization,
    alreadyRunning: true,
    ...(proof.serverInstanceId === undefined ? {} : { serverInstanceId: proof.serverInstanceId }),
  };
}

function reserveEndpoint(host: string, port: number): Promise<EndpointReservation> {
  return new Promise((resolve, reject) => {
    const server = createServer((socket: Socket) => reservedPreflight(socket));
    const onError = (error: Error): void => {
      server.removeListener('listening', onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.removeListener('error', onError);
      resolve({ server, transferred: false });
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen({ host, port, exclusive: true });
  });
}

function reservedPreflight(socket: Socket): void {
  const body = JSON.stringify({
    ok: false,
    error: {
      code: 'owned-server-reserved',
      message: 'The endpoint is reserved for uco handoff.',
      retryable: true,
    },
  });
  socket.setTimeout(500, () => socket.destroy());
  socket.end(
    'HTTP/1.1 503 Service Unavailable\r\n' +
    'Connection: close\r\n' +
    'Content-Type: application/json\r\n' +
    `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
  );
}

async function probeHealth(
  credentials: OwnedServerCredentials,
  fetchImpl: typeof fetch,
): Promise<OwnedHealthProof | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 500);
  try {
    const headers: Record<string, string> = {};
    if (credentials.token) headers.Authorization = `Bearer ${credentials.token}`;
    const response = await fetchImpl(`${credentials.baseUrl}/api/health`, {
      method: 'GET',
      headers,
      signal: controller.signal,
    });
    if (!response.ok) return undefined;
    const payload = await response.json() as {
      stages?: { http?: { authenticated?: unknown } };
      serverInstanceId?: unknown;
      handoffPhase?: unknown;
    };
    if (payload?.stages?.http?.authenticated !== (credentials.authorization === 'required')) {
      return undefined;
    }
    const phase = payload.handoffPhase === 'precommit' || payload.handoffPhase === 'committed'
      ? payload.handoffPhase
      : undefined;
    return {
      ...(typeof payload.serverInstanceId === 'string' && payload.serverInstanceId.length > 0
        ? { serverInstanceId: payload.serverInstanceId }
        : {}),
      ...(phase === undefined ? {} : { phase }),
    };
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

async function waitForExactHealth(
  credentials: OwnedServerCredentials,
  serverInstanceId: string,
  phase: 'precommit' | 'committed',
  fetchImpl: typeof fetch,
  sleepImpl: (ms: number) => Promise<void>,
  pollIntervalMs: number,
  deadline: number,
  child: ChildProcess,
): Promise<void> {
  while (Date.now() < deadline) {
    if (hasChildExited(child)) {
      throw new Error(
        `The exact owned child exited before ${phase} health ` +
        `(code=${child.exitCode ?? 'none'}, signal=${child.signalCode ?? 'none'}).`,
      );
    }
    const proof = await probeHealth(credentials, fetchImpl);
    if (proof?.serverInstanceId === serverInstanceId && proof.phase === phase) return;
    await sleepImpl(Math.min(pollIntervalMs, Math.max(1, deadline - Date.now())));
  }
  throw new Error(`Timed out waiting for exact-instance ${phase} health.`);
}

function waitForOwnedChildMessage(
  child: ChildProcess,
  type: OwnedChildMessage['type'],
  serverInstanceId: string,
  timeoutMs: number,
  token: string | undefined,
): Promise<OwnedChildMessage> {
  return new Promise((resolve, reject) => {
    let timer: NodeJS.Timeout | undefined;
    const finish = (error?: Error, message?: OwnedChildMessage): void => {
      if (timer) clearTimeout(timer);
      child.removeListener('message', onMessage);
      child.removeListener('error', onError);
      child.removeListener('exit', onExit);
      child.removeListener('disconnect', onDisconnect);
      if (error) reject(error);
      else resolve(message as OwnedChildMessage);
    };
    const onMessage = (raw: unknown): void => {
      const message = raw as Partial<OwnedChildMessage>;
      if (message.serverInstanceId !== serverInstanceId) {
        finish(new Error('The owned child reported a mismatched server instance ID.'));
        return;
      }
      if (message.type === 'uco-owned-error') {
        finish(new Error(
          `The owned child rejected handoff: ${redactOwnedDiagnostic(message.detail, token)}`,
        ));
        return;
      }
      if (message.type === type) finish(undefined, message as OwnedChildMessage);
    };
    const onError = (error: Error): void => finish(error);
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => finish(
      new Error(`The owned child exited during handoff (code=${code ?? 'none'}, signal=${signal ?? 'none'}).`),
    );
    const onDisconnect = (): void => finish(new Error('The owned child IPC channel disconnected during handoff.'));
    child.on('message', onMessage);
    child.once('error', onError);
    child.once('exit', onExit);
    child.once('disconnect', onDisconnect);
    timer = setTimeout(() => finish(
      new Error(`Timed out waiting for child IPC message ${type}.`),
    ), Math.max(1, timeoutMs));
  });
}

function sendOwnedChildMessage(
  child: ChildProcess,
  message: { type: 'uco-owned-handoff' | 'uco-owned-commit' | 'uco-owned-abort'; serverInstanceId: string },
  handle: NetServer | undefined,
  keepOpen: boolean,
  token: string | undefined,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!child.connected || child.send === undefined) {
      reject(new Error('Node IPC handle transfer is unavailable for the owned child.'));
      return;
    }
    const callback = (error: Error | null): void => {
      if (error) reject(new Error(
        `Node IPC handoff failed: ${redactOwnedDiagnostic(error, token)}`,
      ));
      else resolve();
    };
    try {
      if (handle) child.send(message, handle, { keepOpen }, callback);
      else child.send(message, callback);
    } catch (error) {
      reject(new Error(`Node IPC handoff failed: ${redactOwnedDiagnostic(error, token)}`));
    }
  });
}

async function cleanupFailedAttempt(
  child: ChildProcess | undefined,
  reservation: EndpointReservation,
  credentials: OwnedServerCredentials,
  serverInstanceId: string,
  timeoutMs: number,
  sleepImpl: (ms: number) => Promise<void>,
): Promise<CleanupResult> {
  const deadline = Date.now() + timeoutMs;
  // Always close the parent's exact duplicate. A transferred child owns a
  // separate descriptor and must release it through abort/disconnect below.
  await closeServer(reservation.server);

  if (child && !hasChildExited(child)) {
    try {
      if (child.connected) {
        await sendOwnedChildMessage(
          child,
          { type: 'uco-owned-abort', serverInstanceId },
          undefined,
          true,
          credentials.token,
        );
      }
    } catch {
      // IPC disconnect below is also an abort signal for every precommit child.
    }
    try { if (child.connected) child.disconnect(); } catch { /* exact-child cleanup continues */ }
  }

  let childExited = child === undefined || hasChildExited(child);
  let endpointReleased = false;
  const pollConfirmations = async (pollDeadline: number): Promise<void> => {
    while (true) {
      childExited = child === undefined || hasChildExited(child);
      if (!endpointReleased) {
        try {
          const confirmation = await reserveEndpoint(credentials.listenHost, credentials.port);
          await closeServer(confirmation.server);
          endpointReleased = true;
        } catch (error) {
          if (!isErrno(error, 'EADDRINUSE')) return;
        }
      }
      if (childExited && endpointReleased) return;
      const left = pollDeadline - Date.now();
      if (left <= 0) return;
      await sleepImpl(Math.min(25, left));
    }
  };

  // Give abort/disconnect a short grace period, but preserve most of the
  // bounded cleanup budget for exact-child termination and confirmation.
  const gracefulDeadline = Math.min(
    deadline,
    Date.now() + Math.max(1, Math.min(250, Math.floor(timeoutMs / 2))),
  );
  await pollConfirmations(gracefulDeadline);
  if (!childExited && child) {
    try { child.kill(); } catch { /* report lack of confirmation below */ }
  }
  await pollConfirmations(deadline);

  return {
    childExited,
    endpointReleased,
    detail: `childExit=${childExited ? 'confirmed' : 'unconfirmed'}, ` +
      `endpointRelease=${endpointReleased ? 'confirmed' : 'unconfirmed'}`,
  };
}

function makeOwnedState(
  credentials: OwnedServerCredentials,
  serverInstanceId: string,
  phase: OwnedServerState['phase'],
): OwnedServerState {
  return {
    protocolVersion: OWNED_STATE_PROTOCOL_VERSION,
    endpoint: credentials.baseUrl,
    listenHost: credentials.listenHost,
    port: credentials.port,
    authorization: credentials.authorization,
    tokenFingerprint: tokenFingerprint(credentials.token),
    serverInstanceId,
    phase,
    updatedAt: new Date().toISOString(),
  };
}

function tokenFingerprint(token: string | undefined): string {
  return createHash('sha256').update(TOKEN_FINGERPRINT_DOMAIN).update(token ?? '').digest('base64url');
}

function stateMatches(state: OwnedServerState, credentials: OwnedServerCredentials): boolean {
  return state.endpoint === credentials.baseUrl &&
    state.listenHost === credentials.listenHost &&
    state.port === credentials.port &&
    state.authorization === credentials.authorization &&
    state.tokenFingerprint === tokenFingerprint(credentials.token);
}

function ownedStatePath(projectPath: string): string {
  return path.join(projectPath, 'UserSettings', OWNED_STATE_NAME);
}

function readOwnedState(projectPath: string): OwnedServerState | undefined {
  const statePath = ownedStatePath(projectPath);
  if (!fs.existsSync(statePath)) return undefined;
  try {
    const value = JSON.parse(fs.readFileSync(statePath, 'utf8')) as Partial<OwnedServerState>;
    if (value.protocolVersion !== OWNED_STATE_PROTOCOL_VERSION ||
        typeof value.endpoint !== 'string' ||
        typeof value.listenHost !== 'string' ||
        !Number.isInteger(value.port) ||
        (value.port ?? 0) < 1 ||
        (value.port ?? 0) > 65535 ||
        (value.authorization !== 'none' && value.authorization !== 'required') ||
        typeof value.tokenFingerprint !== 'string' ||
        typeof value.serverInstanceId !== 'string' ||
        (value.phase !== 'prepared' && value.phase !== 'commit-intent' && value.phase !== 'committed') ||
        typeof value.updatedAt !== 'string' ||
        (value.pid !== undefined && (!Number.isInteger(value.pid) || value.pid <= 0))) {
      return undefined;
    }
    return value as OwnedServerState;
  } catch {
    return undefined;
  }
}

function writeOwnedState(projectPath: string, state: OwnedServerState): void {
  const statePath = ownedStatePath(projectPath);
  const directory = path.dirname(statePath);
  fs.mkdirSync(directory, { recursive: true });
  const tempPath = path.join(
    directory,
    `.${path.basename(statePath)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`,
  );
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(tempPath, 'wx', 0o600);
    fs.writeFileSync(descriptor, JSON.stringify(state, null, 2) + '\n', { encoding: 'utf8' });
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(tempPath, statePath);
  } catch (error) {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch { /* best effort */ }
    }
    try { fs.unlinkSync(tempPath); } catch { /* best effort */ }
    throw error;
  }
}

function parseLocalEndpoint(baseUrl: string): { listenHost: string; port: number } {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error(`COCli-owned server URL is invalid: ${baseUrl}`);
  }
  const hostname = parsed.hostname.toLowerCase();
  const listenHost = hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;
  if (parsed.protocol !== 'http:' || !isOwnedLoopbackHost(listenHost)) {
    throw new Error('UCO can only own a local HTTP Node bridge (localhost, 127.0.0.1, or ::1).');
  }
  const port = parsed.port ? Number(parsed.port) : 80;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`COCli-owned server port is invalid: ${parsed.port}`);
  }
  return { listenHost, port };
}

function isCustomMode(config: UnityConnectionConfig): boolean {
  return config.connectionMode === 'Custom' || config.connectionMode === 0;
}

function isOwnedLoopbackHost(host: string): boolean {
  if (host === 'localhost' || host === '::1') return true;
  const octets = host.split('.');
  return octets.length === 4 &&
    octets.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255) &&
    octets[0] === '127';
}

function normalizeToken(token: string | undefined): string | undefined {
  const normalized = token?.trim();
  return normalized ? normalized : undefined;
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function positive(value: number | undefined, fallback: number): number {
  return Math.max(1, value ?? fallback);
}

function remaining(deadline: number): number {
  return Math.max(1, deadline - Date.now());
}

function redactOwnedDiagnostic(error: unknown, token: string | undefined): string {
  const raw = error instanceof Error ? error.message : String(error);
  const withoutSelectedToken = token ? raw.split(token).join('[REDACTED]') : raw;
  return redactSensitiveText(withoutSelectedToken);
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null &&
    'code' in error && (error as NodeJS.ErrnoException).code === code;
}

function closeServer(server: NetServer): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve) => server.close(() => resolve()));
}

interface BoundedStderrCapture {
  text(): string;
  stop(): void;
}

function captureBoundedStderr(child: ChildProcess, token: string | undefined): BoundedStderrCapture {
  const stream = child.stderr;
  if (!stream) return { text: () => '', stop: () => undefined };
  const chunks: Buffer[] = [];
  let bytes = 0;
  let truncated = false;
  const onData = (chunk: unknown): void => {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    const accepted = buffer.subarray(0, Math.max(0, MAX_STDERR_BYTES - bytes));
    if (accepted.length > 0) chunks.push(accepted);
    bytes += accepted.length;
    if (accepted.length < buffer.length) truncated = true;
  };
  stream.on('data', onData);
  const unref = (stream as typeof stream & { unref?: () => void }).unref;
  if (typeof unref === 'function') unref.call(stream);
  return {
    text(): string {
      const raw = Buffer.concat(chunks, bytes).toString('utf8').trim();
      const suffix = truncated ? ' [stderr truncated]' : '';
      return raw ? `${redactOwnedDiagnostic(raw, token)}${suffix}` : suffix.trim();
    },
    stop(): void {
      stream.removeListener('data', onData);
      stream.resume();
    },
  };
}

function hasChildExited(child: ChildProcess): boolean {
  return (child.exitCode !== null && child.exitCode !== undefined) ||
    (child.signalCode !== null && child.signalCode !== undefined);
}

function waitForSpawn(child: ChildProcess): Promise<void> {
  if (child.pid !== undefined && child.pid !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener('spawn', onSpawn);
      child.removeListener('error', onError);
      if (error) reject(error);
      else resolve();
    };
    const onSpawn = (): void => finish();
    const onError = (error: Error): void => finish(error);
    const timer = setTimeout(
      () => finish(new Error('Node bridge process did not emit spawn within 2000ms.')),
      2_000,
    );
    child.once('spawn', onSpawn);
    child.once('error', onError);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
