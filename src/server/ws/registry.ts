/**
 * Plugin connection registry — tracks WebSocket connections and provides
 * strategy-aware routing (token-based or first-available).
 *
 * Mirrors the .NET server's IConnectionStrategy + ClientUtils behavior:
 *   auth=none  → one READY plugin is routed; a replacement takes over only
 *                after its handshake and tool registration complete
 *   auth=required → multiple plugins, token-routed
 */

import type { WebSocket } from 'ws';
import { ClientFacingMethod } from '../types.js';
import { makeNotification, serializeMessage } from './envelope.js';

export interface EditorReadinessCache {
  state: string;
  ready: boolean;
  blockers: string[];
  retryAfterMs: number;
  queuedSideEffects: number;
  runningSideEffects: number;
  queuedReads: number;
  runningReads: number;
  activeOperations: number;
  observedUtc: Date;
}

/**
 * Editor identity tuple captured from a `bridge-identity-v1` handshake.
 * Undefined members (or the whole snapshot) mean the peer did not report them;
 * constrained calls fail closed against missing members rather than passing.
 */
export interface ConnectionIdentity {
  projectPath?: string;
  editorPid?: number;
  unityVersion?: string;
}

export interface ConnectionEntry {
  connectionId: string;
  ws: WebSocket;
  /** Token used during auth (undefined when auth=none). */
  token?: string;
  /** Plugin-advertised instanceId (optional, from query/header). */
  instanceId?: string;
  connectedUtc: Date;
  handshakeCompatible?: boolean;
  handshakeUtc?: Date;
  toolsRegisteredUtc?: Date;
  promptsRegisteredUtc?: Date;
  resourcesRegisteredUtc?: Date;
  generation: number;
  capabilities: Set<string>;
  editorReadiness?: EditorReadinessCache;
  /** Identity members from the handshake; present only for capability-advertising peers. */
  identity?: ConnectionIdentity;
}


/**
 * Registry of plugin WebSocket connections.
 *
 * Routing strategy:
 * - When `multiPlugin` is false (auth=none), only one connection is kept.
 *   A new connection triggers ForceDisconnect on the previous one.
 * - When `multiPlugin` is true (auth=required), multiple connections coexist
 *   and are routed by token.
 */
export class ConnectionRegistry {
  private readonly connections = new Map<string, ConnectionEntry>();
  private lastSuccessfulConnectionId: string | null = null;
  private nextId = 0;

  constructor(private readonly multiPlugin: boolean) {}

  /**
   * Register a transport connection. A new single-plugin connection does not
   * replace the current ready connection yet: replacement is promoted only by
   * markToolsRegistered(), after a compatible handshake and runner registration.
   * Returns the assigned connectionId.
   */
  register(ws: WebSocket, opts?: { token?: string; instanceId?: string }): string {
    const connectionId = `c${this.nextId++}`;

    const entry: ConnectionEntry = {
      connectionId,
      ws,
      token: opts?.token,
      instanceId: opts?.instanceId,
      connectedUtc: new Date(),
      generation: this.nextId,
      capabilities: new Set<string>(),
    };

    this.connections.set(connectionId, entry);

    return connectionId;
  }

  /** Remove a connection and all its index entries. */
  unregister(connectionId: string): void {
    const entry = this.connections.get(connectionId);
    if (!entry) return;

    this.connections.delete(connectionId);

    if (this.lastSuccessfulConnectionId === connectionId) {
      this.lastSuccessfulConnectionId = this.findLatest((candidate) => this.isEligible(candidate))?.connectionId ?? null;
    }
  }

  get(connectionId: string): ConnectionEntry | undefined {
    return this.connections.get(connectionId);
  }

  /**
   * Adopt an instanceId reported inside the version handshake when the
   * connection did not already carry one from the query/header. Callers that
   * pinned the identity explicitly always win; the handshake is only a
   * fallback source for plugins that connect without it.
   */
  setInstanceId(connectionId: string, instanceId: string): void {
    const entry = this.connections.get(connectionId);
    if (!entry) return;
    const bounded = instanceId.trim().slice(0, 160);
    if (bounded.length === 0) return;
    if (entry.instanceId && entry.instanceId.length > 0) return;
    entry.instanceId = bounded;
  }

