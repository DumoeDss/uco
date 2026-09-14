import { constants as fsConstants } from 'node:fs';
import * as fsSync from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as readline from 'node:readline/promises';
import { CliError } from '../../util/errors.js';
import {
  createNodeUnityCliProcessAdapter,
  createUnityCli,
  type UnityCliProcessAdapter,
  type UnityCliProcessResult,
} from '../utils/unity-cli.js';

export const UNITY_CLI_INSTALLER_HOST = 'public-cdn.cloud.unity3d.com';
export const UNITY_CLI_SETUP_MAX_DOWNLOAD_BYTES = 2 * 1024 * 1024;
export const UNITY_CLI_SETUP_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
export const UNITY_CLI_SETUP_DOWNLOAD_TIMEOUT_MS = 30_000;
export const UNITY_CLI_SETUP_PROCESS_TIMEOUT_MS = 10 * 60_000;
export const UNITY_CLI_SETUP_MAX_REDIRECTS = 5;

export interface UnityCliInstallerMetadata {
  url: string;
  scriptName: 'install.ps1' | 'install.sh';
  executor: 'powershell' | 'bash';
  args: readonly string[];
}

export const UNITY_CLI_SETUP_INSTALLERS: Readonly<Partial<Record<NodeJS.Platform, UnityCliInstallerMetadata>>> = {
  win32: {
    url: 'https://public-cdn.cloud.unity3d.com/hub/prod/cli/install.ps1',
    scriptName: 'install.ps1',
    executor: 'powershell',
    args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File'],
  },
  darwin: {
    url: 'https://public-cdn.cloud.unity3d.com/hub/prod/cli/install.sh',
    scriptName: 'install.sh',
    executor: 'bash',
    args: [],
  },
  linux: {
    url: 'https://public-cdn.cloud.unity3d.com/hub/prod/cli/install.sh',
    scriptName: 'install.sh',
    executor: 'bash',
    args: [],
  },
};

export type SetupUnityCliErrorKind =
  | 'invalid-unity-cli-path'
  | 'unsupported-platform'
  | 'executor-not-found'
  | 'approval-required'
  | 'download-failed'
  | 'unsafe-response'
  | 'temporary-file-failed'
  | 'spawn-failed'
  | 'process-failed'
  | 'output-too-large'
  | 'timeout'
  | 'aborted';

export interface SetupUnityCliErrorFields {
  kind: SetupUnityCliErrorKind;
  message: string;
  cause?: unknown;
  status?: number;
  stdout?: string;
  stderr?: string;
  installerMayHaveChangedMachine?: boolean;
}

export class SetupUnityCliError extends CliError {
  readonly kind: SetupUnityCliErrorKind;
  readonly status: number | undefined;
  readonly stdout: string | undefined;
  readonly stderr: string | undefined;
  readonly installerMayHaveChangedMachine: boolean;

  constructor(fields: SetupUnityCliErrorFields) {
    super(fields.message, `setup-unity-cli-${fields.kind}`);
    this.name = 'SetupUnityCliError';
    this.kind = fields.kind;
    this.status = fields.status;
    this.stdout = fields.stdout;
    this.stderr = fields.stderr;
    this.installerMayHaveChangedMachine = fields.installerMayHaveChangedMachine ?? false;
    if (fields.cause !== undefined) this.cause = fields.cause;
  }

  toJSON(): Record<string, unknown> {
    return {
      error: true,
      kind: this.kind,
      code: this.code,
      message: this.message,
      ...(this.status !== undefined ? { status: this.status } : {}),
      ...(this.stdout ? { stdout: this.stdout } : {}),
      ...(this.stderr ? { stderr: this.stderr } : {}),
      ...(this.installerMayHaveChangedMachine
        ? { installerMayHaveChangedMachine: true }
        : {}),
    };
  }
}

export interface SetupUnityCliPlan {
  platform: NodeJS.Platform;
  installerUrl: string;
  executor: string;
  executorArgs: readonly string[];
  environment: { UNITY_CLI_CHANNEL: 'beta' };
  discovery:
    | {
        status: 'candidate-discovered';
        executable: string;
        verified: false;
        verification: 'planned: bounded unity --version outside dry-run';
      }
    | {
        status: 'not-found';
        executable: null;
        verified: false;
        verification: 'not-applicable';
      };
  verification: 'rediscover executable and run unity --version';
}

