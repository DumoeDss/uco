import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  createOfficialLifecycleAdapter,
  createUnityLifecycleRouter,
  findHighestLifecycleEditor,
  findLatestStableLifecycleRelease,
  type HubLifecycleAdapter,
  type OfficialLifecycleAdapter,
} from '../src/devops/lib/unity-lifecycle.js';
import type {
  UnityCliProcessAdapter,
  UnityCliProcessRequest,
} from '../src/devops/utils/unity-cli.js';

function officialAdapter(path: string | null = '/tools/unity'): OfficialLifecycleAdapter {
  return {
    findUnityCli: vi.fn(() => path),
    getUnityCliVersion: vi.fn(() => '1.0.0-beta.3'),
    listInstalledEditors: vi.fn(async () => [{
      version: '6000.5.6f1',
      path: '/editors/6000.5.6f1/Unity',
      alias: 'latest',
      architecture: 'x86_64',
      modules: ['android'],
      isDefault: true,
    }]),
    listAvailableReleases: vi.fn(async () => [{
      version: '6000.5.6f1',
      alias: 'latest',
      architecture: 'x86_64',
      installedPath: '/editors/6000.5.6f1/Unity',
      isStable: true,
    }]),
    installEditor: vi.fn(async () => undefined),
    createProject: vi.fn(async () => undefined),
  };
}

function hubAdapter(): HubLifecycleAdapter {
  return {
    ensureUnityHub: vi.fn(async () => '/tools/UnityHub'),
    listInstalledEditors: vi.fn(() => [{
      version: '2022.3.62f3',
      path: '/editors/2022.3.62f3',
    }]),
    listAvailableReleases: vi.fn(() => [{ version: '2022.3.62f3', isStable: true }]),
    installEditor: vi.fn(async () => undefined),
    createProject: vi.fn(() => undefined),
  };
}

describe('Unity lifecycle policy', () => {
  it.each([
    [{}, '/tools/unity', 'unity-cli', 'auto-detected'],
    [{ UCO_USE_UNITY_CLI: '' }, null, 'unity-hub', 'auto-absent-fallback'],
    [{ UCO_USE_UNITY_CLI: 'auto' }, null, 'unity-hub', 'auto-absent-fallback'],
    [{ UCO_USE_UNITY_CLI: '1' }, null, 'unity-cli', 'required-by-flag'],
    [{ UCO_USE_UNITY_CLI: '0' }, '/tools/unity', 'unity-hub', 'forced-hub'],
  ] as const)('selects the policy table for %o', (environment, executable, backend, reason) => {
    const official = officialAdapter(executable);
    const hub = hubAdapter();
    const session = createUnityLifecycleRouter({ environment, official, hub }).selectSession();
    expect(session.backend).toBe(backend);
    expect(session.decision.reason).toBe(reason);
    expect(hub.ensureUnityHub).not.toHaveBeenCalled();
  });

  it('treats an explicit path as authoritative in auto even when discovery rejects it', async () => {
    const official = officialAdapter(null);
    vi.mocked(official.listInstalledEditors).mockRejectedValueOnce(new Error('invalid override'));
    const hub = hubAdapter();
    const session = createUnityLifecycleRouter({
      environment: { UNITY_CLI_PATH: '/missing/unity', PATH: '/valid' },
      official,
      hub,
    }).selectSession();

    expect(session.backend).toBe('unity-cli');
    expect(session.decision.reason).toBe('required-by-path-override');
    await expect(session.listInstalledEditors()).rejects.toThrow('invalid override');
    expect(hub.ensureUnityHub).not.toHaveBeenCalled();
    expect(hub.listInstalledEditors).not.toHaveBeenCalled();
  });

  it('lets forced Hub override an invalid official path', async () => {
    const official = officialAdapter(null);
    const hub = hubAdapter();
    const session = createUnityLifecycleRouter({
      environment: { UCO_USE_UNITY_CLI: '0', UNITY_CLI_PATH: '/missing/unity' },
      official,
      hub,
    }).selectSession();

    await expect(session.listInstalledEditors()).resolves.toHaveLength(1);
    expect(official.listInstalledEditors).not.toHaveBeenCalled();
    expect(hub.ensureUnityHub).toHaveBeenCalledTimes(1);
  });

  it('rejects invalid policy values before official or Hub discovery', () => {
    const official = officialAdapter();
    const hub = hubAdapter();
    const router = createUnityLifecycleRouter({
      environment: { UCO_USE_UNITY_CLI: 'yes' },
      official,
      hub,
    });

    expect(router.selectSession).toThrowError(expect.objectContaining({ code: 'invalid-unity-cli-policy' }));
    expect(official.findUnityCli).not.toHaveBeenCalled();
    expect(hub.ensureUnityHub).not.toHaveBeenCalled();
  });
});

