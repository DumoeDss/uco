/**
 * Server factory — create and wire the HTTP + WebSocket server.
 *
 * createServer(config) returns a { start(), stop() } handle.
 */

import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo, Server as NetServer } from 'node:net';

import { validateServerConfig, type ServerConfig } from './config.js';
import { ConnectionRegistry } from './ws/registry.js';
import { PendingTracker } from './ws/pending.js';
import { PluginHub } from './ws/hub.js';
import { SessionStateStore } from './session/store.js';
import { CallRecordStore } from './calls/call-record-store.js';
import { createRestRouter } from './rest/router.js';
import type { RestContext } from './rest/context.js';
import type { PluginClientData } from './types.js';

export interface BridgeHandle {
  /** The underlying HTTP server. */
  httpServer: Server;
  /** The WebSocket hub. */
  hub: PluginHub;
  /** The connection registry. */
  registry: ConnectionRegistry;
  /** The session store. */
  sessionStore: SessionStateStore;
  /** Start listening. Returns a promise that resolves when listening. */
  start(): Promise<ListeningAddress>;
  /** Attach HTTP handling to an already-listening socket received over Node IPC. */
  startWithHandle(handle: NetServer): Promise<ListeningAddress>;
  /** Stop the server and clean up. */
  stop(): Promise<void>;
}

export interface ListeningAddress {
  address: string;
  family: string;
  port: number;
}

export interface OwnedServerRuntime {
  serverInstanceId: string;
  phase: 'precommit' | 'committed';
}

/**
 * Create the bridge server: HTTP REST + WebSocket hub.
 *
 * @param config Server configuration.
 */
export function createServer(
  config: ServerConfig,
  ownedRuntime?: OwnedServerRuntime,
): BridgeHandle {
  const validated = validateServerConfig(config);
  const multiPlugin = validated.authorization === 'required';

  const registry = new ConnectionRegistry(multiPlugin);
  const pending = new PendingTracker();
  const sessionStore = new SessionStateStore();
  const callRecords = new CallRecordStore();
  const clientData: PluginClientData[] = [];

  const hub = new PluginHub({
    registry,
    pending,
    authToken: validated.token,
    serverApiVersion: validated.serverApiVersion,
    serverVersion: validated.serverVersion,
    heartbeatIntervalMs: validated.heartbeatIntervalMs,
    clientData,
    ownedRuntime,
    onCallRecordCompleted: (requestId, operationId, result, isError) => {
      callRecords.completeByRequestId(requestId, operationId, result, isError);
    },
  });

  const restCtx: RestContext = {
    registry,
    pending,
    hub,
    sessionStore,
    callRecords,
    pluginTimeoutMs: validated.pluginTimeoutMs,
    authToken: validated.token,
    ownedRuntime,
  };

  const requestListener = createRestRouter(restCtx);
  const httpServer = createHttpServer(requestListener);

  // Attach the WebSocket hub to the HTTP server.
  hub.attach(httpServer);

  // Start the session sweeper and the call-record sweeper.
  sessionStore.startSweeper();
  const callRecordSweeper = callRecords.startSweeper();

  const listeningAddress = (): ListeningAddress => {
    const address = httpServer.address();
    if (address === null || typeof address === 'string') {
      throw new Error('uco bridge did not report an IP listening address.');
    }
    const info = address as AddressInfo;
    return { address: info.address, family: info.family, port: info.port };
  };

  const listen = (target: { port: number; host: string } | NetServer): Promise<ListeningAddress> => {
    return new Promise((resolve, reject) => {
      const onError = (error: Error): void => {
        httpServer.removeListener('listening', onListening);
        reject(error);
      };
      const onListening = (): void => {
        httpServer.removeListener('error', onError);
        try {
          resolve(listeningAddress());
        } catch (error) {
          reject(error);
        }
      };
      httpServer.once('error', onError);
      httpServer.once('listening', onListening);
      if ('port' in target) httpServer.listen(target.port, target.host);
      else httpServer.listen(target);
    });
  };

  return {
    httpServer,
    hub,
    registry,
    sessionStore,
    start(): Promise<ListeningAddress> {
      return listen({ port: validated.port, host: validated.listenHost });
    },
    startWithHandle(handle: NetServer): Promise<ListeningAddress> {
      return listen(handle);
    },
    stop(): Promise<void> {
      return new Promise((resolve) => {
        hub.close();
        sessionStore.dispose();
        clearInterval(callRecordSweeper);
        httpServer.close(() => resolve());
      });
    },
  };
}
