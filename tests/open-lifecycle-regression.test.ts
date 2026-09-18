import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findEditorPath: vi.fn(),
  launchEditor: vi.fn(),
  findUnityProcess: vi.fn(),
  readConfig: vi.fn(),
  writeConfig: vi.fn(),
  clearCachedEditorPath: vi.fn(),
  prepareOwnedNodeServer: vi.fn(),
}));

vi.mock('../src/devops/utils/unity-editor.js', async () => {
  const actual = await vi.importActual<typeof import('../src/devops/utils/unity-editor.js')>(
    '../src/devops/utils/unity-editor.js',
  );
  return {
    ...actual,
    findEditorPath: mocks.findEditorPath,
    launchEditor: mocks.launchEditor,
  };
});

vi.mock('../src/devops/utils/unity-process.js', () => ({
  findUnityProcess: mocks.findUnityProcess,
}));

vi.mock('../src/devops/utils/config.js', () => ({
  readConfig: mocks.readConfig,
  writeConfig: mocks.writeConfig,
  isCloudMode: vi.fn(() => false),
}));

vi.mock('../src/devops/utils/editor-cache.js', () => ({
  clearCachedEditorPath: mocks.clearCachedEditorPath,
}));

vi.mock('../src/devops/lib/owned-node-server.js', () => ({
  prepareOwnedNodeServer: mocks.prepareOwnedNodeServer,
}));

import {
  _pollAndDismissLaunchErrorsForTests,
  openProject,
} from '../src/devops/lib/open.js';
import { registerOpen } from '../src/commands/devops/open.js';
import { registerWaitForReady } from '../src/commands/devops/wait-for-ready.js';

const temporaryDirectories: string[] = [];

function unityProject(): string {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'uco-open-lifecycle-'));
  temporaryDirectories.push(project);
  fs.mkdirSync(path.join(project, 'Assets'));
  fs.mkdirSync(path.join(project, 'ProjectSettings'));
  fs.writeFileSync(
    path.join(project, 'ProjectSettings', 'ProjectVersion.txt'),
    'm_EditorVersion: 6000.5.6f1\n',
  );
  return project;
}