export type SetupUnityCliResult =
  | {
      success: true;
      status: 'already-installed';
      verified: true;
      executable: string;
      version: string;
    }
  | { success: true; status: 'planned'; dryRun: true; plan: SetupUnityCliPlan }
  | { success: true; status: 'cancelled'; installed: false }
  | {
      success: true;
      status: 'installed';
      verified: true;
      executable: string;
      version: string;
    }
  | {
      success: true;
      status: 'installed-restart-required';
      verified: false;
      nextSteps: readonly string[];
    };

export interface SetupUnityCliOptions {
  yes?: boolean;
  dryRun?: boolean;
  json?: boolean;
  interactive?: boolean;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
}

export interface SetupFetchResponse {
  ok: boolean;
  status: number;
  url: string;
  location?: string;
  contentLength?: number;
  body: AsyncIterable<Uint8Array> | null;
}

export type SetupFetchAdapter = (
  url: string,
  options: { signal: AbortSignal },
) => Promise<SetupFetchResponse>;

export interface SetupUnityCliDependencies {
  platform: NodeJS.Platform;
  environment: NodeJS.ProcessEnv;
  findUnityCli(): string | null;
  getUnityCliVersion(): string | null;
  resolveExecutor(platform: NodeJS.Platform, environment: NodeJS.ProcessEnv): string | null;
  prompt(message: string, signal?: AbortSignal): Promise<boolean>;
  fetchInstaller: SetupFetchAdapter;
  processAdapter: UnityCliProcessAdapter;
  createTempDirectory(): Promise<string>;
  writeInstaller(filePath: string, content: Uint8Array): Promise<void>;
  removeTempDirectory(directory: string): Promise<void>;
  limits: {
    downloadBytes: number;
    downloadTimeoutMs: number;
    processOutputBytes: number;
    processTimeoutMs: number;
  };
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function pathValue(environment: NodeJS.ProcessEnv): string | undefined {
  return environment['PATH'] ?? environment['Path'] ?? environment['path'];
}

function findExecutorOnPath(
  names: readonly string[],
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
): string | null {
  const candidates: string[] = [];
  if (platform === 'win32') {
    const systemRoot = environment['SystemRoot'] ?? environment['WINDIR'];
    if (systemRoot) {
      candidates.push(path.join(
        systemRoot,
        'System32',
        'WindowsPowerShell',
        'v1.0',
        'powershell.exe',
      ));
    }
  }
  const searchPath = pathValue(environment);
  if (searchPath) {
    const delimiter = platform === 'win32' ? ';' : ':';
    for (const directory of searchPath.split(delimiter)) {
      const normalized = directory.trim().replace(/^"(.*)"$/, '$1');
      if (!normalized) continue;
      for (const name of names) candidates.push(path.resolve(normalized, name));
    }
  }
  // This sync check avoids shell lookup: the exact executable path is passed to spawn.
  return candidates.find((candidate) => {
    try {
      fsSync.accessSync(candidate, fsConstants.X_OK);
      return true;
    } catch {
      return false;
    }
  }) ?? null;
}

function defaultResolveExecutor(
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
): string | null {
  if (platform === 'win32') {
    return findExecutorOnPath(['powershell.exe', 'pwsh.exe'], platform, environment);
  }
  return findExecutorOnPath(['bash'], platform, environment);
}

async function defaultPrompt(message: string, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return false;
  const terminal = readline.createInterface({ input: process.stdin, output: process.stderr });
  try {
    const prompt = `${message} [y/N] `;
    const answer = signal
      ? await terminal.question(prompt, { signal })
      : await terminal.question(prompt);
    return /^y(?:es)?$/i.test(answer.trim());
  } catch (error) {
    if (signal?.aborted) return false;
    throw error;
  } finally {
    terminal.close();
  }
}

const defaultFetchInstaller: SetupFetchAdapter = async (url, options) => {
  const response = await fetch(url, { signal: options.signal, redirect: 'manual' });
  const rawLength = response.headers.get('content-length');
  const parsedLength = rawLength === null ? undefined : Number(rawLength);
  return {
    ok: response.ok,
    status: response.status,
    url: response.url,
    ...(response.headers.get('location') !== null
      ? { location: response.headers.get('location')! }
      : {}),
    ...(Number.isFinite(parsedLength) ? { contentLength: parsedLength } : {}),
    body: response.body as unknown as AsyncIterable<Uint8Array> | null,
  };
};

function createProductionDependencies(): SetupUnityCliDependencies {
  const environment = process.env;
  const platform = process.platform;
  const unityCli = createUnityCli({ environment, platform });
  return {
    platform,
    environment,
    findUnityCli: unityCli.findUnityCli,
    getUnityCliVersion: unityCli.getUnityCliVersion,
    resolveExecutor: defaultResolveExecutor,
    prompt: defaultPrompt,
    fetchInstaller: defaultFetchInstaller,
    processAdapter: createNodeUnityCliProcessAdapter(),
    createTempDirectory: async () => {
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'uco-unity-cli-'));
      if (process.platform !== 'win32') await fs.chmod(directory, 0o700);
      return directory;
    },
    writeInstaller: async (filePath, content) => {
      await fs.writeFile(filePath, content, { mode: 0o600, flag: 'wx' });
    },
    removeTempDirectory: async (directory) => {
      await fs.rm(directory, { recursive: true, force: true });
    },
    limits: {
      downloadBytes: UNITY_CLI_SETUP_MAX_DOWNLOAD_BYTES,
      downloadTimeoutMs: UNITY_CLI_SETUP_DOWNLOAD_TIMEOUT_MS,
      processOutputBytes: UNITY_CLI_SETUP_MAX_OUTPUT_BYTES,
      processTimeoutMs: UNITY_CLI_SETUP_PROCESS_TIMEOUT_MS,
    },
  };
}

function validateInstallerUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:'
      && url.hostname === UNITY_CLI_INSTALLER_HOST
      && url.port === ''
      && url.username === ''
      && url.password === '';
  } catch {
    return false;
  }
}

const INSTALLER_ENVIRONMENT_COMMON = [
  'PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'SHELL', 'USER', 'LOGNAME',
  'LANG', 'LC_ALL', 'LC_CTYPE', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
  'HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'NO_PROXY',
  'https_proxy', 'http_proxy', 'all_proxy', 'no_proxy',
] as const;

const INSTALLER_ENVIRONMENT_WINDOWS = [
  'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'USERPROFILE', 'HOMEDRIVE',
  'HOMEPATH', 'LOCALAPPDATA', 'APPDATA', 'PROGRAMDATA', 'ProgramFiles',
  'ProgramFiles(x86)', 'ProgramW6432', 'PROCESSOR_ARCHITECTURE',
  'PROCESSOR_ARCHITEW6432', 'NUMBER_OF_PROCESSORS', 'PSModulePath',
] as const;

/** Build the minimal documented environment inherited by Unity's installer. */
export function createInstallerEnvironment(
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): NodeJS.ProcessEnv {
  const allowed = platform === 'win32'
    ? [...INSTALLER_ENVIRONMENT_COMMON, ...INSTALLER_ENVIRONMENT_WINDOWS]
    : [...INSTALLER_ENVIRONMENT_COMMON];
  const result: NodeJS.ProcessEnv = {};
  for (const name of allowed) {
    const entry = platform === 'win32'
      ? Object.entries(environment).find(([key]) => key.toLowerCase() === name.toLowerCase())
      : (environment[name] === undefined ? undefined : [name, environment[name]] as const);
    if (entry?.[1] !== undefined) result[name] = entry[1];
  }
  result['UNITY_CLI_CHANNEL'] = 'beta';
  return result;
}

function knownDiagnosticSecrets(environment: NodeJS.ProcessEnv): readonly string[] {
  const secretName = /(?:token|secret|password|passwd|api[_-]?key|private[_-]?key|credential|auth)/i;
  const proxyName = /^(?:https?|all)_proxy$/i;
  return Object.entries(environment)
    .filter(([name, value]) => value !== undefined
      && value.length > 0
      && (secretName.test(name) || (proxyName.test(name) && /:\/\/[^/]*@/.test(value))))
    .map(([, value]) => value!)
    .sort((a, b) => b.length - a.length);
}

