import { Command, Option } from 'commander';
import {
  ToolCallControlError,
  resolveToolCallControl,
  type ToolCallControl,
  type ToolCallConfirmation,
  type ToolCallDryRun,
  type ToolCallOptionValues,
} from '../tool-call-control.js';
import type { CallOptions } from '../transport/index.js';
import { CliError } from './errors.js';

/** Commander-facing names for the shared tool-call control fields. */
export interface ToolCallCliOptions {
  control?: string;
  /** Commander derives this spelling from `--request-id`. */
  requestId?: string;
  /** Backwards-compatible programmatic spelling used by library callers. */
  requestID?: string;
  callId?: string;
  correlationId?: string;
  parentCallId?: string;
  deadlineUnixMs?: string;
  /** Shorter compatibility alias for --deadline-unix-ms. */
  deadline?: string;
  cancellationId?: string;
  idempotencyKey?: string;
  confirm?: boolean;
  dryRun?: ToolCallDryRun;
  /** JSON token supplied by a prior confirmation response. */
  confirmation?: string | ToolCallConfirmation;
  expectedProjectPath?: string;
  expectedInstanceId?: string;
  expectedPid?: string;
}

/** Add control metadata options to a tool command without changing its schema. */
export function addToolCallControlOptions(command: Command): Command {
  return command
    .addOption(new Option('--control <json>', 'JSON control metadata (version-one fields and unknown members).'))
    .addOption(new Option('--request-id <id>', 'Compatibility/deferred-completion request id.'))
    .addOption(new Option('--call-id <id>', 'Logical tool-call id (stable across retries).'))
    .addOption(new Option('--correlation-id <id>', 'Top-level trace correlation id.'))
    .addOption(new Option('--parent-call-id <id>', 'Immediate parent logical call id.'))
    .addOption(new Option('--deadline-unix-ms <ms>', 'Absolute Unix timestamp deadline in milliseconds.').conflicts('deadline'))
    .addOption(new Option('--deadline <ms>', 'Alias for --deadline-unix-ms.').conflicts('deadlineUnixMs'))
    .addOption(new Option('--cancellation-id <id>', 'Opaque cancellation metadata.'))
    .addOption(new Option('--idempotency-key <key>', 'Opaque idempotency metadata.'))
    .addOption(new Option('--confirm', 'Approve a previously returned authoring confirmation record.'))
    .addOption(new Option('--dry-run <mode>', 'Authoring dry-run mode.').choices(['none', 'validate', 'plan']))
    .addOption(new Option('--confirmation <json>', 'JSON token returned by confirmation_required or dry-run plan.'))
    .addOption(new Option('--expected-project-path <path>', 'Fail closed unless the routed Editor reports this project path (identity constraint).'))
    .addOption(new Option('--expected-instance-id <id>', 'Fail closed unless the routed Editor reports this stable instance id (identity constraint).'))
    .addOption(new Option('--expected-pid <pid>', 'Fail closed unless the routed Editor runs under this process id (identity constraint).'))
    .addOption(new Option('--wait-until-idle', 'After the call returns, wait until the Editor stops compiling/importing/reloading (bounded by --idle-timeout-ms).'))
    .addOption(new Option('--idle-timeout-ms <ms>', 'Bound for --wait-until-idle in milliseconds (default: 120000).'))
    .addOption(new Option('--wait', 'When the call returns a durable operation handle, poll it to a terminal state and print the terminal envelope.'))
    .addOption(new Option('--wait-timeout-ms <ms>', 'Bound for --wait in milliseconds (default: 600000).'));
}

/** Convert Commander values to the transport's shared CallOptions shape. */
export function toolCallOptionsFromCli(options: ToolCallCliOptions): CallOptions {
  const control = parseControl(options.control);
  const deadlineRaw = options.deadlineUnixMs ?? options.deadline;
  const requestID = options.requestId ?? options.requestID;
  const confirmation = parseConfirmation(options.confirmation);
  const expectedPid = parseExpectedPid(options.expectedPid);
  const values: ToolCallOptionValues = {
    ...(control === undefined ? {} : { control }),
    ...(requestID === undefined ? {} : { requestID }),
    ...(options.callId === undefined ? {} : { callId: options.callId }),
    ...(options.correlationId === undefined ? {} : { correlationId: options.correlationId }),
    ...(options.parentCallId === undefined ? {} : { parentCallId: options.parentCallId }),
    ...(deadlineRaw === undefined ? {} : { deadlineUnixMs: parseDeadline(deadlineRaw) }),
    ...(options.cancellationId === undefined ? {} : { cancellationId: options.cancellationId }),
    ...(options.idempotencyKey === undefined ? {} : { idempotencyKey: options.idempotencyKey }),
    ...(options.confirm === undefined ? {} : { confirm: options.confirm }),
    ...(options.dryRun === undefined ? {} : { dryRun: options.dryRun }),
    ...(confirmation === undefined ? {} : { confirmation }),
    ...(options.expectedProjectPath === undefined ? {} : { expectedProjectPath: options.expectedProjectPath }),
    ...(options.expectedInstanceId === undefined ? {} : { expectedInstanceId: options.expectedInstanceId }),
    ...(expectedPid === undefined ? {} : { expectedPid }),
  };

  try {
    const resolved = resolveToolCallControl(values);
    if (resolved === undefined) return {};
    return {
      control: resolved,
      ...(requestID === undefined ? {} : { requestID }),
    };
  } catch (error) {
    if (error instanceof ToolCallControlError) {
      throw new CliError(error.message, error.code, 1, false, error.toStructuredError());
    }
    throw error;
  }
}

function parseConfirmation(raw: string | ToolCallConfirmation | undefined): ToolCallConfirmation | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) return raw;
  if (typeof raw !== 'string') {
    throw new CliError('--confirmation must contain a JSON object', 'invalid_control');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new CliError(
      `Invalid JSON in --confirmation: ${error instanceof Error ? error.message : String(error)}`,
      'invalid_control',
    );
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new CliError('--confirmation must contain a JSON object', 'invalid_control');
  }
  return parsed as ToolCallConfirmation;
}

function parseControl(raw: string | undefined): ToolCallControl | undefined {
  if (raw === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new CliError(
      `Invalid JSON in --control: ${error instanceof Error ? error.message : String(error)}`,
      'invalid_control',
    );
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new CliError('--control must contain a JSON object', 'invalid_control');
  }
  return parsed as ToolCallControl;
}

function parseDeadline(raw: string): number {
  if (!/^[0-9]+$/.test(raw)) {
    throw new CliError('--deadline-unix-ms must be a non-negative integer', 'invalid_control');
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new CliError('--deadline-unix-ms must be a safe non-negative integer', 'invalid_control');
  }
  return value;
}

function parseExpectedPid(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  if (!/^[0-9]+$/.test(raw)) {
    throw new CliError('--expected-pid must be a positive integer', 'invalid_control');
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new CliError('--expected-pid must be a safe positive integer', 'invalid_control');
  }
  return value;
}
