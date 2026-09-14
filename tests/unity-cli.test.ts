import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createUnityCli,
  UNITY_CLI_BUILD_TIMEOUT_MS,
  UNITY_CLI_DEFAULT_TIMEOUT_MS,
  UNITY_CLI_INSTALL_TIMEOUT_MS,
  UNITY_CLI_MAX_OUTPUT_BYTES,
  UNITY_CLI_MAX_TEST_TIMEOUT_SECONDS,
  UNITY_CLI_MAX_TIMEOUT_MS,
  UNITY_CLI_PROJECT_TIMEOUT_MS,
  UNITY_CLI_TEST_TIMEOUT_MS,
  UNITY_CLI_VERSION_TIMEOUT_MS,
  UnityCliError,
  type UnityCliFactoryOptions,
  type UnityCliProcessAdapter,
  type UnityCliProcessRequest,
  type UnityCliProcessResult,
} from '../src/devops/utils/unity-cli.js';

const BETA_INSTALLED_RECORD = {
  version: '6000.5.6f1',
  location: 'D:\\Program Files\\Unity\\6000.5.6f1\\Editor\\Unity.exe',
  alias: 'latest',
  architecture: 'x86_64',
  modules: '',
  default: false,
  betaFieldThatCallersDoNotKnow: true,
};

const BETA_SUCCESS_ENVELOPE = {
  success: true,
  command: 'editors',
  data: [BETA_INSTALLED_RECORD],
  errors: [],
  warnings: [],
};

const BETA_FAILURE_ENVELOPE = {
  success: false,
  command: 'editors',
  data: null,
  errors: [{ code: 'COMMAND_FAILED', message: 'No installed editor found' }],
  warnings: [{ code: 'BETA_WARNING', message: 'The CLI is in beta' }],
};

function processResult(
  stdout: string,
  overrides: Partial<UnityCliProcessResult> = {},
): UnityCliProcessResult {
  return { stdout, stderr: '', exitCode: 0, ...overrides };
}

type FakeOutcome =
  | UnityCliProcessResult
  | Error
  | ((request: UnityCliProcessRequest) => UnityCliProcessResult | Promise<UnityCliProcessResult>);

class FakeProcessAdapter implements UnityCliProcessAdapter {
  readonly runRequests: UnityCliProcessRequest[] = [];
  readonly runSyncRequests: UnityCliProcessRequest[] = [];
  readonly outcomes: FakeOutcome[] = [];
  readonly syncOutcomes: FakeOutcome[] = [];

  enqueue(outcome: FakeOutcome): this {
    this.outcomes.push(outcome);
    return this;
  }

  enqueueSync(outcome: FakeOutcome): this {
    this.syncOutcomes.push(outcome);
    return this;
  }

  async run(request: UnityCliProcessRequest): Promise<UnityCliProcessResult> {
    this.runRequests.push(request);
    const outcome = this.outcomes.shift();
    if (outcome === undefined) {
      return processResult(JSON.stringify({ success: true, command: 'fake', data: null, errors: [], warnings: [] }));
    }
    if (outcome instanceof Error) throw outcome;
    return typeof outcome === 'function' ? outcome(request) : outcome;
  }

  runSync(request: UnityCliProcessRequest): UnityCliProcessResult {
    this.runSyncRequests.push(request);
    const outcome = this.syncOutcomes.shift();
    if (outcome === undefined) return processResult('1.0.0-beta.3\n');
    if (outcome instanceof Error) throw outcome;
    if (typeof outcome === 'function') {
      const result = outcome(request);
      if (result instanceof Promise) throw new Error('A sync fake outcome cannot return a promise.');
      return result;
    }
    return outcome;
  }
}

function fakeClient(
  adapter = new FakeProcessAdapter(),
  options: Omit<UnityCliFactoryOptions, 'processAdapter'> = {},
) {
  return {
    adapter,
    client: createUnityCli({
      processAdapter: adapter,
      environment: { UNITY_CLI_PATH: '/fake/unity', PATH: '/fallback' },
      platform: 'linux',
      cwd: () => path.parse(process.cwd()).root,
      isRunnableFile: () => true,
      ...options,
    }),
  };
}

async function caughtUnityError(action: Promise<unknown>): Promise<UnityCliError> {
  try {
    await action;
  } catch (error) {
    expect(error).toBeInstanceOf(UnityCliError);
    return error as UnityCliError;
  }
  throw new Error('Expected a UnityCliError.');
}

function realNodeClient() {
  return createUnityCli({
    environment: { ...process.env, UNITY_CLI_PATH: process.execPath },
  });
}

