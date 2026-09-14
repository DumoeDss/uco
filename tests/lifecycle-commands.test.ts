import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  executeCreateProject,
  registerCreateProject,
} from '../src/commands/devops/create-project.js';
import { executeEditors, registerEditors } from '../src/commands/devops/editors.js';
import { registerDevopsCommands } from '../src/commands/devops/index.js';
import {
  executeInstallUnity,
  registerInstallUnity,
} from '../src/commands/devops/install-unity.js';
import type {
  LifecycleDecision,
  UnityLifecycleBackend,
  UnityLifecycleSession,
} from '../src/devops/lib/unity-lifecycle.js';
import { installPlugin } from '../src/devops/lib/install-plugin.js';
import {
  addPluginToManifest,
  inspectPluginManifest,
} from '../src/devops/utils/manifest.js';
import { UnityCliError } from '../src/devops/utils/unity-cli.js';

function fakeSession(
  backend: UnityLifecycleBackend = 'unity-cli',
  overrides: Partial<UnityLifecycleSession> = {},
): UnityLifecycleSession {
  const decision: LifecycleDecision = {
    policy: backend === 'unity-cli' ? 'required' : 'hub',
    reason: backend === 'unity-cli' ? 'required-by-flag' : 'forced-hub',
    overridePresent: false,
    officialAvailable: backend === 'unity-cli',
    ...(backend === 'unity-cli' ? { officialPath: '/tools/unity' } : {}),
    fallback: false,
  };
  return {
    backend,
    decision,
    unityCliPath: backend === 'unity-cli' ? '/tools/unity' : undefined,
    hubPath: backend === 'unity-hub' ? '/tools/UnityHub' : undefined,
    validateInstallOptions: vi.fn(),
    validateCreateOptions: vi.fn(),
    listInstalledEditors: vi.fn(async () => []),
    listAvailableReleases: vi.fn(async () => []),
    installEditor: vi.fn(async () => undefined),
    createProject: vi.fn(async () => undefined),
    getDiagnostics: vi.fn(() => ({
      policy: decision.policy,
      selectedBackend: backend,
      selectionReason: decision.reason,
      overridePresent: false,
      officialAvailable: decision.officialAvailable,
      officialPath: decision.officialPath ?? null,
      officialVersion: backend === 'unity-cli' ? '1.0.0-beta.3' : null,
      fallback: decision.fallback,
    })),
    ...overrides,
  };
}

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'uco-lifecycle-command-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('install-unity lifecycle command', () => {
  it('keeps positional version ahead of a project path and avoids release lookup', async () => {
    const session = fakeSession();
    const result = await executeInstallUnity('6000.5.6f1', { path: '/definitely/missing' }, session);
    expect(session.listAvailableReleases).not.toHaveBeenCalled();
    expect(session.installEditor).toHaveBeenCalledWith('6000.5.6f1', {});
    expect(result).toMatchObject({
      installed: true,
      version: '6000.5.6f1',
      backend: 'unity-cli',
      unityCliPath: '/tools/unity',
    });
  });

  it('reads a project version before querying latest releases', async () => {
    const project = temporaryDirectory();
    fs.mkdirSync(path.join(project, 'ProjectSettings'));
    fs.writeFileSync(
      path.join(project, 'ProjectSettings', 'ProjectVersion.txt'),
      'm_EditorVersion: 2022.3.62f3\n',
    );
    const session = fakeSession();
    await executeInstallUnity(undefined, { path: project }, session);
    expect(session.listAvailableReleases).not.toHaveBeenCalled();
    expect(session.installEditor).toHaveBeenCalledWith('2022.3.62f3', {});
  });

  it('selects the highest stable release from the same session', async () => {
    const session = fakeSession('unity-cli', {
      listAvailableReleases: vi.fn(async () => [
        { version: '6000.6.0b1', isStable: false },
        { version: '6000.3.9f1', isStable: true },
        { version: '6000.3.21f1', isStable: true },
      ]),
    });
    await executeInstallUnity(undefined, {}, session);
    expect(session.installEditor).toHaveBeenCalledWith('6000.3.21f1', {
      prefetchedReleases: await session.listAvailableReleases(),
    });
  });

  it('preserves the already-present short circuit without modifiers', async () => {
    const session = fakeSession('unity-cli', {
      listInstalledEditors: vi.fn(async () => [{ version: '6000.5.6f1', path: '/editor/Unity' }]),
    });
    const result = await executeInstallUnity('6000.5.6f1', {}, session);
    expect(session.installEditor).not.toHaveBeenCalled();
    expect(result).toEqual({
      installed: false,
      alreadyPresent: true,
      version: '6000.5.6f1',
      path: '/editor/Unity',
      backend: 'unity-cli',
      unityCliPath: '/tools/unity',
    });
  });

  it('runs official modifiers for an existing editor and reports the operation', async () => {
    const session = fakeSession('unity-cli', {
      listInstalledEditors: vi.fn(async () => [{ version: '6000.5.6f1', path: '/editor/Unity' }]),
    });
    const result = await executeInstallUnity('6000.5.6f1', {
      modules: ['android'],
      architecture: 'arm64',
      childModules: false,
      force: true,
      acceptEula: true,
      resume: true,
      noElevate: true,
    }, session);
    expect(session.installEditor).toHaveBeenCalledTimes(1);
    expect(session.installEditor).toHaveBeenCalledWith('6000.5.6f1', {
      modules: ['android'],
      architecture: 'arm64',
      childModules: false,
      force: true,
      acceptEula: true,
      resume: true,
      noElevate: true,
    });
    expect(result).toMatchObject({
      installed: false,
      alreadyPresent: true,
      operationPerformed: true,
      updatedExisting: true,
      modulesRequested: ['android'],
    });
  });

  it('validates Hub options before listing editors or resolving a backend path', async () => {
    const error = new Error('official option required');
    const session = fakeSession('unity-hub', {
      validateInstallOptions: vi.fn(() => { throw error; }),
    });
    await expect(executeInstallUnity('6000.5.6f1', { modules: ['android'] }, session))
      .rejects.toBe(error);
    expect(session.listInstalledEditors).not.toHaveBeenCalled();
    expect(session.installEditor).not.toHaveBeenCalled();
  });

  it('does not double execute after an official failure', async () => {
    const error = new UnityCliError({ kind: 'timeout' });
    const session = fakeSession('unity-cli', {
      installEditor: vi.fn(async () => { throw error; }),
    });
    await expect(executeInstallUnity('6000.5.6f1', {}, session)).rejects.toBe(error);
    expect(session.installEditor).toHaveBeenCalledTimes(1);
  });

  it('parses official options and emits one compatible JSON result', async () => {
    const session = fakeSession();
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const program = new Command().exitOverride().option('--json');
    registerInstallUnity(program, () => session);
    await program.parseAsync([
      'node', 'uco', '--json', 'install-unity', '6000.5.6f1',
      '--module', 'android', 'webgl', '--architecture', 'arm64',
      '--changeset', '0123456789ab', '--no-child-modules', '--force',
      '--accept-eula', '--resume', '--no-elevate',
    ]);

    expect(session.installEditor).toHaveBeenCalledWith('6000.5.6f1', {
      modules: ['android', 'webgl'],
      architecture: 'arm64',
      changeset: '0123456789ab',
      childModules: false,
      force: true,
      acceptEula: true,
      resume: true,
      noElevate: true,
    });
    expect(stdout).toHaveBeenCalledTimes(1);
    const result = JSON.parse(String(stdout.mock.calls[0]?.[0]));
    expect(result).toMatchObject({ installed: true, version: '6000.5.6f1', backend: 'unity-cli' });
    expect(result).not.toHaveProperty('hubPath');
  });
});

