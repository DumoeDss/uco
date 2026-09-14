import { Command, Option } from 'commander';
import { CliError, runCommand } from '../../util/cli-context.js';
import {
  buildProjectU,
  type UnityAndroidExportType,
  type UnityAndroidSymbolType,
  type UnityBuildOptions,
  type UnityBuildResult,
  type UnityCliOperationRunOptions,
  type UnityVersioningStrategy,
} from '../../devops/utils/unity-cli.js';
import {
  parsePositiveBase10Integer,
  requireAndroidKeystoreDependencies,
  requireNonEmpty,
  requireOneOf,
  resolveUnityOperationProject,
  withOperationCancellation,
  type OperationSignalHost,
} from './_unity-operations.js';
import {
  commandOptionValues,
  lastCommandOption,
  restoreRootOptions,
  scanCommandInvocation,
} from './_unity-command-line.js';

const ARCHITECTURES = ['x86_64', 'arm64'] as const;
const ANDROID_EXPORT_TYPES = ['apk', 'aab', 'android-studio-project'] as const;
const ANDROID_SYMBOL_TYPES = ['none', 'public', 'debugging'] as const;
const VERSIONING_STRATEGIES = ['semantic', 'tag', 'custom', 'none'] as const;

const opaqueBuildArgsOption = new Option(
  '--args [arguments]',
  'Opaque official build argument string; do not place secrets here',
);
// Commander refuses an option-looking token as a required value. Parsing this
// one option as optional lets the ownership scanner consume that opaque token;
// keep the public help contract required because the action rejects omission.
opaqueBuildArgsOption.flags = '--args <arguments>';

export interface BuildCommandOptions {
  target?: string;
  executeMethod?: string;
  buildTargetGroup?: string;
  outputPath?: string;
  logFile?: string;
  editorVersion?: string;
  editorPath?: string;
  architecture?: string;
  args?: string;
  allowInstall?: boolean;
  tail?: boolean;
  androidExportType?: string;
  androidKeystoreBase64?: string;
  androidKeystorePassword?: string;
  androidKeyAlias?: string;
  androidKeyAliasPassword?: string;
  androidTargetSdkVersion?: string;
  androidSymbolType?: string;
  androidVersionCode?: string;
  versioningStrategy?: string;
  buildVersion?: string;
  allowDirtyBuild?: boolean;
}

export interface UnityBuildClient {
  buildProjectU(
    options: UnityBuildOptions,
    runOptions?: UnityCliOperationRunOptions,
  ): Promise<UnityBuildResult>;
}

export interface BuildExecutionDependencies {
  controller?: AbortController;
  signalHost?: OperationSignalHost;
}

const defaultBuildClient: UnityBuildClient = { buildProjectU };

