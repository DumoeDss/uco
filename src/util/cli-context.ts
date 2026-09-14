// Shared CLI plumbing — resolves a transport from global options,
// runs a command body, and handles output / exit code uniformly.

import process from 'node:process';
import { Command } from 'commander';
import { RestTransport, type UnityCoTransport } from '../transport/index.js';
import { resolveConnection, type Resolved } from '../config/resolve.js';
import { printError, printInfo, printResult, type OutputContext } from './output.js';
import { CliError, TransportError } from './errors.js';
import { toolPayloadRecords } from './tool-payload.js';
import { MAX_TIMER_MILLISECONDS, parseBoundedInteger } from './timeout.js';
import { ToolCallControlError } from '../tool-call-control.js';
import { waitForEditorIdle } from './idle-wait.js';
import { inspectInitialOperationState, waitForDurableOperation } from './operation-wait.js';

export interface GlobalOptions {
  project?: string;
  url?: string;
  token?: string;
  json?: boolean;
  verbose?: boolean;
  timeout?: string;
  timeoutMs?: string;
  waitUntilIdle?: boolean;
  idleTimeoutMs?: string;
  wait?: boolean;
  waitTimeoutMs?: string;
}

export interface CommandContext {
  transport: UnityCoTransport;
  resolved: Resolved;
  output: OutputContext;
  timeoutMs: number;
}

export interface CommandContextOverrides {
  /** Command-local positional project. When defined, it wins over root --project. */
  project?: string;
}

export function buildContext(opts: GlobalOptions): CommandContext {
  const projectPath = opts.project ?? defaultProjectPathFromCwd();
  const resolved = resolveConnection({
    projectPath,
    url: opts.url,
    token: opts.token,
  });

  const timeoutMs = parseTimeout(
    opts.timeoutMs ?? opts.timeout,
    opts.timeoutMs !== undefined ? '--timeout-ms' : '--timeout',
  );

  const transport = new RestTransport({
    baseUrl: resolved.baseUrl,
    token: resolved.token,
    defaultTimeoutMs: timeoutMs,
  });

  return {
    transport,
    resolved,
    output: { json: Boolean(opts.json), verbose: Boolean(opts.verbose) },
    timeoutMs,
  };
}

/**
 * Wrap a command handler so all commands share the same output /
 * error / exit-code contract.
 */
export function runCommand<TArgs extends unknown[]>(
  cmd: Command,
  handler: (ctx: CommandContext, ...args: TArgs) => Promise<unknown> | unknown,
  contextOverrides?: CommandContextOverrides,
): (...args: TArgs) => Promise<void> {
  return async (...args: TArgs) => {
    const opts = mergeGlobalOptions(cmd);
    if (contextOverrides?.project !== undefined) {
      opts.project = contextOverrides.project;
    }
    let ctx: CommandContext;
    try {
      ctx = buildContext(opts);
    } catch (err) {
      printError({ json: Boolean(opts.json), verbose: Boolean(opts.verbose) }, err);
      await exitAfterFlush(1);
      return;
    }

    try {
      let result = await handler(ctx, ...args);
      const reportedFailure = toolReportedFailure(result);
      if (reportedFailure !== null) throw reportedFailure;
      if (opts.wait === true) {
        // Terminal-state wait for durable operations (COCli-03), with
        // graceful degradation (COCli-11): a durable handle is polled to its
        // terminal record; a response that already carries a terminal status
        // is mapped directly onto the exit map; a response with neither is
        // printed as-is with a hint instead of failing the whole invocation —
        // the tool call itself succeeded, only the wait protocol does not
        // apply (non-durable tool or an older plugin).
        const initial = inspectInitialOperationState(result);
        if (initial.operationId !== undefined) {
          const terminal = await waitForDurableOperation(ctx.transport, result, {
            timeoutMs: parseWaitTimeout(opts.waitTimeoutMs),
          });
          if (terminal.status === 'failed') {
            throw new CliError(
              `Editor operation '${terminal.operationId}' failed.`,
              'operation-failed',
              5,
              false,
              terminal.record,
            );
          }
          if (terminal.status === 'cancelled') {
            throw new CliError(
              `Editor operation '${terminal.operationId}' was cancelled.`,
              'operation-cancelled',
              6,
              false,
              terminal.record,
            );
          }
          if (terminal.status === 'interrupted') {
            throw new CliError(
              `Editor operation '${terminal.operationId}' was interrupted.`,
              'operation-interrupted',
              7,
              false,
              terminal.record,
            );
          }
          result = terminal.record;
        } else if (initial.terminalStatus === 'failed') {
          throw new CliError(
            'The tool reported a terminal failure in its response.',
            'operation-failed',
            5,
            false,
            result,
          );
        } else if (initial.terminalStatus === 'cancelled') {
          throw new CliError(
            'The tool reported a cancelled operation in its response.',
            'operation-cancelled',
            6,
            false,
            result,
          );
        } else if (initial.terminalStatus === 'interrupted') {
          throw new CliError(
            'The tool reported an interrupted operation in its response.',
            'operation-interrupted',
            7,
            false,
            result,
          );
        } else if (initial.terminalStatus === undefined) {
          printInfo(ctx.output,
            'Response carried no durable operation handle; --wait polls only durable operations. ' +
            'For non-durable tools poll the relevant surface instead (e.g. build-job-get, tests-job-list, editor-operation-get).');
        }
      }
      if (opts.waitUntilIdle === true) {
        // Opt-in post-call idle gate (COCli-05): hold the result until the
        // Editor stops compiling/importing/reloading, bounded by the caller's
        // timeout. A timeout fails the invocation naming the last blocker.
        await waitForEditorIdle(ctx.transport, {
          timeoutMs: parseIdleTimeout(opts.idleTimeoutMs),
          requestTimeoutMs: ctx.timeoutMs,
        });
      }
      if (result !== undefined) {
        printResult(ctx.output, result);
      }
    } catch (err) {
      printError(ctx.output, err);
      await exitAfterFlush(transportExitCode(err));
    }
  };
}

