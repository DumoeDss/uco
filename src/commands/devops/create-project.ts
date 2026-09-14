import * as fs from 'node:fs';
import * as path from 'node:path';
import { Command } from 'commander';
import { runCommand, CliError } from '../../util/cli-context.js';
import { printInfo } from '../../util/output.js';
import { progressLogger } from './_helpers.js';
import {
  findHighestLifecycleEditor,
  lifecycleBackendMetadata,
  selectUnityLifecycleSession,
  type UnityLifecycleSession,
  type UnityLifecycleSessionSelector,
} from '../../devops/lib/unity-lifecycle.js';
import type { UnityCliArchitecture } from '../../devops/utils/unity-cli.js';
import { installPlugin } from '../../devops/lib/install-plugin.js';
import type { InstallPluginOptions, InstallResult } from '../../devops/lib/types.js';
import { UCO_UNITY_PACKAGE_ID } from '../../devops/utils/manifest.js';
import { recordUnityInInstallManifest } from '../../skills/install-manifest.js';

export interface CreateProjectOptions {
  unity?: string;
  template?: string;
  architecture?: UnityCliArchitecture;
  pluginVersion?: string;
  skipPlugin?: boolean;
}

export type ProjectPluginInstaller = (options: InstallPluginOptions) => Promise<InstallResult>;

export class ProjectCreatedPluginInstallError extends CliError {
  readonly projectPath: string;
  readonly editorVersion: string;
  readonly backendMetadata: Record<string, unknown>;
  readonly packageId = UCO_UNITY_PACKAGE_ID;
  readonly retryCommand: string;
  readonly underlyingCause: Error;

  constructor(fields: {
    projectPath: string;
    editorVersion: string;
    backendMetadata: Record<string, unknown>;
    pluginVersion?: string;
    cause: Error;
  }) {
    const retryCommand = [
      'uco install-plugin',
      JSON.stringify(fields.projectPath),
      ...(fields.pluginVersion !== undefined
        ? ['--version', JSON.stringify(fields.pluginVersion)]
        : []),
    ].join(' ');
    super(
      `Project was created at ${fields.projectPath}, but ${UCO_UNITY_PACKAGE_ID} installation failed: ${fields.cause.message}. Retry with: ${retryCommand}`,
      'project-created-plugin-install-failed',
    );
    this.name = 'ProjectCreatedPluginInstallError';
    this.projectPath = fields.projectPath;
    this.editorVersion = fields.editorVersion;
    this.backendMetadata = fields.backendMetadata;
    this.retryCommand = retryCommand;
    this.underlyingCause = fields.cause;
  }

  toJSON(): Record<string, unknown> {
    return {
      error: true,
      kind: 'project-created-plugin-install-failed',
      code: this.code,
      message: this.message,
      projectCreated: true,
      projectPath: this.projectPath,
      editorVersion: this.editorVersion,
      ...this.backendMetadata,
      packageId: this.packageId,
      cause: this.underlyingCause.message,
      retryCommand: this.retryCommand,
    };
  }
}

/**
 * Whether the resolved project path is absolute and looks like a real Unity
 * project on disk (an `Assets/` or `Packages/` directory exists). The install
 * manifest recording is skipped otherwise: a scripted or partially-failed
 * creation must not leave `.uco/` litter at an arbitrary path.
 */
function isRecordableUnityProject(projectPath: string): boolean {
  return path.isAbsolute(projectPath)
    && (fs.existsSync(path.join(projectPath, 'Assets'))
      || fs.existsSync(path.join(projectPath, 'Packages')));
}

export function validateCreateProjectPluginOptions(options: CreateProjectOptions): string | undefined {
  if (options.skipPlugin && options.pluginVersion !== undefined) {
    throw new CliError(
      '--skip-plugin cannot be combined with --plugin-version.',
      'invalid-plugin-options',
    );
  }
  if (options.pluginVersion !== undefined) {
    const version = options.pluginVersion.trim();
    if (!version) {
      throw new CliError('--plugin-version must not be empty.', 'invalid-plugin-version');
    }
    return version;
  }
  return undefined;
}

