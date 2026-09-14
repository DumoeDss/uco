// uco-owned adapter for the official (beta) Unity CLI.
//
// Keep beta process, envelope, and record details in this module so command
// callers only consume stable uco data. This file intentionally is not part
// of the package exports; active lifecycle callers reach it through the
// uco-owned routing module rather than depending on beta records directly.

import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { CliError } from '../../util/errors.js';

export const UNITY_CLI_DEFAULT_TIMEOUT_MS = 120_000;
export const UNITY_CLI_INSTALL_TIMEOUT_MS = 30 * 60_000;
export const UNITY_CLI_PROJECT_TIMEOUT_MS = 15 * 60_000;
export const UNITY_CLI_VERSION_TIMEOUT_MS = 5_000;
export const UNITY_CLI_BUILD_TIMEOUT_MS = 2 * 60 * 60_000;
export const UNITY_CLI_TEST_TIMEOUT_MS = 2 * 60 * 60_000;
export const UNITY_CLI_MAX_TIMEOUT_MS = 2_147_483_647;
export const UNITY_CLI_TEST_SETTLEMENT_MARGIN_MS = 5 * 60_000;
export const UNITY_CLI_MAX_TEST_TIMEOUT_SECONDS = Math.floor(
  (UNITY_CLI_MAX_TIMEOUT_MS - UNITY_CLI_TEST_SETTLEMENT_MARGIN_MS) / 1_000,
);
export const UNITY_CLI_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

const UNITY_CLI_VERSION_MAX_OUTPUT_BYTES = 64 * 1024;
const UNITY_CLI_DIAGNOSTIC_LIMIT = 16 * 1024;
const UNITY_CLI_TERMINATION_GRACE_MS = 1_000;
const REDACTED = '[REDACTED]';
const SENSITIVE_OPTIONS = new Set([
  '--android-keystore-base64',
  '--android-keystore-password',
  '--android-key-alias-password',
  '-accesstoken',
  '--access-token',
  '--token',
  '--authorization',
]);
const SENSITIVE_JSON_KEYS = new Set([
  'accesstoken', 'authorization', 'bearer', 'token', 'password', 'secret', 'apikey',
  'androidkeystorebase64', 'androidkeystorepassword', 'androidkeyaliaspassword',
]);

export type UnityCliErrorKind =
  | 'not-found'
  | 'spawn-failed'
  | 'timeout'
  | 'aborted'
  | 'output-too-large'
  | 'invalid-json'
  | 'invalid-envelope'
  | 'command-failed'
  | 'invalid-data';

export interface UnityCliDiagnostic {
  code?: string;
  message: string;
}

export interface UnityCliErrorFields {
  kind: UnityCliErrorKind;
  message?: string;
  executable?: string;
  args?: readonly string[];
  processExitCode?: number;
  processSignal?: string;
  stderr?: string;
  rawStdout?: string;
  officialCommand?: string;
  officialErrors?: readonly UnityCliDiagnostic[];
  warnings?: readonly UnityCliDiagnostic[];
  cause?: Error;
}

interface RedactedUnityCliErrorFields {
  args?: string[];
  stderr?: string;
  rawStdout?: string;
  officialCommand?: string;
  officialErrors?: UnityCliDiagnostic[];
  warnings?: UnityCliDiagnostic[];
  message?: string;
  causeMessage?: string;
}

function sensitiveValues(args: readonly string[] | undefined): string[] {
  if (args === undefined) return [];
  const values = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? '';
    const equals = arg.indexOf('=');
    const option = equals === -1 ? arg : arg.slice(0, equals);
    if (SENSITIVE_OPTIONS.has(option.toLowerCase())) {
      const value = equals === -1 ? args[index + 1] : arg.slice(equals + 1);
      if (value) values.add(value);
    }
    collectSensitiveValues(arg, values);
  }
  return [...values].sort((left, right) => right.length - left.length);
}

