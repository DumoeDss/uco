import * as fs from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import type { spawn } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  prepareOwnedNodeServer,
  resolveOwnedServerCredentials,
} from '../src/devops/lib/owned-node-server.js';
import { readConfig, writeConfig } from '../src/devops/utils/config.js';

const temporaryDirectories: string[] = [];
const servers: Server[] = [];

function temporaryProject(): string {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'uco-owned-server-'));
  temporaryDirectories.push(project);
  return project;
}

async function listen(authenticated: boolean): Promise<string> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({
      ok: true,
      stages: { http: { ready: true, authenticated } },
    }));
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    if (!server.listening) continue;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

describe('owned credential resolution', () => {
  it('keeps an explicit token ephemeral and ahead of the descriptor token', () => {
    const project = temporaryProject();
    writeConfig(project, {
      connectionMode: 'Custom',
      host: 'http://127.0.0.1:24560',
      token: 'stored-token',
      authOption: 'none',
      unknown: 'preserve-me',
    });
    const configPath = path.join(project, 'UserSettings', 'AI-Game-Developer-Config.json');
    const before = fs.readFileSync(configPath, 'utf8');

    const resolved = resolveOwnedServerCredentials({
      projectPath: project,
      token: 'explicit-token',
    });

    expect(resolved).toMatchObject({ token: 'explicit-token', tokenSource: 'explicit' });
    expect(fs.readFileSync(configPath, 'utf8')).toBe(before);
  });

  it('reuses a custom descriptor token, normalizes required auth, and preserves unknown fields', () => {
    const project = temporaryProject();
    writeConfig(project, {
      connectionMode: 'Custom',
      host: 'http://127.0.0.1:24561',
      token: 'stored-token',
      authOption: 'none',
      unknown: { future: true },
    });

    const resolved = resolveOwnedServerCredentials({ projectPath: project });

    expect(resolved).toMatchObject({ token: 'stored-token', tokenSource: 'descriptor' });
    expect(readConfig(project)).toMatchObject({
      token: 'stored-token',
      authOption: 'required',
      unknown: { future: true },
    });
  });

  it('generates and persists one 32-byte token when no reusable token exists', () => {
    const project = temporaryProject();

    const resolved = resolveOwnedServerCredentials({
      projectPath: project,
      url: 'http://127.0.0.1:24562',
    });

    expect(resolved.tokenSource).toBe('generated');
    expect(resolved.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(resolved.token!, 'base64url')).toHaveLength(32);
    expect(readConfig(project)).toMatchObject({
      host: 'http://127.0.0.1:24562',
      token: resolved.token,
      authOption: 'required',
      connectionMode: 'Custom',
    });
  });

  it('leaves stored credentials untouched for explicit auth=none', () => {
    const project = temporaryProject();
    writeConfig(project, {
      connectionMode: 'Custom',
      host: 'http://127.0.0.1:24563',
      token: 'stored-token',
      authOption: 'required',
    });
    const before = JSON.stringify(readConfig(project));

    expect(resolveOwnedServerCredentials({ projectPath: project, auth: 'none' }))
      .toMatchObject({ token: undefined, tokenSource: 'none', authorization: 'none' });
    expect(JSON.stringify(readConfig(project))).toBe(before);
  });

  it('rejects auth=none plus an explicit token before descriptor mutation', () => {
    const project = temporaryProject();
    expect(() => resolveOwnedServerCredentials({
      projectPath: project,
      url: 'http://127.0.0.1:24564',
      token: 'must-not-leak',
      auth: 'none',
    })).toThrow(/cannot be combined/);
    expect(readConfig(project)).toBeNull();
  });
});

describe('owned endpoint compatibility', () => {
  it('reuses only a listener whose health matches the requested auth mode', async () => {
    const project = temporaryProject();
    const url = await listen(false);
    const spawnImpl = vi.fn() as unknown as typeof spawn;

    await expect(prepareOwnedNodeServer({
      projectPath: project,
      url,
      auth: 'none',
    }, { spawnImpl })).resolves.toMatchObject({
      alreadyRunning: true,
      authorization: 'none',
    });
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it('does not reuse a listener with mismatched authenticated health', async () => {
    const project = temporaryProject();
    const url = await listen(false);
    const spawnImpl = vi.fn() as unknown as typeof spawn;

    await expect(prepareOwnedNodeServer({
      projectPath: project,
      url,
      token: 'required-token',
      lockTimeoutMs: 20,
      lockPollIntervalMs: 1,
    }, { spawnImpl })).rejects.toThrow(/occupied|incompatible listener/i);
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it('rejects non-local ownership before spawning a process', async () => {
    const project = temporaryProject();
    const spawnImpl = vi.fn() as unknown as typeof spawn;

    await expect(prepareOwnedNodeServer({
      projectPath: project,
      url: 'https://example.invalid:24572',
      token: 'fixture-token',
    }, { spawnImpl })).rejects.toThrow(/only own a local HTTP Node bridge/);
    expect(spawnImpl).not.toHaveBeenCalled();
  });
});