function redactKnownSecrets(value: string, secrets: readonly string[]): string {
  return secrets.reduce(
    (redacted, secret) => redacted.split(secret).join('[REDACTED]'),
    value,
  );
}

function boundedDiagnostic(value: string, secrets: readonly string[]): string | undefined {
  const trimmed = redactKnownSecrets(value, secrets).trim();
  if (!trimmed) return undefined;
  return trimmed.length <= 16_384 ? trimmed : `${trimmed.slice(0, 16_384)}…`;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

async function downloadInstaller(
  metadata: UnityCliInstallerMetadata,
  options: SetupUnityCliOptions,
  dependencies: SetupUnityCliDependencies,
): Promise<Uint8Array> {
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = (): void => controller.abort();
  options.signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, dependencies.limits.downloadTimeoutMs);
  try {
    let requestUrl = metadata.url;
    const visitedUrls = new Set([new URL(requestUrl).href]);
    let redirectCount = 0;
    let response: SetupFetchResponse;
    while (true) {
      response = await dependencies.fetchInstaller(requestUrl, { signal: controller.signal });
      if (!validateInstallerUrl(response.url)
        || new URL(response.url).href !== new URL(requestUrl).href) {
        throw new SetupUnityCliError({
          kind: 'unsafe-response',
          message: `Unity installer response used an unexpected URL: ${response.url}`,
        });
      }
      if (!REDIRECT_STATUSES.has(response.status)) break;
      if (response.location === undefined) {
        throw new SetupUnityCliError({
          kind: 'unsafe-response',
          message: `Unity installer redirect HTTP ${response.status} did not include Location.`,
        });
      }
      if (redirectCount >= UNITY_CLI_SETUP_MAX_REDIRECTS) {
        throw new SetupUnityCliError({
          kind: 'unsafe-response',
          message: `Unity installer exceeded ${UNITY_CLI_SETUP_MAX_REDIRECTS} redirects.`,
        });
      }
      let redirectUrl: URL;
      try {
        redirectUrl = new URL(response.location, response.url);
      } catch (error) {
        throw new SetupUnityCliError({
          kind: 'unsafe-response',
          message: `Unity installer returned an invalid redirect: ${response.location}`,
          cause: error,
        });
      }
      if (!validateInstallerUrl(redirectUrl.href)) {
        throw new SetupUnityCliError({
          kind: 'unsafe-response',
          message: `Unity installer redirected outside the allowed HTTPS origin: ${redirectUrl.href}`,
        });
      }
      if (visitedUrls.has(redirectUrl.href)) {
        throw new SetupUnityCliError({
          kind: 'unsafe-response',
          message: `Unity installer redirect loop detected at: ${redirectUrl.href}`,
        });
      }
      visitedUrls.add(redirectUrl.href);
      redirectCount += 1;
      requestUrl = redirectUrl.href;
    }
    if (!response.ok) {
      throw new SetupUnityCliError({
        kind: 'download-failed',
        message: `Unity installer download returned HTTP ${response.status}.`,
        status: response.status,
      });
    }
    if (response.contentLength !== undefined
      && response.contentLength > dependencies.limits.downloadBytes) {
      throw new SetupUnityCliError({
        kind: 'unsafe-response',
        message: 'Unity installer response exceeds the configured byte limit.',
      });
    }
    if (response.body === null) {
      throw new SetupUnityCliError({ kind: 'unsafe-response', message: 'Unity installer response was empty.' });
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    for await (const chunk of response.body) {
      total += chunk.byteLength;
      if (total > dependencies.limits.downloadBytes) {
        controller.abort();
        throw new SetupUnityCliError({
          kind: 'unsafe-response',
          message: 'Unity installer response exceeds the configured byte limit.',
        });
      }
      chunks.push(chunk);
    }
    if (total === 0) {
      throw new SetupUnityCliError({ kind: 'unsafe-response', message: 'Unity installer response was empty.' });
    }
    return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total);
  } catch (error) {
    if (error instanceof SetupUnityCliError) throw error;
    if (options.signal?.aborted) {
      throw new SetupUnityCliError({ kind: 'aborted', message: 'Unity CLI setup was aborted.', cause: error });
    }
    if (timedOut) {
      throw new SetupUnityCliError({ kind: 'timeout', message: 'Unity installer download timed out.', cause: error });
    }
    throw new SetupUnityCliError({
      kind: 'download-failed',
      message: `Failed to download Unity's official installer: ${error instanceof Error ? error.message : String(error)}`,
      cause: error,
    });
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
  }
}