/**
 * Documented failure vocabulary for wrapper-position `status` members
 * (COCli-04). Values outside this vocabulary (success, queued, running,
 * pending, …) never flag a failure.
 */
const TOOL_FAILURE_STATUS_VOCABULARY = new Set(['error', 'failed']);

function toolReportedFailure(result: unknown): CliError | null {
  for (const payload of toolPayloadRecords(result)) {
    const failure = wrapperFailureDetail(payload);
    if (failure === null) continue;
    return new CliError(failure, 'tool-reported-failure', 5, false, payload);
  }
  return null;
}

/**
 * Detect an inner failure indicator at the bridge's known wrapper positions:
 * `ok`/`Ok` false, `isError`/`IsError` true, a `status`/`Status` in the
 * documented failure vocabulary, or an `error`/`Error` member carrying a
 * message or code. The scan stays bounded to wrapper records and never
 * recurses into arbitrary application data.
 */
function wrapperFailureDetail(payload: Record<string, unknown>): string | null {
  if (payload['Ok'] === false || payload['ok'] === false) {
    return detailMessage(payload) ?? 'Unity tool reported failure.';
  }
  if (payload['IsError'] === true || payload['isError'] === true) {
    return detailMessage(payload) ?? 'Unity tool reported an inner error (isError=true).';
  }
  for (const key of ['status', 'Status']) {
    const value = payload[key];
    if (typeof value === 'string' && TOOL_FAILURE_STATUS_VOCABULARY.has(value.toLowerCase())) {
      return detailMessage(payload) ?? `Unity tool reported failure status '${value}'.`;
    }
  }
  const errorMember = payload['Error'] ?? payload['error'];
  if (errorMember !== undefined && errorMember !== null) {
    if (typeof errorMember === 'string' && errorMember.trim().length > 0) {
      return errorMember;
    }
    if (typeof errorMember === 'object' && !Array.isArray(errorMember)) {
      const errorRecord = errorMember as Record<string, unknown>;
      const message = [errorRecord['message'], errorRecord['Message']]
        .find((value): value is string => typeof value === 'string' && value.trim().length > 0);
      const code = [errorRecord['code'], errorRecord['Code']]
        .find((value): value is string => typeof value === 'string' && value.trim().length > 0);
      if (message !== undefined || code !== undefined) {
        return message !== undefined && code !== undefined
          ? `${message} (${code})`
          : (message ?? `Unity tool reported error code '${code}'.`);
      }
    }
  }
  return null;
}

function detailMessage(payload: Record<string, unknown>): string | undefined {
  for (const key of ['Message', 'message']) {
    const value = payload[key];
    if (typeof value === 'string' && value.trim().length > 0) return value;
  }
  for (const key of ['Error', 'error']) {
    const value = payload[key];
    if (typeof value === 'string' && value.trim().length > 0) return value;
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const nested = value as Record<string, unknown>;
      const nestedMessage = [nested['message'], nested['Message']]
        .find((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0);
      if (nestedMessage !== undefined) return nestedMessage;
    }
  }
  return undefined;
}

