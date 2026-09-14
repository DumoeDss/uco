import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RestContext } from './context.js';
import { sendJson } from './context.js';
import { restAuthMiddleware } from './auth.js';

export function handleLocalHealth(_req: IncomingMessage, res: ServerResponse): void {
  sendJson(res, 200, {
    ok: true,
    stages: {
      process: { ready: true, pid: process.pid },
      http: { ready: true, authenticated: false },
    },
  });
}

export function handleReadinessHealth(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RestContext,
): void {
  if (!restAuthMiddleware(req, res, { token: ctx.authToken })) return;
  const connections = ctx.registry.snapshot().filter((entry) => entry.ws.readyState === entry.ws.OPEN);
  const handshaken = connections.filter((entry) => entry.handshakeCompatible === true);
  const runners = connections.filter((entry) => ctx.registry.isEligible(entry));
  const routed = ctx.registry.resolve({ token: ctx.authToken });
  const active = routed ?? handshaken.at(-1) ?? connections.at(-1);

  sendJson(res, 200, {
    ok: true,
    ready: routed !== undefined && routed.editorReadiness?.ready === true,
    ...(ctx.ownedRuntime === undefined ? {} : {
      serverInstanceId: ctx.ownedRuntime.serverInstanceId,
      handoffPhase: ctx.ownedRuntime.phase,
    }),
    stages: {
      process: { ready: true, pid: process.pid },
      http: { ready: true, authenticated: Boolean(ctx.authToken) },
      webSocket: { ready: connections.length > 0, connections: connections.length },
      handshake: {
        ready: active?.handshakeCompatible === true,
        compatibleConnections: handshaken.length,
      },
      capabilities: {
        ready: active === undefined ? false : (
          active.toolsRegisteredUtc !== undefined
          && (!active.capabilities.has('operation-identity-v1')
            || (active.promptsRegisteredUtc !== undefined
              && active.resourcesRegisteredUtc !== undefined))
        ),
        tools: active?.toolsRegisteredUtc !== undefined,
        prompts: active?.promptsRegisteredUtc !== undefined,
        resources: active?.resourcesRegisteredUtc !== undefined,
      },
      toolRunner: {
        ready: ctx.registry.isEligible(active),
        registeredConnections: runners.length,
      },
      editor: active?.editorReadiness === undefined
        ? { ready: null, state: 'settling', reason: 'requires-read-only-editor-probe' }
        : {
            ready: active.editorReadiness.ready,
            state: active.editorReadiness.state,
            blockers: active.editorReadiness.blockers,
            retryAfterMs: active.editorReadiness.retryAfterMs,
            observedUtc: active.editorReadiness.observedUtc.toISOString(),
          },
      scheduler: active?.editorReadiness === undefined
        ? { ready: null, reason: 'not-observed' }
        : {
            ready: active.editorReadiness.state !== 'busy',
            queuedSideEffects: active.editorReadiness.queuedSideEffects,
            runningSideEffects: active.editorReadiness.runningSideEffects,
            queuedReads: active.editorReadiness.queuedReads,
            runningReads: active.editorReadiness.runningReads,
          },
      operations: active?.editorReadiness === undefined
        ? { ready: null, reason: 'not-observed' }
        : {
            ready: active.editorReadiness.activeOperations === 0,
            active: active.editorReadiness.activeOperations,
          },
      probe: { ready: false, reason: 'not-run-by-node-local-health' },
    },
    ...(active === undefined ? {} : {
      generation: active.connectionId,
      connection: {
        id: active.connectionId,
        instanceId: active.instanceId ?? null,
        connectedUtc: active.connectedUtc.toISOString(),
        handshakeUtc: active.handshakeUtc?.toISOString() ?? null,
        toolsRegisteredUtc: active.toolsRegisteredUtc?.toISOString() ?? null,
        promptsRegisteredUtc: active.promptsRegisteredUtc?.toISOString() ?? null,
        resourcesRegisteredUtc: active.resourcesRegisteredUtc?.toISOString() ?? null,
        capabilities: [...active.capabilities].slice(0, 32),
        pluginGeneration: active.generation,
        // Full Editor identity tuple (bridge-identity-v1): one atomic response
        // carries server, Editor, and project identity for pinning/verification.
        identityAvailable: active.identity !== undefined,
        projectPath: active.identity?.projectPath ?? null,
        editorPid: active.identity?.editorPid ?? null,
        unityVersion: active.identity?.unityVersion ?? null,
      },
    }),
  });
}