function processFailure(
  result: UnityCliProcessResult,
  environment: NodeJS.ProcessEnv,
): SetupUnityCliError | null {
  const secrets = knownDiagnosticSecrets(environment);
  const common = {
    stdout: boundedDiagnostic(result.stdout, secrets),
    stderr: boundedDiagnostic(result.stderr, secrets),
    installerMayHaveChangedMachine: true,
  };
  switch (result.failure) {
    case 'aborted':
      return new SetupUnityCliError({ kind: 'aborted', message: 'Unity installer execution was aborted.', ...common });
    case 'timeout':
      return new SetupUnityCliError({ kind: 'timeout', message: 'Unity installer execution timed out.', ...common });
    case 'output-too-large':
      return new SetupUnityCliError({
        kind: 'output-too-large',
        message: 'Unity installer output exceeded the configured limit.',
        ...common,
      });
    case 'spawn-failed':
      return new SetupUnityCliError({
        kind: 'spawn-failed',
        message: `Failed to start Unity's installer${result.cause ? `: ${redactKnownSecrets(result.cause.message, secrets)}` : '.'}`,
        ...common,
      });
    case undefined:
      break;
  }
  if (result.exitCode !== 0) {
    return new SetupUnityCliError({
      kind: 'process-failed',
      message: `Unity's installer exited with code ${result.exitCode ?? 'unknown'}. It may have made partial machine changes; inspect the bounded diagnostics and retry after correction.`,
      ...common,
    });
  }
  return null;
}

function planFor(
  platform: NodeJS.Platform,
  metadata: UnityCliInstallerMetadata,
  executor: string,
  discoveredExecutable: string | null,
): SetupUnityCliPlan {
  return {
    platform,
    installerUrl: metadata.url,
    executor,
    executorArgs: [...metadata.args, `<temporary-${metadata.scriptName}>`],
    environment: { UNITY_CLI_CHANNEL: 'beta' },
    discovery: discoveredExecutable === null
      ? {
          status: 'not-found',
          executable: null,
          verified: false,
          verification: 'not-applicable',
        }
      : {
          status: 'candidate-discovered',
          executable: discoveredExecutable,
          verified: false,
          verification: 'planned: bounded unity --version outside dry-run',
        },
    verification: 'rediscover executable and run unity --version',
  };
}

function resolveInstallerRuntime(
  dependencies: SetupUnityCliDependencies,
): { metadata: UnityCliInstallerMetadata; executor: string } {
  const metadata = UNITY_CLI_SETUP_INSTALLERS[dependencies.platform];
  if (metadata === undefined) {
    throw new SetupUnityCliError({
      kind: 'unsupported-platform',
      message: `Unsupported platform ${dependencies.platform}; Unity CLI setup supports Windows, macOS, and Linux.`,
    });
  }
  const executor = dependencies.resolveExecutor(dependencies.platform, dependencies.environment);
  if (executor === null) {
    throw new SetupUnityCliError({
      kind: 'executor-not-found',
      message: metadata.executor === 'powershell'
        ? 'Windows PowerShell was not found on PATH.'
        : 'bash was not found on PATH.',
    });
  }
  return { metadata, executor };
}

/** The currently documented beta CLI emits a bare SemVer `x.y.z-beta.n`. */
export function isOfficialUnityCliVersion(value: string): boolean {
  return /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-beta\.(0|[1-9]\d*)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(value);
}

/**
 * Discover, explicitly approve, acquire, run, and verify Unity's official CLI
 * installer. All external behavior has a production/test shared adapter seam.
 */