function realNodeScriptArgs(script: string): string[] {
  const directory = temporaryDirectory();
  const scriptPath = path.join(directory, 'unity-cli-process-fixture.cjs');
  fs.writeFileSync(scriptPath, script);
  return [scriptPath];
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (processExists(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return !processExists(pid);
}

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'uco-unity-cli-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('official Unity CLI discovery', () => {
  it('uses a valid authoritative override without launching it', () => {
    const adapter = new FakeProcessAdapter();
    const checked: string[] = [];
    const override = path.resolve('custom', 'unity');
    const client = createUnityCli({
      processAdapter: adapter,
      environment: { UNITY_CLI_PATH: override, PATH: path.resolve('fallback') },
      platform: 'linux',
      isRunnableFile: (candidate) => { checked.push(candidate); return candidate === override; },
    });

    expect(client.findUnityCli()).toBe(override);
    expect(checked).toEqual([override]);
    expect(adapter.runRequests).toHaveLength(0);
    expect(adapter.runSyncRequests).toHaveLength(0);
  });

  it('does not fall through to PATH when a non-empty override is invalid', () => {
    const override = path.resolve('missing', 'unity');
    const fallback = path.resolve('tools', 'unity');
    const checked: string[] = [];
    const client = createUnityCli({
      environment: { UNITY_CLI_PATH: override, PATH: path.dirname(fallback) },
      platform: 'linux',
      isRunnableFile: (candidate) => { checked.push(candidate); return candidate === fallback; },
    });

    expect(client.findUnityCli()).toBeNull();
    expect(checked).toEqual([override]);
  });

  it('searches PATH and returns an absolute platform candidate', () => {
    const first = path.resolve('first-bin');
    const second = path.resolve('second-bin');
    const expected = path.resolve(second, 'unity');
    const client = createUnityCli({
      environment: { PATH: `${first}:${second}` },
      platform: 'linux',
      isRunnableFile: (candidate) => candidate === expected,
    });

    expect(client.findUnityCli()).toBe(expected);
    expect(path.isAbsolute(client.findUnityCli() ?? '')).toBe(true);
  });

  it('honors Windows PATH separators and PATHEXT', () => {
    const first = path.resolve('first-win-bin');
    const second = path.resolve('second-win-bin');
    const expected = path.resolve(second, 'unity.EXE');
    const client = createUnityCli({
      environment: { Path: `${first};${second}`, PATHEXT: '.CMD;.EXE' },
      platform: 'win32',
      isRunnableFile: (candidate) => candidate === expected,
    });

    expect(client.findUnityCli()).toBe(expected);
  });

  it.each(['.cmd', '.bat', '.txt', ''])('rejects a Windows override ending in %s by default', (extension) => {
    const directory = temporaryDirectory();
    const candidate = path.join(directory, `unity${extension}`);
    fs.writeFileSync(candidate, 'not a directly executable Windows image');
    const client = createUnityCli({
      environment: { UNITY_CLI_PATH: candidate },
      platform: 'win32',
    });

    expect(client.findUnityCli()).toBeNull();
  });

  it.each(['.exe', '.COM'])('accepts a directly executable Windows override ending in %s', (extension) => {
    const directory = temporaryDirectory();
    const candidate = path.join(directory, `unity${extension}`);
    fs.writeFileSync(candidate, 'fixture');
    const client = createUnityCli({
      environment: { UNITY_CLI_PATH: candidate },
      platform: 'win32',
    });

    expect(client.findUnityCli()).toBe(path.resolve(candidate));
  });

  it('skips Windows command scripts in PATH and discovers a later executable image', () => {
    const directory = temporaryDirectory();
    fs.writeFileSync(path.join(directory, 'unity.CMD'), 'fixture');
    fs.writeFileSync(path.join(directory, 'unity.BAT'), 'fixture');
    const executable = path.join(directory, 'unity.EXE');
    fs.writeFileSync(executable, 'fixture');
    const client = createUnityCli({
      environment: { Path: directory, PATHEXT: '.CMD;.BAT;.EXE' },
      platform: 'win32',
    });

    expect(client.findUnityCli()).toBe(path.resolve(executable));
  });

  it('does not discover Windows PATH command scripts when no executable image exists', () => {
    const directory = temporaryDirectory();
    fs.writeFileSync(path.join(directory, 'unity.CMD'), 'fixture');
    fs.writeFileSync(path.join(directory, 'unity.BAT'), 'fixture');
    const client = createUnityCli({
      environment: { Path: directory, PATHEXT: '.CMD;.BAT' },
      platform: 'win32',
    });

    expect(client.findUnityCli()).toBeNull();
  });

  it('returns null when no candidate exists and does not cache later environment changes', () => {
    const environment: NodeJS.ProcessEnv = { PATH: path.resolve('empty-bin') };
    let available = false;
    const client = createUnityCli({
      environment,
      platform: 'linux',
      isRunnableFile: (candidate) => available && candidate === path.resolve('new-bin', 'unity'),
    });

    expect(client.findUnityCli()).toBeNull();
    environment['PATH'] = path.resolve('new-bin');
    available = true;
    expect(client.findUnityCli()).toBe(path.resolve('new-bin', 'unity'));
  });
});

describe('official Unity CLI version probe', () => {
  it('returns a trimmed version under the short bound', () => {
    const adapter = new FakeProcessAdapter().enqueueSync(processResult(' 1.0.0-beta.3 \r\n'));
    const { client } = fakeClient(adapter);

    expect(client.getUnityCliVersion()).toBe('1.0.0-beta.3');
    expect(adapter.runSyncRequests[0]).toMatchObject({
      args: ['--version'],
      timeoutMs: UNITY_CLI_VERSION_TIMEOUT_MS,
    });
  });

  it.each([
    ['empty output', processResult('  ')],
    ['non-zero exit', processResult('1.0.0-beta.3', { exitCode: 2 })],
    ['spawn failure', processResult('', { exitCode: null, failure: 'spawn-failed' })],
    ['timeout', processResult('', { exitCode: null, failure: 'timeout' })],
  ])('returns null for %s', (_label, result) => {
    const adapter = new FakeProcessAdapter().enqueueSync(result);
    expect(fakeClient(adapter).client.getUnityCliVersion()).toBeNull();
  });

  it('returns null without probing when discovery fails', () => {
    const adapter = new FakeProcessAdapter();
    const { client } = fakeClient(adapter, { isRunnableFile: () => false });
    expect(client.getUnityCliVersion()).toBeNull();
    expect(adapter.runSyncRequests).toHaveLength(0);
  });
});

