import { Command } from 'commander';
import { CliError, runCommand } from '../../util/cli-context.js';
import {
  testProjectU,
  UNITY_CLI_TEST_TIMEOUT_MS,
  UNITY_CLI_MAX_TEST_TIMEOUT_SECONDS,
  type UnityCliOperationRunOptions,
  type UnityTestMode,
  type UnityTestOptions,
  type UnityTestResult,
} from '../../devops/utils/unity-cli.js';
import {
  parsePositiveBase10Integer,
  requireNonEmpty,
  requireOneOf,
  resolveUnityOperationProject,
  withOperationCancellation,
  type OperationSignalHost,
} from './_unity-operations.js';
import {
  lastCommandOption,
  restoreRootOption,
  scanCommandInvocation,
} from './_unity-command-line.js';

const ARCHITECTURES = ['x86_64', 'arm64'] as const;
const TEST_MODES = ['EditMode', 'PlayMode'] as const;
const DEFAULT_TEST_TIMEOUT_SECONDS = UNITY_CLI_TEST_TIMEOUT_MS / 1_000;

export interface TestCommandOptions {
  mode?: string;
  filter?: string;
  output?: string;
  editorVersion?: string;
  editorPath?: string;
  architecture?: string;
  allowInstall?: boolean;
  timeout?: string;
  timeoutSeconds?: string;
}

export interface UnityTestClient {
  testProjectU(
    options: UnityTestOptions,
    runOptions?: UnityCliOperationRunOptions,
  ): Promise<UnityTestResult>;
}

export interface TestExecutionDependencies {
  controller?: AbortController;
  signalHost?: OperationSignalHost;
}

export interface ParsedTestInvocation {
  project?: string;
  editorArgs: string[];
  timeout?: string;
}

const defaultTestClient: UnityTestClient = { testProjectU };

export function parseTestInvocation(
  command: Command,
  _commanderProject: string | undefined,
): ParsedTestInvocation {
  const invocation = scanCommandInvocation(command);
  if (invocation.positionals.length > 1) {
    throw new CliError(
      invocation.passthrough.length > 0
        ? 'Only one project positional may appear before the literal `--` delimiter.'
        : 'Raw Unity Editor arguments must follow a literal `--` delimiter.',
      'invalid-unity-editor-arguments',
    );
  }
  const timeout = lastCommandOption(invocation, 'timeout');
  return {
    ...(invocation.positionals[0] !== undefined ? { project: invocation.positionals[0] } : {}),
    editorArgs: invocation.passthrough,
    ...(typeof timeout === 'string' ? { timeout } : {}),
  };
}

function validatedTestOptions(
  project: string,
  options: TestCommandOptions,
  editorArgs: readonly string[],
): UnityTestOptions {
  const validated: UnityTestOptions = { project };
  if (options.mode !== undefined) {
    validated.mode = requireOneOf(options.mode, TEST_MODES, '--mode') as UnityTestMode;
  }
  if (options.filter !== undefined) {
    validated.filter = requireNonEmpty(options.filter, '--filter');
  }
  if (options.output !== undefined) {
    validated.output = requireNonEmpty(options.output, '--output');
  }
  if (options.editorVersion !== undefined) {
    validated.editorVersion = requireNonEmpty(options.editorVersion, '--editor-version');
  }
  if (options.editorPath !== undefined) {
    validated.editorPath = requireNonEmpty(options.editorPath, '--editor-path');
  }
  if (options.architecture !== undefined) {
    validated.architecture = requireOneOf(options.architecture, ARCHITECTURES, '--architecture');
  }
  if (options.allowInstall === true) validated.allowInstall = true;
  const timeout = options.timeoutSeconds ?? options.timeout;
  if (timeout !== undefined) {
    validated.timeoutSeconds = parsePositiveBase10Integer(
      timeout,
      options.timeoutSeconds !== undefined ? '--timeout-seconds <seconds>' : '--timeout <seconds>',
      UNITY_CLI_MAX_TEST_TIMEOUT_SECONDS,
    );
  }
  if (editorArgs.length > 0) validated.editorArgs = [...editorArgs];
  return validated;
}

export async function executeTest(
  positionalProject: string | undefined,
  options: TestCommandOptions,
  editorArgs: readonly string[],
  rootProject: string | undefined,
  client: UnityTestClient = defaultTestClient,
  dependencies: TestExecutionDependencies = {},
): Promise<UnityTestResult> {
  const project = resolveUnityOperationProject(positionalProject, rootProject);
  const testOptions = validatedTestOptions(project, options, editorArgs);
  const controller = dependencies.controller ?? new AbortController();
  const operation = (): Promise<UnityTestResult> => client.testProjectU(
    testOptions,
    { signal: controller.signal },
  );
  return dependencies.signalHost === undefined
    ? withOperationCancellation(controller, operation)
    : withOperationCancellation(controller, operation, dependencies.signalHost);
}

export function registerTest(
  program: Command,
  client: UnityTestClient = defaultTestClient,
): void {
  program
    .command('test [project]')
    .description('Run Unity Test Framework suites with the official Unity CLI (no Hub fallback).')
    .allowExcessArguments(true)
    .option('--mode <mode>', 'Test mode: EditMode or PlayMode')
    .option('--filter <filter>', 'Official Unity test filter (forwarded unchanged)')
    .option('--output <path>', 'Test report output path (forwarded unchanged)')
    .option('--editor-version <version>', 'Unity Editor version')
    .option('-e, --editor-path <path>', 'Unity Editor executable path (forwarded unchanged)')
    .option('-a, --architecture <architecture>', 'Editor architecture: x86_64 or arm64')
    .option('--allow-install', 'Allow the official CLI to install a required editor')
    .option(
      '--timeout <seconds>',
      `Deprecated alias for --timeout-seconds; seconds; default: ${DEFAULT_TEST_TIMEOUT_SECONDS}; range: 1-${UNITY_CLI_MAX_TEST_TIMEOUT_SECONDS}`,
    )
    .option(
      '--timeout-seconds <seconds>',
      `Official Unity test-process timeout in seconds (canonical; default: ${DEFAULT_TEST_TIMEOUT_SECONDS}; range: 1-${UNITY_CLI_MAX_TEST_TIMEOUT_SECONDS}; deprecated alias: --timeout; not root REST milliseconds)`,
    )
    .addHelpText('after', '\nRaw Unity Editor arguments are accepted only after a literal `--` and are preserved verbatim.')
    .action(function (this: Command, commanderProject: string | undefined, options: TestCommandOptions) {
      const scanned = scanCommandInvocation(this);
      // Keep Commander's established root-option intermixing. Only `test`
      // owns a timeout after the subcommand; restore the root prefix/default.
      restoreRootOption(this, scanned, 'timeout');
      return runCommand(this, async (ctx) => {
        const invocation = parseTestInvocation(this, commanderProject);
        return executeTest(
          invocation.project,
          { ...options, ...(invocation.timeout !== undefined && options.timeoutSeconds === undefined ? { timeout: invocation.timeout } : {}) },
          invocation.editorArgs,
          ctx.resolved.projectPath,
          client,
        );
      })();
    });
}