export async function setupUnityCli(
  options: SetupUnityCliOptions = {},
  dependencies: SetupUnityCliDependencies = createProductionDependencies(),
): Promise<SetupUnityCliResult> {
  const override = nonEmpty(dependencies.environment['UNITY_CLI_PATH']);
  const existing = dependencies.findUnityCli();
  if (existing === null && override !== undefined) {
    throw new SetupUnityCliError({
      kind: 'invalid-unity-cli-path',
      message: `UNITY_CLI_PATH is authoritative but is not runnable: ${override}. Fix it or unset UNITY_CLI_PATH before retrying.`,
    });
  }
  if (options.dryRun) {
    const { metadata, executor } = resolveInstallerRuntime(dependencies);
    return {
      success: true,
      status: 'planned',
      dryRun: true,
      plan: planFor(dependencies.platform, metadata, executor, existing),
    };
  }
  if (existing !== null) {
    const version = dependencies.getUnityCliVersion();
    if (version !== null && isOfficialUnityCliVersion(version)) {
      return {
        success: true,
        status: 'already-installed',
        verified: true,
        executable: existing,
        version,
      };
    }
    if (override !== undefined) {
      throw new SetupUnityCliError({
        kind: 'invalid-unity-cli-path',
        message: `UNITY_CLI_PATH is runnable but did not pass the bounded official Unity CLI --version check: ${override}. Fix it or unset UNITY_CLI_PATH before retrying.`,
      });
    }
  }
  const { metadata, executor } = resolveInstallerRuntime(dependencies);
  if (options.signal?.aborted) {
    throw new SetupUnityCliError({ kind: 'aborted', message: 'Unity CLI setup was aborted.' });
  }

  let approved = options.yes === true;
  if (!approved) {
    if (options.json || !options.interactive) {
      throw new SetupUnityCliError({
        kind: 'approval-required',
        message: `Approval is required before downloading and executing ${metadata.url}. Re-run with --yes to approve automation.`,
      });
    }
    approved = await dependencies.prompt(
      `Download and execute Unity's remote beta installer from ${metadata.url}?`,
      options.signal,
    );
    if (options.signal?.aborted) {
      throw new SetupUnityCliError({ kind: 'aborted', message: 'Unity CLI setup was aborted.' });
    }
    if (!approved) return { success: true, status: 'cancelled', installed: false };
  }

  options.onProgress?.(`Downloading Unity CLI installer from ${metadata.url}`);
  const content = await downloadInstaller(metadata, options, dependencies);
  let temporaryDirectory: string | undefined;
  try {
    try {
      temporaryDirectory = await dependencies.createTempDirectory();
      const scriptPath = path.join(temporaryDirectory, metadata.scriptName);
      await dependencies.writeInstaller(scriptPath, content);
      options.onProgress?.(`Executing Unity's ${metadata.scriptName} with the beta channel`);
      const installerEnvironment = createInstallerEnvironment(
        dependencies.environment,
        dependencies.platform,
      );
      const result = await dependencies.processAdapter.run({
        executable: executor,
        args: [...metadata.args, scriptPath],
        environment: installerEnvironment,
        timeoutMs: dependencies.limits.processTimeoutMs,
        maxOutputBytes: dependencies.limits.processOutputBytes,
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
      });
      const failure = processFailure(result, dependencies.environment);
      if (failure !== null) throw failure;
    } catch (error) {
      if (error instanceof SetupUnityCliError) throw error;
      throw new SetupUnityCliError({
        kind: 'temporary-file-failed',
        message: `Failed to prepare Unity's installer securely: ${error instanceof Error ? error.message : String(error)}`,
        cause: error,
      });
    }
  } finally {
    if (temporaryDirectory !== undefined) {
      try {
        await dependencies.removeTempDirectory(temporaryDirectory);
      } catch (error) {
        throw new SetupUnityCliError({
          kind: 'temporary-file-failed',
          message: `Failed to remove uco's temporary installer directory: ${temporaryDirectory}`,
          cause: error,
          installerMayHaveChangedMachine: true,
        });
      }
    }
  }

  const installed = dependencies.findUnityCli();
  const version = installed === null ? null : dependencies.getUnityCliVersion();
  if (installed !== null && version !== null && isOfficialUnityCliVersion(version)) {
    return {
      success: true,
      status: 'installed',
      verified: true,
      executable: installed,
      version,
    };
  }
  return {
    success: true,
    status: 'installed-restart-required',
    verified: false,
    nextSteps: [
      'Reopen your shell or update PATH.',
      'Run `unity --version` to verify the installation.',
    ],
  };
}