describe('JSON process and envelope contract', () => {
  it('returns only successful data, tolerates extra fields, and adds one JSON flag', async () => {
    const adapter = new FakeProcessAdapter().enqueue(processResult(JSON.stringify(BETA_SUCCESS_ENVELOPE)));
    const { client } = fakeClient(adapter);

    await expect(client.runUnityJson(['editors', '-i', '--json', '--format=json'])).resolves.toEqual([
      BETA_INSTALLED_RECORD,
    ]);
    expect(adapter.runRequests[0]).toMatchObject({
      args: ['editors', '-i', '--json'],
      timeoutMs: UNITY_CLI_DEFAULT_TIMEOUT_MS,
      maxOutputBytes: UNITY_CLI_MAX_OUTPUT_BYTES,
    });
  });

  it('normalizes formats only before the passthrough delimiter', async () => {
    const adapter = new FakeProcessAdapter();
    const { client } = fakeClient(adapter);

    await client.runUnityJson([
      'test', '/project', '--format', 'text', '--json', '--format=json',
      '--', '--json', '--format', 'editor-format', '--format=something',
    ]);

    expect(adapter.runRequests[0]?.args).toEqual([
      'test', '/project', '--json',
      '--', '--json', '--format', 'editor-format', '--format=something',
    ]);
  });

  it('honors a positive custom timeout', async () => {
    const adapter = new FakeProcessAdapter();
    const { client } = fakeClient(adapter);
    await client.runUnityJson(['editors', '-i'], { timeoutMs: 4321 });
    expect(adapter.runRequests[0]?.timeoutMs).toBe(4321);
  });

  it('accepts the exact Node timer ceiling and rejects one millisecond above before launch', async () => {
    const acceptedAdapter = new FakeProcessAdapter();
    await fakeClient(acceptedAdapter).client.runUnityJson(
      ['editors', '-i'],
      { timeoutMs: UNITY_CLI_MAX_TIMEOUT_MS },
    );
    expect(acceptedAdapter.runRequests[0]?.timeoutMs).toBe(UNITY_CLI_MAX_TIMEOUT_MS);

    const rejectedAdapter = new FakeProcessAdapter();
    const error = await caughtUnityError(fakeClient(rejectedAdapter).client.runUnityJson(
      ['editors', '-i'],
      { timeoutMs: UNITY_CLI_MAX_TIMEOUT_MS + 1 },
    ));
    expect(error.kind).toBe('invalid-data');
    expect(error.message).toContain(String(UNITY_CLI_MAX_TIMEOUT_MS));
    expect(rejectedAdapter.runRequests).toHaveLength(0);
  });

  it('rejects non-positive timeouts before launching', async () => {
    const adapter = new FakeProcessAdapter();
    const { client } = fakeClient(adapter);
    const error = await caughtUnityError(client.runUnityJson(['editors'], { timeoutMs: 0 }));
    expect(error.kind).toBe('invalid-data');
    expect(adapter.runRequests).toHaveLength(0);
  });

  it('parses the beta failure envelope before classifying its non-zero exit', async () => {
    const adapter = new FakeProcessAdapter().enqueue(processResult(
      JSON.stringify(BETA_FAILURE_ENVELOPE),
      { exitCode: 4, stderr: 'less useful process text' },
    ));
    const { client } = fakeClient(adapter);
    const error = await caughtUnityError(client.runUnityJson(['editors', '-i']));

    expect(error.kind).toBe('command-failed');
    expect(error.message).toBe('No installed editor found');
    expect(error.processExitCode).toBe(4);
    expect(error.officialCommand).toBe('editors');
    expect(error.officialErrors).toEqual(BETA_FAILURE_ENVELOPE.errors);
    expect(error.warnings).toEqual(BETA_FAILURE_ENVELOPE.warnings);
    expect(error.stderr).toBe('less useful process text');
  });

  it.each([
    ['success envelope with non-zero exit', { ...BETA_SUCCESS_ENVELOPE }, 7],
    ['failure envelope with zero exit', { ...BETA_FAILURE_ENVELOPE }, 0],
  ])('rejects inconsistent signals: %s', async (_label, envelope, exitCode) => {
    const adapter = new FakeProcessAdapter().enqueue(processResult(JSON.stringify(envelope), { exitCode }));
    const error = await caughtUnityError(fakeClient(adapter).client.runUnityJson(['editors']));
    expect(error.kind).toBe('command-failed');
  });

  it.each([
    ['empty output', '', 'invalid-json'],
    ['malformed output', '{ definitely not JSON', 'invalid-json'],
    ['missing success', JSON.stringify({ data: [] }), 'invalid-envelope'],
    ['missing data', JSON.stringify({ success: true, errors: [], warnings: [] }), 'invalid-envelope'],
    ['invalid diagnostics', JSON.stringify({ success: false, data: null, errors: [{}] }), 'invalid-envelope'],
  ])('classifies %s', async (_label, stdout, expectedKind) => {
    const adapter = new FakeProcessAdapter().enqueue(processResult(stdout));
    const error = await caughtUnityError(fakeClient(adapter).client.runUnityJson(['editors']));
    expect(error.kind).toBe(expectedKind);
  });

  it.each([
    ['spawn-failed', 'spawn-failed'],
    ['timeout', 'timeout'],
    ['aborted', 'aborted'],
    ['output-too-large', 'output-too-large'],
  ] as const)('preserves the %s process outcome', async (_label, failure) => {
    const adapter = new FakeProcessAdapter().enqueue(processResult('', { exitCode: null, failure }));
    const error = await caughtUnityError(fakeClient(adapter).client.runUnityJson(['editors']));
    expect(error.kind).toBe(failure);
  });

  it('normalizes an adapter rejection to spawn-failed', async () => {
    const adapter = new FakeProcessAdapter().enqueue(new Error('spawn EPERM'));
    const error = await caughtUnityError(fakeClient(adapter).client.runUnityJson(['editors']));
    expect(error.kind).toBe('spawn-failed');
    expect(error.message).toBe('spawn EPERM');
  });

  it('honors an already-aborted caller signal without launching', async () => {
    const adapter = new FakeProcessAdapter();
    const controller = new AbortController();
    controller.abort();
    const error = await caughtUnityError(
      fakeClient(adapter).client.runUnityJson(['editors'], { signal: controller.signal }),
    );
    expect(error.kind).toBe('aborted');
    expect(adapter.runRequests).toHaveLength(0);
  });

  it('passes caller values as discrete arguments without shell interpretation', async () => {
    const adapter = new FakeProcessAdapter();
    const { client } = fakeClient(adapter);
    await client.runUnityJson(['projects', 'new', 'name; Remove-Item *', '--path', 'C:\\A & B']);
    expect(adapter.runRequests[0]?.args).toEqual([
      'projects', 'new', 'name; Remove-Item *', '--path', 'C:\\A & B', '--json',
    ]);
  });

  it('bounds raw diagnostics and serializes only present fields', async () => {
    const adapter = new FakeProcessAdapter().enqueue(processResult('x'.repeat(40_000)));
    const error = await caughtUnityError(fakeClient(adapter).client.runUnityJson(['editors']));
    const serialized = error.toJSON();
    expect((serialized['rawStdout'] as string).length).toBeLessThan(40_000);
    expect(serialized).toMatchObject({
      error: true,
      kind: 'invalid-json',
      code: 'unity-cli-invalid-json',
      exitCode: 1,
    });
    expect(serialized).not.toHaveProperty('officialCommand');
    expect(serialized).not.toHaveProperty('warnings');
  });

  it('reports unavailable discovery with the authoritative override', async () => {
    const override = path.resolve('missing', 'unity');
    const client = createUnityCli({
      environment: { UNITY_CLI_PATH: override, PATH: path.resolve('valid-bin') },
      platform: 'linux',
      isRunnableFile: () => false,
    });
    const error = await caughtUnityError(client.runUnityJson(['editors']));
    expect(error.kind).toBe('not-found');
    expect(error.message).toContain('UNITY_CLI_PATH');
    expect(error.toJSON()).not.toHaveProperty('executable');
  });

  it('parses JSONL progress and selects the terminal official envelope', async () => {
    const stdout = [
      JSON.stringify({ type: 'progress', progress: 0.5, message: 'building' }),
      JSON.stringify({
        success: true,
        command: 'build',
        data: { outputPath: 'Build/Game.exe' },
        errors: [],
        warnings: [],
      }),
    ].join('\r\n');
    const adapter = new FakeProcessAdapter().enqueue(processResult(stdout));

    await expect(fakeClient(adapter).client.runUnityJson(['build', '/project']))
      .resolves.toEqual({ outputPath: 'Build/Game.exe' });
  });

  it('identifies a malformed JSONL record without treating the whole stream as one document', async () => {
    const stdout = [
      JSON.stringify({ type: 'progress', progress: 0.25 }),
      '{not-json}',
      JSON.stringify({ success: true, command: 'build', data: {}, errors: [], warnings: [] }),
    ].join('\n');
    const adapter = new FakeProcessAdapter().enqueue(processResult(stdout));
    const error = await caughtUnityError(fakeClient(adapter).client.runUnityJson(['build', '/project']));

    expect(error.kind).toBe('invalid-json');
    expect(error.message).toContain('record 2');
  });

  it('selects a terminal JSONL failure and preserves its official diagnostic', async () => {
    const stdout = [
      JSON.stringify({ type: 'progress', progress: 0.75 }),
      JSON.stringify({
        success: false,
        command: 'build',
        data: null,
        errors: [{ code: 'BUILD_FAILED', message: 'fixture failure' }],
        warnings: [],
      }),
    ].join('\n');
    const adapter = new FakeProcessAdapter().enqueue(processResult(stdout, { exitCode: 1 }));
    const error = await caughtUnityError(fakeClient(adapter).client.runUnityJson(['build', '/project']));

    expect(error.kind).toBe('command-failed');
    expect(error.message).toContain('fixture failure');
    expect(error.officialErrors).toEqual([{ code: 'BUILD_FAILED', message: 'fixture failure' }]);
  });

  it('redacts temporary access tokens from option JSON URL and bearer diagnostics', async () => {
    const secrets = ['fixture-option-token', 'fixture-json-token', 'fixture-query-token', 'fixture-bearer-token'];
    const adapter = new FakeProcessAdapter().enqueue(processResult(
      `failed ${secrets.join(' ')}`,
      { stderr: `Authorization: Bearer ${secrets[3]}` },
    ));
    const error = await caughtUnityError(fakeClient(adapter).client.runUnityJson([
      'build', '/project', '-accessToken', secrets[0],
      '--args', JSON.stringify({ accessToken: secrets[1] }),
      `https://example.invalid/?access_token=${secrets[2]}`,
      '--authorization', `Bearer ${secrets[3]}`,
    ]));
    const serialized = JSON.stringify(error.toJSON());

    for (const secret of secrets) expect(serialized).not.toContain(secret);
    expect(serialized).toContain('[REDACTED]');
  });

  it('redacts signing values from process-failure diagnostics and attempted arguments', async () => {
    const keystore = 'fixture-keystore-payload';
    const password = 'fixture-keystore-password';
    const aliasPassword = 'fixture-alias-password';
    const adapter = new FakeProcessAdapter().enqueue(processResult(
      `${keystore} ${password}`,
      {
        stderr: `failed with ${aliasPassword}`,
        exitCode: null,
        failure: 'spawn-failed',
        cause: new Error(`spawn rejected ${password}`),
      },
    ));
    const error = await caughtUnityError(fakeClient(adapter).client.runUnityJson([
      'build', '/project',
      '--android-keystore-base64', keystore,
      '--android-keystore-password', password,
      `--android-key-alias-password=${aliasPassword}`,
      '--target', 'Android',
    ]));
    const serialized = JSON.stringify(error.toJSON());

    expect(serialized).not.toContain(keystore);
    expect(serialized).not.toContain(password);
    expect(serialized).not.toContain(aliasPassword);
    expect(error.args).toContain('Android');
    expect(serialized).toContain('[REDACTED]');
  });

  it.each([
    ['invalid JSON', 'not-json fixture-keystore-payload'],
    ['invalid envelope', JSON.stringify({ success: 'yes', data: 'fixture-keystore-payload' })],
  ])('redacts signing values from %s output and selected messages', async (_label, stdout) => {
    const secret = 'fixture-keystore-payload';
    const adapter = new FakeProcessAdapter().enqueue(processResult(stdout, {
      stderr: `stderr mentions ${secret}`,
    }));
    const error = await caughtUnityError(fakeClient(adapter).client.runUnityJson([
      'build', '/project', '--android-keystore-base64', secret,
    ]));
    const serialized = JSON.stringify(error.toJSON());

    expect(serialized).not.toContain(secret);
    expect(error.message).toContain('[REDACTED]');
  });

  it('redacts official errors, warnings, raw envelopes, and the top-level message', async () => {
    const secret = 'fixture-keystore-password';
    const envelope = {
      success: false,
      command: 'build',
      data: null,
      errors: [{ code: 'SIGNING_FAILED', message: `password ${secret} rejected` }],
      warnings: [{ code: 'SIGNING_WARNING', message: `do not reuse ${secret}` }],
    };
    const adapter = new FakeProcessAdapter().enqueue(processResult(JSON.stringify(envelope), {
      exitCode: 5,
      stderr: `stderr ${secret}`,
    }));
    const error = await caughtUnityError(fakeClient(adapter).client.runUnityJson([
      'build', '/project', '--android-keystore-password', secret,
    ]));
    const serialized = JSON.stringify(error.toJSON());

    expect(serialized).not.toContain(secret);
    expect(error.message).toBe('password [REDACTED] rejected');
    expect(error.officialErrors).toEqual([
      { code: 'SIGNING_FAILED', message: 'password [REDACTED] rejected' },
    ]);
    expect(error.warnings).toEqual([
      { code: 'SIGNING_WARNING', message: 'do not reuse [REDACTED]' },
    ]);
  });

  it('redacts the JSON-escaped representation of a signing value from raw envelopes', async () => {
    const secret = 'fixture-line-one\n"fixture-line-two"\\end';
    const adapter = new FakeProcessAdapter().enqueue(processResult(JSON.stringify({
      success: false,
      command: 'build',
      data: null,
      errors: [{ code: 'SIGNING_FAILED', message: `rejected ${secret}` }],
      warnings: [],
    }), { exitCode: 2 }));
    const error = await caughtUnityError(fakeClient(adapter).client.runUnityJson([
      'build', '/project', '--android-keystore-password', secret,
    ]));
    const serialized = JSON.stringify(error.toJSON());

    expect(serialized).not.toContain('fixture-line-one');
    expect(serialized).not.toContain('fixture-line-two');
    expect(serialized).toContain('[REDACTED]');
  });

  it('redacts signing values when the process adapter rejects', async () => {
    const secret = 'fixture-alias-password';
    const adapter = new FakeProcessAdapter().enqueue(new Error(`spawn failed for ${secret}`));
    const error = await caughtUnityError(fakeClient(adapter).client.runUnityJson([
      'build', '/project', '--android-key-alias-password', secret,
    ]));

    expect(error.message).toBe('spawn failed for [REDACTED]');
    expect(JSON.stringify(error.toJSON())).not.toContain(secret);
  });
});

