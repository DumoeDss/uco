import * as path from 'node:path';
import { EventEmitter } from 'node:events';
import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  executeBuild,
  registerBuild,
  type BuildCommandOptions,
  type UnityBuildClient,
} from '../src/commands/devops/build.js';
import { executeTest, registerTest, type UnityTestClient } from '../src/commands/devops/test.js';
import {
  parsePositiveBase10Integer,
  requireAndroidKeystoreDependencies,
  requireNonEmpty,
  requireOneOf,
  resolveUnityOperationProject,
  withOperationCancellation,
} from '../src/commands/devops/_unity-operations.js';
import {
  UNITY_CLI_MAX_TEST_TIMEOUT_SECONDS,
  UnityCliError,
} from '../src/devops/utils/unity-cli.js';

function fakeBuildClient(result: unknown = { built: true }): UnityBuildClient {
  return { buildProjectU: vi.fn(async () => result) };
}

function fakeTestClient(result: unknown = { passed: 1 }): UnityTestClient {
  return { testProjectU: vi.fn(async () => result) };
}

function rootProgram(): Command {
  return new Command()
    .exitOverride()
    .option('-P, --project <path>')
    .option('-u, --url <url>')
    .option('-t, --token <token>')
    .option('-j, --json')
    .option('-v, --verbose')
    .option('--timeout <ms>', 'REST timeout in milliseconds', '60000');
}

function withRequiredBuildOptions(tokens: readonly string[]): string[] {
  const argv = [...tokens];
  const buildIndex = argv.indexOf('build');
  argv.splice(buildIndex + 1, 0, '--target', 'WebGL', '--execute-method', 'Build.Perform');
  return argv;
}

interface CommanderBuildSnapshot {
  root: Record<string, unknown>;
  command: Record<string, unknown>;
}

async function parseWithCommanderBuildControl(tokens: readonly string[]): Promise<CommanderBuildSnapshot> {
  const program = rootProgram();
  let snapshot: CommanderBuildSnapshot | undefined;
  program
    .command('build [project]')
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .option('--target <target>')
    .option('--execute-method <method>')
    .option('-o, --output-path <path>')
    .option('-l, --log-file <path>')
    .option('-e, --editor-path <path>')
    .option('-a, --architecture <architecture>')
    .action(function (this: Command, _project: string | undefined, options: Record<string, unknown>) {
      snapshot = { root: { ...program.opts() }, command: { ...options } };
    });
  await program.parseAsync(['node', 'uco', ...tokens]);
  if (snapshot === undefined) throw new Error('Commander control did not select build.');
  return snapshot;
}

