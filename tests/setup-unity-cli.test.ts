import { Command } from 'commander';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerSetupUnityCli } from '../src/commands/devops/setup-unity-cli.js';
import {
  setupUnityCli,
  SetupUnityCliError,
  UNITY_CLI_SETUP_INSTALLERS,
  UNITY_CLI_SETUP_MAX_REDIRECTS,
  type SetupFetchResponse,
  type SetupUnityCliDependencies,
} from '../src/devops/lib/setup-unity-cli.js';
import {
  createUnityCli,
  type UnityCliProcessAdapter,
  UnityCliProcessRequest,
  UnityCliProcessResult,
} from '../src/devops/utils/unity-cli.js';

afterEach(() => vi.restoreAllMocks());

async function* body(...chunks: string[]): AsyncIterable<Uint8Array> {
  for (const chunk of chunks) yield Buffer.from(chunk);
}

function response(overrides: Partial<SetupFetchResponse> = {}): SetupFetchResponse {
  return {
    ok: true,
    status: 200,
    url: UNITY_CLI_SETUP_INSTALLERS.linux!.url,
    body: body('#!/usr/bin/env bash\n', 'echo install\n'),
    ...overrides,
  };
}

function processResult(overrides: Partial<UnityCliProcessResult> = {}): UnityCliProcessResult {
  return { stdout: '', stderr: '', exitCode: 0, ...overrides };
}

function fakeDependencies(
  overrides: Partial<SetupUnityCliDependencies> = {},
): SetupUnityCliDependencies {
  return {
    platform: 'linux',
    environment: { PATH: '/bin' },
    findUnityCli: vi.fn(() => null),
    getUnityCliVersion: vi.fn(() => null),
    resolveExecutor: vi.fn(() => '/bin/bash'),
    prompt: vi.fn(async () => true),
    fetchInstaller: vi.fn(async () => response()),
    processAdapter: {
      run: vi.fn(async () => processResult()),
      runSync: vi.fn(() => processResult()),
    },
    createTempDirectory: vi.fn(async () => '/private/uco-temp'),
    writeInstaller: vi.fn(async () => undefined),
    removeTempDirectory: vi.fn(async () => undefined),
    limits: {
      downloadBytes: 1024,
      downloadTimeoutMs: 100,
      processOutputBytes: 1024,
      processTimeoutMs: 100,
    },
    ...overrides,
  };
}

async function setupError(
  operation: Promise<unknown>,
): Promise<SetupUnityCliError> {
  try {
    await operation;
  } catch (error) {
    expect(error).toBeInstanceOf(SetupUnityCliError);
    return error as SetupUnityCliError;
  }
  throw new Error('Expected setup to fail.');
}