describe('production process termination', () => {
  it('preserves a multibyte UTF-8 value split across real stdout chunks', async () => {
    const script = [
      'const value = String.fromCodePoint(0x4f60);',
      "const payload = Buffer.from(JSON.stringify({ success: true, command: 'fixture', data: value, errors: [], warnings: [] }));",
      'const marker = Buffer.from(value);',
      'const offset = payload.indexOf(marker);',
      'process.stdout.write(payload.subarray(0, offset + 1));',
      'setTimeout(() => process.stdout.write(payload.subarray(offset + 1)), 50);',
    ].join('\n');

    const value = await realNodeClient().runUnityJson<string>(realNodeScriptArgs(script));

    expect(value).toBe(String.fromCodePoint(0x4f60));
    expect([...value].map((character) => character.codePointAt(0))).toEqual([0x4f60]);
  });

  it('settles an in-flight caller abort without Unity or a network', async () => {
    const controller = new AbortController();
    const startedAt = Date.now();
    const action = realNodeClient().runUnityJson(
      realNodeScriptArgs('setInterval(() => {}, 1_000)'),
      { signal: controller.signal, timeoutMs: 10_000 },
    );

    setTimeout(() => controller.abort(), 100);
    const error = await caughtUnityError(action);

    expect(error.kind).toBe('aborted');
    expect(Date.now() - startedAt).toBeLessThan(4_000);
  }, 10_000);

  it('force-terminates a real process tree when the child ignores graceful termination', async () => {
    const timeoutMs = 500;
    const script = [
      "const { spawn } = require('node:child_process');",
      "const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1_000)'], { stdio: 'ignore' });",
      "process.stdout.write(`grandchild:${grandchild.pid}\\n`);",
      "process.on('SIGTERM', () => {});",
      'setInterval(() => {}, 1_000);',
    ].join('\n');
    const startedAt = Date.now();
    let grandchildPid: number | undefined;

    try {
      const error = await caughtUnityError(
        realNodeClient().runUnityJson(realNodeScriptArgs(script), { timeoutMs }),
      );
      const elapsedMs = Date.now() - startedAt;
      const pidMatch = /grandchild:(\d+)/.exec(error.rawStdout ?? '');
      grandchildPid = pidMatch === null ? undefined : Number(pidMatch[1]);

      expect(error.kind).toBe('timeout');
      expect(grandchildPid).toBeTypeOf('number');
      expect(elapsedMs).toBeLessThan(5_000);
      if (process.platform !== 'win32') {
        // SIGTERM was ignored, so POSIX must have reached the forced phase.
        expect(elapsedMs).toBeGreaterThanOrEqual(timeoutMs + 800);
      }
      await expect(waitForProcessExit(grandchildPid!, 3_000)).resolves.toBe(true);
    } finally {
      if (grandchildPid !== undefined && processExists(grandchildPid)) {
        process.kill(grandchildPid, 'SIGKILL');
      }
    }
  }, 10_000);

  it('enforces the raw-byte output limit through the production adapter', async () => {
    const script = [
      `process.stdout.write(Buffer.alloc(${UNITY_CLI_MAX_OUTPUT_BYTES + 1024}, 0x78));`,
      'setInterval(() => {}, 1_000);',
    ].join('\n');
    const startedAt = Date.now();

    const error = await caughtUnityError(
      realNodeClient().runUnityJson(realNodeScriptArgs(script), { timeoutMs: 10_000 }),
    );

    expect(error.kind).toBe('output-too-large');
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(Buffer.byteLength(error.rawStdout ?? '', 'utf8')).toBeLessThanOrEqual(16 * 1024 + 3);
  }, 10_000);
});