describe('Unity lifecycle sessions', () => {
  it('pins an authoritative invalid override as unavailable for the selected session', async () => {
    const environment: NodeJS.ProcessEnv = { UNITY_CLI_PATH: 'missing-unity' };
    let runnable = false;
    const isRunnableFile = vi.fn(() => runnable);
    const processAdapter: UnityCliProcessAdapter = {
      run: vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 })),
      runSync: vi.fn(() => ({ stdout: '', stderr: '', exitCode: 0 })),
    };
    const official = createOfficialLifecycleAdapter({
      environment,
      isRunnableFile,
      processAdapter,
    });
    const session = createUnityLifecycleRouter({
      environment,
      official,
      hub: hubAdapter(),
    }).selectSession();

    expect(session.decision.reason).toBe('required-by-path-override');
    environment.UNITY_CLI_PATH = 'now-valid-unity';
    runnable = true;

    await expect(session.listInstalledEditors()).rejects.toMatchObject({
      kind: 'not-found',
      message: expect.stringContaining('missing-unity'),
    });
    expect(isRunnableFile).toHaveBeenCalledTimes(1);
    expect(processAdapter.run).not.toHaveBeenCalled();
  });

  it('pins every production official operation and version probe to the selected executable', async () => {
    const workingDirectory = process.cwd();
    const firstExecutable = path.resolve(workingDirectory, 'first', 'unity');
    const secondExecutable = path.resolve(workingDirectory, 'second', 'unity');
    const environment: NodeJS.ProcessEnv = { PATH: 'first' };
    let runnableExecutable = firstExecutable;
    const isRunnableFile = vi.fn((candidate: string) => candidate === runnableExecutable);
    const runRequests: UnityCliProcessRequest[] = [];
    const syncRequests: UnityCliProcessRequest[] = [];
    const processAdapter: UnityCliProcessAdapter = {
      async run(request) {
        runRequests.push(request);
        const data = request.args.includes('-i')
          ? [{
            version: '6000.5.6f1',
            location: '/editor/Unity',
            modules: '',
            default: false,
          }]
          : request.args.includes('-r')
            ? [{ version: '6000.5.6f1' }]
            : null;
        return {
          stdout: JSON.stringify({ success: true, command: 'test', data }),
          stderr: '',
          exitCode: 0,
        };
      },
      runSync(request) {
        syncRequests.push(request);
        return { stdout: '1.0.0-beta.3', stderr: '', exitCode: 0 };
      },
    };
    const official = createOfficialLifecycleAdapter({
      environment,
      platform: 'linux',
      cwd: () => workingDirectory,
      isRunnableFile,
      processAdapter,
    });
    const session = createUnityLifecycleRouter({
      environment,
      official,
      hub: hubAdapter(),
    }).selectSession();

    expect(session.unityCliPath).toBe(firstExecutable);
    environment.PATH = 'second';
    runnableExecutable = secondExecutable;

    await session.listInstalledEditors();
    await session.listAvailableReleases();
    await session.installEditor('6000.5.6f1');
    await session.createProject({
      projectPath: path.join(workingDirectory, 'Game'),
      editorVersion: '6000.5.6f1',
    });
    expect(session.getDiagnostics().officialVersion).toBe('1.0.0-beta.3');

    expect(runRequests).toHaveLength(4);
    expect(runRequests.every((request) => request.executable === firstExecutable)).toBe(true);
    expect(syncRequests).toHaveLength(1);
    expect(syncRequests[0]?.executable).toBe(firstExecutable);
    expect(runRequests.some((request) => request.executable === secondExecutable)).toBe(false);
    expect(isRunnableFile).toHaveBeenCalledTimes(1);
  });

  it('keeps the selected official backend sticky and never retries a failure through Hub', async () => {
    const official = officialAdapter();
    vi.mocked(official.installEditor).mockRejectedValueOnce(new Error('official timed out'));
    const hub = hubAdapter();
    const session = createUnityLifecycleRouter({ environment: {}, official, hub }).selectSession();

    await session.listInstalledEditors();
    await expect(session.installEditor('6000.5.6f1')).rejects.toThrow('official timed out');
    expect(official.findUnityCli).toHaveBeenCalledTimes(1);
    expect(hub.ensureUnityHub).not.toHaveBeenCalled();
    expect(hub.installEditor).not.toHaveBeenCalled();
  });

  it('lazily resolves Hub at most once for a selected session', async () => {
    const hub = hubAdapter();
    const session = createUnityLifecycleRouter({
      environment: {},
      official: officialAdapter(null),
      hub,
    }).selectSession();

    await session.listInstalledEditors();
    await session.listAvailableReleases();
    await session.installEditor('2022.3.62f3');
    expect(hub.ensureUnityHub).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{ modules: ['android'] }, '--module'],
    [{ architecture: 'arm64' as const }, '--architecture'],
    [{ changeset: '0123456789ab' }, '--changeset'],
    [{ childModules: false }, '--no-child-modules'],
    [{ force: true }, '--force'],
    [{ acceptEula: true }, '--accept-eula'],
    [{ resume: true }, '--resume'],
    [{ noElevate: true }, '--no-elevate'],
  ])('rejects Hub install option %s before resolving Hub', async (options, optionName) => {
    const hub = hubAdapter();
    const session = createUnityLifecycleRouter({
      environment: { UCO_USE_UNITY_CLI: '0' },
      official: officialAdapter(),
      hub,
    }).selectSession();

    await expect(session.installEditor('6000.5.6f1', options)).rejects.toMatchObject({
      code: 'unity-cli-required',
      message: expect.stringContaining(optionName),
    });
    expect(hub.ensureUnityHub).not.toHaveBeenCalled();
    expect(hub.installEditor).not.toHaveBeenCalled();
  });

  it.each(['template', 'architecture'] as const)(
    'rejects Hub project %s before resolving Hub',
    async (key) => {
      const hub = hubAdapter();
      const session = createUnityLifecycleRouter({
        environment: { UCO_USE_UNITY_CLI: '0' },
        official: officialAdapter(),
        hub,
      }).selectSession();
      const option = key === 'template'
        ? { template: 'com.unity.template.3d' }
        : { architecture: 'arm64' as const };

      await expect(session.createProject({
        projectPath: '/projects/Game',
        editorVersion: '6000.5.6f1',
        ...option,
      })).rejects.toMatchObject({ code: 'unity-cli-required' });
      expect(hub.ensureUnityHub).not.toHaveBeenCalled();
      expect(hub.createProject).not.toHaveBeenCalled();
    },
  );

  it('normalizes Hub records without fabricating official fields', async () => {
    const session = createUnityLifecycleRouter({
      environment: {},
      official: officialAdapter(null),
      hub: hubAdapter(),
    }).selectSession();

    await expect(session.listInstalledEditors()).resolves.toEqual([{
      version: '2022.3.62f3',
      path: '/editors/2022.3.62f3',
    }]);
    await expect(session.listAvailableReleases()).resolves.toEqual([{
      version: '2022.3.62f3',
      isStable: true,
    }]);
  });

  it('derives official project name and parent from one target and never requests open', async () => {
    const official = officialAdapter();
    const session = createUnityLifecycleRouter({ environment: {}, official, hub: hubAdapter() }).selectSession();
    const target = process.platform === 'win32' ? 'C:\\Projects\\MyGame' : '/Projects/MyGame';

    await session.createProject({
      projectPath: target,
      editorVersion: '6000.5.6f1',
      template: 'com.unity.template.3d',
      architecture: 'arm64',
    });
    expect(official.createProject).toHaveBeenCalledWith({
      name: 'MyGame',
      parent: process.platform === 'win32' ? 'C:\\Projects' : '/Projects',
      editorVersion: '6000.5.6f1',
      template: 'com.unity.template.3d',
      architecture: 'arm64',
    });
    expect(official.createProject).not.toHaveBeenCalledWith(expect.objectContaining({ open: true }));
  });

  it('rejects a filesystem root before either creation adapter', async () => {
    const official = officialAdapter();
    const hub = hubAdapter();
    const session = createUnityLifecycleRouter({ environment: {}, official, hub }).selectSession();
    await expect(session.createProject({ projectPath: process.platform === 'win32' ? 'C:\\' : '/' }))
      .rejects.toMatchObject({ code: 'invalid-project-path' });
    expect(official.createProject).not.toHaveBeenCalled();
    expect(hub.createProject).not.toHaveBeenCalled();
  });

  it('reports coherent diagnostics without changing the selected backend', () => {
    const official = officialAdapter('/tools/unity');
    const session = createUnityLifecycleRouter({
      environment: { UCO_USE_UNITY_CLI: '0' },
      official,
      hub: hubAdapter(),
    }).selectSession();
    expect(session.getDiagnostics()).toEqual({
      policy: 'hub',
      selectedBackend: 'unity-hub',
      selectionReason: 'forced-hub',
      overridePresent: false,
      officialAvailable: true,
      officialPath: '/tools/unity',
      officialVersion: '1.0.0-beta.3',
      fallback: false,
    });
    expect(official.getUnityCliVersion).toHaveBeenCalledTimes(1);
  });

  it('reports a failed bounded version probe as unavailable without changing selection', () => {
    const official = officialAdapter('/tools/unity');
    vi.mocked(official.getUnityCliVersion).mockReturnValueOnce(null);
    const session = createUnityLifecycleRouter({ environment: {}, official, hub: hubAdapter() }).selectSession();
    expect(session.getDiagnostics()).toMatchObject({
      selectedBackend: 'unity-cli',
      selectionReason: 'auto-detected',
      officialAvailable: true,
      officialPath: '/tools/unity',
      officialVersion: null,
      fallback: false,
    });
    expect(session.backend).toBe('unity-cli');
  });
});

describe('lifecycle version selection', () => {
  it('selects the numeric highest editor and highest stable release', () => {
    expect(findHighestLifecycleEditor([
      { version: '2022.3.9f1', path: '/old' },
      { version: '2022.3.62f3', path: '/new' },
    ])?.path).toBe('/new');
    expect(findLatestStableLifecycleRelease([
      { version: '6000.7.0b2', isStable: false },
      { version: '6000.3.9f1', isStable: true },
      { version: '6000.3.21f1', isStable: true },
    ])?.version).toBe('6000.3.21f1');
  });
});
