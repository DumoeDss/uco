/**
 * uco bridge — entry point and public exports.
 *
 * Exports createServer(), ServerConfig, and shared types.
 * Also provides a main() function for the `uco serve` subcommand / bin entry.
 */

export {
  createServer,
  type ListeningAddress,
  type BridgeHandle,
  type OwnedServerRuntime,
} from './app.js';
export {
  isLoopbackHost,
  normalizeListenHost,
  parseServerConfig,
  validateServerConfig,
  type ServerConfig,
  DEFAULT_SERVER_API_VERSION,
  DEFAULT_SERVER_VERSION,
} from './config.js';
export { ConnectionRegistry } from './ws/registry.js';
export { PendingTracker } from './ws/pending.js';
export { PluginHub } from './ws/hub.js';
export { SessionStateStore, type SessionState } from './session/store.js';
export * as types from './types.js';

import { createServer, type OwnedServerRuntime } from './app.js';
import { parseServerConfig } from './config.js';
import type { Server as NetServer } from 'node:net';

const OWNED_HANDOFF_ARGUMENT = '--owned-ipc-handoff';

interface OwnedParentMessage {
  type: 'uco-owned-handoff' | 'uco-owned-commit' | 'uco-owned-abort';
  serverInstanceId: string;
}

interface OwnedChildMessage {
  type: 'uco-owned-attached' | 'uco-owned-committed' | 'uco-owned-error';
  serverInstanceId: string;
  detail?: string;
}

/**
 * Main entry point for `uco serve` or `bin/server.mjs`.
 * Parses process.argv and starts the server.
 */
export async function main(argv: string[]): Promise<void> {
  const args = argv.slice(2); // skip node + script
  const config = parseServerConfig(args);

  if (args.includes(OWNED_HANDOFF_ARGUMENT)) {
    const serverInstanceId = process.env.COCLI_SERVER_INSTANCE_ID?.trim();
    if (!serverInstanceId) {
      throw new Error('Owned IPC handoff requires COCLI_SERVER_INSTANCE_ID.');
    }
    startOwnedIpcChild(config, serverInstanceId);
    return;
  }

  const server = createServer(config);

  const listening = await server.start();
  const displayHost = listening.address.includes(':') ? `[${listening.address}]` : listening.address;

  console.log(`uco bridge listening on http://${displayHost}:${listening.port}`);
  console.log(`  API version:  ${config.serverApiVersion}`);
  console.log(`  Server version: ${config.serverVersion}`);
  console.log(`  Auth: ${config.authorization}`);
  console.log(`  WebSocket hub: ws://${displayHost}:${listening.port}/hub/plugin`);
  console.log(`  REST:  http://${displayHost}:${listening.port}/help`);

  // Graceful shutdown.
  const shutdown = async (): Promise<void> => {
    console.log('\nShutting down...');
    await server.stop();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

/**
 * Keep a handed-off child coupled to its parent until an exact-instance
 * commit arrives. A precommit child always closes on abort or IPC loss.
 */
function startOwnedIpcChild(
  config: ReturnType<typeof parseServerConfig>,
  serverInstanceId: string,
): void {
  const runtime: OwnedServerRuntime = { serverInstanceId, phase: 'precommit' };
  const server = createServer(config, runtime);
  let attached = false;
  let closing = false;

  const send = (message: OwnedChildMessage): void => {
    if (!process.connected || process.send === undefined) {
      throw new Error('The uco parent IPC channel is unavailable.');
    }
    process.send(message);
  };

  const abort = async (exitCode: number): Promise<void> => {
    if (closing || runtime.phase === 'committed') return;
    closing = true;
    if (attached) await server.stop();
    if (process.connected) process.disconnect();
    process.exit(exitCode);
  };

  const shutdown = async (exitCode: number): Promise<void> => {
    if (closing) return;
    closing = true;
    if (attached) await server.stop();
    if (process.connected) process.disconnect();
    process.exit(exitCode);
  };

  process.on('message', (raw: unknown, handle: unknown) => {
    void (async () => {
      const message = raw as Partial<OwnedParentMessage>;
      if (message.serverInstanceId !== serverInstanceId) {
        await abort(1);
        return;
      }

      if (message.type === 'uco-owned-abort') {
        await abort(1);
        return;
      }
      if (message.type === 'uco-owned-handoff') {
        if (attached || !isTransferredServer(handle)) {
          send({
            type: 'uco-owned-error',
            serverInstanceId,
            detail: 'The transferred listening handle was missing or invalid.',
          });
          await abort(1);
          return;
        }
        try {
          await server.startWithHandle(handle);
          attached = true;
          send({ type: 'uco-owned-attached', serverInstanceId });
        } catch (error) {
          send({
            type: 'uco-owned-error',
            serverInstanceId,
            detail: error instanceof Error ? error.message : String(error),
          });
          await abort(1);
        }
        return;
      }
      if (message.type === 'uco-owned-commit') {
        if (!attached || runtime.phase !== 'precommit') {
          await abort(1);
          return;
        }
        runtime.phase = 'committed';
        send({ type: 'uco-owned-committed', serverInstanceId });
      }
    })().catch(() => void abort(1));
  });

  process.once('disconnect', () => { void abort(1); });
  process.once('SIGINT', () => { void shutdown(0); });
  process.once('SIGTERM', () => { void shutdown(0); });
}

function isTransferredServer(handle: unknown): handle is NetServer {
  return typeof handle === 'object' && handle !== null &&
    'address' in handle && typeof (handle as NetServer).address === 'function';
}