describe('normalized lifecycle adapters', () => {
  it('normalizes the observed installed-editor beta record', async () => {
    const adapter = new FakeProcessAdapter().enqueue(processResult(JSON.stringify(BETA_SUCCESS_ENVELOPE)));
    const editors = await fakeClient(adapter).client.listInstalledEditorsU();
    expect(editors).toEqual([{
      version: '6000.5.6f1',
      path: BETA_INSTALLED_RECORD.location,
      alias: 'latest',
      architecture: 'x86_64',
      modules: [],
      isDefault: false,
    }]);
    expect(adapter.runRequests[0]?.args).toEqual(['editors', '-i', '--json']);
  });

  it('accepts path and array-module aliases', async () => {
    const data = [{
      version: '2022.3.62f3',
      path: '/opt/unity/Editor/Unity',
      modules: ['android', 'webgl'],
      default: true,
    }];
    const adapter = new FakeProcessAdapter().enqueue(processResult(JSON.stringify({
      success: true, data, errors: [], warnings: [], futureField: 'ignored',
    })));
    await expect(fakeClient(adapter).client.listInstalledEditorsU()).resolves.toEqual([{
      version: '2022.3.62f3',
      path: '/opt/unity/Editor/Unity',
      modules: ['android', 'webgl'],
      isDefault: true,
    }]);
  });

  it.each([
    [{ location: '/editor' }],
    [{ version: '6000.5.6f1' }],
    [{ version: '6000.5.6f1', location: '/editor', modules: [42] }],
    [{ version: '6000.5.6f1', location: '/editor', default: 'false' }],
  ])('fails the whole installed listing for invalid records', async (data) => {
    const adapter = new FakeProcessAdapter().enqueue(processResult(JSON.stringify({ success: true, data })));
    const error = await caughtUnityError(fakeClient(adapter).client.listInstalledEditorsU());
    expect(error.kind).toBe('invalid-data');
  });

  it('derives release stability and retains installed locations', async () => {
    const data = [
      { version: '6000.3.21f1', alias: 'lts', architecture: 'x86_64', location: '/installed/final' },
      { version: '6000.6.0b5' },
      { version: '6000.7.0a3' },
    ];
    const adapter = new FakeProcessAdapter().enqueue(processResult(JSON.stringify({ success: true, data })));
    const releases = await fakeClient(adapter).client.listAvailableReleasesU();
    expect(releases).toEqual([
      {
        version: '6000.3.21f1', alias: 'lts', architecture: 'x86_64',
        installedPath: '/installed/final', isStable: true,
      },
      { version: '6000.6.0b5', isStable: false },
      { version: '6000.7.0a3', isStable: false },
    ]);
    expect(adapter.runRequests[0]?.args).toEqual(['editors', '-r', '--json']);
  });

  it('accepts the release path alias and rejects a missing version', async () => {
    const validAdapter = new FakeProcessAdapter().enqueue(processResult(JSON.stringify({
      success: true, data: [{ version: '6000.3.21f1', path: '/installed/alias' }],
    })));
    await expect(fakeClient(validAdapter).client.listAvailableReleasesU()).resolves.toEqual([{
      version: '6000.3.21f1', installedPath: '/installed/alias', isStable: true,
    }]);

    const invalidAdapter = new FakeProcessAdapter().enqueue(processResult(JSON.stringify({
      success: true, data: [{ alias: 'latest' }],
    })));
    const error = await caughtUnityError(fakeClient(invalidAdapter).client.listAvailableReleasesU());
    expect(error.kind).toBe('invalid-data');
  });

  it('constructs one module group and selects the install timeout', async () => {
    const adapter = new FakeProcessAdapter();
    await fakeClient(adapter).client.installEditorU('6000.5.6f1', ['android', 'webgl']);
    expect(adapter.runRequests[0]).toMatchObject({
      args: [
        'install', '6000.5.6f1', '--module', 'android', 'webgl',
        '--non-interactive', '--json',
      ],
      timeoutMs: UNITY_CLI_INSTALL_TIMEOUT_MS,
    });
  });

  it('constructs every structured install option as a discrete argument', async () => {
    const adapter = new FakeProcessAdapter();
    await fakeClient(adapter).client.installEditorU('6000.5.6f1', {
      modules: ['android', 'webgl'],
      architecture: 'arm64',
      changeset: '0123456789ab',
      childModules: true,
      force: true,
      acceptEula: true,
      resume: true,
      noElevate: true,
    });
    expect(adapter.runRequests[0]).toMatchObject({
      args: [
        'install', '6000.5.6f1', '--module', 'android', 'webgl',
        '--architecture', 'arm64', '--changeset', '0123456789ab', '--cm',
        '--force', '--accept-eula', '--resume', '--no-elevate',
        '--non-interactive', '--json',
      ],
      timeoutMs: UNITY_CLI_INSTALL_TIMEOUT_MS,
    });
  });

  it('preserves explicit child-module false and omits other false booleans', async () => {
    const adapter = new FakeProcessAdapter();
    await fakeClient(adapter).client.installEditorU('6000.5.6f1', {
      childModules: false,
      force: false,
      acceptEula: false,
      resume: false,
      noElevate: false,
    });
    expect(adapter.runRequests[0]?.args).toEqual([
      'install', '6000.5.6f1', '--no-cm', '--non-interactive', '--json',
    ]);
  });

  it('rejects invalid structured install values before launching', async () => {
    const adapter = new FakeProcessAdapter();
    const { client } = fakeClient(adapter);
    const architectureError = await caughtUnityError(client.installEditorU('6000.5.6f1', {
      architecture: 'universal' as 'arm64',
    }));
    expect(architectureError.kind).toBe('invalid-data');
    const changesetError = await caughtUnityError(client.installEditorU('6000.5.6f1', {
      changeset: ' ',
    }));
    expect(changesetError.kind).toBe('invalid-data');
    expect(adapter.runRequests).toHaveLength(0);
  });

  it('omits the module option for an empty install module list', async () => {
    const adapter = new FakeProcessAdapter();
    await fakeClient(adapter).client.installEditorU('6000.5.6f1');
    expect(adapter.runRequests[0]?.args).toEqual([
      'install', '6000.5.6f1', '--non-interactive', '--json',
    ]);
  });

  it('constructs all project options and selects the project timeout', async () => {
    const adapter = new FakeProcessAdapter();
    await fakeClient(adapter).client.createProjectU({
      name: 'My Game',
      parent: 'C:\\Unity Projects',
      editorVersion: '6000.5.6f1',
      template: 'com.unity.template.3d',
      architecture: 'x86_64',
    });
    expect(adapter.runRequests[0]).toMatchObject({
      args: [
        'projects', 'new', 'My Game', '--path', 'C:\\Unity Projects',
        '--editor-version', '6000.5.6f1', '--template', 'com.unity.template.3d',
        '--architecture', 'x86_64',
        '--non-interactive', '--json',
      ],
      timeoutMs: UNITY_CLI_PROJECT_TIMEOUT_MS,
    });
  });

  it('omits optional project arguments and rejects blank caller data', async () => {
    const adapter = new FakeProcessAdapter();
    const { client } = fakeClient(adapter);
    await client.createProjectU({ name: 'Game', parent: '/projects' });
    expect(adapter.runRequests[0]?.args).toEqual([
      'projects', 'new', 'Game', '--path', '/projects', '--non-interactive', '--json',
    ]);
    const error = await caughtUnityError(client.createProjectU({ name: ' ', parent: '/projects' }));
    expect(error.kind).toBe('invalid-data');
    expect(adapter.runRequests).toHaveLength(1);
  });

  it('rejects an invalid project architecture before launching', async () => {
    const adapter = new FakeProcessAdapter();
    const error = await caughtUnityError(fakeClient(adapter).client.createProjectU({
      name: 'Game',
      parent: '/projects',
      architecture: 'universal' as 'arm64',
    }));
    expect(error.kind).toBe('invalid-data');
    expect(adapter.runRequests).toHaveLength(0);
  });
});

