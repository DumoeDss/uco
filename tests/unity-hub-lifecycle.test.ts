import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from 'node:child_process';
import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerCreateProject } from '../src/commands/devops/create-project.js';
import { registerEditors } from '../src/commands/devops/editors.js';
import { registerInstallUnity } from '../src/commands/devops/install-unity.js';
import {
  createUnityLifecycleRouter,
  type HubLifecycleAdapter,
  type OfficialLifecycleAdapter,
  type UnityLifecycleSessionSelector,
} from '../src/devops/lib/unity-lifecycle.js';
import {
  createProject,
  installEditor,
  listAvailableReleases,
  listInstalledEditors,
  silentUnityHubOutput,
  type UnityHubOperationOptions,
  type UnityHubProcessAdapter,
} from '../src/devops/utils/unity-hub.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function officialUnavailable(): OfficialLifecycleAdapter {
  return {
    findUnityCli: vi.fn(() => null),
    getUnityCliVersion: vi.fn(() => null),
    listInstalledEditors: vi.fn(async () => []),
    listAvailableReleases: vi.fn(async () => []),
    installEditor: vi.fn(async () => undefined),
    createProject: vi.fn(async () => undefined),
  };
}

function successfulInstallProcess(): ChildProcessWithoutNullStreams {
  const processEmitter = new EventEmitter() as ChildProcessWithoutNullStreams;
  processEmitter.stdout = new PassThrough();
  processEmitter.stderr = new PassThrough();
  processEmitter.stdin = new PassThrough();
  queueMicrotask(() => {
    processEmitter.stdout.write('[Unity (6000.5.6f1)] downloading 50%\n');
    processEmitter.stdout.write('[Unity (6000.5.6f1)] installed successfully.\n');
    processEmitter.stdout.end();
    processEmitter.stderr.end();
    processEmitter.emit('close', 0, null);
  });
  return processEmitter;
}

function productionLikeHub(
  processAdapter: Partial<UnityHubProcessAdapter>,
): HubLifecycleAdapter {
  const withProcess = (options: UnityHubOperationOptions | undefined): UnityHubOperationOptions => ({
    ...options,
    processAdapter,
  });
  return {
    ensureUnityHub: vi.fn(async () => '/fake/UnityHub'),
    listInstalledEditors: (hubPath, options) => (
      listInstalledEditors(hubPath, withProcess(options))
    ),
    listAvailableReleases: (hubPath, options) => (
      listAvailableReleases(hubPath, withProcess(options))
    ),
    installEditor: (hubPath, version, releases, options) => (
      installEditor(hubPath, version, releases, withProcess(options))
    ),
    createProject: (hubPath, projectPath, version, options) => (
      createProject(hubPath, projectPath, version, withProcess(options))
    ),
  };
}

function forcedHubSelector(hub: HubLifecycleAdapter): UnityLifecycleSessionSelector {
  const router = createUnityLifecycleRouter({
    environment: { UCO_USE_UNITY_CLI: '0' },
    official: officialUnavailable(),
    hub,
  });
  return (options) => router.selectSession(options);
}

function captureJsonStreams(): {
  stdout: ReturnType<typeof vi.spyOn>;
  stderr: ReturnType<typeof vi.spyOn>;
} {
  return {
    stdout: vi.spyOn(process.stdout, 'write').mockImplementation(() => true),
    stderr: vi.spyOn(process.stderr, 'write').mockImplementation(() => true),
  };
}

describe('strict production Hub inventory', () => {
  it('keeps a genuine empty result as [] while throwing installed and release execution failures', () => {
    const emptyProcess: Partial<UnityHubProcessAdapter> = {
      execFileSync: vi.fn(() => '') as unknown as UnityHubProcessAdapter['execFileSync'],
    };
    const strictOptions: UnityHubOperationOptions = {
      output: silentUnityHubOutput,
      processAdapter: emptyProcess,
      strictInventory: true,
    };
    expect(listInstalledEditors('/fake/hub', strictOptions)).toEqual([]);
    expect(listAvailableReleases('/fake/hub', strictOptions)).toEqual([]);

    const failureProcess: Partial<UnityHubProcessAdapter> = {
      execFileSync: vi.fn(() => { throw new Error('spawn ENOENT'); }) as unknown as UnityHubProcessAdapter['execFileSync'],
    };
    expect(() => listInstalledEditors('/missing/hub', {
      ...strictOptions,
      processAdapter: failureProcess,
    })).toThrow('Failed to list installed Unity editors: spawn ENOENT');
    expect(() => listAvailableReleases('/missing/hub', {
      ...strictOptions,
      processAdapter: failureProcess,
    })).toThrow('Failed to list available Unity releases: spawn ENOENT');

    const malformedProcess: Partial<UnityHubProcessAdapter> = {
      execFileSync: vi.fn(() => 'unexpected Hub schema') as unknown as UnityHubProcessAdapter['execFileSync'],
    };
    expect(() => listInstalledEditors('/fake/hub', {
      ...strictOptions,
      processAdapter: malformedProcess,
    })).toThrow('could not be parsed');
    expect(() => listAvailableReleases('/fake/hub', {
      ...strictOptions,
      processAdapter: malformedProcess,
    })).toThrow('could not be parsed');
  });

  it('preserves the legacy [] fallback unless strict inventory is explicitly selected', () => {
    const processAdapter: Partial<UnityHubProcessAdapter> = {
      execFileSync: vi.fn(() => { throw new Error('legacy failure'); }) as unknown as UnityHubProcessAdapter['execFileSync'],
    };
    expect(listInstalledEditors('/missing/hub', {
      output: silentUnityHubOutput,
      processAdapter,
    })).toEqual([]);
    expect(listAvailableReleases('/missing/hub', {
      output: silentUnityHubOutput,
      processAdapter,
    })).toEqual([]);
  });
});

