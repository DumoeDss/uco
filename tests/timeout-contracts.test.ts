import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  MAX_TIMER_MILLISECONDS,
  MAX_TIMER_SECONDS,
  parseBoundedInteger,
} from '../src/util/timeout.js';
import { UNITY_CLI_MAX_TEST_TIMEOUT_SECONDS } from '../src/devops/utils/unity-cli.js';
import { coerceInteger } from '../src/codegen/coerce.js';
import { emitToolCommands } from '../src/codegen/emit.js';

function sourceCli(args: readonly string[]) {
  return spawnSync(process.execPath, ['--import', 'tsx', 'src/index.ts', ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
    shell: false,
  });
}

function normalizedHelp(args: readonly string[]): string {
  const result = sourceCli(args);
  expect(result.status, result.stderr).toBe(0);
  expect(result.stderr).toBe('');
  return result.stdout.replace(/\s+/g, ' ');
}

describe('timeout option contracts', () => {
  it('documents unit, default, range, and deprecated alias for every timeout option', () => {
    const root = normalizedHelp(['--help']);
    expect(root).toContain(`--timeout-ms <ms> Per-request timeout in milliseconds (canonical; default: 60000; range: 1-${MAX_TIMER_MILLISECONDS}; deprecated alias: --timeout)`);
    expect(root).toContain(`--timeout <ms> Deprecated alias for --timeout-ms; milliseconds; default: 60000; range: 1-${MAX_TIMER_MILLISECONDS}`);

    const wait = normalizedHelp(['wait-for-ready', '--help']);
    expect(wait).toContain(`--timeout-ms <ms> Maximum wait in milliseconds (canonical; default: 120000; range: 1-${MAX_TIMER_MILLISECONDS}; deprecated alias: --timeout)`);
    expect(wait).toContain(`--timeout <ms> Deprecated alias for --timeout-ms; milliseconds; default: 120000; range: 1-${MAX_TIMER_MILLISECONDS}`);

    const close = normalizedHelp(['close', '--help']);
    expect(close).toContain(`--timeout-seconds <seconds> Normal-close timeout in seconds (canonical; default: 30; range: 1-${MAX_TIMER_SECONDS}; deprecated alias: --timeout)`);
    expect(close).toContain(`--timeout <seconds> Deprecated alias for --timeout-seconds; seconds; default: 30; range: 1-${MAX_TIMER_SECONDS}`);

    const status = normalizedHelp(['status', '--help']);
    expect(status).toContain(`--timeout-ms <ms> Per-probe timeout in milliseconds (canonical; default: 5000; range: 1-${MAX_TIMER_MILLISECONDS}; deprecated alias: --timeout)`);
    expect(status).toContain(`--timeout <ms> Deprecated alias for --timeout-ms; milliseconds; default: 5000; range: 1-${MAX_TIMER_MILLISECONDS}`);

    const open = normalizedHelp(['open', '--help']);
    expect(open).toContain(`--launch-dismiss-timeout-ms <ms> Launch-error dismiss timeout in milliseconds (default: 30000; range: 1-${MAX_TIMER_MILLISECONDS})`);

    const test = normalizedHelp(['test', '--help']);
    expect(test).toContain(`--timeout-seconds <seconds> Official Unity test-process timeout in seconds (canonical; default: 7200; range: 1-${UNITY_CLI_MAX_TEST_TIMEOUT_SECONDS}; deprecated alias: --timeout;`);
    expect(test).toContain(`--timeout <seconds> Deprecated alias for --timeout-seconds; seconds; default: 7200; range: 1-${UNITY_CLI_MAX_TEST_TIMEOUT_SECONDS}`);

    const generated = normalizedHelp(['tests-run', '--help']);
    expect(generated).toMatch(/executionTimeoutSeconds.*seconds\. Default 1800; valid range 1\.\.86400/i);
    expect(generated).toMatch(/waitTimeoutSeconds.*seconds.*Default 10; valid range 1\.\.300/i);
  }, 20_000);

  it('uses one strict integer range validator at millisecond command boundaries', () => {
    const options = {
      option: '--timeout-ms',
      unit: 'milliseconds' as const,
      maximum: MAX_TIMER_MILLISECONDS,
    };
    expect(parseBoundedInteger('1', options)).toBe(1);
    expect(parseBoundedInteger(String(MAX_TIMER_MILLISECONDS), options)).toBe(MAX_TIMER_MILLISECONDS);
    for (const invalid of ['0', '-1', '1.5', 'NaN', String(MAX_TIMER_MILLISECONDS + 1)]) {
      expect(() => parseBoundedInteger(invalid, options)).toThrow(/Expected an integer in milliseconds/);
    }
  });

  it('requires generated integers to consume the full input and remain safe', () => {
    expect(coerceInteger('42')).toBe(42);
    expect(coerceInteger('+42')).toBe(42);
    for (const invalid of ['1.5', '10junk', '1e3', '', String(Number.MAX_SAFE_INTEGER + 1)]) {
      expect(() => coerceInteger(invalid)).toThrow(/Expected a safe integer/);
    }
  });

  it('emits schema minimum and maximum checks for generated integer options', () => {
    const output = emitToolCommands([{
      name: 'bounded-integer',
      enabled: true,
      inputSchema: {
        type: 'object',
        properties: {
          count: { type: 'integer', minimum: 2, maximum: 5 },
        },
      },
    }]);
    expect(output).toContain('.argParser((raw) => coerceInteger(raw, 2, 5))');
    expect(coerceInteger('2', 2, 5)).toBe(2);
    expect(coerceInteger('5', 2, 5)).toBe(5);
    expect(() => coerceInteger('1', 2, 5)).toThrow(/from 2 to 5/);
    expect(() => coerceInteger('6', 2, 5)).toThrow(/from 2 to 5/);
  });

  it.each([
    ['--executionTimeoutSeconds', '1.5', '1', '86400'],
    ['--executionTimeoutSeconds', '10junk', '1', '86400'],
    ['--executionTimeoutSeconds', '0', '1', '86400'],
    ['--executionTimeoutSeconds', '86401', '1', '86400'],
    ['--waitTimeoutSeconds', '1.5', '1', '300'],
    ['--waitTimeoutSeconds', '10junk', '1', '300'],
    ['--waitTimeoutSeconds', '0', '1', '300'],
    ['--waitTimeoutSeconds', '301', '1', '300'],
  ])('rejects invalid generated timeout %s=%s before transport', (flag, value, minimum, maximum) => {
    const result = sourceCli(['tests-run', flag, value]);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain(`Expected a safe integer from ${minimum} to ${maximum}`);
  });
});