describe('official build adapter', () => {
  it('constructs the minimal build call, forwards cancellation, and returns only data', async () => {
    const result = { outputPath: 'Build/game.exe', platform: 'Windows64' };
    const adapter = new FakeProcessAdapter().enqueue(processResult(JSON.stringify({
      success: true, command: 'build', data: result, errors: [], warnings: [],
    })));
    const controller = new AbortController();
    const value = await fakeClient(adapter).client.buildProjectU({
      project: '/projects/game',
      target: 'StandaloneWindows64',
      executeMethod: 'BuildScript.PerformBuild',
    }, { signal: controller.signal });

    expect(value).toEqual(result);
    expect(adapter.runRequests[0]).toMatchObject({
      args: [
        'build', '/projects/game',
        '--target', 'StandaloneWindows64',
        '--execute-method', 'BuildScript.PerformBuild',
        '--non-interactive', '--no-tail', '--json',
      ],
      timeoutMs: UNITY_CLI_BUILD_TIMEOUT_MS,
      signal: controller.signal,
    });
  });

  it('constructs every build option once in deterministic order and keeps --args unsplit', async () => {
    const adapter = new FakeProcessAdapter();
    await fakeClient(adapter).client.buildProjectU({
      project: '/projects/game',
      target: 'Android',
      executeMethod: 'BuildScript.PerformBuild',
      buildTargetGroup: 'Android',
      outputPath: 'Builds/My Game.aab',
      logFile: 'Logs/build log.txt',
      editorVersion: '6000.5.6f1',
      editorPath: 'Editors/Unity',
      architecture: 'arm64',
      args: '--custom "one value" --other=two',
      allowInstall: true,
      noTail: true,
      androidExportType: 'aab',
      androidKeystoreBase64: 'keystore-fixture',
      androidKeystorePassword: 'keystore-password-fixture',
      androidKeyAlias: 'release',
      androidKeyAliasPassword: 'alias-password-fixture',
      androidTargetSdkVersion: 35,
      androidSymbolType: 'debugging',
      androidVersionCode: 42,
      versioningStrategy: 'custom',
      buildVersion: '1.2.3-beta.4',
      allowDirtyBuild: true,
    });

    expect(adapter.runRequests[0]?.args).toEqual([
      'build', '/projects/game',
      '--target', 'Android',
      '--execute-method', 'BuildScript.PerformBuild',
      '--build-target-group', 'Android',
      '--output-path', 'Builds/My Game.aab',
      '--log-file', 'Logs/build log.txt',
      '--editor-version', '6000.5.6f1',
      '--editor-path', 'Editors/Unity',
      '--architecture', 'arm64',
      '--args', '--custom "one value" --other=two',
      '--allow-install',
      '--android-export-type', 'aab',
      '--android-keystore-base64', 'keystore-fixture',
      '--android-keystore-password', 'keystore-password-fixture',
      '--android-key-alias', 'release',
      '--android-key-alias-password', 'alias-password-fixture',
      '--android-target-sdk-version', '35',
      '--android-symbol-type', 'debugging',
      '--android-version-code', '42',
      '--versioning-strategy', 'custom',
      '--build-version', '1.2.3-beta.4',
      '--allow-dirty-build',
      '--non-interactive', '--no-tail', '--json',
    ]);
    expect(adapter.runRequests[0]?.args.filter((arg) => arg === '--no-tail')).toHaveLength(1);
    expect(adapter.runRequests[0]?.args.filter((arg) => arg === '--json')).toHaveLength(1);
  });

  it.each([
    '--json',
    '--format=something',
    '--non-interactive',
    '--no-tail',
  ])('preserves an opaque --args value that resembles wrapper flag %s', async (opaqueValue) => {
    const adapter = new FakeProcessAdapter();
    await fakeClient(adapter).client.buildProjectU({
      project: '/projects/game',
      target: 'WebGL',
      executeMethod: 'BuildScript.PerformBuild',
      args: opaqueValue,
    });

    expect(adapter.runRequests[0]?.args).toEqual([
      'build', '/projects/game',
      '--target', 'WebGL',
      '--execute-method', 'BuildScript.PerformBuild',
      '--args', opaqueValue,
      '--non-interactive', '--no-tail', '--json',
    ]);
  });

  it('preserves a structured official build failure', async () => {
    const adapter = new FakeProcessAdapter().enqueue(processResult(JSON.stringify({
      success: false,
      command: 'build',
      data: null,
      errors: [{ code: 'BUILD_FAILED', message: 'Build method failed' }],
      warnings: [],
    }), { exitCode: 3 }));
    const error = await caughtUnityError(fakeClient(adapter).client.buildProjectU({
      project: '/projects/game', target: 'Android', executeMethod: 'Build.Perform',
    }));

    expect(error.toJSON()).toMatchObject({
      kind: 'command-failed',
      officialCommand: 'build',
      officialErrors: [{ code: 'BUILD_FAILED', message: 'Build method failed' }],
      processExitCode: 3,
    });
  });
});