  markHandshake(
    connectionId: string,
    compatible: boolean,
    capabilities: readonly string[] = [],
    generation?: number,
    identity?: ConnectionIdentity,
  ): void {
    const entry = this.connections.get(connectionId);
    if (!entry) return;
    entry.handshakeCompatible = compatible;
    entry.handshakeUtc = new Date();
    entry.capabilities = new Set(capabilities
      .filter((value) => typeof value === 'string' && value.trim().length > 0)
      .slice(0, 32)
      .map((value) => value.trim().slice(0, 160)));
    // Identity is meaningful only when the peer advertised the capability that
    // promises the members; anything else keeps the snapshot unavailable.
    entry.identity = entry.capabilities.has('bridge-identity-v1')
      ? sanitizeIdentity(identity)
      : undefined;
    if (Number.isInteger(generation) && generation! > 0) entry.generation = generation!;
    if (!compatible) entry.toolsRegisteredUtc = undefined;
  }

  markToolsRegistered(connectionId: string): void {
    const entry = this.connections.get(connectionId);
    if (!entry || entry.handshakeCompatible !== true) return;
    entry.toolsRegisteredUtc = new Date();
    this.promoteIfEligible(entry);
  }

  markPromptsRegistered(connectionId: string): void {
    const entry = this.connections.get(connectionId);
    if (!entry || entry.handshakeCompatible !== true) return;
    entry.promptsRegisteredUtc = new Date();
    this.promoteIfEligible(entry);
  }

  markResourcesRegistered(connectionId: string): void {
    const entry = this.connections.get(connectionId);
    if (!entry || entry.handshakeCompatible !== true) return;
    entry.resourcesRegisteredUtc = new Date();
    this.promoteIfEligible(entry);
  }

  updateEditorReadiness(connectionId: string, value: unknown): void {
    const entry = this.connections.get(connectionId);
    const snapshot = sanitizeReadiness(value);
    if (!entry || !snapshot) return;
    entry.editorReadiness = snapshot;
  }

  noteDurableOperationAccepted(connectionId: string): void {
    const entry = this.connections.get(connectionId);
    if (!entry) return;
    const previous = entry.editorReadiness;
    entry.editorReadiness = {
      state: 'busy',
      ready: false,
      blockers: ['active-operation'],
      retryAfterMs: previous?.retryAfterMs ?? 250,
      queuedSideEffects: Math.max(1, previous?.queuedSideEffects ?? 0),
      runningSideEffects: previous?.runningSideEffects ?? 0,
      queuedReads: previous?.queuedReads ?? 0,
      runningReads: previous?.runningReads ?? 0,
      activeOperations: Math.max(1, previous?.activeOperations ?? 0),
      observedUtc: new Date(),
    };
  }

  getByToken(token: string): ConnectionEntry | undefined {
    return this.findLatest((entry) => entry.token === token && this.isOpen(entry));
  }

  getByInstanceId(instanceId: string): ConnectionEntry | undefined {
    return this.findLatest((entry) => entry.instanceId === instanceId && this.isOpen(entry));
  }

  /** Get the last successful connection (default routing target). */
  getLastSuccessful(): ConnectionEntry | undefined {
    if (this.lastSuccessfulConnectionId === null) return undefined;
    const entry = this.connections.get(this.lastSuccessfulConnectionId);
    return this.isEligible(entry) ? entry : undefined;
  }

  /** A connection is routable only after compatible handshake + declared registration. */
  isEligible(entry: ConnectionEntry | undefined): entry is ConnectionEntry {
    if (entry === undefined || !this.isOpen(entry)
      || entry.handshakeCompatible !== true || entry.toolsRegisteredUtc === undefined) {
      return false;
    }
    // Legacy peers did not advertise generation-owned initialization and retain
    // tools-only compatibility. New peers must complete prompts/resources/tools.
    const generationOwned = entry.capabilities.has('operation-identity-v1')
      || entry.capabilities.has('cancel-tool-call-v1');
    return !generationOwned
      || (entry.promptsRegisteredUtc !== undefined
        && entry.resourcesRegisteredUtc !== undefined);
  }

  /** Resolve an eligible target connection given optional session routing hints. */
  resolve(opts?: { instanceId?: string | null; token?: string | null }): ConnectionEntry | undefined {
    // An explicit instance pin is strict: never fall through to another Editor.
    if (opts?.instanceId) {
      return this.findLatest((entry) => entry.instanceId === opts.instanceId && this.isEligible(entry));
    }

    // Token routing is also strict. Multiple reconnecting sockets may share a
    // token, so scan newest-to-oldest and select the newest eligible one rather
    // than a latest-transport index that may point at an unready replacement.
    if (opts?.token) {
      return this.findLatest((entry) => entry.token === opts.token && this.isEligible(entry));
    }

    const last = this.getLastSuccessful();
    if (last) return last;
    return this.findLatest((entry) => this.isEligible(entry));
  }

