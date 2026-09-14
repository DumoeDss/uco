// uco wait-for-ready — require every bridge stage and an Editor probe.
//
// Useful in CI / `uco open && uco wait-for-ready && uco ...` chains.

import { Command } from 'commander';
import { runCommand, CliError } from '../../util/cli-context.js';
import { printInfo } from '../../util/output.js';
import { TransportError } from '../../util/errors.js';
import { MAX_TIMER_MILLISECONDS, parseBoundedInteger } from '../../util/timeout.js';
import {
  READINESS_STAGES,
  asRecord,
  editorReadiness,
  registrationReadiness,
  transportStage,
} from '../../util/readiness.js';

export { editorReadiness };

interface WaitOpts {
  timeout?: string;
  timeoutMs?: string;
  interval?: string;
  expectedProjectPath?: string;
  expectedInstanceId?: string;
  expectedPid?: string;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_INTERVAL_MS = 3_000;

export function registerWaitForReady(program: Command): void {
  program
    .command('wait-for-ready [project]')
    .description('Wait for Node, WebSocket, handshake/tool runner, idle Editor, and a read-only probe.')
    .option('--timeout-ms <ms>', `Maximum wait in milliseconds (canonical; default: ${DEFAULT_TIMEOUT_MS}; range: 1-${MAX_TIMER_MILLISECONDS}; deprecated alias: --timeout)`)
    .option('--timeout <ms>', `Deprecated alias for --timeout-ms; milliseconds; default: ${DEFAULT_TIMEOUT_MS}; range: 1-${MAX_TIMER_MILLISECONDS}`)
    .option('--interval <ms>', `Poll interval in milliseconds (default: ${DEFAULT_INTERVAL_MS}; range: 1-${MAX_TIMER_MILLISECONDS})`, String(DEFAULT_INTERVAL_MS))
    .option('--expected-project-path <path>', 'Fail the wait when the connected Editor reports a different project path.')
    .option('--expected-instance-id <id>', 'Fail the wait when the connected Editor reports a different stable instance id.')
    .option('--expected-pid <pid>', 'Fail the wait when the connected Editor runs under a different process id.')
    .action(function (this: Command, projectArg: string | undefined, opts: WaitOpts) {
      return runCommand(this, async (ctx) => {
        const timeoutRaw = opts.timeoutMs ?? opts.timeout ?? String(DEFAULT_TIMEOUT_MS);
        const timeoutMs = parseBoundedInteger(timeoutRaw, {
          option: opts.timeoutMs !== undefined ? '--timeout-ms' : '--timeout',
          unit: 'milliseconds',
          maximum: MAX_TIMER_MILLISECONDS,
        });
        const intervalMs = parseBoundedInteger(opts.interval ?? String(DEFAULT_INTERVAL_MS), {
          option: '--interval',
          unit: 'milliseconds',
          maximum: MAX_TIMER_MILLISECONDS,
          code: 'invalid-interval',
        });
        const expectedIdentity = parseExpectedIdentity(opts);

        const probeTimeout = Math.min(intervalMs, 10_000);
        const start = Date.now();
        const deadline = start + timeoutMs;
        const readyAtMs: Record<string, number> = {};
        let attempt = 0;
        let lastStage = 'process';
        let lastCause = 'not-started';
        let lastHealth: unknown;
        while (Date.now() < deadline) {
          attempt++;
          let activeStage = 'http';
          try {
            const health = await ctx.transport.health({
              timeoutMs: remainingProbeBudget(deadline, probeTimeout, activeStage),
            });
            lastHealth = health;
            observeHealthTimings(health, readyAtMs, Date.now() - start);
            const registration = registrationReadiness(health);
            if (!registration.ready) {
              lastStage = registration.stage;
              lastCause = registration.cause;
              throw new ReadinessPending(registration.stage, registration.cause);
            }

            // A pinned identity is verified as soon as the connection reports
            // its tuple: a mismatch fails the wait immediately with both tuples
            // rather than spinning to the timeout.
            const connectionBlock = asRecord(asRecord(health)?.['connection']);
            if (expectedIdentity !== undefined) {
              const identityFailure = identityFailureFor(connectionBlock, expectedIdentity);
              if (identityFailure !== undefined) throw identityFailure;
            }

            activeStage = 'editor';
            lastStage = activeStage;
            const state = await ctx.transport.callTool(
              'editor-application-get-state',
              {},
              { timeoutMs: remainingProbeBudget(deadline, probeTimeout, activeStage) },
            );
            const editor = editorReadiness(state);
            if (!editor.ready) {
              lastStage = editor.stage;
              lastCause = editor.cause;
              throw new ReadinessPending(editor.stage, editor.cause);
            }

            const elapsedMs = Date.now() - start;
            readyAtMs['editor'] ??= elapsedMs;
            readyAtMs['probe'] ??= elapsedMs;
            const healthRecord = asRecord(health);
            const connection = asRecord(healthRecord?.['connection']);
            const generation = healthRecord?.['generation']
              ?? connection?.['generation']
              ?? connection?.['id']
              ?? null;
            return {
              ok: true,
              ready: true,
              url: ctx.resolved.baseUrl,
              attempts: attempt,
              elapsedSeconds: seconds(elapsedMs),
              connection: connection ?? null,
              generation,
              stages: readinessResultStages(healthRecord?.['stages'], readyAtMs),
              timing: {
                totalElapsedMs: elapsedMs,
                totalElapsedSeconds: seconds(elapsedMs),
                stages: stageTimingResult(readyAtMs),
              },
            };
          } catch (err) {
            if (!(err instanceof TransportError) && !(err instanceof ReadinessPending)) throw err;
            if (err instanceof ReadinessPending) {
              lastStage = err.stage;
              lastCause = err.cause;
            } else {
              lastStage = activeStage === 'editor' || activeStage === 'probe'
                ? activeStage
                : transportStage(err);
              lastCause = err.kind;
            }
            const remainingMs = deadline - Date.now();
            const remainingS = Math.max(0, Math.ceil(remainingMs / 1000));
            printInfo(ctx.output, `attempt ${attempt}: ${lastStage}/${lastCause} (${remainingS}s left)`);
            const sleepMs = Math.min(intervalMs, Math.max(0, remainingMs));
            if (sleepMs <= 0) break;
            await new Promise((r) => setTimeout(r, sleepMs));
          }
        }
        const elapsedMs = Date.now() - start;
        const healthRecord = asRecord(lastHealth);
        const connection = asRecord(healthRecord?.['connection']);
        const generation = healthRecord?.['generation']
          ?? connection?.['generation']
          ?? connection?.['id']
          ?? null;
        throw new CliError(
          `Timed out after ${(timeoutMs / 1000).toFixed(1)}s waiting for ${lastStage}: ${lastCause}`,
          'wait-timeout',
          3,
          true,
          {
            stage: lastStage,
            cause: lastCause,
            attempts: attempt,
            connection: connection ?? null,
            generation,
            stages: readinessFailureStages(
              healthRecord?.['stages'],
              readyAtMs,
              lastStage,
              lastCause,
            ),
            timing: {
              totalElapsedMs: elapsedMs,
              totalElapsedSeconds: seconds(elapsedMs),
              stages: stageTimingResult(readyAtMs, true),
            },
          },
        );
      }, { project: projectArg })();
    });
}

class ReadinessPending extends Error {
  constructor(readonly stage: string, readonly cause: string) {
    super(`${stage}: ${cause}`);
  }
}

interface ExpectedIdentity {
  projectPath?: string;
  instanceId?: string;
  pid?: number;
}

function parseExpectedIdentity(opts: WaitOpts): ExpectedIdentity | undefined {
  if (opts.expectedProjectPath === undefined
    && opts.expectedInstanceId === undefined
    && opts.expectedPid === undefined) {
    return undefined;
  }
  let pid: number | undefined;
  if (opts.expectedPid !== undefined) {
    if (!/^[0-9]+$/.test(opts.expectedPid)) {
      throw new CliError('--expected-pid must be a positive integer', 'invalid_control');
    }
    pid = Number(opts.expectedPid);
    if (!Number.isSafeInteger(pid) || pid <= 0) {
      throw new CliError('--expected-pid must be a safe positive integer', 'invalid_control');
    }
  }
  return {
    ...(opts.expectedProjectPath === undefined ? {} : { projectPath: opts.expectedProjectPath }),
    ...(opts.expectedInstanceId === undefined ? {} : { instanceId: opts.expectedInstanceId }),
    ...(pid === undefined ? {} : { pid }),
  };
}

/**
 * Compare pinned identity against the health connection block. Returns the
 * wait-failure error (identity mismatch/unavailable with both tuples) or
 * undefined when the observed identity satisfies every pinned member.
 */
function identityFailureFor(
  connection: Record<string, unknown> | undefined,
  expected: ExpectedIdentity,
): CliError | undefined {
  if (connection === undefined) return undefined;
  const observed = {
    instanceId: connection['instanceId'] ?? null,
    projectPath: connection['projectPath'] ?? null,
    editorPid: connection['editorPid'] ?? null,
    unityVersion: connection['unityVersion'] ?? null,
  };

  const violations: Array<{ field: string; expected: unknown; observed: unknown }> = [];
  const unavailable: string[] = [];
  if (expected.instanceId !== undefined) {
    if (observed.instanceId === null) unavailable.push('expectedInstanceId');
    else if (observed.instanceId !== expected.instanceId) {
      violations.push({ field: 'expectedInstanceId', expected: expected.instanceId, observed: observed.instanceId });
    }
  }
  if (expected.projectPath !== undefined) {
    if (observed.projectPath === null) unavailable.push('expectedProjectPath');
    else if (!identityPathsEqual(expected.projectPath, observed.projectPath as string)) {
      violations.push({ field: 'expectedProjectPath', expected: expected.projectPath, observed: observed.projectPath });
    }
  }
  if (expected.pid !== undefined) {
    if (observed.editorPid === null) unavailable.push('expectedPid');
    else if (observed.editorPid !== expected.pid) {
      violations.push({ field: 'expectedPid', expected: expected.pid, observed: observed.editorPid });
    }
  }
  if (violations.length === 0 && unavailable.length === 0) return undefined;

  const expectedTuple = {
    ...(expected.projectPath === undefined ? {} : { projectPath: expected.projectPath }),
    ...(expected.instanceId === undefined ? {} : { instanceId: expected.instanceId }),
    ...(expected.pid === undefined ? {} : { editorPid: expected.pid }),
  };
  if (violations.length === 0) {
    return new CliError(
      `Connected Editor did not report the pinned identity member(s): ${unavailable.join(', ')}.`,
      'identity_unavailable',
      4,
      false,
      { expected: expectedTuple, observed },
    );
  }
  return new CliError(
    `Connected Editor does not match the pinned identity: ${violations
      .map((violation) => `${violation.field} expected ${JSON.stringify(violation.expected)}, observed ${JSON.stringify(violation.observed)}`)
      .join('; ')}.`,
    'identity_mismatch',
    4,
    false,
    { expected: expectedTuple, observed, violations },
  );
}

function identityPathsEqual(expected: string, observed: string): boolean {
  if (expected === observed) return true;
  if (process.platform !== 'win32') return false;
  return expected.toLowerCase() === observed.toLowerCase();
}

function remainingProbeBudget(deadline: number, probeLimitMs: number, stage: string): number {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) throw new ReadinessPending(stage, 'budget-exhausted');
  return Math.min(probeLimitMs, remainingMs);
}

