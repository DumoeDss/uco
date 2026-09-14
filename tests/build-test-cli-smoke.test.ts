import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { UNITY_CLI_MAX_TEST_TIMEOUT_SECONDS } from '../src/devops/utils/unity-cli.js';

const PACKAGE_ROOT = process.cwd();

function builtCli(args: readonly string[], environment: NodeJS.ProcessEnv = process.env) {
  return spawnSync(process.execPath, ['bin/uco.mjs', ...args], {
    cwd: PACKAGE_ROOT,
    env: environment,
    encoding: 'utf8',
    shell: false,
  });
}

describe('built build/test CLI smokes', () => {
  it('lists the top-level official build and test commands', () => {
    const result = builtCli(['--help']);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('build [options] [project]');
    expect(result.stdout).toContain('test [options] [project]');
    expect(result.stdout).toContain('setup-unity-cli [options]');
  });

  it('exposes setup help and preserves non-interactive JSON approval purity', () => {
    const help = builtCli(['setup-unity-cli', '--help']);
    expect(help.status).toBe(0);
    expect(help.stderr).toBe('');
    expect(help.stdout).toContain('--yes');
    expect(help.stdout).toContain('--dry-run');

    const candidateDryRun = builtCli(['--json', 'setup-unity-cli', '--dry-run'], {
      ...process.env,
      UNITY_CLI_PATH: process.execPath,
    });
    expect(candidateDryRun.status).toBe(0);
    expect(candidateDryRun.stderr).toBe('');
    expect(JSON.parse(candidateDryRun.stdout)).toMatchObject({
      status: 'planned',
      dryRun: true,
      plan: {
        discovery: {
          status: 'candidate-discovered',
          executable: process.execPath,
          verified: false,
        },
      },
    });

    const unrelatedOverride = builtCli(['--json', 'setup-unity-cli'], {
      ...process.env,
      UNITY_CLI_PATH: process.execPath,
    });
    expect(unrelatedOverride.status).toBe(1);
    expect(unrelatedOverride.stdout).toBe('');
    expect(JSON.parse(unrelatedOverride.stderr)).toMatchObject({
      ok: false,
      error: { details: { kind: 'invalid-unity-cli-path' } },
    });

    const environment = { ...process.env };
    delete environment['UNITY_CLI_PATH'];
    if (process.platform === 'win32') {
      const systemRoot = process.env['SystemRoot'] ?? 'C:\\Windows';
      environment['PATH'] = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0');
    } else {
      environment['PATH'] = '/bin:/usr/bin';
    }
    const dryRun = builtCli(['--json', 'setup-unity-cli', '--dry-run'], environment);
    expect(dryRun.status).toBe(0);
    expect(dryRun.stderr).toBe('');
    expect(JSON.parse(dryRun.stdout)).toMatchObject({
      status: 'planned',
      dryRun: true,
      plan: { discovery: { status: 'not-found', executable: null, verified: false } },
    });

    const result = builtCli(['--json', 'setup-unity-cli'], environment);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(JSON.parse(result.stderr)).toMatchObject({
      ok: false,
      error: {
        code: 'setup-unity-cli-approval-required',
        details: { kind: 'approval-required' },
      },
    });
  });

  it('advertises the built wait-for-ready positional and millisecond options', () => {
    const result = builtCli(['wait-for-ready', '--help']);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('wait-for-ready [options] [project]');
    expect(result.stdout).toContain('--timeout <ms>');
    expect(result.stdout).toContain('--interval <ms>');
  });

  it('parses built wait-for-ready positional plus suffix globals and emits one JSON error without polling', () => {
    const result = builtCli([
      'wait-for-ready', 'positional-game', '--project', 'root-game', '--json',
      '--timeout', 'not-a-number',
    ]);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(JSON.parse(result.stderr)).toMatchObject({
      ok: false,
      error: {
        code: 'invalid-timeout',
        message: 'Invalid --timeout: not-a-number. Expected an integer in milliseconds from 1 to 2147483647.',
        retryable: false,
      },
    });
    expect(result.stderr.trim().split(/\r?\n(?=\{)/)).toHaveLength(1);
  });

  it('documents build aliases, official-only routing, opaque args, and disabled live tailing', () => {
    const result = builtCli(['build', '--help']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('official Unity CLI (no Hub fallback; live tail');
    expect(result.stdout).toContain('-o, --output-path <path>');
    expect(result.stdout).toContain('-l, --log-file <path>');
    expect(result.stdout).toContain('-e, --editor-path <path>');
    expect(result.stdout).toContain('-a, --architecture <architecture>');
    expect(result.stdout).toContain('--args <arguments>');
    expect(result.stdout).toContain('Opaque official build argument string');
    expect(result.stdout).toContain('uco always enforces this');
  });

  it('documents test aliases, seconds ownership, and literal delimiter passthrough', () => {
    const result = builtCli(['test', '--help']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('official Unity CLI (no Hub fallback)');
    expect(result.stdout).toContain('-e, --editor-path <path>');
    expect(result.stdout).toContain('-a, --architecture <architecture>');
    expect(result.stdout).toContain('--timeout <seconds>');
    expect(result.stdout).toContain(`range: 1-${UNITY_CLI_MAX_TEST_TIMEOUT_SECONDS}`);
    expect(result.stdout).toMatch(/not root\s+REST\s+milliseconds/);
    expect(result.stdout).toContain('--timeout-seconds <seconds>');
    expect(result.stdout).toContain('only after a literal `--`');
  });

  it('preserves suffix global options for an existing command without executing it', () => {
    const result = builtCli([
      'ping', '--json', '--project', 'game', '--url', 'http://127.0.0.1:1',
      '--token', 'secret', '--verbose', '--timeout', '50', '--help',
    ]);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('Usage: uco ping');
  });

  it.each([
    ['pure suffix booleans', [
      'build', '--target', 'WebGL', '--execute-method', 'Build.Perform', '-jv',
    ]],
    ['attached root project before build', [
      '-jPgame', 'build', '--target', 'WebGL', '--execute-method', 'Build.Perform',
    ]],
    ['attached root project after build', [
      'build', '--target', 'WebGL', '--execute-method', 'Build.Perform', '-jPgame',
    ]],
    ['attached child output after root booleans', [
      'build', '--target', 'WebGL', '--execute-method', 'Build.Perform', '-jvoBuild/out',
    ]],
    ['option-looking attached root project', [
      'build', '--target', 'WebGL', '--execute-method', 'Build.Perform', '-jP-jv',
    ]],
  ])('accepts compact short grammar for %s before safe discovery failure', (_label, commandArgs) => {
    const missing = path.resolve(PACKAGE_ROOT, 'definitely-missing-unity-cli.exe');
    const result = builtCli(commandArgs, {
      ...process.env,
      UNITY_CLI_PATH: missing,
      UCO_USE_UNITY_CLI: '0',
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(JSON.parse(result.stderr)).toMatchObject({
      ok: false,
      error: {
        code: 'unity-cli-not-found',
        details: { kind: 'not-found' },
      },
    });
  });

  it('rejects a non-empty build delimiter tail before official CLI discovery', () => {
    const missing = path.resolve(PACKAGE_ROOT, 'definitely-missing-unity-cli.exe');
    const result = builtCli([
      '--json', 'build', '--target', 'WebGL', '--execute-method', 'Build.Perform',
      '--', '--bogus',
    ], {
      ...process.env,
      UNITY_CLI_PATH: missing,
      UCO_USE_UNITY_CLI: '0',
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    const payload = JSON.parse(result.stderr) as { error: Record<string, unknown> };
    expect(payload).toMatchObject({
      ok: false,
      error: { code: 'invalid-unity-build-arguments' },
    });
    expect(payload.error['message']).toContain('does not accept arguments after a literal `--`');
    expect(payload.error['message']).not.toContain(missing);
  });

  it.each([
    ['build', ['build', '--target', 'WebGL', '--execute-method', 'Build.Perform']],
    ['test', ['test']],
  ])('fails %s safely for an invalid authoritative CLI override', (_command, commandArgs) => {
    const missing = path.resolve(PACKAGE_ROOT, 'definitely-missing-unity-cli.exe');
    const result = builtCli(['--json', ...commandArgs], {
      ...process.env,
      UNITY_CLI_PATH: missing,
      UCO_USE_UNITY_CLI: '0',
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    const payload = JSON.parse(result.stderr) as { error: Record<string, unknown> };
    expect(payload).toMatchObject({
      ok: false,
      error: {
        code: 'unity-cli-not-found',
        details: { kind: 'not-found' },
      },
    });
    expect(payload.error['message']).toContain(missing);
    expect(result.stderr.trim().split(/\r?\n(?=\{)/)).toHaveLength(1);
  });

  it.each([
    ['build', ['build', '--target', 'WebGL', '--execute-method', 'Build.Perform', '--json']],
    ['test', ['test', '--timeout', '90', '--json']],
    ['test with both timeout owners', ['--timeout', '7000', 'test', '--timeout', '90', '--json']],
  ])('accepts suffix JSON for %s before the safe unavailable error', (_command, commandArgs) => {
    const missing = path.resolve(PACKAGE_ROOT, 'definitely-missing-unity-cli.exe');
    const result = builtCli(commandArgs, {
      ...process.env,
      UNITY_CLI_PATH: missing,
      UCO_USE_UNITY_CLI: '0',
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(JSON.parse(result.stderr)).toMatchObject({
      ok: false,
      error: {
        code: 'unity-cli-not-found',
        details: { kind: 'not-found' },
      },
    });
  });

  it('rejects a test timeout above the maximum before official CLI discovery', () => {
    const missing = path.resolve(PACKAGE_ROOT, 'definitely-missing-unity-cli.exe');
    const result = builtCli([
      '--json', 'test', '--timeout', String(UNITY_CLI_MAX_TEST_TIMEOUT_SECONDS + 1),
    ], {
      ...process.env,
      UNITY_CLI_PATH: missing,
      UCO_USE_UNITY_CLI: '0',
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    const payload = JSON.parse(result.stderr) as { error: Record<string, unknown> };
    expect(payload).toMatchObject({ ok: false, error: { code: 'invalid-unity-option' } });
    expect(payload.error['message']).toContain(`no greater than ${UNITY_CLI_MAX_TEST_TIMEOUT_SECONDS}`);
    expect(payload.error['message']).not.toContain(missing);
  });
});