function collectSensitiveValues(value: string, values: Set<string>): void {
  for (const match of value.matchAll(/\bBearer\s+([^\s,;"']+)/gi)) {
    if (match[1]) values.add(match[1]);
  }
  for (const match of value.matchAll(/(?:[?&]|\b)(?:access_token|accessToken|token|api_key)=([^&#\s"']+)/gi)) {
    if (match[1]) {
      values.add(match[1]);
      try { values.add(decodeURIComponent(match[1])); } catch { /* keep encoded value */ }
    }
  }
  const trimmed = value.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return;
  try {
    collectSensitiveJson(JSON.parse(trimmed), values);
  } catch {
    // Non-JSON arguments are handled by option and text-pattern collection.
  }
}

function collectSensitiveJson(value: unknown, values: Set<string>, key?: string): void {
  if (key !== undefined && SENSITIVE_JSON_KEYS.has(key.replace(/[-_.\s]/g, '').toLowerCase())) {
    if (typeof value === 'string' && value) values.add(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectSensitiveJson(entry, values);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  for (const [entryKey, entryValue] of Object.entries(value as Record<string, unknown>)) {
    collectSensitiveJson(entryValue, values, entryKey);
  }
}

function redactText(value: string | undefined, secrets: readonly string[]): string | undefined {
  if (value === undefined) return undefined;
  return secrets.reduce(
    (redacted, secret) => {
      const jsonEscaped = JSON.stringify(secret).slice(1, -1);
      const rawRedacted = redacted.split(secret).join(REDACTED);
      return jsonEscaped === secret
        ? rawRedacted
        : rawRedacted.split(jsonEscaped).join(REDACTED);
    },
    value,
  );
}

function redactDiagnostics(
  diagnostics: readonly UnityCliDiagnostic[] | undefined,
  secrets: readonly string[],
): UnityCliDiagnostic[] | undefined {
  return diagnostics?.map((diagnostic) => ({
    ...(diagnostic.code !== undefined
      ? { code: redactText(diagnostic.code, secrets) ?? diagnostic.code }
      : {}),
    message: redactText(diagnostic.message, secrets) ?? diagnostic.message,
  }));
}

function redactErrorFields(fields: UnityCliErrorFields): RedactedUnityCliErrorFields {
  const secrets = sensitiveValues(fields.args);
  return {
    ...(fields.args !== undefined
      ? { args: fields.args.map((arg) => redactText(arg, secrets) ?? arg) }
      : {}),
    ...(fields.stderr !== undefined ? { stderr: redactText(fields.stderr, secrets) } : {}),
    ...(fields.rawStdout !== undefined ? { rawStdout: redactText(fields.rawStdout, secrets) } : {}),
    ...(fields.officialCommand !== undefined
      ? { officialCommand: redactText(fields.officialCommand, secrets) }
      : {}),
    ...(fields.officialErrors !== undefined
      ? { officialErrors: redactDiagnostics(fields.officialErrors, secrets) }
      : {}),
    ...(fields.warnings !== undefined
      ? { warnings: redactDiagnostics(fields.warnings, secrets) }
      : {}),
    ...(fields.message !== undefined ? { message: redactText(fields.message, secrets) } : {}),
    ...(fields.cause !== undefined ? { causeMessage: redactText(fields.cause.message, secrets) } : {}),
  };
}

function truncateDiagnostic(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (value.length <= UNITY_CLI_DIAGNOSTIC_LIMIT) return value;
  return `${value.slice(0, UNITY_CLI_DIAGNOSTIC_LIMIT)}…`;
}

function fallbackErrorMessage(kind: UnityCliErrorKind): string {
  switch (kind) {
    case 'not-found': return 'Official Unity CLI was not found.';
    case 'spawn-failed': return 'Failed to start the official Unity CLI.';
    case 'timeout': return 'Official Unity CLI command timed out.';
    case 'aborted': return 'Official Unity CLI command was aborted.';
    case 'output-too-large': return 'Official Unity CLI output exceeded the configured limit.';
    case 'invalid-json': return 'Official Unity CLI returned invalid JSON.';
    case 'invalid-envelope': return 'Official Unity CLI returned an incompatible JSON envelope.';
    case 'command-failed': return 'Official Unity CLI command failed.';
    case 'invalid-data': return 'Official Unity CLI returned invalid command data.';
  }
}

/** A stable uco error for official Unity CLI failures. */
export class UnityCliError extends CliError {
  readonly kind: UnityCliErrorKind;
  readonly executable: string | undefined;
  readonly args: readonly string[] | undefined;
  readonly processExitCode: number | undefined;
  readonly processSignal: string | undefined;
  readonly stderr: string | undefined;
  readonly rawStdout: string | undefined;
  readonly officialCommand: string | undefined;
  readonly officialErrors: readonly UnityCliDiagnostic[] | undefined;
  readonly warnings: readonly UnityCliDiagnostic[] | undefined;

  constructor(fields: UnityCliErrorFields) {
    const redacted = redactErrorFields(fields);
    const officialMessage = redacted.officialErrors
      ?.find((item) => item.message.trim())?.message.trim();
    const stderr = truncateDiagnostic(redacted.stderr?.trim());
    const rawStdout = truncateDiagnostic(redacted.rawStdout);
    const message = officialMessage
      ?? (stderr || undefined)
      ?? redacted.causeMessage
      ?? redacted.message
      ?? fallbackErrorMessage(fields.kind);

    super(message, `unity-cli-${fields.kind}`, 1);
    this.name = 'UnityCliError';
    this.kind = fields.kind;
    this.executable = fields.executable;
    this.args = redacted.args;
    this.processExitCode = fields.processExitCode;
    this.processSignal = fields.processSignal;
    this.stderr = stderr;
    this.rawStdout = rawStdout;
    this.officialCommand = redacted.officialCommand;
    this.officialErrors = redacted.officialErrors;
    this.warnings = redacted.warnings;
  }

  toJSON(): Record<string, unknown> {
    return {
      error: true,
      kind: this.kind,
      message: this.message,
      code: this.code,
      exitCode: this.exitCode,
      ...(this.executable !== undefined ? { executable: this.executable } : {}),
      ...(this.args !== undefined ? { args: this.args } : {}),
      ...(this.processExitCode !== undefined ? { processExitCode: this.processExitCode } : {}),
      ...(this.processSignal !== undefined ? { processSignal: this.processSignal } : {}),
      ...(this.stderr !== undefined ? { stderr: this.stderr } : {}),
      ...(this.rawStdout !== undefined ? { rawStdout: this.rawStdout } : {}),
      ...(this.officialCommand !== undefined ? { officialCommand: this.officialCommand } : {}),
      ...(this.officialErrors !== undefined ? { officialErrors: this.officialErrors } : {}),
      ...(this.warnings !== undefined ? { warnings: this.warnings } : {}),
    };
  }
}

export type UnityCliProcessFailure =
  | 'spawn-failed'
  | 'timeout'
  | 'aborted'
  | 'output-too-large';

export interface UnityCliProcessRequest {
  executable: string;
  args: readonly string[];
  timeoutMs: number;
  maxOutputBytes: number;
  /** Optional exact child environment for callers such as vendor installers. */
  environment?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

export interface UnityCliProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal?: string | null;
  failure?: UnityCliProcessFailure;
  cause?: Error;
}

/** @internal Injectable subprocess seam used by wrapper contract tests. */
export interface UnityCliProcessAdapter {
  run(request: UnityCliProcessRequest): Promise<UnityCliProcessResult>;
  runSync(request: UnityCliProcessRequest): UnityCliProcessResult;
}

function toBuffer(chunk: unknown): Buffer {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (typeof chunk === 'string') return Buffer.from(chunk, 'utf8');
  return Buffer.from(String(chunk), 'utf8');
}

function windowsTaskkillExecutable(): string {
  const systemRoot = process.env['SystemRoot'] ?? process.env['WINDIR'];
  return systemRoot
    ? path.join(systemRoot, 'System32', 'taskkill.exe')
    : 'taskkill.exe';
}

/**
 * Unity operations can launch package-manager/import worker descendants. Keep
 * the CLI in its own POSIX process group and terminate that group as a unit; on
 * Windows, taskkill /T is the closest built-in equivalent. A detached daemon
 * that deliberately leaves the group is outside this wrapper's ownership.
 */
function terminateProcessTree(
  child: ReturnType<typeof spawn>,
  force: boolean,
): void {
  const pid = child.pid;
  const signal: NodeJS.Signals = force ? 'SIGKILL' : 'SIGTERM';
  if (pid === undefined) {
    child.kill(signal);
    return;
  }

  if (process.platform === 'win32') {
    let fallbackUsed = false;
    const fallback = (): void => {
      if (fallbackUsed) return;
      fallbackUsed = true;
      child.kill(signal);
    };
    try {
      const killer = spawn(
        windowsTaskkillExecutable(),
        ['/PID', String(pid), '/T', ...(force ? ['/F'] : [])],
        { shell: false, windowsHide: true, stdio: 'ignore' },
      );
      killer.once('error', fallback);
      killer.once('close', (code) => {
        if (code !== 0) fallback();
      });
      killer.unref();
    } catch {
      fallback();
    }
    return;
  }

  try {
    process.kill(-pid, signal);
  } catch {
    child.kill(signal);
  }
}

const nodeProcessAdapter: UnityCliProcessAdapter = {
  run(request) {
    return new Promise((resolve) => {
      if (request.signal?.aborted) {
        resolve({ stdout: '', stderr: '', exitCode: null, failure: 'aborted' });
        return;
      }

      let stdout = '';
      let stderr = '';
      let outputBytes = 0;
      let completed = false;
      let failure: UnityCliProcessFailure | undefined;
      let cause: Error | undefined;
      let timer: NodeJS.Timeout | undefined;
      let forceTimer: NodeJS.Timeout | undefined;
      const stdoutDecoder = new StringDecoder('utf8');
      const stderrDecoder = new StringDecoder('utf8');
      let decodersEnded = false;

      const endDecoders = (): void => {
        if (decodersEnded) return;
        decodersEnded = true;
        stdout += stdoutDecoder.end();
        stderr += stderrDecoder.end();
      };

      const finish = (exitCode: number | null, processSignal?: string | null): void => {
        if (completed) return;
        completed = true;
        endDecoders();
        if (timer !== undefined) clearTimeout(timer);
        if (forceTimer !== undefined) clearTimeout(forceTimer);
        request.signal?.removeEventListener('abort', onAbort);
        resolve({
          stdout,
          stderr,
          exitCode,
          signal: processSignal,
          ...(failure !== undefined ? { failure } : {}),
          ...(cause !== undefined ? { cause } : {}),
        });
      };

      let child: ReturnType<typeof spawn>;
      const terminate = (kind: UnityCliProcessFailure): void => {
        if (completed || failure !== undefined) return;
        failure = kind;
        if (timer !== undefined) {
          clearTimeout(timer);
          timer = undefined;
        }
        terminateProcessTree(child, false);
        forceTimer = setTimeout(() => {
          terminateProcessTree(child, true);

          // A process can ignore signals or keep inherited pipe handles open in
          // descendants. Do not make caller settlement depend on a close event
          // after the bounded grace period.
          child.stdout?.destroy();
          child.stderr?.destroy();
          child.unref();
          finish(null);
        }, UNITY_CLI_TERMINATION_GRACE_MS);
      };
      const onAbort = (): void => terminate('aborted');

      try {
        child = spawn(request.executable, [...request.args], {
          shell: false,
          detached: process.platform !== 'win32',
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          ...(request.environment !== undefined ? { env: request.environment } : {}),
        });
      } catch (error) {
        cause = error instanceof Error ? error : new Error(String(error));
        failure = 'spawn-failed';
        finish(null);
        return;
      }

      const capture = (target: 'stdout' | 'stderr', chunk: unknown): void => {
        if (failure !== undefined) return;
        const bytes = toBuffer(chunk);
        const remainingBytes = request.maxOutputBytes - outputBytes;
        if (bytes.length > remainingBytes) {
          if (remainingBytes > 0) {
            const decoder = target === 'stdout' ? stdoutDecoder : stderrDecoder;
            const text = decoder.write(bytes.subarray(0, remainingBytes));
            if (target === 'stdout') stdout += text;
            else stderr += text;
            outputBytes += remainingBytes;
          }
          terminate('output-too-large');
          return;
        }
        outputBytes += bytes.length;
        const decoder = target === 'stdout' ? stdoutDecoder : stderrDecoder;
        const text = decoder.write(bytes);
        if (target === 'stdout') stdout += text;
        else stderr += text;
      };

      child.stdout?.on('data', (chunk) => capture('stdout', chunk));
      child.stderr?.on('data', (chunk) => capture('stderr', chunk));
      child.once('error', (error) => {
        cause = error;
        failure ??= 'spawn-failed';
        finish(null);
      });
      child.once('close', (code, processSignal) => finish(code, processSignal));
      request.signal?.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(() => terminate('timeout'), request.timeoutMs);
    });
  },

  runSync(request) {
    if (request.signal?.aborted) {
      return { stdout: '', stderr: '', exitCode: null, failure: 'aborted' };
    }

    try {
      const result = spawnSync(request.executable, [...request.args], {
        shell: false,
        windowsHide: true,
        encoding: 'utf8',
        timeout: request.timeoutMs,
        killSignal: 'SIGKILL',
        maxBuffer: request.maxOutputBytes,
        stdio: ['ignore', 'pipe', 'pipe'],
        ...(request.environment !== undefined ? { env: request.environment } : {}),
      });
      const error = result.error;
      const errorCode = (error as NodeJS.ErrnoException | undefined)?.code;
      const failure: UnityCliProcessFailure | undefined = errorCode === 'ETIMEDOUT'
        ? 'timeout'
        : errorCode === 'ENOBUFS'
          ? 'output-too-large'
          : error === undefined
            ? undefined
            : 'spawn-failed';
      return {
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
        exitCode: result.status,
        signal: result.signal,
        ...(failure !== undefined ? { failure } : {}),
        ...(error !== undefined ? { cause: error } : {}),
      };
    } catch (error) {
      return {
        stdout: '',
        stderr: '',
        exitCode: null,
        failure: 'spawn-failed',
        cause: error instanceof Error ? error : new Error(String(error)),
      };
    }
  },
};

/** @internal Production process adapter shared by bounded no-shell workflows. */
export function createNodeUnityCliProcessAdapter(): UnityCliProcessAdapter {
  return nodeProcessAdapter;
}

export interface UnityCliRunOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface UnityCliOperationRunOptions {
  signal?: AbortSignal;
}

export interface InstalledEditor {
  version: string;
  path: string;
  alias?: string;
  architecture?: string;
  modules: string[];
  isDefault: boolean;
}

export interface AvailableRelease {
  version: string;
  alias?: string;
  architecture?: string;
  installedPath?: string;
  isStable: boolean;
}

export type UnityCliArchitecture = 'x86_64' | 'arm64';

export interface InstallEditorOptions {
  modules?: readonly string[];
  architecture?: UnityCliArchitecture;
  changeset?: string;
  childModules?: boolean;
  force?: boolean;
  acceptEula?: boolean;
  resume?: boolean;
  noElevate?: boolean;
}

export interface CreateUnityProjectOptions {
  name: string;
  parent: string;
  editorVersion?: string;
  template?: string;
  architecture?: UnityCliArchitecture;
}

export type UnityAndroidExportType = 'apk' | 'aab' | 'android-studio-project';
export type UnityAndroidSymbolType = 'none' | 'public' | 'debugging';
export type UnityVersioningStrategy = 'semantic' | 'tag' | 'custom' | 'none';
export type UnityTestMode = 'EditMode' | 'PlayMode';

/** The beta CLI owns these data schemas; uco deliberately keeps them opaque. */
export type UnityBuildResult = unknown;
export type UnityTestResult = unknown;

export interface UnityBuildOptions {
  project: string;
  target: string;
  executeMethod: string;
  buildTargetGroup?: string;
  outputPath?: string;
  logFile?: string;
  editorVersion?: string;
  editorPath?: string;
  architecture?: UnityCliArchitecture;
  args?: string;
  allowInstall?: boolean;
  noTail?: boolean;
  androidExportType?: UnityAndroidExportType;
  androidKeystoreBase64?: string;
  androidKeystorePassword?: string;
  androidKeyAlias?: string;
  androidKeyAliasPassword?: string;
  androidTargetSdkVersion?: number;
  androidSymbolType?: UnityAndroidSymbolType;
  androidVersionCode?: number;
  versioningStrategy?: UnityVersioningStrategy;
  buildVersion?: string;
  allowDirtyBuild?: boolean;
}

export interface UnityTestOptions {
  project: string;
  mode?: UnityTestMode;
  filter?: string;
  output?: string;
  editorVersion?: string;
  editorPath?: string;
  architecture?: UnityCliArchitecture;
  allowInstall?: boolean;
  timeoutSeconds?: number;
  editorArgs?: readonly string[];
}

export interface UnityCli {
  findUnityCli(): string | null;
  getUnityCliVersion(): string | null;
  runUnityJson<T>(args: readonly string[], options?: UnityCliRunOptions): Promise<T>;
  installEditorU(
    version: string,
    modulesOrOptions?: readonly string[] | InstallEditorOptions,
  ): Promise<void>;
  listInstalledEditorsU(): Promise<InstalledEditor[]>;
  listAvailableReleasesU(): Promise<AvailableRelease[]>;
  createProjectU(options: CreateUnityProjectOptions): Promise<void>;
  buildProjectU(
    options: UnityBuildOptions,
    runOptions?: UnityCliOperationRunOptions,
  ): Promise<UnityBuildResult>;
  testProjectU(
    options: UnityTestOptions,
    runOptions?: UnityCliOperationRunOptions,
  ): Promise<UnityTestResult>;
}

export interface UnityCliFactoryOptions {
  processAdapter?: UnityCliProcessAdapter;
  environment?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  cwd?: () => string;
  isRunnableFile?: (candidate: string, platform: NodeJS.Platform) => boolean;
  /**
   * Bind every operation from this client to one already-selected executable.
   * `null` deliberately pins unavailability; omission keeps normal discovery.
   */
  pinnedExecutable?: string | null;
}

interface OfficialEnvelope {
  success: boolean;
  command?: string;
  data: unknown;
  errors?: UnityCliDiagnostic[];
  warnings?: UnityCliDiagnostic[];
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeDiagnostics(value: unknown): UnityCliDiagnostic[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const diagnostics: UnityCliDiagnostic[] = [];
  for (const item of value) {
    if (typeof item === 'string') {
      const message = nonEmptyString(item);
      if (message === undefined) return undefined;
      diagnostics.push({ message });
      continue;
    }
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return undefined;
    const record = item as Record<string, unknown>;
    const message = nonEmptyString(record['message']);
    const code = record['code'] === undefined ? undefined : nonEmptyString(record['code']);
    if (message === undefined || (record['code'] !== undefined && code === undefined)) return undefined;
    diagnostics.push({ ...(code !== undefined ? { code } : {}), message });
  }
  return diagnostics;
}

function parseEnvelope(value: unknown): OfficialEnvelope | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record['success'] !== 'boolean' || !Object.hasOwn(record, 'data')) return null;
  const command = record['command'] === undefined ? undefined : nonEmptyString(record['command']);
  if (record['command'] !== undefined && command === undefined) return null;
  const errors = record['errors'] === undefined ? undefined : normalizeDiagnostics(record['errors']);
  const warnings = record['warnings'] === undefined ? undefined : normalizeDiagnostics(record['warnings']);
  if (record['errors'] !== undefined && errors === undefined) return null;
  if (record['warnings'] !== undefined && warnings === undefined) return null;
  return {
    success: record['success'],
    data: record['data'],
    ...(command !== undefined ? { command } : {}),
    ...(errors !== undefined ? { errors } : {}),
    ...(warnings !== undefined ? { warnings } : {}),
  };
}

function parseOfficialOutput(rawStdout: string): { parsed: unknown; record?: number } {
  try {
    return { parsed: JSON.parse(rawStdout) };
  } catch (singleError) {
    const lines = rawStdout.split(/\r?\n/);
    const records: unknown[] = [];
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]?.trim();
      if (!line) continue;
      try {
        records.push(JSON.parse(line));
      } catch (lineError) {
        throw new Error(
          `Invalid JSONL record ${index + 1}: ${(lineError as Error).message}`,
          { cause: singleError },
        );
      }
    }
    if (records.length <= 1) throw singleError;
    for (let index = records.length - 1; index >= 0; index -= 1) {
      if (parseEnvelope(records[index]) !== null) return { parsed: records[index], record: index + 1 };
    }
    return { parsed: records[records.length - 1], record: records.length };
  }
}

// The wrapper constructs these as discrete option/value pairs. Normalization
// must not mistake a value which happens to look like a transport flag for an
// actual option occurrence (notably the intentionally opaque build --args).
const UNITY_CLI_VALUE_OPTIONS = new Set([
  '--format',
  '--module',
  '--os',
  '--architecture',
  '--changeset',
  '--path',
  '--editor-version',
  '--template',
  '--target',
  '--execute-method',
  '--build-target-group',
  '--output-path',
  '--log-file',
  '--editor-path',
  '--args',
  '--android-export-type',
  '--android-keystore-base64',
  '--android-keystore-password',
  '--android-key-alias',
  '--android-key-alias-password',
  '--android-target-sdk-version',
  '--android-symbol-type',
  '--android-version-code',
  '--versioning-strategy',
  '--build-version',
  '--mode',
  '--filter',
  '--output',
  '--timeout',
]);

function jsonArguments(args: readonly string[]): string[] {
  const delimiterIndex = args.indexOf('--');
  const commandArgs = delimiterIndex === -1 ? args : args.slice(0, delimiterIndex);
  const passthroughArgs = delimiterIndex === -1 ? [] : args.slice(delimiterIndex);
  const normalized: string[] = [];
  for (let index = 0; index < commandArgs.length; index += 1) {
    const arg = commandArgs[index];
    if (arg === '--json' || arg.startsWith('--format=')) continue;
    if (arg === '--format') {
      index += 1;
      continue;
    }
    normalized.push(arg);
    if (UNITY_CLI_VALUE_OPTIONS.has(arg) && index + 1 < commandArgs.length) {
      index += 1;
      normalized.push(commandArgs[index]!);
    }
  }
  normalized.push('--json');
  return [...normalized, ...passthroughArgs];
}

function forceFlag(args: readonly string[], flag: string): string[] {
  const delimiterIndex = args.indexOf('--');
  const commandArgs = delimiterIndex === -1 ? args : args.slice(0, delimiterIndex);
  const passthroughArgs = delimiterIndex === -1 ? [] : args.slice(delimiterIndex);
  const normalized: string[] = [];
  for (let index = 0; index < commandArgs.length; index += 1) {
    const arg = commandArgs[index]!;
    if (arg !== flag) normalized.push(arg);
    if (UNITY_CLI_VALUE_OPTIONS.has(arg) && index + 1 < commandArgs.length) {
      index += 1;
      normalized.push(commandArgs[index]!);
    }
  }
  return [...normalized, flag, ...passthroughArgs];
}

function defaultIsRunnableFile(candidate: string, platform: NodeJS.Platform): boolean {
  try {
    if (!fs.statSync(candidate).isFile()) return false;
    if (platform === 'win32') {
      const extension = path.extname(candidate).toLowerCase();
      return extension === '.exe' || extension === '.com';
    }
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function pathValue(environment: NodeJS.ProcessEnv, platform: NodeJS.Platform): string | undefined {
  if (platform !== 'win32') return environment['PATH'];
  const key = Object.keys(environment).find((candidate) => candidate.toLowerCase() === 'path');
  return key === undefined ? undefined : environment[key];
}

function windowsExtensions(environment: NodeJS.ProcessEnv): string[] {
  const key = Object.keys(environment).find((candidate) => candidate.toLowerCase() === 'pathext');
  const raw = key === undefined ? '.COM;.EXE;.BAT;.CMD' : environment[key];
  const extensions = (raw ?? '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map((extension) => extension.trim())
    .filter(Boolean)
    .map((extension) => extension.startsWith('.') ? extension : `.${extension}`)
    .filter((extension) => extension.toLowerCase() === '.exe' || extension.toLowerCase() === '.com');
  return extensions;
}

function requirePositiveTimeout(timeoutMs: number): void {
  if (
    !Number.isSafeInteger(timeoutMs)
    || timeoutMs <= 0
    || timeoutMs > UNITY_CLI_MAX_TIMEOUT_MS
  ) {
    throw new UnityCliError({
      kind: 'invalid-data',
      message: `Unity CLI timeout must be a positive integer no greater than ${UNITY_CLI_MAX_TIMEOUT_MS} milliseconds.`,
    });
  }
}

function processFailureError(
  result: UnityCliProcessResult,
  executable: string,
  args: readonly string[],
): UnityCliError | null {
  if (result.failure === undefined) return null;
  return new UnityCliError({
    kind: result.failure,
    executable,
    args,
    ...(result.exitCode !== null ? { processExitCode: result.exitCode } : {}),
    ...(result.signal ? { processSignal: result.signal } : {}),
    stderr: result.stderr,
    rawStdout: result.stdout,
    cause: result.cause,
  });
}

function invalidData(operation: string): UnityCliError {
  return new UnityCliError({
    kind: 'invalid-data',
    message: `Official Unity CLI returned invalid data for ${operation}.`,
  });
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined | null {
  if (record[key] === undefined || record[key] === null) return undefined;
  return nonEmptyString(record[key]) ?? null;
}

function normalizeModules(value: unknown): string[] | null {
  if (value === undefined || value === null || value === '') return [];
  if (typeof value === 'string') {
    return value.split(',').map((item) => item.trim()).filter(Boolean);
  }
  if (!Array.isArray(value)) return null;
  const modules: string[] = [];
  for (const item of value) {
    const module = nonEmptyString(item);
    if (module === undefined) return null;
    modules.push(module);
  }
  return modules;
}

function mapInstalledEditors(data: unknown): InstalledEditor[] {
  if (!Array.isArray(data)) throw invalidData('installed editor listing');
  return data.map((item) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      throw invalidData('installed editor listing');
    }
    const record = item as Record<string, unknown>;
    const version = nonEmptyString(record['version']);
    const editorPath = nonEmptyString(record['location']) ?? nonEmptyString(record['path']);
    const alias = optionalString(record, 'alias');
    const architecture = optionalString(record, 'architecture');
    const modules = normalizeModules(record['modules']);
    if (
      version === undefined
      || editorPath === undefined
      || alias === null
      || architecture === null
      || modules === null
      || (record['default'] !== undefined && typeof record['default'] !== 'boolean')
    ) {
      throw invalidData('installed editor listing');
    }
    return {
      version,
      path: editorPath,
      ...(alias !== undefined ? { alias } : {}),
      ...(architecture !== undefined ? { architecture } : {}),
      modules,
      isDefault: record['default'] === true,
    };
  });
}

function mapAvailableReleases(data: unknown): AvailableRelease[] {
  if (!Array.isArray(data)) throw invalidData('available release listing');
  return data.map((item) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      throw invalidData('available release listing');
    }
    const record = item as Record<string, unknown>;
    const version = nonEmptyString(record['version']);
    const alias = optionalString(record, 'alias');
    const architecture = optionalString(record, 'architecture');
    const installedPath = record['location'] === undefined
      ? optionalString(record, 'path')
      : optionalString(record, 'location');
    if (version === undefined || alias === null || architecture === null || installedPath === null) {
      throw invalidData('available release listing');
    }
    return {
      version,
      ...(alias !== undefined ? { alias } : {}),
      ...(architecture !== undefined ? { architecture } : {}),
      ...(installedPath !== undefined ? { installedPath } : {}),
      isStable: /f\d+$/i.test(version),
    };
  });
}

function requireArgument(value: string, label: string): string {
  const normalized = nonEmptyString(value);
  if (normalized === undefined) {
    throw new UnityCliError({ kind: 'invalid-data', message: `${label} must be a non-empty string.` });
  }
  return normalized;
}

function requirePreservedArgument(value: string, label: string): string {
  if (nonEmptyString(value) === undefined) {
    throw new UnityCliError({ kind: 'invalid-data', message: `${label} must be a non-empty string.` });
  }
  return value;
}

function requireArchitecture(value: string, label: string): UnityCliArchitecture {
  if (value !== 'x86_64' && value !== 'arm64') {
    throw new UnityCliError({
      kind: 'invalid-data',
      message: `${label} must be either x86_64 or arm64.`,
    });
  }
  return value;
}

function testOperationTimeoutMs(timeoutSeconds: number | undefined): number {
  if (timeoutSeconds === undefined) return UNITY_CLI_TEST_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(timeoutSeconds)
    || timeoutSeconds <= 0
    || timeoutSeconds > UNITY_CLI_MAX_TEST_TIMEOUT_SECONDS
  ) {
    throw new UnityCliError({
      kind: 'invalid-data',
      message: `Unity test timeout must be a positive integer no greater than ${UNITY_CLI_MAX_TEST_TIMEOUT_SECONDS} seconds.`,
    });
  }
  return Math.max(
    UNITY_CLI_TEST_TIMEOUT_MS,
    timeoutSeconds * 1_000 + UNITY_CLI_TEST_SETTLEMENT_MARGIN_MS,
  );
}

/**
 * @internal Creates a wrapper with injectable process/discovery dependencies.
 * Production callers should use the top-level facade functions below.
 */
export function createUnityCli(options: UnityCliFactoryOptions = {}): UnityCli {
  const processAdapter = options.processAdapter ?? nodeProcessAdapter;
  const environment = options.environment ?? process.env;
  const platform = options.platform ?? process.platform;
  const cwd = options.cwd ?? process.cwd;
  const isRunnableFile = options.isRunnableFile ?? defaultIsRunnableFile;
  const executableIsPinned = Object.prototype.hasOwnProperty.call(options, 'pinnedExecutable');

  const findUnityCli = (): string | null => {
    if (executableIsPinned) return options.pinnedExecutable ?? null;

    const override = nonEmptyString(environment['UNITY_CLI_PATH']);
    if (override !== undefined) {
      const candidate = path.resolve(cwd(), override);
      return isRunnableFile(candidate, platform) ? candidate : null;
    }

    const searchPath = pathValue(environment, platform);
    if (!searchPath) return null;
    const delimiter = platform === 'win32' ? ';' : ':';
    const executableNames = platform === 'win32'
      ? windowsExtensions(environment).map((extension) => `unity${extension}`)
      : ['unity'];

    for (const rawDirectory of searchPath.split(delimiter)) {
      const unquotedDirectory = rawDirectory.trim().replace(/^"(.*)"$/, '$1');
      const directory = path.resolve(cwd(), unquotedDirectory || '.');
      for (const executableName of executableNames) {
        const candidate = path.resolve(directory, executableName);
        if (isRunnableFile(candidate, platform)) return candidate;
      }
    }
    return null;
  };

  const getUnityCliVersion = (): string | null => {
    const executable = findUnityCli();
    if (executable === null) return null;
    try {
      const result = processAdapter.runSync({
        executable,
        args: ['--version'],
        timeoutMs: UNITY_CLI_VERSION_TIMEOUT_MS,
        maxOutputBytes: UNITY_CLI_VERSION_MAX_OUTPUT_BYTES,
      });
      if (result.failure !== undefined || result.exitCode !== 0) return null;
      return nonEmptyString(result.stdout) ?? null;
    } catch {
      return null;
    }
  };

  const runUnityJson = async <T>(
    args: readonly string[],
    runOptions: UnityCliRunOptions = {},
  ): Promise<T> => {
    const executable = findUnityCli();
    if (executable === null) {
      const override = nonEmptyString(environment['UNITY_CLI_PATH']);
      throw new UnityCliError({
        kind: 'not-found',
        message: override === undefined
          ? 'Official Unity CLI was not found on PATH.'
          : `UNITY_CLI_PATH does not name a runnable file: ${path.resolve(cwd(), override)}`,
      });
    }
    if (!args.every((arg) => typeof arg === 'string')) {
      throw new UnityCliError({ kind: 'invalid-data', message: 'Unity CLI arguments must be strings.' });
    }
    const timeoutMs = runOptions.timeoutMs ?? UNITY_CLI_DEFAULT_TIMEOUT_MS;
    requirePositiveTimeout(timeoutMs);
    const finalArgs = jsonArguments(args);
    if (runOptions.signal?.aborted) {
      throw new UnityCliError({ kind: 'aborted', executable, args: finalArgs });
    }

    let result: UnityCliProcessResult;
    try {
      result = await processAdapter.run({
        executable,
        args: finalArgs,
        timeoutMs,
        maxOutputBytes: UNITY_CLI_MAX_OUTPUT_BYTES,
        ...(runOptions.signal !== undefined ? { signal: runOptions.signal } : {}),
      });
    } catch (error) {
      throw new UnityCliError({
        kind: runOptions.signal?.aborted ? 'aborted' : 'spawn-failed',
        executable,
        args: finalArgs,
        cause: error instanceof Error ? error : new Error(String(error)),
      });
    }

    const processError = processFailureError(result, executable, finalArgs);
    if (processError !== null) throw processError;

    const rawStdout = result.stdout;
    if (!rawStdout.trim()) {
      throw new UnityCliError({
        kind: 'invalid-json', executable, args: finalArgs,
        ...(result.exitCode !== null ? { processExitCode: result.exitCode } : {}),
        ...(result.signal ? { processSignal: result.signal } : {}),
        stderr: result.stderr, rawStdout,
      });
    }

    let parsed: unknown;
    try {
      parsed = parseOfficialOutput(rawStdout).parsed;
    } catch (error) {
      throw new UnityCliError({
        kind: 'invalid-json', executable, args: finalArgs,
        ...(result.exitCode !== null ? { processExitCode: result.exitCode } : {}),
        ...(result.signal ? { processSignal: result.signal } : {}),
        stderr: result.stderr, rawStdout,
        cause: error instanceof Error ? error : undefined,
      });
    }

    const envelope = parseEnvelope(parsed);
    if (envelope === null) {
      throw new UnityCliError({
        kind: 'invalid-envelope', executable, args: finalArgs,
        ...(result.exitCode !== null ? { processExitCode: result.exitCode } : {}),
        ...(result.signal ? { processSignal: result.signal } : {}),
        stderr: result.stderr, rawStdout,
      });
    }

    if (!envelope.success || result.exitCode !== 0) {
      throw new UnityCliError({
        kind: 'command-failed', executable, args: finalArgs,
        ...(result.exitCode !== null ? { processExitCode: result.exitCode } : {}),
        ...(result.signal ? { processSignal: result.signal } : {}),
        stderr: result.stderr, rawStdout,
        officialCommand: envelope.command,
        officialErrors: envelope.errors,
        warnings: envelope.warnings,
      });
    }
    return envelope.data as T;
  };

  const installEditorU = async (
    version: string,
    modulesOrOptions: readonly string[] | InstallEditorOptions = [],
  ): Promise<void> => {
    const normalizedVersion = requireArgument(version, 'Unity editor version');
    const installOptions: InstallEditorOptions = Array.isArray(modulesOrOptions)
      ? { modules: modulesOrOptions }
      : modulesOrOptions as InstallEditorOptions;
    const normalizedModules = (installOptions.modules ?? [])
      .map((module) => requireArgument(module, 'Unity editor module'));
    const args = ['install', normalizedVersion];
    if (normalizedModules.length > 0) args.push('--module', ...normalizedModules);
    if (installOptions.architecture !== undefined) {
      args.push(
        '--architecture',
        requireArchitecture(installOptions.architecture, 'Unity editor architecture'),
      );
    }
    if (installOptions.changeset !== undefined) {
      args.push('--changeset', requireArgument(installOptions.changeset, 'Unity editor changeset'));
    }
    if (installOptions.childModules !== undefined) {
      args.push(installOptions.childModules ? '--cm' : '--no-cm');
    }
    if (installOptions.force === true) args.push('--force');
    if (installOptions.acceptEula === true) args.push('--accept-eula');
    if (installOptions.resume === true) args.push('--resume');
    if (installOptions.noElevate === true) args.push('--no-elevate');
    args.push('--non-interactive');
    await runUnityJson<unknown>(args, { timeoutMs: UNITY_CLI_INSTALL_TIMEOUT_MS });
  };

  const listInstalledEditorsU = async (): Promise<InstalledEditor[]> => {
    return mapInstalledEditors(await runUnityJson<unknown>(['editors', '-i']));
  };

  const listAvailableReleasesU = async (): Promise<AvailableRelease[]> => {
    return mapAvailableReleases(await runUnityJson<unknown>(['editors', '-r']));
  };

  const createProjectU = async (projectOptions: CreateUnityProjectOptions): Promise<void> => {
    const name = requireArgument(projectOptions.name, 'Unity project name');
    const parent = requireArgument(projectOptions.parent, 'Unity project parent directory');
    const args = ['projects', 'new', name, '--path', parent];
    if (projectOptions.editorVersion !== undefined) {
      args.push('--editor-version', requireArgument(projectOptions.editorVersion, 'Unity editor version'));
    }
    if (projectOptions.template !== undefined) {
      args.push('--template', requireArgument(projectOptions.template, 'Unity project template'));
    }
    if (projectOptions.architecture !== undefined) {
      args.push(
        '--architecture',
        requireArchitecture(projectOptions.architecture, 'Unity project architecture'),
      );
    }
    args.push('--non-interactive');
    await runUnityJson<unknown>(args, { timeoutMs: UNITY_CLI_PROJECT_TIMEOUT_MS });
  };

  const buildProjectU = async (
    buildOptions: UnityBuildOptions,
    operationOptions: UnityCliOperationRunOptions = {},
  ): Promise<UnityBuildResult> => {
    const args = [
      'build',
      requirePreservedArgument(buildOptions.project, 'Unity build project'),
      '--target',
      requirePreservedArgument(buildOptions.target, 'Unity build target'),
      '--execute-method',
      requirePreservedArgument(buildOptions.executeMethod, 'Unity build execute method'),
    ];
    if (buildOptions.buildTargetGroup !== undefined) {
      args.push('--build-target-group', requirePreservedArgument(
        buildOptions.buildTargetGroup,
        'Unity build target group',
      ));
    }
    if (buildOptions.outputPath !== undefined) {
      args.push('--output-path', requirePreservedArgument(buildOptions.outputPath, 'Unity build output path'));
    }
    if (buildOptions.logFile !== undefined) {
      args.push('--log-file', requirePreservedArgument(buildOptions.logFile, 'Unity build log file'));
    }
    if (buildOptions.editorVersion !== undefined) {
      args.push('--editor-version', requirePreservedArgument(
        buildOptions.editorVersion,
        'Unity build editor version',
      ));
    }
    if (buildOptions.editorPath !== undefined) {
      args.push('--editor-path', requirePreservedArgument(buildOptions.editorPath, 'Unity build editor path'));
    }
    if (buildOptions.architecture !== undefined) {
      args.push('--architecture', requireArchitecture(buildOptions.architecture, 'Unity build architecture'));
    }
    if (buildOptions.args !== undefined) {
      args.push('--args', requirePreservedArgument(buildOptions.args, 'Unity build arguments'));
    }
    if (buildOptions.allowInstall === true) args.push('--allow-install');
    if (buildOptions.noTail === true) args.push('--no-tail');
    if (buildOptions.androidExportType !== undefined) {
      args.push('--android-export-type', buildOptions.androidExportType);
    }
    if (buildOptions.androidKeystoreBase64 !== undefined) {
      args.push('--android-keystore-base64', requirePreservedArgument(
        buildOptions.androidKeystoreBase64,
        'Android keystore payload',
      ));
    }
    if (buildOptions.androidKeystorePassword !== undefined) {
      args.push('--android-keystore-password', requirePreservedArgument(
        buildOptions.androidKeystorePassword,
        'Android keystore password',
      ));
    }
    if (buildOptions.androidKeyAlias !== undefined) {
      args.push('--android-key-alias', requirePreservedArgument(
        buildOptions.androidKeyAlias,
        'Android key alias',
      ));
    }
    if (buildOptions.androidKeyAliasPassword !== undefined) {
      args.push('--android-key-alias-password', requirePreservedArgument(
        buildOptions.androidKeyAliasPassword,
        'Android key alias password',
      ));
    }
    if (buildOptions.androidTargetSdkVersion !== undefined) {
      args.push('--android-target-sdk-version', String(buildOptions.androidTargetSdkVersion));
    }
    if (buildOptions.androidSymbolType !== undefined) {
      args.push('--android-symbol-type', buildOptions.androidSymbolType);
    }
    if (buildOptions.androidVersionCode !== undefined) {
      args.push('--android-version-code', String(buildOptions.androidVersionCode));
    }
    if (buildOptions.versioningStrategy !== undefined) {
      args.push('--versioning-strategy', buildOptions.versioningStrategy);
    }
    if (buildOptions.buildVersion !== undefined) {
      args.push('--build-version', requirePreservedArgument(buildOptions.buildVersion, 'Unity build version'));
    }
    if (buildOptions.allowDirtyBuild === true) args.push('--allow-dirty-build');

    const jsonSafeArgs = forceFlag(forceFlag(args, '--non-interactive'), '--no-tail');
    return runUnityJson<UnityBuildResult>(jsonSafeArgs, {
      timeoutMs: UNITY_CLI_BUILD_TIMEOUT_MS,
      ...(operationOptions.signal !== undefined ? { signal: operationOptions.signal } : {}),
    });
  };

  const testProjectU = async (
    testOptions: UnityTestOptions,
    operationOptions: UnityCliOperationRunOptions = {},
  ): Promise<UnityTestResult> => {
    let args = [
      'test',
      requirePreservedArgument(testOptions.project, 'Unity test project'),
    ];
    if (testOptions.mode !== undefined) args.push('--mode', testOptions.mode);
    if (testOptions.filter !== undefined) {
      args.push('--filter', requirePreservedArgument(testOptions.filter, 'Unity test filter'));
    }
    if (testOptions.output !== undefined) {
      args.push('--output', requirePreservedArgument(testOptions.output, 'Unity test output'));
    }
    if (testOptions.editorVersion !== undefined) {
      args.push('--editor-version', requirePreservedArgument(
        testOptions.editorVersion,
        'Unity test editor version',
      ));
    }
    if (testOptions.editorPath !== undefined) {
      args.push('--editor-path', requirePreservedArgument(testOptions.editorPath, 'Unity test editor path'));
    }
    if (testOptions.architecture !== undefined) {
      args.push('--architecture', requireArchitecture(testOptions.architecture, 'Unity test architecture'));
    }
    if (testOptions.allowInstall === true) args.push('--allow-install');
    if (testOptions.timeoutSeconds !== undefined) {
      args.push('--timeout', String(testOptions.timeoutSeconds));
    }
    if ((testOptions.editorArgs?.length ?? 0) > 0) {
      args.push('--', ...testOptions.editorArgs!);
    }
    args = forceFlag(args, '--non-interactive');

    return runUnityJson<UnityTestResult>(args, {
      timeoutMs: testOperationTimeoutMs(testOptions.timeoutSeconds),
      ...(operationOptions.signal !== undefined ? { signal: operationOptions.signal } : {}),
    });
  };

  return {
    findUnityCli,
    getUnityCliVersion,
    runUnityJson,
    installEditorU,
    listInstalledEditorsU,
    listAvailableReleasesU,
    createProjectU,
    buildProjectU,
    testProjectU,
  };
}

const defaultUnityCli = createUnityCli();

export function findUnityCli(): string | null {
  return defaultUnityCli.findUnityCli();
}

export function getUnityCliVersion(): string | null {
  return defaultUnityCli.getUnityCliVersion();
}

export function runUnityJson<T>(args: readonly string[], options?: UnityCliRunOptions): Promise<T> {
  return defaultUnityCli.runUnityJson<T>(args, options);
}

export function installEditorU(version: string, modules?: readonly string[]): Promise<void>;
export function installEditorU(version: string, options?: InstallEditorOptions): Promise<void>;
export function installEditorU(
  version: string,
  modulesOrOptions?: readonly string[] | InstallEditorOptions,
): Promise<void> {
  return defaultUnityCli.installEditorU(version, modulesOrOptions);
}

export function listInstalledEditorsU(): Promise<InstalledEditor[]> {
  return defaultUnityCli.listInstalledEditorsU();
}

export function listAvailableReleasesU(): Promise<AvailableRelease[]> {
  return defaultUnityCli.listAvailableReleasesU();
}

export function createProjectU(options: CreateUnityProjectOptions): Promise<void> {
  return defaultUnityCli.createProjectU(options);
}

export function buildProjectU(
  options: UnityBuildOptions,
  runOptions?: UnityCliOperationRunOptions,
): Promise<UnityBuildResult> {
  return defaultUnityCli.buildProjectU(options, runOptions);
}

export function testProjectU(
  options: UnityTestOptions,
  runOptions?: UnityCliOperationRunOptions,
): Promise<UnityTestResult> {
  return defaultUnityCli.testProjectU(options, runOptions);
}