describe('Hub lifecycle JSON stdout discipline', () => {
  it('serializes a strict production inventory failure without partial stdout', async () => {
    const processAdapter: Partial<UnityHubProcessAdapter> = {
      execFileSync: vi.fn(() => { throw new Error('Hub inventory crashed'); }) as unknown as UnityHubProcessAdapter['execFileSync'],
    };
    const streams = captureJsonStreams();
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code ?? 0}`);
    }) as never);
    const program = new Command().exitOverride().option('--json');
    registerEditors(program, forcedHubSelector(productionLikeHub(processAdapter)));

    await expect(program.parseAsync(['node', 'uco', '--json', 'editors']))
      .rejects.toThrow('exit:1');
    expect(streams.stdout).not.toHaveBeenCalled();
    expect(streams.stderr).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(streams.stderr.mock.calls[0]?.[0]))).toMatchObject({
      ok: false,
      error: {
        code: 'unexpected-error',
        message: expect.stringContaining('Hub inventory crashed'),
        retryable: false,
      },
    });
  });

  it.each([
    ['installed', ['node', 'uco', '--json', 'editors']],
    ['releases', ['node', 'uco', '--json', 'editors', '--releases']],
  ] as const)('emits one JSON value for production %s inventory', async (_label, argv) => {
    const processAdapter: Partial<UnityHubProcessAdapter> = {
      execFileSync: vi.fn((_file, args) => (
        (args as readonly string[]).includes('--releases')
          ? '6000.5.6f1\n6000.6.0b2\n'
          : ''
      )) as unknown as UnityHubProcessAdapter['execFileSync'],
    };
    const streams = captureJsonStreams();
    const program = new Command().exitOverride().option('--json');
    registerEditors(program, forcedHubSelector(productionLikeHub(processAdapter)));

    await program.parseAsync([...argv]);

    expect(streams.stdout).toHaveBeenCalledTimes(1);
    expect(() => JSON.parse(String(streams.stdout.mock.calls[0]?.[0]))).not.toThrow();
    expect(streams.stderr).not.toHaveBeenCalled();
  });

  it('keeps Hub install spinner and parsed progress off JSON stdout', async () => {
    const processAdapter: Partial<UnityHubProcessAdapter> = {
      execFileSync: vi.fn((_file, args) => (
        (args as readonly string[]).includes('--installed')
          ? ''
          : '6000.5.6f1\n'
      )) as unknown as UnityHubProcessAdapter['execFileSync'],
      spawn: vi.fn((
        _command: string,
        _args: readonly string[],
        _options: SpawnOptionsWithoutStdio,
      ) => successfulInstallProcess()) as unknown as UnityHubProcessAdapter['spawn'],
    };
    const streams = captureJsonStreams();
    const program = new Command().exitOverride().option('--json');
    registerInstallUnity(program, forcedHubSelector(productionLikeHub(processAdapter)));

    await program.parseAsync(['node', 'uco', '--json', 'install-unity', '6000.5.6f1']);

    expect(streams.stdout).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(streams.stdout.mock.calls[0]?.[0]))).toMatchObject({
      installed: true,
      backend: 'unity-hub',
      hubPath: '/fake/UnityHub',
    });
    expect(streams.stderr).not.toHaveBeenCalled();
  });

  it('captures Hub editor creation output instead of inheriting process streams', async () => {
    const targetRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'uco-hub-create-'));
    temporaryDirectories.push(targetRoot);
    const projectPath = path.join(targetRoot, 'NeverCreatedByTest');
    const fakeEditorPath = path.join(targetRoot, 'Editor', 'Unity.exe');
    fs.mkdirSync(path.dirname(fakeEditorPath), { recursive: true });
    fs.writeFileSync(fakeEditorPath, 'not executed: process adapter captures the invocation');
    const runFile = vi.fn((_file: string, args: readonly string[]) => (
      args.includes('--installed')
        ? `6000.5.6f1 , installed at ${fakeEditorPath}\n`
        : 'fake editor output that must remain captured'
    ));
    const processAdapter: Partial<UnityHubProcessAdapter> = {
      execFileSync: runFile as unknown as UnityHubProcessAdapter['execFileSync'],
    };
    const streams = captureJsonStreams();
    const program = new Command().exitOverride().option('--json');
    registerCreateProject(program, forcedHubSelector(productionLikeHub(processAdapter)));

    await program.parseAsync([
      'node', 'uco', '--json', 'create-project', projectPath,
      '--unity', '6000.5.6f1', '--skip-plugin',
    ]);

    expect(streams.stdout).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(streams.stdout.mock.calls[0]?.[0]))).toMatchObject({
      created: true,
      projectPath,
      backend: 'unity-hub',
    });
    expect(streams.stderr).not.toHaveBeenCalled();
    expect(runFile.mock.calls[1]?.[2]).toMatchObject({
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    expect(fs.existsSync(projectPath)).toBe(false);
  });
});