describe('Unity CLI setup contracts', () => {
  it('maps only the documented platform installer endpoints', () => {
    expect(UNITY_CLI_SETUP_INSTALLERS.win32).toMatchObject({
      url: 'https://public-cdn.cloud.unity3d.com/hub/prod/cli/install.ps1',
      executor: 'powershell',
    });
    expect(UNITY_CLI_SETUP_INSTALLERS.darwin).toEqual(UNITY_CLI_SETUP_INSTALLERS.linux);
    expect(UNITY_CLI_SETUP_INSTALLERS.aix).toBeUndefined();
  });

  it('returns an existing executable without prompt, network, or process work', async () => {
    const dependencies = fakeDependencies({
      findUnityCli: vi.fn(() => '/tools/unity'),
      getUnityCliVersion: vi.fn(() => '1.0.0-beta.9'),
    });
    await expect(setupUnityCli({}, dependencies)).resolves.toEqual({
      success: true,
      status: 'already-installed',
      verified: true,
      executable: '/tools/unity',
      version: '1.0.0-beta.9',
    });
    expect(dependencies.prompt).not.toHaveBeenCalled();
    expect(dependencies.fetchInstaller).not.toHaveBeenCalled();
    expect(dependencies.processAdapter.run).not.toHaveBeenCalled();
  });

  it('rejects an invalid authoritative UNITY_CLI_PATH before external work', async () => {
    const dependencies = fakeDependencies({
      environment: { UNITY_CLI_PATH: '/missing/unity', PATH: '/bin' },
    });
    expect((await setupError(setupUnityCli({ dryRun: true }, dependencies))).kind)
      .toBe('invalid-unity-cli-path');
    expect(dependencies.getUnityCliVersion).not.toHaveBeenCalled();
    expect(dependencies.processAdapter.runSync).not.toHaveBeenCalled();
    expect(dependencies.processAdapter.run).not.toHaveBeenCalled();
    expect(dependencies.fetchInstaller).not.toHaveBeenCalled();
  });

  it.each([
    ['empty/failed version probe', null],
    ['runnable unrelated executable', 'v24.15.0'],
    ['malformed output', 'Unity CLI version unknown'],
  ])('rejects an authoritative executable with %s', async (_label, version) => {
    const dependencies = fakeDependencies({
      environment: { UNITY_CLI_PATH: '/tools/not-unity', PATH: '/bin' },
      findUnityCli: vi.fn(() => '/tools/not-unity'),
      getUnityCliVersion: vi.fn(() => version),
    });
    const error = await setupError(setupUnityCli({}, dependencies));
    expect(error.kind).toBe('invalid-unity-cli-path');
    expect(dependencies.fetchInstaller).not.toHaveBeenCalled();
    expect(dependencies.processAdapter.run).not.toHaveBeenCalled();
  });

  it('reports a discovered dry-run candidate as unverified without any version subprocess', async () => {
    const processAdapter: UnityCliProcessAdapter = {
      run: vi.fn(async () => processResult()),
      runSync: vi.fn(() => processResult({ stdout: '1.0.0-beta.9\n' })),
    };
    const environment = { UNITY_CLI_PATH: '/usr/local/bin/unity', PATH: '/bin' };
    const discoveryClient = createUnityCli({
      environment,
      platform: 'linux',
      isRunnableFile: () => true,
      processAdapter,
    });
    const dependencies = fakeDependencies({
      environment,
      findUnityCli: discoveryClient.findUnityCli,
      getUnityCliVersion: discoveryClient.getUnityCliVersion,
      processAdapter,
    });
    await expect(setupUnityCli({ dryRun: true, json: true }, dependencies)).resolves.toMatchObject({
      status: 'planned',
      dryRun: true,
      plan: {
        discovery: {
          status: 'candidate-discovered',
          executable: path.resolve('/usr/local/bin/unity'),
          verified: false,
          verification: 'planned: bounded unity --version outside dry-run',
        },
      },
    });
    expect(processAdapter.runSync).not.toHaveBeenCalled();
    expect(processAdapter.run).not.toHaveBeenCalled();
    expect(dependencies.fetchInstaller).not.toHaveBeenCalled();
  });

  it('rejects unsupported platforms before network access', async () => {
    const dependencies = fakeDependencies({ platform: 'aix' });
    expect((await setupError(setupUnityCli({ yes: true }, dependencies))).kind)
      .toBe('unsupported-platform');
    expect(dependencies.fetchInstaller).not.toHaveBeenCalled();
  });

  it('returns a fully side-effect-free dry-run plan', async () => {
    const dependencies = fakeDependencies();
    await expect(setupUnityCli({ dryRun: true }, dependencies)).resolves.toMatchObject({
      success: true,
      status: 'planned',
      dryRun: true,
      plan: {
        platform: 'linux',
        installerUrl: UNITY_CLI_SETUP_INSTALLERS.linux!.url,
        executor: '/bin/bash',
        environment: { UNITY_CLI_CHANNEL: 'beta' },
        discovery: {
          status: 'not-found',
          executable: null,
          verified: false,
          verification: 'not-applicable',
        },
      },
    });
    expect(dependencies.getUnityCliVersion).not.toHaveBeenCalled();
    expect(dependencies.prompt).not.toHaveBeenCalled();
    expect(dependencies.fetchInstaller).not.toHaveBeenCalled();
    expect(dependencies.createTempDirectory).not.toHaveBeenCalled();
    expect(dependencies.processAdapter.run).not.toHaveBeenCalled();
    expect(dependencies.processAdapter.runSync).not.toHaveBeenCalled();
  });

  it('requires --yes in JSON or non-interactive mode before network access', async () => {
    for (const options of [{ json: true }, { interactive: false }]) {
      const dependencies = fakeDependencies();
      expect((await setupError(setupUnityCli(options, dependencies))).kind)
        .toBe('approval-required');
      expect(dependencies.prompt).not.toHaveBeenCalled();
      expect(dependencies.fetchInstaller).not.toHaveBeenCalled();
    }
  });

  it('treats the interactive prompt as default-no cancellation', async () => {
    const dependencies = fakeDependencies({ prompt: vi.fn(async () => false) });
    await expect(setupUnityCli({ interactive: true }, dependencies)).resolves.toEqual({
      success: true,
      status: 'cancelled',
      installed: false,
    });
    expect(dependencies.fetchInstaller).not.toHaveBeenCalled();
    expect(dependencies.createTempDirectory).not.toHaveBeenCalled();
  });

  it.each([
    ['cross-origin redirect', response({ url: 'https://example.com/install.sh' })],
    ['non-HTTPS final URL', response({ url: 'http://public-cdn.cloud.unity3d.com/install.sh' })],
    ['empty body', response({ body: body() })],
    ['declared oversized body', response({ contentLength: 2048 })],
    ['streamed oversized body', response({ body: body('x'.repeat(1025)) })],
  ])('rejects an unsafe %s and never executes it', async (_label, unsafeResponse) => {
    const dependencies = fakeDependencies({
      fetchInstaller: vi.fn(async () => unsafeResponse),
    });
    expect((await setupError(setupUnityCli({ yes: true }, dependencies))).kind)
      .toBe('unsafe-response');
    expect(dependencies.processAdapter.run).not.toHaveBeenCalled();
  });

  it('follows a bounded same-origin redirect manually', async () => {
    const initial = UNITY_CLI_SETUP_INSTALLERS.linux!.url;
    const redirected = 'https://public-cdn.cloud.unity3d.com/hub/prod/cli/install-current.sh';
    const fetchInstaller = vi.fn(async (url: string) => url === initial
      ? response({ ok: false, status: 302, url: initial, location: redirected, body: null })
      : response({ url: redirected }));
    const dependencies = fakeDependencies({ fetchInstaller });
    await expect(setupUnityCli({ yes: true }, dependencies)).resolves.toMatchObject({
      status: 'installed-restart-required',
    });
    expect(fetchInstaller.mock.calls.map(([url]) => url)).toEqual([initial, redirected]);
    expect(dependencies.processAdapter.run).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['cross-origin', 'https://example.com/install.sh'],
    ['non-HTTPS', 'http://public-cdn.cloud.unity3d.com/install.sh'],
    ['credentials', 'https://user:password@public-cdn.cloud.unity3d.com/install.sh'],
    ['non-default port', 'https://public-cdn.cloud.unity3d.com:8443/install.sh'],
  ])('rejects a %s redirect before requesting its destination', async (_label, location) => {
    const initial = UNITY_CLI_SETUP_INSTALLERS.linux!.url;
    const fetchInstaller = vi.fn(async () => response({
      ok: false,
      status: 302,
      url: initial,
      location,
      body: null,
    }));
    const dependencies = fakeDependencies({ fetchInstaller });
    expect((await setupError(setupUnityCli({ yes: true }, dependencies))).kind)
      .toBe('unsafe-response');
    expect(fetchInstaller).toHaveBeenCalledTimes(1);
    expect(dependencies.processAdapter.run).not.toHaveBeenCalled();
  });

  it('rejects redirect loops', async () => {
    const initial = UNITY_CLI_SETUP_INSTALLERS.linux!.url;
    const second = 'https://public-cdn.cloud.unity3d.com/hub/prod/cli/second.sh';
    const fetchInstaller = vi.fn(async (url: string) => response({
      ok: false,
      status: 302,
      url,
      location: url === initial ? second : initial,
      body: null,
    }));
    const error = await setupError(setupUnityCli({ yes: true }, fakeDependencies({ fetchInstaller })));
    expect(error).toMatchObject({ kind: 'unsafe-response' });
    expect(error.message).toContain('loop');
    expect(fetchInstaller).toHaveBeenCalledTimes(2);
  });

  it('rejects redirect chains beyond the fixed hop limit', async () => {
    const initial = UNITY_CLI_SETUP_INSTALLERS.linux!.url;
    const fetchInstaller = vi.fn(async (url: string) => {
      const current = new URL(url);
      const index = Number(current.searchParams.get('hop') ?? '0');
      const next = new URL(initial);
      next.searchParams.set('hop', String(index + 1));
      return response({
        ok: false,
        status: 302,
        url: current.href,
        location: next.href,
        body: null,
      });
    });
    const error = await setupError(setupUnityCli({ yes: true }, fakeDependencies({ fetchInstaller })));
    expect(error).toMatchObject({ kind: 'unsafe-response' });
    expect(error.message).toContain(`exceeded ${UNITY_CLI_SETUP_MAX_REDIRECTS}`);
    expect(fetchInstaller).toHaveBeenCalledTimes(UNITY_CLI_SETUP_MAX_REDIRECTS + 1);
  });

  it('rejects an outside-then-back chain before the outside request', async () => {
    const initial = UNITY_CLI_SETUP_INSTALLERS.linux!.url;
    const fetchInstaller = vi.fn(async (url: string) => {
      if (url === initial) {
        return response({
          ok: false,
          status: 302,
          url,
          location: 'https://outside.example.test/redirect-back',
          body: null,
        });
      }
      return response({ url, location: initial });
    });
    expect((await setupError(setupUnityCli({ yes: true }, fakeDependencies({ fetchInstaller })))).kind)
      .toBe('unsafe-response');
    expect(fetchInstaller).toHaveBeenCalledTimes(1);
  });

  it('maps failed HTTP, download timeout, and preflight abort to typed failures', async () => {
    const failed = fakeDependencies({
      fetchInstaller: vi.fn(async () => response({ ok: false, status: 503 })),
    });
    expect((await setupError(setupUnityCli({ yes: true }, failed))).kind)
      .toBe('download-failed');

    const timedOut = fakeDependencies({
      limits: {
        downloadBytes: 1024,
        downloadTimeoutMs: 1,
        processOutputBytes: 1024,
        processTimeoutMs: 100,
      },
      fetchInstaller: vi.fn((_url, options) => new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      })),
    });
    expect((await setupError(setupUnityCli({ yes: true }, timedOut))).kind).toBe('timeout');

    const controller = new AbortController();
    controller.abort();
    const aborted = fakeDependencies();
    expect((await setupError(setupUnityCli({ yes: true, signal: controller.signal }, aborted))).kind)
      .toBe('aborted');
    expect(aborted.fetchInstaller).not.toHaveBeenCalled();
  });

  it.each([
    ['spawn-failed', 'spawn-failed'],
    ['timeout', 'timeout'],
    ['aborted', 'aborted'],
    ['output-too-large', 'output-too-large'],
  ] as const)('maps process %s and always removes uco temp files', async (failure, expectedKind) => {
    const dependencies = fakeDependencies({
      processAdapter: {
        run: vi.fn(async () => processResult({ failure })),
        runSync: vi.fn(() => processResult()),
      },
    });
    expect((await setupError(setupUnityCli({ yes: true }, dependencies))).kind).toBe(expectedKind);
    expect(dependencies.removeTempDirectory).toHaveBeenCalledWith('/private/uco-temp');
  });

  it('maps non-zero installer exit and write failure while cleaning temporary files', async () => {
    const nonZero = fakeDependencies({
      processAdapter: {
        run: vi.fn(async () => processResult({ exitCode: 7, stderr: 'vendor failed' })),
        runSync: vi.fn(() => processResult()),
      },
    });
    const processError = await setupError(setupUnityCli({ yes: true }, nonZero));
    expect(processError).toMatchObject({
      kind: 'process-failed',
      stderr: 'vendor failed',
      installerMayHaveChangedMachine: true,
    });
    expect(nonZero.removeTempDirectory).toHaveBeenCalledTimes(1);

    const writeFailure = fakeDependencies({
      writeInstaller: vi.fn(async () => { throw new Error('disk full'); }),
    });
    expect((await setupError(setupUnityCli({ yes: true }, writeFailure))).kind)
      .toBe('temporary-file-failed');
    expect(writeFailure.processAdapter.run).not.toHaveBeenCalled();
    expect(writeFailure.removeTempDirectory).toHaveBeenCalledTimes(1);
  });

  it('runs the safe argument-array installer with beta env and verifies rediscovery', async () => {
    const requests: UnityCliProcessRequest[] = [];
    const find = vi.fn<() => string | null>()
      .mockReturnValueOnce(null)
      .mockReturnValue('/installed/unity');
    const dependencies = fakeDependencies({
      findUnityCli: find,
      getUnityCliVersion: vi.fn(() => '1.0.0-beta.9'),
      processAdapter: {
        run: vi.fn(async (request) => {
          requests.push(request);
          return processResult();
        }),
        runSync: vi.fn(() => processResult()),
      },
    });
    await expect(setupUnityCli({ yes: true }, dependencies)).resolves.toMatchObject({
      status: 'installed',
      verified: true,
      executable: '/installed/unity',
      version: '1.0.0-beta.9',
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      executable: '/bin/bash',
      args: [path.join('/private/uco-temp', 'install.sh')],
      environment: { PATH: '/bin', UNITY_CLI_CHANNEL: 'beta' },
    });
  });

  it('uses an allowlisted child environment and redacts parent secrets from diagnostics', async () => {
    const sentinel = 'sentinel-secret-value';
    const requests: UnityCliProcessRequest[] = [];
    const dependencies = fakeDependencies({
      environment: {
        PATH: '/bin',
        HOME: '/home/tester',
        HTTPS_PROXY: 'https://proxy.example.test',
        NPM_TOKEN: sentinel,
        GITHUB_TOKEN: sentinel,
        COCLI_API_KEY: sentinel,
      },
      processAdapter: {
        run: vi.fn(async (request) => {
          requests.push(request);
          return processResult({
            failure: 'spawn-failed',
            stdout: `echo ${sentinel}`,
            stderr: `failed ${sentinel}`,
            cause: new Error(`cause ${sentinel}`),
          });
        }),
        runSync: vi.fn(() => processResult()),
      },
    });
    const error = await setupError(setupUnityCli({ yes: true }, dependencies));
    expect(requests).toHaveLength(1);
    expect(requests[0]!.environment).toEqual({
      PATH: '/bin',
      HOME: '/home/tester',
      HTTPS_PROXY: 'https://proxy.example.test',
      UNITY_CLI_CHANNEL: 'beta',
    });
    const serialized = JSON.stringify(error.toJSON());
    expect(serialized).not.toContain(sentinel);
    expect(serialized).toContain('[REDACTED]');
  });

  it('reports successful installer completion separately from stale PATH', async () => {
    const dependencies = fakeDependencies();
    await expect(setupUnityCli({ yes: true }, dependencies)).resolves.toMatchObject({
      status: 'installed-restart-required',
      verified: false,
      nextSteps: expect.arrayContaining([expect.stringContaining('unity --version')]),
    });
  });
});