export async function executeCreateProject(
  positionalPath: string,
  options: CreateProjectOptions,
  session: UnityLifecycleSession,
  pluginInstaller: ProjectPluginInstaller = installPlugin,
): Promise<Record<string, unknown>> {
  const projectPath = path.resolve(positionalPath);
  const pluginVersion = validateCreateProjectPluginOptions(options);
  session.validateCreateOptions({
    projectPath,
    ...(options.unity !== undefined ? { editorVersion: options.unity } : {}),
    ...(options.template !== undefined ? { template: options.template } : {}),
    ...(options.architecture !== undefined ? { architecture: options.architecture } : {}),
  });

  let editorVersion = options.unity;
  if (!editorVersion) {
    const highest = findHighestLifecycleEditor(await session.listInstalledEditors());
    if (highest === null) {
      throw new CliError(
        'No Unity editors installed. Run `uco install-unity` first.',
        'no-editors',
      );
    }
    editorVersion = highest.version;
  }

  await session.createProject({
    projectPath,
    editorVersion,
    ...(options.template !== undefined ? { template: options.template } : {}),
    ...(options.architecture !== undefined ? { architecture: options.architecture } : {}),
  });

  const backendMetadata = lifecycleBackendMetadata(session);
  if (options.skipPlugin) {
    return {
      created: true,
      projectPath,
      editorVersion,
      ...backendMetadata,
      plugin: { status: 'skipped', packageId: UCO_UNITY_PACKAGE_ID },
    };
  }

  const pluginResult = await pluginInstaller({
    unityProjectPath: projectPath,
    ...(pluginVersion !== undefined ? { version: pluginVersion } : {}),
  });
  if (pluginResult.kind === 'failure') {
    throw new ProjectCreatedPluginInstallError({
      projectPath,
      editorVersion,
      backendMetadata,
      ...(pluginVersion !== undefined ? { pluginVersion } : {}),
      cause: pluginResult.error,
    });
  }

  // Record the Unity surface in the install manifest. create-project installs
  // the plugin from the OpenUPM registry (a version, not the uco bundle), so
  // the resolved version is recorded as the user-managed source. Fails open.
  // Guarded: only an absolute path that actually looks like a Unity project
  // (an `Assets/` or `Packages/` directory on disk) is recorded — the
  // recording must never conjure `.uco/` directories under a relative or
  // junk path (scripted callers, partially-failed creations).
  if (isRecordableUnityProject(projectPath)) {
    recordUnityInInstallManifest(projectPath, {
      installed: true,
      source: pluginResult.installedVersion,
      projectPath,
    });
  }

  return {
    created: true,
    projectPath,
    editorVersion,
    ...backendMetadata,
    plugin: {
      status: 'installed',
      packageId: UCO_UNITY_PACKAGE_ID,
      version: pluginResult.installedVersion,
      manifestPath: pluginResult.manifestPath,
      modified: pluginResult.modified,
    },
  };
}

export function registerCreateProject(
  program: Command,
  selectSession: UnityLifecycleSessionSelector = selectUnityLifecycleSession,
  pluginInstaller: ProjectPluginInstaller = installPlugin,
): void {
  program
    .command('create-project <path>')
    .description('Create a new Unity project at the given path.')
    .option('--unity <version>', 'Unity Editor version (default: highest installed)')
    .option('--template <template>', 'Official Unity project template identifier')
    .option('--architecture <architecture>', 'Project architecture: x86_64 or arm64')
    .option('--plugin-version <version>', `Exact ${UCO_UNITY_PACKAGE_ID} version (skips latest lookup)`)
    .option('--skip-plugin', 'Create the project without installing the uco Unity package')
    .action(function (this: Command, positionalPath: string, opts: CreateProjectOptions) {
      return runCommand(this, async (ctx) => {
        validateCreateProjectPluginOptions(opts);
        const session = selectSession({ silent: ctx.output.json });
        if (session.decision.fallback) {
          printInfo(
            ctx.output,
            'Official Unity CLI was not found; using Unity Hub. Install the official `unity` CLI to enable native project options.',
          );
        }
        return executeCreateProject(
          positionalPath,
          opts,
          session,
          (pluginOptions) => pluginInstaller({
            ...pluginOptions,
            onProgress: progressLogger(ctx),
          }),
        );
      })();
    });
}