function observeHealthTimings(value: unknown, readyAtMs: Record<string, number>, elapsedMs: number): void {
  const stages = asRecord(asRecord(value)?.['stages']);
  if (stages === undefined) return;
  for (const stage of READINESS_STAGES) {
    if (asRecord(stages[stage])?.['ready'] === true) readyAtMs[stage] ??= elapsedMs;
  }
}

function readinessResultStages(
  healthStages: unknown,
  readyAtMs: Record<string, number>,
): Record<string, unknown> {
  const source = asRecord(healthStages) ?? {};
  const result: Record<string, unknown> = {};
  for (const stage of READINESS_STAGES) {
    result[stage] = withTiming(asRecord(source[stage]) ?? { ready: true }, readyAtMs[stage] ?? 0);
  }
  result['editor'] = withTiming({ ready: true }, readyAtMs['editor'] ?? 0);
  result['probe'] = withTiming(
    { ready: true, tool: 'editor-application-get-state' },
    readyAtMs['probe'] ?? 0,
  );
  return result;
}

function stageTimingResult(
  readyAtMs: Record<string, number>,
  includePending = false,
): Record<string, unknown> {
  return Object.fromEntries(
    [...READINESS_STAGES, 'editor', 'probe'].map((stage) => [
      stage,
      readyAtMs[stage] === undefined && includePending
        ? { elapsedMs: null, elapsedSeconds: null }
        : { elapsedMs: readyAtMs[stage] ?? 0, elapsedSeconds: seconds(readyAtMs[stage] ?? 0) },
    ]),
  );
}

function readinessFailureStages(
  healthStages: unknown,
  readyAtMs: Record<string, number>,
  lastStage: string,
  lastCause: string,
): Record<string, unknown> {
  const source = asRecord(healthStages) ?? {};
  const result: Record<string, unknown> = {};
  for (const stage of READINESS_STAGES) {
    const entry = asRecord(source[stage]) ?? { ready: false, reason: 'not-observed' };
    result[stage] = readyAtMs[stage] === undefined
      ? { ...entry, elapsedMs: null, elapsedSeconds: null }
      : withTiming(entry, readyAtMs[stage]);
  }
  for (const stage of ['editor', 'probe']) {
    result[stage] = readyAtMs[stage] === undefined
      ? {
          ready: false,
          reason: lastStage === stage ? lastCause : 'not-reached',
          elapsedMs: null,
          elapsedSeconds: null,
        }
      : withTiming({ ready: true }, readyAtMs[stage]);
  }
  return result;
}

function withTiming(record: Record<string, unknown>, elapsedMs: number): Record<string, unknown> {
  return { ...record, elapsedMs, elapsedSeconds: seconds(elapsedMs) };
}

function seconds(milliseconds: number): number {
  return Number((milliseconds / 1000).toFixed(3));
}