describe('setup-unity-cli Commander surface', () => {
  it('advertises only explicit approval and dry-run controls', () => {
    const program = new Command().exitOverride();
    registerSetupUnityCli(program, vi.fn(async () => ({
      success: true as const,
      status: 'cancelled' as const,
      installed: false as const,
    })));
    const command = program.commands.find((candidate) => candidate.name() === 'setup-unity-cli');
    expect(command).toBeDefined();
    expect(command!.options.map((option) => option.long)).toEqual(['--yes', '--dry-run']);
    expect(command!.helpInformation()).toContain("Unity's official beta CLI");
  });

  it('emits exactly one JSON success value and suppresses progress', async () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const execute = vi.fn(async (options) => {
      options.onProgress?.('must stay suppressed');
      return {
        success: true as const,
        status: 'planned' as const,
        dryRun: true as const,
        plan: {
          platform: 'linux' as const,
          installerUrl: UNITY_CLI_SETUP_INSTALLERS.linux!.url,
          executor: '/bin/bash',
          executorArgs: ['<temporary-install.sh>'],
          environment: { UNITY_CLI_CHANNEL: 'beta' as const },
          discovery: {
            status: 'not-found' as const,
            executable: null,
            verified: false as const,
            verification: 'not-applicable' as const,
          },
          verification: 'rediscover executable and run unity --version' as const,
        },
      };
    });
    const program = new Command().exitOverride().option('--json');
    registerSetupUnityCli(program, execute);
    await program.parseAsync(['node', 'uco', '--json', 'setup-unity-cli', '--dry-run']);
    expect(stdout).toHaveBeenCalledTimes(1);
    expect(stderr).not.toHaveBeenCalled();
    expect(JSON.parse(String(stdout.mock.calls[0]?.[0]))).toMatchObject({ status: 'planned' });
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({
      dryRun: true,
      json: true,
      interactive: false,
    }));
  });

  it('emits one structured approval error to JSON stderr and no stdout', async () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code ?? 0}`);
    }) as never);
    const program = new Command().exitOverride().option('--json');
    registerSetupUnityCli(program, vi.fn(async () => {
      throw new SetupUnityCliError({
        kind: 'approval-required',
        message: 'Re-run with --yes.',
      });
    }));
    await expect(program.parseAsync(['node', 'uco', '--json', 'setup-unity-cli']))
      .rejects.toThrow('exit:1');
    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(stderr.mock.calls[0]?.[0]))).toMatchObject({
      ok: false,
      error: {
        code: 'setup-unity-cli-approval-required',
        retryable: false,
        details: { kind: 'approval-required' },
      },
    });
  });
});