beforeEach(() => {
  mocks.findEditorPath.mockReset();
  mocks.launchEditor.mockReset();
  mocks.findUnityProcess.mockReset().mockReturnValue(null);
  mocks.readConfig.mockReset().mockReturnValue(null);
  mocks.writeConfig.mockReset();
  mocks.clearCachedEditorPath.mockReset();
  mocks.prepareOwnedNodeServer.mockReset().mockResolvedValue({
    baseUrl: 'http://127.0.0.1:23456',
    token: 'fixture-token',
    authorization: 'required',
    alreadyRunning: false,
    pid: 31337,
  });
});

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('enriched open regressions after lifecycle locator routing', () => {
  it('still launches the editor directly with bridge env and waits for the child spawn event', async () => {
    const project = unityProject();
    const executable = process.platform === 'win32' ? 'C:\\Unity\\Editor\\Unity.exe' : '/opt/unity/Editor/Unity';
    mocks.findEditorPath.mockResolvedValue(executable);
    const child = new EventEmitter() as ChildProcess;
    let childPid: number | undefined;
    Object.defineProperty(child, 'pid', { get: () => childPid, configurable: true });
    mocks.launchEditor.mockImplementation((
      _editorPath: string,
      _projectPath: string,
      _env: Record<string, string> | undefined,
      callbacks: { onSpawn?: (pid: number | undefined) => void },
    ) => {
      setTimeout(() => {
        childPid = 4242;
        callbacks.onSpawn?.(4242);
        child.emit('spawn');
      }, 25);
      return child;
    });
    const events: Array<{ phase: string; [key: string]: unknown }> = [];
    const startedAt = Date.now();

    const result = await openProject({
      projectPath: project,
      url: 'http://127.0.0.1:23456',
      token: 'secret',
      auth: 'required',
      keepConnected: true,
      tools: 'scene,console',
      transport: 'streamableHttp',
      startServer: false,
      autoDismissLaunchErrors: false,
      onProgress: (event) => events.push(event),
    });

    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(15);
    expect(mocks.findEditorPath).toHaveBeenCalledWith('6000.5.6f1');
    expect(mocks.launchEditor).toHaveBeenCalledWith(
      executable,
      path.resolve(project),
      {
        UNITY_COPILOT_HOST: 'http://127.0.0.1:23456',
        UNITY_COPILOT_KEEP_CONNECTED: 'true',
        UNITY_COPILOT_TOOLS: 'scene,console',
        UNITY_COPILOT_TOKEN: 'secret',
        UNITY_COPILOT_AUTH_OPTION: 'required',
        UNITY_COPILOT_TRANSPORT: 'streamableHttp',
        UNITY_COPILOT_START_SERVER: 'false',
      },
      expect.objectContaining({ onSpawn: expect.any(Function), onError: expect.any(Function) }),
    );
    expect(result).toMatchObject({
      kind: 'success',
      editorPath: executable,
      editorPid: 4242,
      unityVersion: '6000.5.6f1',
    });
    expect(events.map((event) => event.phase)).toEqual([
      'start',
      'detecting-editor-version',
      'editors-located',
      'editor-resolved',
      'connection-details',
      'launching-editor',
      'editor-launched',
      'done',
    ]);
    const connectionDetails = events.find((event) => event.phase === 'connection-details');
    expect(connectionDetails).toMatchObject({
      envVars: { UNITY_COPILOT_TOKEN: '[REDACTED]' },
    });
    expect(JSON.stringify(events)).not.toContain('secret');
  });

  it('keeps launch-error dismissal progress independent of service readiness polling', async () => {
    const progress: Array<{ phase: string }> = [];
    const warnings: string[] = [];
    const probe = vi.fn()
      .mockResolvedValueOnce({ kind: 'dismissed', button: 'Ignore' })
      .mockResolvedValue({ kind: 'not-found' });

    await _pollAndDismissLaunchErrorsForTests({
      timeoutMs: 80,
      intervalMs: 50,
      noDialogGraceMs: 0,
      platform: 'win32',
      probe,
      warnings,
      onProgress: (event) => progress.push(event),
    });

    expect(probe).toHaveBeenCalled();
    expect(progress).toContainEqual(expect.objectContaining({ phase: 'launch-errors-dismissed' }));
    expect(warnings).toEqual([]);
  });

  it('keeps open and wait-for-ready as independently registered command boundaries', () => {
    const program = new Command();
    registerOpen(program);
    registerWaitForReady(program);

    const openCommand = program.commands.find((command) => command.name() === 'open');
    const waitCommand = program.commands.find((command) => command.name() === 'wait-for-ready');
    expect(openCommand).toBeDefined();
    expect(waitCommand).toBeDefined();
    expect(openCommand?.description()).toContain('Open a Unity project');
    expect(openCommand?.options.find((option) => option.long === '--start-server')?.description)
      .toContain('uco-owned bridge');
    expect(waitCommand?.description()).toBe(
      'Wait for Node, WebSocket, handshake/tool runner, idle Editor, and a read-only probe.',
    );
    expect(openCommand?.options.map((option) => option.long)).not.toContain('--interval');
    expect(waitCommand?.options.map((option) => option.long)).toEqual([
      '--timeout-ms',
      '--timeout',
      '--interval',
      // COCli-01 identity pins: fail the wait when the connected Editor
      // reports a different project/instance/pid.
      '--expected-project-path',
      '--expected-instance-id',
      '--expected-pid',
    ]);
  });

  it('keeps launch failures on the existing failure result path', async () => {
    const project = unityProject();
    mocks.findEditorPath.mockRejectedValue(new Error('selected official inventory failed'));
    const result = await openProject({ projectPath: project, autoDismissLaunchErrors: false });
    expect(result).toMatchObject({
      kind: 'failure',
      success: false,
      unityVersion: '6000.5.6f1',
      errorMessage: 'selected official inventory failed',
    });
    expect(mocks.launchEditor).not.toHaveBeenCalled();
  });

  it('establishes a COCli-owned Node listener before launching Unity', async () => {
    const project = unityProject();
    const order: string[] = [];
    mocks.findEditorPath.mockResolvedValue('C:\\Unity\\Editor\\Unity.exe');
    mocks.prepareOwnedNodeServer.mockImplementation(async () => {
      order.push('node-ready');
      return {
        baseUrl: 'http://127.0.0.1:23456',
        token: 'fixture-token',
        authorization: 'required',
        alreadyRunning: false,
        pid: 31337,
      };
    });
    const child = new EventEmitter() as ChildProcess;
    Object.defineProperty(child, 'pid', { value: 4242, configurable: true });
    mocks.launchEditor.mockImplementation(() => {
      order.push('editor-launch');
      return child;
    });

    const result = await openProject({
      projectPath: project,
      url: 'http://127.0.0.1:23456',
      token: 'fixture-token',
      auth: 'required',
      startServer: true,
      autoDismissLaunchErrors: false,
    });

    expect(result.kind).toBe('success');
    expect(order).toEqual(['node-ready', 'editor-launch']);
    expect(mocks.launchEditor).toHaveBeenCalledWith(
      'C:\\Unity\\Editor\\Unity.exe',
      path.resolve(project),
      expect.objectContaining({
        UNITY_COPILOT_HOST: 'http://127.0.0.1:23456',
        UNITY_COPILOT_TOKEN: 'fixture-token',
        UNITY_COPILOT_AUTH_OPTION: 'required',
        UNITY_COPILOT_START_SERVER: 'false',
      }),
      expect.any(Object),
    );
  });

  it('fails with close-and-reopen guidance when owned startup is requested for a running Editor', async () => {
    const project = unityProject();
    mocks.findUnityProcess.mockReturnValue({
      pid: 5150,
      commandLine: '"C:\\Unity\\Editor\\Unity.exe" -projectPath "C:\\Project"',
    });

    const result = await openProject({
      projectPath: project,
      startServer: true,
      autoDismissLaunchErrors: false,
    });

    expect(result).toMatchObject({ kind: 'failure', success: false });
    if (result.kind === 'failure') {
      expect(result.errorMessage).toMatch(/already running.*close.*reopen/i);
      expect(result.errorMessage).toMatch(/cannot receive.*environment/i);
    }
    expect(mocks.prepareOwnedNodeServer).not.toHaveBeenCalled();
    expect(mocks.findEditorPath).not.toHaveBeenCalled();
    expect(mocks.launchEditor).not.toHaveBeenCalled();
  });

  it('does not launch Unity and redacts explicit credentials when owned startup fails', async () => {
    const project = unityProject();
    const secret = 'owned-startup-secret';
    mocks.findEditorPath.mockResolvedValue('C:\\Unity\\Editor\\Unity.exe');
    mocks.prepareOwnedNodeServer.mockRejectedValue(
      new Error(`Unable to start --token ${secret}`),
    );

    const result = await openProject({
      projectPath: project,
      url: 'http://127.0.0.1:23456',
      token: secret,
      auth: 'required',
      startServer: true,
      autoDismissLaunchErrors: false,
    });

    expect(result).toMatchObject({ kind: 'failure', success: false });
    if (result.kind === 'failure') {
      expect(result.errorMessage).not.toContain(secret);
      expect(result.error.message).not.toContain(secret);
    }
    expect(mocks.launchEditor).not.toHaveBeenCalled();
  });
});