function mergeGlobalOptions(cmd: Command): GlobalOptions {
  // Collect opts along the chain root → … → cmd so that a value parsed at a
  // deeper level (an option placed after the subcommand name, enabled by
  // enablePositionalOptions + the passthrough registrations) overrides the
  // root's value for the same key. The previous child → root walk let the
  // root's defaults clobber explicitly-passed subcommand values.
  const chain: Command[] = [];
  let current: Command | null = cmd;
  while (current) {
    chain.unshift(current);
    current = current.parent ?? null;
  }
  const collected: GlobalOptions = {};
  for (const node of chain) {
    Object.assign(collected, node.opts());
  }
  return collected;
}

function defaultProjectPathFromCwd(): string | undefined {
  // If the CWD looks like a Unity project, use it; otherwise let
  // resolveConnection() complain.
  const cwd = process.cwd();
  return cwd;
}

function parseTimeout(raw: string | undefined, option: string): number {
  if (!raw) return 60_000;
  return parseBoundedInteger(raw, {
    option,
    unit: 'milliseconds',
    maximum: MAX_TIMER_MILLISECONDS,
  });
}

const DEFAULT_IDLE_TIMEOUT_MS = 120_000;
const DEFAULT_OPERATION_WAIT_TIMEOUT_MS = 600_000;

function parseIdleTimeout(raw: string | undefined): number {
  if (!raw) return DEFAULT_IDLE_TIMEOUT_MS;
  return parseBoundedInteger(raw, {
    option: '--idle-timeout-ms',
    unit: 'milliseconds',
    maximum: MAX_TIMER_MILLISECONDS,
  });
}

function parseWaitTimeout(raw: string | undefined): number {
  if (!raw) return DEFAULT_OPERATION_WAIT_TIMEOUT_MS;
  return parseBoundedInteger(raw, {
    option: '--wait-timeout-ms',
    unit: 'milliseconds',
    maximum: MAX_TIMER_MILLISECONDS,
  });
}

/**
 * Documented exit-code map (docs/cli.md):
 *   0 success · 1 unexpected · 2 connection-refused · 3 timeout/wait-timeout/
 *   deadline-exceeded · 4 HTTP-level server rejection · 5 tool-reported
 *   failure (incl. detected inner failures) · 6 cancelled · 7 interrupted.
 */
function transportExitCode(err: unknown): number {
  if (err instanceof TransportError) {
    switch (err.kind) {
      case 'connection-refused':
        return 2;
      case 'timeout':
        return 3;
      case 'http':
        return 4;
      default:
        return 1;
    }
  }
  if (err instanceof ToolCallControlError) {
    switch (err.code) {
      case 'cancelled':
        return 6;
      case 'deadline_exceeded':
        return 3;
      case 'tool_execution_failed':
        return 5;
      default:
        // Any other structured server rejection (confirmation_required,
        // invalid_control, identity_mismatch, editor_not_ready, …) is an
        // HTTP-level rejection of the call.
        return 4;
    }
  }
  if (err instanceof CliError) return err.exitCode;
  return 1;
}

// Re-export so command files can use a single import.
export { CliError, TransportError };

/**
 * Exit after pending stdout/stderr writes flush. Calling process.exit() with a
 * pipe write still in flight aborts the process on Windows (libuv asserts on
 * the closing handle), which surfaces as exit code 0xC0000409 instead of the
 * documented code.
 */
function exitAfterFlush(code: number): Promise<never> {
  process.exitCode = code;
  const flush = (stream: NodeJS.WriteStream): Promise<void> => new Promise((resolve) => {
    if (stream.writableLength === 0) resolve();
    else stream.once('drain', () => resolve());
  });
  // Exiting exactly as a socket closes aborts the process on Windows
  // (0xC0000409) instead of reporting the documented code, so a process that
  // holds network handles gets one bounded settle window before the hard
  // exit. When no network handles are active (unit tests, pure-local
  // failures) the exit is immediate — mocked-timer environments never
  // observe a forced wait. The global fetch dispatcher is deliberately NOT
  // closed: it is process-global, and closing it would poison every later
  // fetch in host processes (test workers) that reuse this module.
  const active = typeof process.getActiveResourcesInfo === 'function'
    ? process.getActiveResourcesInfo()
    : [];
  const hasNetwork = active.some((resource) =>
    resource === 'TCPSocketWrap' || resource === 'TCPWrap' || resource === 'Socket');
  const drained = Promise.all([flush(process.stdout), flush(process.stderr)]);
  const settle = hasNetwork
    ? new Promise<void>((resolve) => setTimeout(resolve, 25).unref())
    : Promise.resolve();
  return Promise.race([drained.then(() => settle), new Promise<void>((resolve) => setTimeout(resolve, 1_000).unref())])
    .catch(() => undefined)
    .then(() => process.exit(code));
}