function captureOutput(): {
  stdout: ReturnType<typeof vi.spyOn>;
  stderr: ReturnType<typeof vi.spyOn>;
} {
  return {
    stdout: vi.spyOn(process.stdout, 'write').mockImplementation(() => true),
    stderr: vi.spyOn(process.stderr, 'write').mockImplementation(() => true),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('shared build/test command helpers', () => {
  it('resolves positional, root project, and cwd in precedence order', () => {
    const cwd = path.resolve('workspace');
    expect(resolveUnityOperationProject('positional', 'root', cwd)).toBe(path.resolve(cwd, 'positional'));
    expect(resolveUnityOperationProject(undefined, 'root', cwd)).toBe(path.resolve(cwd, 'root'));
    expect(resolveUnityOperationProject(undefined, undefined, cwd)).toBe(cwd);
  });

  it('preserves usable values and rejects empty values', () => {
    expect(requireNonEmpty(' value ', '--value')).toBe(' value ');
    expect(() => requireNonEmpty('  ', '--value')).toThrow('--value');
    expect(() => resolveUnityOperationProject(' ', '/root')).toThrow('Unity project');
  });

  it('validates enums and positive base-10 integers without Unity semantics', () => {
    expect(requireOneOf('arm64', ['x86_64', 'arm64'] as const, '--architecture')).toBe('arm64');
    expect(() => requireOneOf('universal', ['x86_64', 'arm64'] as const, '--architecture')).toThrow();
    expect(parsePositiveBase10Integer('0042', '--code')).toBe(42);
    for (const invalid of ['0', '-1', '1.5', '1e2', 'Infinity', 'abc']) {
      expect(() => parsePositiveBase10Integer(invalid, '--code')).toThrow();
    }
  });

  it('requires password and alias only when a keystore payload is supplied', () => {
    expect(() => requireAndroidKeystoreDependencies({})).not.toThrow();
    expect(() => requireAndroidKeystoreDependencies({
      androidKeystoreBase64: 'payload', androidKeystorePassword: 'password', androidKeyAlias: 'release',
    })).not.toThrow();
    expect(() => requireAndroidKeystoreDependencies({ androidKeystoreBase64: 'payload' }))
      .toThrow('--android-keystore-base64 requires');
  });

  it.each(['success', 'failure'] as const)('removes both signal listeners after %s', async (outcome) => {
    const host = new EventEmitter();
    const controller = new AbortController();
    const operation = outcome === 'success'
      ? async () => 'done'
      : async () => { throw new Error('failed'); };
    const action = withOperationCancellation(controller, operation, host);
    if (outcome === 'success') await expect(action).resolves.toBe('done');
    else await expect(action).rejects.toThrow('failed');
    expect(host.listenerCount('SIGINT')).toBe(0);
    expect(host.listenerCount('SIGTERM')).toBe(0);
  });

  it('aborts a supplied controller once and cleans listeners after interrupt', async () => {
    const host = new EventEmitter();
    const controller = new AbortController();
    const aborts = vi.fn();
    controller.signal.addEventListener('abort', aborts);
    const action = withOperationCancellation(controller, async () => {
      host.emit('SIGINT');
      host.emit('SIGTERM');
      return controller.signal.aborted;
    }, host);
    await expect(action).resolves.toBe(true);
    expect(aborts).toHaveBeenCalledTimes(1);
    expect(host.listenerCount('SIGINT')).toBe(0);
    expect(host.listenerCount('SIGTERM')).toBe(0);
  });
});

describe('build command', () => {
  it('maps the complete command surface, keeps paths/args unchanged, and forwards one signal', async () => {
    const client = fakeBuildClient();
    const controller = new AbortController();
    const result = await executeBuild('games/My Game', {
      target: 'FutureTarget', executeMethod: 'Build.Perform', buildTargetGroup: 'FutureGroup',
      outputPath: 'Builds/My Game', logFile: 'Logs/build.log', editorVersion: '6000.5.6f1',
      editorPath: 'relative/Unity', architecture: 'arm64', args: '--one "two words"',
      allowInstall: true, tail: false, androidExportType: 'aab',
      androidKeystoreBase64: 'payload', androidKeystorePassword: 'password',
      androidKeyAlias: 'release', androidKeyAliasPassword: 'alias-password',
      androidTargetSdkVersion: '35', androidSymbolType: 'public', androidVersionCode: '9',
      versioningStrategy: 'custom', buildVersion: '1.2.3', allowDirtyBuild: true,
    }, '/ignored-root', client, { controller, signalHost: new EventEmitter() });

    expect(result).toEqual({ built: true });
    expect(client.buildProjectU).toHaveBeenCalledTimes(1);
    expect(client.buildProjectU).toHaveBeenCalledWith({
      project: path.resolve('games/My Game'),
      target: 'FutureTarget', executeMethod: 'Build.Perform', buildTargetGroup: 'FutureGroup',
      outputPath: 'Builds/My Game', logFile: 'Logs/build.log', editorVersion: '6000.5.6f1',
      editorPath: 'relative/Unity', architecture: 'arm64', args: '--one "two words"',
      allowInstall: true, noTail: true, androidExportType: 'aab',
      androidKeystoreBase64: 'payload', androidKeystorePassword: 'password',
      androidKeyAlias: 'release', androidKeyAliasPassword: 'alias-password',
      androidTargetSdkVersion: 35, androidSymbolType: 'public', androidVersionCode: 9,
      versioningStrategy: 'custom', buildVersion: '1.2.3', allowDirtyBuild: true,
    }, { signal: controller.signal });
  });

  it('uses root/default project and does not read a REST timeout', async () => {
    const rootClient = fakeBuildClient();
    await executeBuild(undefined, { target: 'WebGL', executeMethod: 'Build.Perform' }, 'root-project', rootClient);
    expect(rootClient.buildProjectU).toHaveBeenCalledWith(
      expect.objectContaining({ project: path.resolve('root-project') }),
      expect.anything(),
    );

    const defaultClient = fakeBuildClient();
    await executeBuild(undefined, { target: 'WebGL', executeMethod: 'Build.Perform' }, undefined, defaultClient);
    expect(defaultClient.buildProjectU).toHaveBeenCalledWith(
      expect.objectContaining({ project: process.cwd() }),
      expect.anything(),
    );
  });

  it.each([
    [{ executeMethod: 'Build.Perform' }, '--target'],
    [{ target: 'Android' }, '--execute-method'],
    [{ target: 'Android', executeMethod: 'Build.Perform', architecture: 'universal' }, '--architecture'],
    [{ target: 'Android', executeMethod: 'Build.Perform', androidExportType: 'zip' }, '--android-export-type'],
    [{ target: 'Android', executeMethod: 'Build.Perform', androidSymbolType: 'all' }, '--android-symbol-type'],
    [{ target: 'Android', executeMethod: 'Build.Perform', versioningStrategy: 'automatic' }, '--versioning-strategy'],
    [{ target: 'Android', executeMethod: 'Build.Perform', androidVersionCode: '0' }, '--android-version-code'],
    [{ target: 'Android', executeMethod: 'Build.Perform', androidTargetSdkVersion: '3.5' }, '--android-target-sdk-version'],
    [{ target: 'Android', executeMethod: 'Build.Perform', androidKeystoreBase64: 'secret' }, '--android-keystore-base64'],
  ])('rejects invalid input before adapter invocation: %s', async (options, message) => {
    const client = fakeBuildClient();
    await expect(executeBuild(undefined, options, '/project', client)).rejects.toThrow(message);
    expect(client.buildProjectU).not.toHaveBeenCalled();
  });

  it('emits direct official data in JSON and human modes', async () => {
    for (const json of [true, false]) {
      const client = fakeBuildClient({ artifact: 'Build/game' });
      const output = captureOutput();
      const program = rootProgram();
      registerBuild(program, client);
      await program.parseAsync([
        'node', 'uco', ...(json ? ['--json'] : []),
        'build', '--target', 'WebGL', '--execute-method', 'Build.Perform',
      ]);
      expect(output.stdout).toHaveBeenCalledTimes(1);
      expect(JSON.parse(String(output.stdout.mock.calls[0]?.[0]))).toEqual({ artifact: 'Build/game' });
      expect(output.stderr).not.toHaveBeenCalled();
      vi.restoreAllMocks();
    }
  });

  it('parses every build flag and keeps positional project ahead of root project', async () => {
    const client = fakeBuildClient();
    captureOutput();
    const program = rootProgram();
    registerBuild(program, client);
    await program.parseAsync([
      'node', 'uco', '--project', 'root-game', 'build', 'positional-game',
      '--target', 'Android', '--execute-method', 'Build.Perform',
      '--build-target-group', 'Android', '-o', 'Builds/game.aab', '-l', 'Logs/build.log',
      '--editor-version', '6000.5.6f1', '-e', 'relative/Unity', '-a', 'arm64',
      '--args', '--opaque one value', '--allow-install', '--no-tail',
      '--android-export-type', 'aab', '--android-keystore-base64', 'payload',
      '--android-keystore-password', 'password', '--android-key-alias', 'release',
      '--android-key-alias-password', 'alias-password', '--android-target-sdk-version', '35',
      '--android-symbol-type', 'debugging', '--android-version-code', '7',
      '--versioning-strategy', 'custom', '--build-version', '2.0.0', '--allow-dirty-build',
    ]);
    expect(client.buildProjectU).toHaveBeenCalledWith(expect.objectContaining({
      project: path.resolve('positional-game'), target: 'Android', executeMethod: 'Build.Perform',
      buildTargetGroup: 'Android', outputPath: 'Builds/game.aab', logFile: 'Logs/build.log',
      editorVersion: '6000.5.6f1', editorPath: 'relative/Unity', architecture: 'arm64',
      args: '--opaque one value', allowInstall: true, noTail: true,
      androidExportType: 'aab', androidKeystoreBase64: 'payload',
      androidKeystorePassword: 'password', androidKeyAlias: 'release',
      androidKeyAliasPassword: 'alias-password', androidTargetSdkVersion: 35,
      androidSymbolType: 'debugging', androidVersionCode: 7,
      versioningStrategy: 'custom', buildVersion: '2.0.0', allowDirtyBuild: true,
    }), expect.anything());
  });

  it.each([
    ['separate', ['--args', '--json'], '--json'],
    ['separate format', ['--args', '--format=something'], '--format=something'],
    ['separate non-interactive', ['--args', '--non-interactive'], '--non-interactive'],
    ['separate no-tail', ['--args', '--no-tail'], '--no-tail'],
    ['attached JSON', ['--args=--json'], '--json'],
    ['attached format', ['--args=--format=something'], '--format=something'],
    ['attached non-interactive', ['--args=--non-interactive'], '--non-interactive'],
    ['attached forced flag', ['--args=--no-tail'], '--no-tail'],
    ['separate child flag', ['--args', '--allow-install'], '--allow-install'],
    ['separate root cluster', ['--args', '-jv'], '-jv'],
    ['separate compact root value', ['--args', '-jPgame'], '-jPgame'],
  ])('preserves %s opaque build arguments through Commander', async (_label, argumentTokens, expected) => {
    const client = fakeBuildClient();
    captureOutput();
    const program = rootProgram();
    registerBuild(program, client);
    await program.parseAsync([
      'node', 'uco', 'build', '--target', 'WebGL',
      '--execute-method', 'Build.Perform', ...argumentTokens,
    ]);
    expect(client.buildProjectU).toHaveBeenCalledWith(
      expect.objectContaining({ args: expected }),
      expect.anything(),
    );
    if (expected === '--allow-install') {
      expect(client.buildProjectU).toHaveBeenCalledWith(
        expect.not.objectContaining({ allowInstall: true }),
        expect.anything(),
      );
    }
    if (expected === '-jv' || expected === '-jPgame') {
      expect(program.opts()).not.toMatchObject({ json: true });
      expect(program.opts()).not.toMatchObject({ verbose: true });
      expect(program.opts().project).toBeUndefined();
    }
  });

  it.each([
    {
      label: 'pure booleans before the subcommand',
      tokens: ['-jv', 'build'],
      root: { json: true, verbose: true },
    },
    {
      label: 'pure booleans after the subcommand',
      tokens: ['build', '-jv'],
      root: { json: true, verbose: true },
    },
    {
      label: 'attached root project after a boolean before the subcommand',
      tokens: ['-jPgame', 'build'],
      root: { json: true, project: 'game' },
    },
    {
      label: 'attached root project after a boolean after the subcommand',
      tokens: ['build', '-jPgame'],
      root: { json: true, project: 'game' },
    },
    {
      label: 'separate root project after a boolean before the subcommand',
      tokens: ['-jP', 'game', 'build'],
      root: { json: true, project: 'game' },
    },
    {
      label: 'separate root project after a boolean after the subcommand',
      tokens: ['build', '-jP', 'game'],
      root: { json: true, project: 'game' },
    },
    {
      label: 'option-looking attached root project',
      tokens: ['build', '-jP-jv'],
      root: { json: true, project: '-jv' },
    },
    {
      label: 'option-looking separate root project',
      tokens: ['build', '-jP', '-jv'],
      root: { json: true, project: '-jv' },
    },
    {
      label: 'attached root URL after a boolean',
      tokens: ['build', '-juhttp://127.0.0.1:1'],
      root: { json: true, url: 'http://127.0.0.1:1' },
    },
    {
      label: 'attached root token after a boolean',
      tokens: ['build', '-jtsecret'],
      root: { json: true, token: 'secret' },
    },
    {
      label: 'attached command output after two root booleans',
      tokens: ['build', '-jvoBuild/out'],
      root: { json: true, verbose: true },
      command: { outputPath: 'Build/out' },
    },
    {
      label: 'separate command output after two root booleans',
      tokens: ['build', '-jvo', 'Build/out'],
      root: { json: true, verbose: true },
      command: { outputPath: 'Build/out' },
    },
    {
      label: 'attached command log path after a root boolean',
      tokens: ['build', '-jlLogs/build.log'],
      root: { json: true },
      command: { logFile: 'Logs/build.log' },
    },
    {
      label: 'attached command editor path after a root boolean',
      tokens: ['build', '-jerelative/Unity'],
      root: { json: true },
      command: { editorPath: 'relative/Unity' },
    },
    {
      label: 'attached command architecture after a root boolean',
      tokens: ['build', '-jax86_64'],
      root: { json: true },
      command: { architecture: 'x86_64' },
    },
  ] satisfies Array<{
    label: string;
    tokens: string[];
    root: Record<string, unknown>;
    command?: Partial<BuildCommandOptions>;
  }>)('matches Commander compact-short grammar: $label', async ({ tokens, root, command = {} }) => {
    const argv = withRequiredBuildOptions(tokens);
    const control = await parseWithCommanderBuildControl(argv);
    expect(control.root).toMatchObject(root);
    expect(control.command).toMatchObject(command);

    const client = fakeBuildClient();
    captureOutput();
    const program = rootProgram();
    registerBuild(program, client);
    await program.parseAsync(['node', 'uco', ...argv]);

    expect(program.opts()).toEqual(control.root);
    expect(client.buildProjectU).toHaveBeenCalledWith(expect.objectContaining({
      project: path.resolve(typeof root['project'] === 'string' ? root['project'] : process.cwd()),
      ...command,
    }), expect.anything());
  });

  it('keeps an opaque compact token as data and recognizes the following real compact token', async () => {
    const client = fakeBuildClient();
    captureOutput();
    const program = rootProgram();
    registerBuild(program, client);

    await program.parseAsync([
      'node', 'uco', 'build', '--target', 'WebGL', '--execute-method', 'Build.Perform',
      '--args', '-jv', '-jPgame',
    ]);

    expect(program.opts()).toMatchObject({ json: true, project: 'game' });
    expect(program.opts()).not.toMatchObject({ verbose: true });
    expect(client.buildProjectU).toHaveBeenCalledWith(expect.objectContaining({
      args: '-jv',
      project: path.resolve('game'),
    }), expect.anything());
  });

  it.each([
    ['boolean prefix with unknown remainder', '-jvx', '-x', { json: true, verbose: true }],
    ['leading unknown compact token', '-xj', '-xj', {}],
  ])('rejects compact unknowns without losing Commander-owned state: %s', async (
    _label,
    token,
    expectedUnknown,
    expectedRoot,
  ) => {
    const argv = withRequiredBuildOptions(['build', token]);
    const control = await parseWithCommanderBuildControl(argv);
    expect(control.root).toMatchObject(expectedRoot);

    const client = fakeBuildClient();
    const output = captureOutput();
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);
    const program = rootProgram();
    registerBuild(program, client);

    await expect(program.parseAsync(['node', 'uco', ...argv])).rejects.toThrow('exit:1');
    expect(program.opts()).toEqual(control.root);
    expect(client.buildProjectU).not.toHaveBeenCalled();
    expect(String(output.stderr.mock.calls[0]?.[0])).toContain(`Unknown build option: ${expectedUnknown}`);
  });

  it('rejects a non-empty literal delimiter tail before invoking the build adapter', async () => {
    const client = fakeBuildClient();
    const output = captureOutput();
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);
    const program = rootProgram();
    registerBuild(program, client);

    await expect(program.parseAsync([
      'node', 'uco', '--json', 'build',
      '--target', 'WebGL', '--execute-method', 'Build.Perform', '--', '--bogus', 'value',
    ])).rejects.toThrow('exit:1');

    expect(client.buildProjectU).not.toHaveBeenCalled();
    expect(output.stdout).not.toHaveBeenCalled();
    expect(JSON.parse(String(output.stderr.mock.calls[0]?.[0]))).toMatchObject({
      ok: false,
      error: {
        code: 'invalid-unity-build-arguments',
        message: expect.stringContaining('does not accept arguments after a literal `--`'),
        retryable: false,
      },
    });
  });

  it('preserves a structured official failure with no stdout or retry', async () => {
    const failure = new UnityCliError({
      kind: 'command-failed', officialCommand: 'build',
      officialErrors: [{ code: 'BUILD_FAILED', message: 'build rejected' }],
    });
    const client: UnityBuildClient = { buildProjectU: vi.fn(async () => { throw failure; }) };
    const output = captureOutput();
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`exit:${code}`); }) as never);
    const program = rootProgram();
    registerBuild(program, client);
    await expect(program.parseAsync([
      'node', 'uco', '--json', 'build', '--target', 'WebGL', '--execute-method', 'Build.Perform',
    ])).rejects.toThrow('exit:1');
    expect(output.stdout).not.toHaveBeenCalled();
    expect(JSON.parse(String(output.stderr.mock.calls[0]?.[0]))).toMatchObject({
      ok: false,
      error: {
        code: 'unity-cli-command-failed',
        details: { kind: 'command-failed', officialCommand: 'build' },
      },
    });
    expect(client.buildProjectU).toHaveBeenCalledTimes(1);
  });
});