describe('create-project lifecycle command', () => {
  it('uses an explicit editor without inventory and preserves official metadata', async () => {
    const session = fakeSession();
    const pluginInstaller = vi.fn(async () => ({
      kind: 'success' as const,
      success: true as const,
      installedVersion: '0.73.0',
      manifestPath: path.resolve('games/MyGame/Packages/manifest.json'),
      modified: true,
      warnings: [],
      nextSteps: [],
    }));
    const result = await executeCreateProject('games/MyGame', {
      unity: '6000.5.6f1',
      template: 'com.unity.template.3d',
      architecture: 'arm64',
    }, session, pluginInstaller);
    const projectPath = path.resolve('games/MyGame');
    expect(session.listInstalledEditors).not.toHaveBeenCalled();
    expect(session.createProject).toHaveBeenCalledWith({
      projectPath,
      editorVersion: '6000.5.6f1',
      template: 'com.unity.template.3d',
      architecture: 'arm64',
    });
    expect(result).toEqual({
      created: true,
      projectPath,
      editorVersion: '6000.5.6f1',
      backend: 'unity-cli',
      unityCliPath: '/tools/unity',
      plugin: {
        status: 'installed',
        packageId: 'com.atelierai.unity.copilot',
        version: '0.73.0',
        manifestPath: path.resolve('games/MyGame/Packages/manifest.json'),
        modified: true,
      },
    });
    expect(pluginInstaller).toHaveBeenCalledWith({ unityProjectPath: projectPath });
  });

  it('selects the highest installed editor and preserves Hub metadata', async () => {
    const session = fakeSession('unity-hub', {
      listInstalledEditors: vi.fn(async () => [
        { version: '2022.3.9f1', path: '/old' },
        { version: '2022.3.62f3', path: '/new' },
      ]),
    });
    const result = await executeCreateProject('MyGame', { skipPlugin: true }, session);
    expect(session.createProject).toHaveBeenCalledWith({
      projectPath: path.resolve('MyGame'),
      editorVersion: '2022.3.62f3',
    });
    expect(result).toMatchObject({
      created: true,
      editorVersion: '2022.3.62f3',
      backend: 'unity-hub',
      hubPath: '/tools/UnityHub',
      plugin: { status: 'skipped', packageId: 'com.atelierai.unity.copilot' },
    });
    expect(result).not.toHaveProperty('unityCliPath');
  });

  it('keeps the existing no-editor error', async () => {
    await expect(executeCreateProject('MyGame', {}, fakeSession()))
      .rejects.toMatchObject({ code: 'no-editors' });
  });

  it('validates Hub template options before inventory or project mutation', async () => {
    const error = new Error('official option required');
    const session = fakeSession('unity-hub', {
      validateCreateOptions: vi.fn(() => { throw error; }),
    });
    await expect(executeCreateProject('MyGame', { template: '3d' }, session)).rejects.toBe(error);
    expect(session.listInstalledEditors).not.toHaveBeenCalled();
    expect(session.createProject).not.toHaveBeenCalled();
  });

  it('parses project options and emits one compatible JSON result', async () => {
    const session = fakeSession();
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const program = new Command().exitOverride().option('--json');
    registerCreateProject(program, () => session);
    await program.parseAsync([
      'node', 'uco', '--json', 'create-project', 'MyGame',
      '--unity', '6000.5.6f1', '--template', 'com.unity.template.3d',
      '--architecture', 'x86_64', '--skip-plugin',
    ]);
    expect(stdout).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(stdout.mock.calls[0]?.[0]))).toMatchObject({
      created: true,
      editorVersion: '6000.5.6f1',
      backend: 'unity-cli',
      plugin: { status: 'skipped' },
    });
  });

  it('forwards an exact plugin version after creation and skips latest lookup semantics', async () => {
    const session = fakeSession();
    const pluginInstaller = vi.fn(async () => ({
      kind: 'success' as const,
      success: true as const,
      installedVersion: '1.2.3',
      manifestPath: '/game/Packages/manifest.json',
      modified: false,
      warnings: [],
      nextSteps: [],
    }));
    const result = await executeCreateProject('MyGame', {
      unity: '6000.5.6f1',
      pluginVersion: ' 1.2.3 ',
    }, session, pluginInstaller);
    expect(session.createProject).toHaveBeenCalledTimes(1);
    expect(pluginInstaller).toHaveBeenCalledWith({
      unityProjectPath: path.resolve('MyGame'),
      version: '1.2.3',
    });
    expect(result).toMatchObject({ plugin: { version: '1.2.3', modified: false } });
  });

  it.each([
    { skipPlugin: true, pluginVersion: '1.2.3' },
    { pluginVersion: '   ' },
  ])('rejects invalid plugin options before inventory or project mutation: %j', async (options) => {
    const session = fakeSession();
    const pluginInstaller = vi.fn();
    await expect(executeCreateProject('MyGame', options, session, pluginInstaller))
      .rejects.toBeInstanceOf(Error);
    expect(session.validateCreateOptions).not.toHaveBeenCalled();
    expect(session.listInstalledEditors).not.toHaveBeenCalled();
    expect(session.createProject).not.toHaveBeenCalled();
    expect(pluginInstaller).not.toHaveBeenCalled();
  });

  it('does not install a plugin when lifecycle creation fails', async () => {
    const creationError = new Error('official create failed');
    const session = fakeSession('unity-cli', {
      createProject: vi.fn(async () => { throw creationError; }),
    });
    const pluginInstaller = vi.fn();
    await expect(executeCreateProject('MyGame', {
      unity: '6000.5.6f1',
    }, session, pluginInstaller)).rejects.toBe(creationError);
    expect(session.createProject).toHaveBeenCalledTimes(1);
    expect(pluginInstaller).not.toHaveBeenCalled();
  });

  it('reports plugin failure as retained-project partial state without retrying creation', async () => {
    const session = fakeSession();
    const pluginInstaller = vi.fn(async () => ({
      kind: 'failure' as const,
      success: false as const,
      warnings: [],
      nextSteps: [],
      error: new Error('registry offline'),
    }));
    await expect(executeCreateProject('MyGame', {
      unity: '6000.5.6f1',
      pluginVersion: '1.2.3',
    }, session, pluginInstaller)).rejects.toMatchObject({
      code: 'project-created-plugin-install-failed',
      projectPath: path.resolve('MyGame'),
      packageId: 'com.atelierai.unity.copilot',
      retryCommand: expect.stringContaining('install-plugin'),
    });
    expect(session.createProject).toHaveBeenCalledTimes(1);
    expect(pluginInstaller).toHaveBeenCalledTimes(1);
  });

  it('keeps a newly created project manifest byte-for-byte unchanged for malformed registry data', async () => {
    const project = temporaryDirectory();
    const packages = path.join(project, 'Packages');
    fs.mkdirSync(packages);
    const manifestPath = path.join(packages, 'manifest.json');
    const original = '{\n  "dependencies": { "com.example.keep": "1.0.0" },\n  "custom": true\n}\n';
    fs.writeFileSync(manifestPath, original);
    const addToManifest = vi.fn((projectPath: string, version: string, force: boolean) => (
      addPluginToManifest(projectPath, version, force)
    ));
    const pluginInstaller = (options: Parameters<typeof installPlugin>[0]) => installPlugin(options, {
      resolveLatestVersion: vi.fn(async () => ({ malicious: true }) as unknown as Promise<string>),
      inspectManifest: inspectPluginManifest,
      addToManifest,
    });
    const session = fakeSession();
    await expect(executeCreateProject(project, {
      unity: '6000.5.6f1',
    }, session, pluginInstaller)).rejects.toMatchObject({
      code: 'project-created-plugin-install-failed',
      projectPath: project,
    });
    expect(session.createProject).toHaveBeenCalledTimes(1);
    expect(addToManifest).not.toHaveBeenCalled();
    expect(fs.readFileSync(manifestPath, 'utf8')).toBe(original);
  });

  it('emits exactly one structured JSON error and no stdout after partial failure', async () => {
    const session = fakeSession();
    const pluginInstaller = vi.fn(async () => ({
      kind: 'failure' as const,
      success: false as const,
      warnings: [],
      nextSteps: [],
      error: new Error('manifest replace failed'),
    }));
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code ?? 0}`);
    }) as never);
    const program = new Command().exitOverride().option('--json');
    registerCreateProject(program, () => session, pluginInstaller);
    await expect(program.parseAsync([
      'node', 'uco', '--json', 'create-project', 'MyGame', '--unity', '6000.5.6f1',
    ])).rejects.toThrow('exit:1');
    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(stderr.mock.calls[0]?.[0]))).toMatchObject({
      ok: false,
      error: {
        code: 'project-created-plugin-install-failed',
        retryable: false,
        details: {
          kind: 'project-created-plugin-install-failed',
          projectCreated: true,
          packageId: 'com.atelierai.unity.copilot',
          cause: 'manifest replace failed',
        },
      },
    });
  });
});

describe('editors command', () => {
  it('returns installed inventory by default and releases exclusively when requested', async () => {
    const session = fakeSession('unity-cli', {
      listInstalledEditors: vi.fn(async () => [{
        version: '6000.5.6f1',
        path: '/editor/Unity',
        alias: 'latest',
        architecture: 'x86_64',
        modules: ['android'],
        isDefault: true,
      }]),
      listAvailableReleases: vi.fn(async () => [{ version: '6000.5.6f1', isStable: true }]),
    });
    const installed = await executeEditors({}, session);
    expect(installed).toHaveProperty('editors');
    expect(installed).not.toHaveProperty('releases');
    const releases = await executeEditors({ releases: true }, session);
    expect(releases).toEqual({
      backend: 'unity-cli',
      releases: [{ version: '6000.5.6f1', isStable: true }],
    });
    expect(releases).not.toHaveProperty('editors');
  });

  it('adds diagnostics without changing inventory selection', async () => {
    const session = fakeSession('unity-hub');
    const result = await executeEditors({ diagnostics: true }, session);
    expect(result).toMatchObject({
      backend: 'unity-hub',
      editors: [],
      diagnostics: {
        policy: 'hub',
        selectedBackend: 'unity-hub',
        selectionReason: 'forced-hub',
      },
    });
    expect(session.listInstalledEditors).toHaveBeenCalledTimes(1);
    expect(session.listAvailableReleases).not.toHaveBeenCalled();
  });

  it('emits exactly one JSON object with no hint noise on stdout', async () => {
    const session = fakeSession('unity-hub', {
      decision: {
        policy: 'auto',
        reason: 'auto-absent-fallback',
        overridePresent: false,
        officialAvailable: false,
        fallback: true,
      },
    });
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const program = new Command().exitOverride().option('--json');
    registerEditors(program, () => session);
    await program.parseAsync(['node', 'uco', '--json', 'editors', '--diagnostics']);
    expect(stdout).toHaveBeenCalledTimes(1);
    expect(() => JSON.parse(String(stdout.mock.calls[0]?.[0]))).not.toThrow();
    expect(stderr).not.toHaveBeenCalled();
  });

  it('preserves structured official errors on JSON stderr without partial stdout', async () => {
    const officialError = new UnityCliError({
      kind: 'command-failed',
      officialCommand: 'editors',
      officialErrors: [{ code: 'BROKEN', message: 'inventory rejected' }],
    });
    const session = fakeSession('unity-cli', {
      listInstalledEditors: vi.fn(async () => { throw officialError; }),
    });
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code ?? 0}`);
    }) as never);
    const program = new Command().exitOverride().option('--json');
    registerEditors(program, () => session);

    await expect(program.parseAsync(['node', 'uco', '--json', 'editors']))
      .rejects.toThrow('exit:1');
    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(stderr.mock.calls[0]?.[0]))).toMatchObject({
      ok: false,
      error: {
        code: 'unity-cli-command-failed',
        retryable: false,
        details: {
          kind: 'command-failed',
          officialCommand: 'editors',
          officialErrors: [{ code: 'BROKEN', message: 'inventory rejected' }],
        },
      },
    });
  });

  it('registers editors plus the official build/test commands but not doctor', () => {
    const program = new Command();
    registerDevopsCommands(program);
    const names = program.commands.map((command) => command.name());
    expect(names).toContain('editors');
    expect(names).toContain('build');
    expect(names).toContain('test');
    expect(names).not.toContain('doctor');
    expect(program.helpInformation()).toContain('editors');
    expect(program.helpInformation()).toContain('build');
    expect(program.helpInformation()).toContain('test');
  });
});