function validatedBuildOptions(
  project: string,
  options: BuildCommandOptions,
): UnityBuildOptions {
  const validated: UnityBuildOptions = {
    project,
    target: requireNonEmpty(options.target ?? '', '--target'),
    executeMethod: requireNonEmpty(options.executeMethod ?? '', '--execute-method'),
    noTail: true,
  };
  if (options.buildTargetGroup !== undefined) {
    validated.buildTargetGroup = requireNonEmpty(options.buildTargetGroup, '--build-target-group');
  }
  if (options.outputPath !== undefined) {
    validated.outputPath = requireNonEmpty(options.outputPath, '--output-path');
  }
  if (options.logFile !== undefined) {
    validated.logFile = requireNonEmpty(options.logFile, '--log-file');
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
  if (options.args !== undefined) validated.args = requireNonEmpty(options.args, '--args');
  if (options.allowInstall === true) validated.allowInstall = true;
  if (options.androidExportType !== undefined) {
    validated.androidExportType = requireOneOf(
      options.androidExportType,
      ANDROID_EXPORT_TYPES,
      '--android-export-type',
    ) as UnityAndroidExportType;
  }
  if (options.androidKeystoreBase64 !== undefined) {
    validated.androidKeystoreBase64 = requireNonEmpty(
      options.androidKeystoreBase64,
      '--android-keystore-base64',
    );
  }
  if (options.androidKeystorePassword !== undefined) {
    validated.androidKeystorePassword = requireNonEmpty(
      options.androidKeystorePassword,
      '--android-keystore-password',
    );
  }
  if (options.androidKeyAlias !== undefined) {
    validated.androidKeyAlias = requireNonEmpty(options.androidKeyAlias, '--android-key-alias');
  }
  if (options.androidKeyAliasPassword !== undefined) {
    validated.androidKeyAliasPassword = requireNonEmpty(
      options.androidKeyAliasPassword,
      '--android-key-alias-password',
    );
  }
  if (options.androidTargetSdkVersion !== undefined) {
    validated.androidTargetSdkVersion = parsePositiveBase10Integer(
      options.androidTargetSdkVersion,
      '--android-target-sdk-version',
    );
  }
  if (options.androidSymbolType !== undefined) {
    validated.androidSymbolType = requireOneOf(
      options.androidSymbolType,
      ANDROID_SYMBOL_TYPES,
      '--android-symbol-type',
    ) as UnityAndroidSymbolType;
  }
  if (options.androidVersionCode !== undefined) {
    validated.androidVersionCode = parsePositiveBase10Integer(
      options.androidVersionCode,
      '--android-version-code',
    );
  }
  if (options.versioningStrategy !== undefined) {
    validated.versioningStrategy = requireOneOf(
      options.versioningStrategy,
      VERSIONING_STRATEGIES,
      '--versioning-strategy',
    ) as UnityVersioningStrategy;
  }
  if (options.buildVersion !== undefined) {
    validated.buildVersion = requireNonEmpty(options.buildVersion, '--build-version');
  }
  if (options.allowDirtyBuild === true) validated.allowDirtyBuild = true;
  requireAndroidKeystoreDependencies(validated);
  return validated;
}

export async function executeBuild(
  positionalProject: string | undefined,
  options: BuildCommandOptions,
  rootProject: string | undefined,
  client: UnityBuildClient = defaultBuildClient,
  dependencies: BuildExecutionDependencies = {},
): Promise<UnityBuildResult> {
  const project = resolveUnityOperationProject(positionalProject, rootProject);
  const buildOptions = validatedBuildOptions(project, options);
  const controller = dependencies.controller ?? new AbortController();
  const operation = (): Promise<UnityBuildResult> => client.buildProjectU(
    buildOptions,
    { signal: controller.signal },
  );
  return dependencies.signalHost === undefined
    ? withOperationCancellation(controller, operation)
    : withOperationCancellation(controller, operation, dependencies.signalHost);
}

export function registerBuild(
  program: Command,
  client: UnityBuildClient = defaultBuildClient,
): void {
  program
    .command('build [project]')
    .description('Build a Unity project with the official Unity CLI (no Hub fallback; live tail disabled).')
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .option('--target <target>', 'Build target (required; official Unity CLI value)')
    .option('--execute-method <method>', 'Static build method to execute (required)')
    .option('--build-target-group <group>', 'Unity build target group')
    .option('-o, --output-path <path>', 'Build artifact output path (forwarded unchanged)')
    .option('-l, --log-file <path>', 'Build log file path (forwarded unchanged)')
    .option('--editor-version <version>', 'Unity Editor version')
    .option('-e, --editor-path <path>', 'Unity Editor executable path (forwarded unchanged)')
    .option('-a, --architecture <architecture>', 'Editor architecture: x86_64 or arm64')
    .addOption(opaqueBuildArgsOption)
    .option('--allow-install', 'Allow the official CLI to install a required editor')
    .option('--no-tail', 'Disable live build-log tailing (uco always enforces this)')
    .option('--android-export-type <type>', 'Android export: apk, aab, or android-studio-project')
    .option('--android-keystore-base64 <base64>', 'Base64 Android keystore payload (redacted from errors)')
    .option('--android-keystore-password <password>', 'Android keystore password (redacted from errors)')
    .option('--android-key-alias <alias>', 'Android signing key alias')
    .option('--android-key-alias-password <password>', 'Android key alias password (redacted from errors)')
    .option('--android-target-sdk-version <version>', 'Positive Android target SDK integer')
    .option('--android-symbol-type <type>', 'Android symbols: none, public, or debugging')
    .option('--android-version-code <code>', 'Positive Android version code integer')
    .option('--versioning-strategy <strategy>', 'Versioning: semantic, tag, custom, or none')
    .option('--build-version <version>', 'Explicit build version')
    .option('--allow-dirty-build', 'Allow a build from a dirty working tree')
    .action(function (this: Command, project: string | undefined, _options: BuildCommandOptions) {
      const invocation = scanCommandInvocation(this, ['args']);
      // A separate opaque value such as `--args --json` is consumed by the root
      // parser before this action. Restore only genuine root option occurrences.
      restoreRootOptions(this, invocation);
      return runCommand(this, async (ctx) => {
        if (invocation.passthrough.length > 0) {
          throw new CliError(
            'Build does not accept arguments after a literal `--` delimiter.',
            'invalid-unity-build-arguments',
          );
        }
        if (invocation.unknownOptions.length > 0) {
          throw new CliError(
            `Unknown build option: ${invocation.unknownOptions[0]}`,
            'invalid-unity-build-option',
          );
        }
        if (invocation.positionals.length > 1) {
          throw new CliError(
            'Only one Unity project positional may be supplied to build.',
            'invalid-unity-build-arguments',
          );
        }
        const scannedArgs = lastCommandOption(invocation, 'args');
        const hasArgsOption = invocation.options.some(
          (option) => option.owner === 'command' && option.attribute === 'args',
        );
        if (hasArgsOption && typeof scannedArgs !== 'string') {
          throw new CliError('--args requires a value.', 'invalid-unity-build-arguments');
        }
        const resolvedOptions = commandOptionValues(invocation) as BuildCommandOptions;
        return executeBuild(
          invocation.positionals[0] ?? project,
          resolvedOptions,
          ctx.resolved.projectPath,
          client,
        );
      })();
    });
}