describe('official test adapter', () => {
  it('constructs the minimal test call under the two-hour bound', async () => {
    const adapter = new FakeProcessAdapter();
    await fakeClient(adapter).client.testProjectU({ project: '/projects/game' });

    expect(adapter.runRequests[0]).toMatchObject({
      args: ['test', '/projects/game', '--non-interactive', '--json'],
      timeoutMs: UNITY_CLI_TEST_TIMEOUT_MS,
    });
  });

  it('constructs all test options, preserves seconds and opaque Editor tokens, and forwards signal', async () => {
    const result = { passed: 12, failed: 0 };
    const adapter = new FakeProcessAdapter().enqueue(processResult(JSON.stringify({
      success: true, command: 'test', data: result, errors: [], warnings: [],
    })));
    const controller = new AbortController();
    const value = await fakeClient(adapter).client.testProjectU({
      project: '/projects/game',
      mode: 'PlayMode',
      filter: 'Category=Smoke Tests',
      output: 'Reports/results.xml',
      editorVersion: '6000.5.6f1',
      editorPath: 'Editors/Unity',
      architecture: 'x86_64',
      allowInstall: true,
      timeoutSeconds: 90,
      editorArgs: ['-nographics', '--json', '--format', 'editor-value', '--format=something'],
    }, { signal: controller.signal });

    expect(value).toEqual(result);
    expect(adapter.runRequests[0]).toMatchObject({
      args: [
        'test', '/projects/game',
        '--mode', 'PlayMode',
        '--filter', 'Category=Smoke Tests',
        '--output', 'Reports/results.xml',
        '--editor-version', '6000.5.6f1',
        '--editor-path', 'Editors/Unity',
        '--architecture', 'x86_64',
        '--allow-install',
        '--timeout', '90',
        '--non-interactive', '--json',
        '--', '-nographics', '--json', '--format', 'editor-value', '--format=something',
      ],
      timeoutMs: UNITY_CLI_TEST_TIMEOUT_MS,
      signal: controller.signal,
    });
  });

  it('extends a long command timeout by the five-minute settlement margin', async () => {
    const adapter = new FakeProcessAdapter();
    await fakeClient(adapter).client.testProjectU({
      project: '/projects/game',
      timeoutSeconds: 8_000,
    });

    expect(adapter.runRequests[0]?.args).toContain('8000');
    expect(adapter.runRequests[0]?.timeoutMs).toBe(8_000_000 + 5 * 60_000);
  });

  it('accepts the exact test-seconds ceiling and rejects the next second before launch', async () => {
    const acceptedAdapter = new FakeProcessAdapter();
    await fakeClient(acceptedAdapter).client.testProjectU({
      project: '/projects/game',
      timeoutSeconds: UNITY_CLI_MAX_TEST_TIMEOUT_SECONDS,
    });
    expect(acceptedAdapter.runRequests[0]?.timeoutMs).toBe(
      UNITY_CLI_MAX_TEST_TIMEOUT_SECONDS * 1_000 + 5 * 60_000,
    );
    expect(acceptedAdapter.runRequests[0]!.timeoutMs).toBeLessThanOrEqual(UNITY_CLI_MAX_TIMEOUT_MS);

    const rejectedAdapter = new FakeProcessAdapter();
    const error = await caughtUnityError(fakeClient(rejectedAdapter).client.testProjectU({
      project: '/projects/game',
      timeoutSeconds: UNITY_CLI_MAX_TEST_TIMEOUT_SECONDS + 1,
    }));
    expect(error.kind).toBe('invalid-data');
    expect(error.message).toContain(String(UNITY_CLI_MAX_TEST_TIMEOUT_SECONDS));
    expect(rejectedAdapter.runRequests).toHaveLength(0);
  });

  it('rejects an invalid seconds bound before launching', async () => {
    const adapter = new FakeProcessAdapter();
    const error = await caughtUnityError(fakeClient(adapter).client.testProjectU({
      project: '/projects/game', timeoutSeconds: 1.5,
    }));
    expect(error.kind).toBe('invalid-data');
    expect(adapter.runRequests).toHaveLength(0);
  });

  it('preserves a structured official test failure without retrying', async () => {
    const adapter = new FakeProcessAdapter().enqueue(processResult(JSON.stringify({
      success: false,
      command: 'test',
      data: null,
      errors: [{ code: 'TESTS_FAILED', message: 'One test failed' }],
      warnings: [],
    }), { exitCode: 2 }));
    const error = await caughtUnityError(fakeClient(adapter).client.testProjectU({
      project: '/projects/game', mode: 'EditMode',
    }));

    expect(error.kind).toBe('command-failed');
    expect(error.officialErrors).toEqual([{ code: 'TESTS_FAILED', message: 'One test failed' }]);
    expect(adapter.runRequests).toHaveLength(1);
  });
});
