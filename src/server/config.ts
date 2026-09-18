/**
 * Server configuration — parse CLI args into a ServerConfig object.
 *
 * Mirrors the .NET DataArguments parameters.
 */

import { readFileSync } from 'node:fs';
import {
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  DEFAULT_PORT,
  DEFAULT_PLUGIN_TIMEOUT_MS,
} from './types.js';

export interface ServerConfig {
  /** Port to listen on (default 8080). */
  port: number;
  /** Socket bind host (default loopback-only 127.0.0.1). */
  listenHost: string;
  /** Explicit acknowledgement that a non-loopback socket may be opened. */
  allowLan: boolean;
  /** Bearer token for auth (empty = no auth). */
  token?: string;
  /** Authorization mode: 'none' or 'required' (inferred from token). */
  authorization: 'none' | 'required';
  /** Plugin forward timeout in ms (default 10000). */
  pluginTimeoutMs: number;
  /** Application heartbeat interval in ms (default 20000). */
  heartbeatIntervalMs: number;
  /** Optional webhook URL for analytics events. */
  webhookUrl?: string;
  /** Server API version string. */
  serverApiVersion: string;
  /** Server version string. */
  serverVersion: string;
}

export const DEFAULT_SERVER_API_VERSION = '2.0.0';

/**
 * The banner's server version tracks the npm package version, read at module
 * load. It used to be a hardcoded constant that no release remembered to
 * bump — it still said `0.2.1-node` on the 1.0.x builds. Resolved from
 * `package.json` relative to this module, which lands identically from
 * `src/` (tests, tsx) and `dist/` (published builds); the literal is only the
 * fallback for a unreadable manifest.
 */
export const DEFAULT_SERVER_VERSION = resolvePackageVersion('uco-unknown');

function resolvePackageVersion(fallback: string): string {
  try {
    const pkg = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { version?: unknown };
    return typeof pkg.version === 'string' && pkg.version.length > 0 ? pkg.version : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Parse CLI args into a ServerConfig.
 * Supports: --port, --listen-host, --allow-lan, --token, --authorization,
 * --plugin-timeout-ms, --heartbeat-interval-ms, --webhook-url
 */
export function parseServerConfig(
  args: string[],
  environment: Readonly<Record<string, string | undefined>> = process.env,
): ServerConfig {
  const config: ServerConfig = {
    port: DEFAULT_PORT,
    listenHost: '127.0.0.1',
    allowLan: false,
    authorization: 'required',
    pluginTimeoutMs: DEFAULT_PLUGIN_TIMEOUT_MS,
    heartbeatIntervalMs: DEFAULT_HEARTBEAT_INTERVAL_MS,
    serverApiVersion: DEFAULT_SERVER_API_VERSION,
    serverVersion: DEFAULT_SERVER_VERSION,
  };
  let cliToken: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];

    switch (arg) {
      case '--port':
        if (next) {
          config.port = parseInt(next, 10);
          i++;
        }
        break;
      case '--listen-host':
        if (next !== undefined) {
          config.listenHost = next;
          i++;
        }
        break;
      case '--allow-lan':
        config.allowLan = true;
        break;
      case '--token':
        if (next !== undefined) {
          cliToken = next;
          i++;
        }
        break;
      case '--authorization':
        if (next === 'none' || next === 'required') {
          config.authorization = next;
          i++;
        } else {
          throw new Error('--authorization must be "none" or "required".');
        }
        break;
      case '--plugin-timeout-ms':
        if (next) {
          config.pluginTimeoutMs = parseInt(next, 10);
          i++;
        }
        break;
      case '--heartbeat-interval-ms':
        if (next) {
          config.heartbeatIntervalMs = parseInt(next, 10);
          i++;
        }
        break;
      case '--webhook-url':
        if (next !== undefined) {
          config.webhookUrl = next;
          i++;
        }
        break;
    }
  }

  // The explicit CLI credential always wins over the owned-process channel.
  config.token = normalizeToken(cliToken ?? environment.UCO_SERVER_TOKEN);

  return validateServerConfig(config);
}

/** Normalize brackets used in URL-form IPv6 literals before socket binding. */
export function normalizeListenHost(host: string): string {
  const trimmed = host.trim();
  return trimmed.startsWith('[') && trimmed.endsWith(']')
    ? trimmed.slice(1, -1)
    : trimmed;
}

/** Classify loopback without resolving arbitrary DNS names. */
export function isLoopbackHost(host: string): boolean {
  const normalized = normalizeListenHost(host).toLowerCase();
  if (normalized === 'localhost' || normalized === '::1') return true;
  const octets = normalized.split('.');
  return octets.length === 4
    && octets.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
    && octets[0] === '127';
}

/**
 * Re-check the transport security contract at the public server boundary.
 * Programmatic callers therefore cannot bypass the CLI parser's validation.
 */
export function validateServerConfig(config: ServerConfig): ServerConfig {
  const listenHost = normalizeListenHost(config.listenHost);
  const token = normalizeToken(config.token);
  if (listenHost.length === 0) {
    throw new Error('listenHost must be a non-empty hostname or address.');
  }
  if (!Number.isInteger(config.port) || config.port < 0 || config.port > 65535) {
    throw new Error('port must be an integer between 0 and 65535.');
  }
  if (config.authorization !== 'none' && config.authorization !== 'required') {
    throw new Error('authorization must be "none" or "required".');
  }
  if (config.authorization === 'required' && !token) {
    throw new Error(
      'Bearer authentication is required by default. Supply --token, set UCO_SERVER_TOKEN, ' +
      'or explicitly select loopback-only --authorization none.',
    );
  }
  if (config.authorization === 'none' && token) {
    throw new Error('A bearer token cannot be combined with --authorization none.');
  }

  const loopback = isLoopbackHost(listenHost);
  if (!loopback && !config.allowLan) {
    throw new Error(`Non-loopback listen host "${listenHost}" requires explicit --allow-lan.`);
  }
  if (!loopback && (config.authorization !== 'required' || !token)) {
    throw new Error('LAN listening requires bearer authentication and a non-empty token.');
  }
  if (config.authorization === 'none' && !loopback) {
    throw new Error('Unauthenticated mode is restricted to loopback listeners.');
  }

  return {
    ...config,
    listenHost,
    ...(token === undefined ? { token: undefined } : { token }),
  };
}

function normalizeToken(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}