  /** Return a snapshot of all connections (for GET /api/instances). */
  snapshot(): ConnectionEntry[] {
    return Array.from(this.connections.values());
  }

  /** Number of active connections. */
  get size(): number {
    return this.connections.size;
  }

  private isOpen(entry: ConnectionEntry): boolean {
    return entry.ws.readyState === entry.ws.OPEN;
  }

  private promoteIfEligible(entry: ConnectionEntry): void {
    if (!this.isEligible(entry)) return;
    this.lastSuccessfulConnectionId = entry.connectionId;
    if (!this.multiPlugin) this.disconnectOlderConnections(entry.connectionId);
  }

  private findLatest(predicate: (entry: ConnectionEntry) => boolean): ConnectionEntry | undefined {
    let found: ConnectionEntry | undefined;
    for (const entry of this.connections.values()) {
      if (predicate(entry)) found = entry;
    }
    return found;
  }

  /**
   * Promote a ready replacement in single-plugin mode. Only older connections
   * are retired; a newer transport that is still handshaking must not be killed
   * merely because the older connection finished registration first.
   */
  private disconnectOlderConnections(connectionId: string): void {
    for (const [id, entry] of this.connections) {
      if (id === connectionId) break;
      if (!this.isOpen(entry)) continue;

      const reason = 'Replaced by a new ready connection.';
      const notif = makeNotification(ClientFacingMethod.ForceDisconnect, { reason });
      entry.ws.send(serializeMessage(notif));
      entry.ws.close(4001, reason);
      this.unregister(id);
    }
  }
}

const READINESS_STATES = new Set([
  'ready', 'settling', 'compiling', 'importing', 'playmode-transition',
  'building', 'busy', 'disconnected',
]);

const MAX_IDENTITY_PATH_LENGTH = 1024;
const MAX_IDENTITY_VERSION_LENGTH = 64;

/** Bound and type-check handshake identity members before they enter routing. */
function sanitizeIdentity(value: unknown): ConnectionIdentity | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const projectPath = typeof record['projectPath'] === 'string' && record['projectPath'].trim().length > 0
    ? record['projectPath'].trim().slice(0, MAX_IDENTITY_PATH_LENGTH)
    : undefined;
  const editorPid = typeof record['editorPid'] === 'number'
    && Number.isSafeInteger(record['editorPid']) && record['editorPid'] > 0
    ? record['editorPid']
    : undefined;
  const unityVersion = typeof record['unityVersion'] === 'string' && record['unityVersion'].trim().length > 0
    ? record['unityVersion'].trim().slice(0, MAX_IDENTITY_VERSION_LENGTH)
    : undefined;
  if (projectPath === undefined && editorPid === undefined && unityVersion === undefined) {
    return undefined;
  }
  return {
    ...(projectPath === undefined ? {} : { projectPath }),
    ...(editorPid === undefined ? {} : { editorPid }),
    ...(unityVersion === undefined ? {} : { unityVersion }),
  };
}

function sanitizeReadiness(value: unknown): EditorReadinessCache | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const state = typeof record['state'] === 'string' ? record['state']
    : typeof record['State'] === 'string' ? record['State']
      : undefined;
  const ready = typeof record['ready'] === 'boolean' ? record['ready']
    : typeof record['Ready'] === 'boolean' ? record['Ready']
      : undefined;
  if (!state || !READINESS_STATES.has(state) || ready === undefined) return undefined;
  const number = (camel: string, pascal: string, maximum: number): number => {
    const candidate = record[camel] ?? record[pascal];
    return typeof candidate === 'number' && Number.isInteger(candidate)
      ? Math.max(0, Math.min(maximum, candidate))
      : 0;
  };
  const blockersValue = record['blockers'] ?? record['Blockers'];
  const blockers = Array.isArray(blockersValue)
    ? blockersValue.filter((item): item is string => typeof item === 'string')
      .slice(0, 8).map((item) => item.slice(0, 160))
    : [];
  return {
    state,
    ready,
    blockers,
    retryAfterMs: Math.max(50, Math.min(5_000,
      number('retryAfterMs', 'RetryAfterMs', 5_000) || 250)),
    queuedSideEffects: number('queuedSideEffects', 'QueuedSideEffects', 64),
    runningSideEffects: number('runningSideEffects', 'RunningSideEffects', 1),
    queuedReads: number('queuedReads', 'QueuedReads', 64),
    runningReads: number('runningReads', 'RunningReads', 4),
    activeOperations: number('activeOperations', 'ActiveOperations', 200),
    observedUtc: new Date(),
  };
}