describe('test command', () => {
  it('does not disable suffix global options for existing commands', async () => {
    const program = rootProgram();
    const existingAction = vi.fn();
    program.command('existing').action(existingAction);
    registerTest(program, fakeTestClient());

    await program.parseAsync([
      'node', 'uco', 'existing', '--json', '--project', 'game',
      '--url', 'http://127.0.0.1:1', '--token', 'secret', '--verbose', '--timeout', '42',
    ]);

    expect(existingAction).toHaveBeenCalledTimes(1);
    expect(program.opts()).toMatchObject({
      json: true,
      project: 'game',
      url: 'http://127.0.0.1:1',
      token: 'secret',
      verbose: true,
      timeout: '42',
    });
  });

  it('keeps suffix global options available on build after test registration', async () => {
    const program = rootProgram();
    const buildClient = fakeBuildClient();
    registerBuild(program, buildClient);
    registerTest(program, fakeTestClient());
    captureOutput();

    await program.parseAsync([
      'node', 'uco', 'build', '--target', 'WebGL', '--execute-method', 'Build.Perform',
      '--json', '--project', 'root-game', '--url', 'http://127.0.0.1:1',
      '--token', 'secret', '--verbose', '--timeout', '41',
    ]);

    expect(buildClient.buildProjectU).toHaveBeenCalledWith(
      expect.objectContaining({ project: path.resolve('root-game') }),
      expect.anything(),
    );
    expect(program.opts()).toMatchObject({ json: true, timeout: '41', verbose: true });
  });

  it('maps all options and preserves opaque Editor tokens', async () => {
    const client = fakeTestClient();
    const controller = new AbortController();
    await executeTest('game', {
      mode: 'EditMode', filter: 'Category=Smoke', output: 'Reports/result.xml',
      editorVersion: '6000.5.6f1', editorPath: 'relative/Unity', architecture: 'x86_64',
      allowInstall: true, timeout: '90',
    }, ['-nographics', '--json', '--format=something'], '/ignored', client, {
      controller, signalHost: new EventEmitter(),
    });
    expect(client.testProjectU).toHaveBeenCalledWith({
      project: path.resolve('game'), mode: 'EditMode', filter: 'Category=Smoke',
      output: 'Reports/result.xml', editorVersion: '6000.5.6f1', editorPath: 'relative/Unity',
      architecture: 'x86_64', allowInstall: true, timeoutSeconds: 90,
      editorArgs: ['-nographics', '--json', '--format=something'],
    }, { signal: controller.signal });
  });

  it.each([
    [{ mode: 'editmode' }, '--mode'],
    [{ architecture: 'universal' }, '--architecture'],
    [{ timeout: '0' }, '--timeout'],
    [{ timeout: '1.5' }, '--timeout'],
    [{ filter: ' ' }, '--filter'],
  ])('rejects invalid test input before adapter invocation: %s', async (options, message) => {
    const client = fakeTestClient();
    await expect(executeTest(undefined, options, [], '/project', client)).rejects.toThrow(message);
    expect(client.testProjectU).not.toHaveBeenCalled();
  });

  it('accepts the maximum test seconds and rejects the next second before adapter invocation', async () => {
    const acceptedClient = fakeTestClient();
    await executeTest(undefined, {
      timeout: String(UNITY_CLI_MAX_TEST_TIMEOUT_SECONDS),
    }, [], '/project', acceptedClient);
    expect(acceptedClient.testProjectU).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutSeconds: UNITY_CLI_MAX_TEST_TIMEOUT_SECONDS }),
      expect.anything(),
    );

    const rejectedClient = fakeTestClient();
    await expect(executeTest(undefined, {
      timeout: String(UNITY_CLI_MAX_TEST_TIMEOUT_SECONDS + 1),
    }, [], '/project', rejectedClient)).rejects.toThrow(
      `no greater than ${UNITY_CLI_MAX_TEST_TIMEOUT_SECONDS}`,
    );
    expect(rejectedClient.testProjectU).not.toHaveBeenCalled();
  });

  it('separates root milliseconds from command seconds, including simultaneous use', async () => {
    captureOutput();
    const client = fakeTestClient();
    const program = rootProgram();
    registerTest(program, client);
    await program.parseAsync([
      'node', 'uco', '--timeout', '7000', '--project', 'root-game',
      'test', '--timeout', '90', '--mode', 'PlayMode',
    ]);
    expect(client.testProjectU).toHaveBeenCalledWith(expect.objectContaining({
      project: path.resolve('root-game'), timeoutSeconds: 90, mode: 'PlayMode',
    }), expect.anything());
    expect(program.opts().timeout).toBe('7000');

    const rootOnlyClient = fakeTestClient();
    const rootOnlyProgram = rootProgram();
    registerTest(rootOnlyProgram, rootOnlyClient);
    await rootOnlyProgram.parseAsync(['node', 'uco', '--timeout', '7000', 'test']);
    expect(rootOnlyClient.testProjectU).toHaveBeenCalledWith(
      expect.not.objectContaining({ timeoutSeconds: expect.anything() }),
      expect.anything(),
    );
    expect(rootOnlyProgram.opts().timeout).toBe('7000');

    const localOnlyClient = fakeTestClient();
    const localOnlyProgram = rootProgram();
    registerTest(localOnlyProgram, localOnlyClient);
    await localOnlyProgram.parseAsync(['node', 'uco', 'test', '--timeout', '90']);
    expect(localOnlyClient.testProjectU).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutSeconds: 90 }),
      expect.anything(),
    );
    expect(localOnlyProgram.opts().timeout).toBe('60000');
  });

  it('accepts suffix JSON/project/url/token/verbose while keeping test timeout local', async () => {
    captureOutput();
    const client = fakeTestClient();
    const program = rootProgram();
    registerTest(program, client);

    await program.parseAsync([
      'node', 'uco', 'test', '--timeout=90', '--json', '--project=root-game',
      '--url=http://127.0.0.1:1', '--token=secret', '--verbose',
    ]);

    expect(client.testProjectU).toHaveBeenCalledWith(
      expect.objectContaining({ project: path.resolve('root-game'), timeoutSeconds: 90 }),
      expect.anything(),
    );
    expect(program.opts()).toMatchObject({
      json: true,
      project: 'root-game',
      url: 'http://127.0.0.1:1',
      token: 'secret',
      verbose: true,
      timeout: '60000',
    });
  });

  it('distinguishes an omitted project from Editor arguments after the delimiter', async () => {
    captureOutput();
    const client = fakeTestClient();
    const program = rootProgram();
    registerTest(program, client);
    await program.parseAsync([
      'node', 'uco', 'test', '--', '-nographics', '--json', '--format', 'editor',
    ]);
    expect(client.testProjectU).toHaveBeenCalledWith(expect.objectContaining({
      project: process.cwd(),
      editorArgs: ['-nographics', '--json', '--format', 'editor'],
    }), expect.anything());
  });

  it('parses every test flag, positional precedence, and post-delimiter order', async () => {
    const client = fakeTestClient({ passed: 4 });
    const output = captureOutput();
    const program = rootProgram();
    registerTest(program, client);
    await program.parseAsync([
      'node', 'uco', '--json', '--project', 'root-game', 'test', 'positional-game',
      '--mode', 'PlayMode', '--filter', 'Category=Smoke Tests', '--output', 'Reports/result.xml',
      '--editor-version', '6000.5.6f1', '-e', 'relative/Unity', '-a', 'x86_64',
      '--allow-install', '--timeout', '120', '--', '-nographics', '--json', '--format=something',
    ]);
    expect(client.testProjectU).toHaveBeenCalledWith({
      project: path.resolve('positional-game'), mode: 'PlayMode', filter: 'Category=Smoke Tests',
      output: 'Reports/result.xml', editorVersion: '6000.5.6f1', editorPath: 'relative/Unity',
      architecture: 'x86_64', allowInstall: true, timeoutSeconds: 120,
      editorArgs: ['-nographics', '--json', '--format=something'],
    }, expect.anything());
    expect(JSON.parse(String(output.stdout.mock.calls[0]?.[0]))).toEqual({ passed: 4 });
  });

  it('prints the same direct test data in human mode', async () => {
    const client = fakeTestClient({ passed: 2, failed: 0 });
    const output = captureOutput();
    const program = rootProgram();
    registerTest(program, client);
    await program.parseAsync(['node', 'uco', 'test']);
    expect(JSON.parse(String(output.stdout.mock.calls[0]?.[0]))).toEqual({ passed: 2, failed: 0 });
    expect(output.stderr).not.toHaveBeenCalled();
  });

  it('rejects undelimited excess tokens without invoking the adapter', async () => {
    const client = fakeTestClient();
    captureOutput();
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`exit:${code}`); }) as never);
    const program = rootProgram();
    registerTest(program, client);
    await expect(program.parseAsync(['node', 'uco', 'test', 'project', 'extra']))
      .rejects.toThrow('exit:1');
    expect(client.testProjectU).not.toHaveBeenCalled();
  });

  it('returns direct data and does not retry an unavailable official client', async () => {
    const unavailable = new UnityCliError({ kind: 'not-found', message: 'override unavailable' });
    const client: UnityTestClient = { testProjectU: vi.fn(async () => { throw unavailable; }) };
    const output = captureOutput();
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`exit:${code}`); }) as never);
    const program = rootProgram();
    registerTest(program, client);
    await expect(program.parseAsync(['node', 'uco', '--json', 'test']))
      .rejects.toThrow('exit:1');
    expect(output.stdout).not.toHaveBeenCalled();
    expect(JSON.parse(String(output.stderr.mock.calls[0]?.[0]))).toMatchObject({
      ok: false,
      error: {
        code: 'unity-cli-not-found', message: 'override unavailable',
        details: { kind: 'not-found' },
      },
    });
    expect(client.testProjectU).toHaveBeenCalledTimes(1);
  });
});
