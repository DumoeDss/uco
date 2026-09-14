import * as fs from 'node:fs';
import * as path from 'node:path';
import { Command } from 'commander';
import { runCommand, CliError } from '../../util/cli-context.js';
import { printInfo } from '../../util/output.js';
import {
  findLatestStableLifecycleRelease,
  lifecycleBackendMetadata,
  selectUnityLifecycleSession,
  type UnityLifecycleSession,
  type UnityLifecycleSessionSelector,
} from '../../devops/lib/unity-lifecycle.js';
import type {
  InstallEditorOptions,
  UnityCliArchitecture,
} from '../../devops/utils/unity-cli.js';
import { getProjectEditorVersion } from '../../devops/utils/unity-editor.js';

export interface InstallUnityOptions {
  path?: string;
  modules?: readonly string[];
  architecture?: UnityCliArchitecture;
  changeset?: string;
  childModules?: boolean;
  force?: boolean;
  acceptEula?: boolean;
  resume?: boolean;
  noElevate?: boolean;
}

interface CommanderInstallUnityOptions extends Omit<InstallUnityOptions, 'modules' | 'noElevate'> {
  module?: string[];
  elevate?: boolean;
}

function officialInstallOptions(options: InstallUnityOptions): InstallEditorOptions {
  return {
    ...(options.modules !== undefined ? { modules: options.modules } : {}),
    ...(options.architecture !== undefined ? { architecture: options.architecture } : {}),
    ...(options.changeset !== undefined ? { changeset: options.changeset } : {}),
    ...(options.childModules !== undefined ? { childModules: options.childModules } : {}),
    ...(options.force === true ? { force: true } : {}),
    ...(options.acceptEula === true ? { acceptEula: true } : {}),
    ...(options.resume === true ? { resume: true } : {}),
    ...(options.noElevate === true ? { noElevate: true } : {}),
  };
}

export function hasInstallModifiers(options: InstallUnityOptions): boolean {
  return (options.modules?.length ?? 0) > 0
    || options.architecture !== undefined
    || options.changeset !== undefined
    || options.childModules !== undefined
    || options.force === true
    || options.acceptEula === true
    || options.resume === true
    || options.noElevate === true;
}

export async function executeInstallUnity(
  positionalVersion: string | undefined,
  options: InstallUnityOptions,
  session: UnityLifecycleSession,
): Promise<Record<string, unknown>> {
  const installOptions = officialInstallOptions(options);
  session.validateInstallOptions(installOptions);

  let version = positionalVersion;
  if (!version && options.path) {
    const projectPath = path.resolve(options.path);
    if (!fs.existsSync(projectPath)) {
      throw new CliError(`Project path does not exist: ${projectPath}`, 'no-such-project');
    }
    const detected = getProjectEditorVersion(projectPath) ?? undefined;
    if (!detected) {
      throw new CliError(
        'Could not read editor version from ProjectSettings/ProjectVersion.txt',
        'no-version-detected',
      );
    }
    version = detected;
  }

  let prefetchedReleases: Awaited<ReturnType<UnityLifecycleSession['listAvailableReleases']>> | undefined;
  if (!version) {
    prefetchedReleases = await session.listAvailableReleases();
    const latest = findLatestStableLifecycleRelease(prefetchedReleases);
    if (!latest) {
      throw new CliError(
        `No stable releases available from ${session.backend === 'unity-cli' ? 'the official Unity CLI' : 'Unity Hub'}`,
        'no-stable-release',
      );
    }
    version = latest.version;
  }

  const editors = await session.listInstalledEditors();
  const already = editors.find((editor) => editor.version === version);
  const modifiers = hasInstallModifiers(options);
  if (already && !modifiers) {
    return {
      installed: false,
      alreadyPresent: true,
      version,
      path: already.path,
      ...lifecycleBackendMetadata(session),
    };
  }

  await session.installEditor(version, {
    ...installOptions,
    ...(prefetchedReleases !== undefined ? { prefetchedReleases } : {}),
  });

  return {
    installed: already === undefined,
    ...(already !== undefined ? { alreadyPresent: true, updatedExisting: true } : {}),
    version,
    ...(already !== undefined ? { path: already.path } : {}),
    operationPerformed: true,
    ...(options.modules !== undefined && options.modules.length > 0
      ? { modulesRequested: [...options.modules] }
      : {}),
    ...lifecycleBackendMetadata(session),
  };
}

export function registerInstallUnity(
  program: Command,
  selectSession: UnityLifecycleSessionSelector = selectUnityLifecycleSession,
): void {
  program
    .command('install-unity [version]')
    .description('Install or modify a Unity Editor version. Omit version for latest stable.')
    .option('--path <project>', 'Read the required version from an existing Unity project')
    .option('--module <modules...>', 'Install one or more official Unity editor modules')
    .option('--architecture <architecture>', 'Editor architecture: x86_64 or arm64')
    .option('--changeset <changeset>', 'Install a specific official Unity changeset')
    .option('--child-modules', 'Include child modules')
    .option('--no-child-modules', 'Exclude child modules')
    .option('--force', 'Force the official install operation')
    .option('--accept-eula', 'Explicitly accept the Unity EULA')
    .option('--resume', 'Resume an interrupted official install')
    .option('--no-elevate', 'Do not request privilege elevation')
    .action(function (
      this: Command,
      positionalVersion: string | undefined,
      opts: CommanderInstallUnityOptions,
    ) {
      return runCommand(this, async (ctx) => {
        const session = selectSession({ silent: ctx.output.json });
        if (session.decision.fallback) {
          printInfo(
            ctx.output,
            'Official Unity CLI was not found; using Unity Hub. Install the official `unity` CLI to enable native lifecycle options.',
          );
        }
        return executeInstallUnity(positionalVersion, {
          ...(opts.path !== undefined ? { path: opts.path } : {}),
          ...(opts.module !== undefined ? { modules: opts.module } : {}),
          ...(opts.architecture !== undefined ? { architecture: opts.architecture } : {}),
          ...(opts.changeset !== undefined ? { changeset: opts.changeset } : {}),
          ...(opts.childModules !== undefined ? { childModules: opts.childModules } : {}),
          ...(opts.force === true ? { force: true } : {}),
          ...(opts.acceptEula === true ? { acceptEula: true } : {}),
          ...(opts.resume === true ? { resume: true } : {}),
          ...(opts.elevate === false ? { noElevate: true } : {}),
        }, session);
      })();
    });
}
