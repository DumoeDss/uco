import {
  addPluginToManifest,
  inspectPluginManifest,
  resolveLatestVersion,
  type AddPluginResult,
} from '../utils/manifest.js';
import { silentLogger } from './logger.js';
import { emitProgress } from './progress.js';
import { requireUnityProject } from './validation.js';
import type { InstallPluginOptions, InstallResult, PluginPlannedAction } from './types.js';
import { isValidVersion, isNewerVersion } from '../utils/semver.js';

/**
 * Install the Unity-MCP plugin into a Unity project. Library-safe:
 * never calls `process.exit`, never prints to stdout / stderr, never
 * throws past the public boundary — errors are returned in
 * `{ kind: 'failure', success: false, error }`.
 *
 * The returned `InstallResult` is a discriminated union — narrow with
 * `result.kind === 'success'` to access `installedVersion` /
 * `manifestPath`, or `result.kind === 'failure'` to access `error`.
 */
export interface InstallPluginDependencies {
  resolveLatestVersion(): Promise<string>;
  inspectManifest(projectPath: string): ReturnType<typeof inspectPluginManifest>;
  addToManifest(projectPath: string, version: string, force: boolean): AddPluginResult;
}

const productionDependencies: InstallPluginDependencies = {
  resolveLatestVersion: () => resolveLatestVersion(silentLogger),
  inspectManifest: inspectPluginManifest,
  addToManifest: (projectPath, version, force) => (
    addPluginToManifest(projectPath, version, force, silentLogger)
  ),
};

export async function installPlugin(
  opts: InstallPluginOptions,
  dependencies: InstallPluginDependencies = productionDependencies,
): Promise<InstallResult> {
  const warnings: string[] = [];
  const nextSteps: string[] = [];

  try {
    const validated = requireUnityProject(opts?.unityProjectPath);
    if (!validated.ok) {
      return {
        kind: 'failure',
        success: false,
        manifestPath: validated.manifestPath,
        warnings,
        nextSteps,
        error: validated.error,
      };
    }
    const { projectPath } = validated;

    emitProgress(opts.onProgress, { phase: 'start', message: `Installing Unity-MCP plugin into ${projectPath}` });

    let version = opts.version?.trim();
    const isExplicitVersion = !!version;
    if (!version) {
      const inspection = dependencies.inspectManifest(projectPath);
      if (inspection.activeSourceIsNonSemver && inspection.activeSource !== undefined) {
        version = inspection.activeSource;
      } else {
        version = await dependencies.resolveLatestVersion();
        if (typeof version !== 'string'
          || version !== version.trim()
          || /[\u0000-\u001f\u007f]/.test(version)
          || !isValidVersion(version)) {
          throw new Error(
            'OpenUPM returned an invalid latest plugin version. '
            + 'Retry, or run `uco install-plugin <project> --version <version>`.',
          );
        }
        emitProgress(opts.onProgress, {
          phase: 'dependencies-resolved',
          message: `Resolved latest plugin version: ${version}`,
          version,
        });
      }
    }

    if (opts.dryRun === true) {
      // Plan-only mode: report exactly what a real run would write — the
      // resolved target version and the manifest patch — without touching
      // the manifest. The no-downgrade comparison is reported from the
      // inspection snapshot instead of the write path.
      const inspection = dependencies.inspectManifest(projectPath);
      if (inspection.activeSource !== undefined
        && inspection.activeSource !== version
        && !isExplicitVersion
        && !inspection.activeSourceIsNonSemver
        && isNewerVersion(inspection.activeSource, version)) {
        warnings.push(
          `Plugin already at version ${inspection.activeSource} (>= ${version}); a real run would keep it. ` +
          'Run `uco install-plugin <project> --version <version>` to force a specific value.',
        );
      }
      nextSteps.push('Re-run without --dry-run to apply the planned manifest patch.');
      emitProgress(opts.onProgress, { phase: 'done', message: 'Dry run complete — nothing written.' });
      return {
        kind: 'success',
        success: true,
        installedVersion: version,
        manifestPath: inspection.manifestPath,
        modified: false,
        warnings,
        nextSteps,
        dryRun: true,
        plannedActions: [
          { action: 'manifest-patch', path: inspection.manifestPath, version } satisfies PluginPlannedAction,
        ],
      };
    }

    const result = dependencies.addToManifest(projectPath, version, isExplicitVersion);

    if (result.resolvedVersion !== version && !isExplicitVersion) {
      warnings.push(
        `Plugin already at version ${result.resolvedVersion} (>= ${version}). ` +
        'Skipping version update. Run `uco install-plugin <project> --version <version>` to force a specific value.',
      );
    }

    emitProgress(opts.onProgress, {
      phase: 'manifest-patched',
      message: result.modified
        ? `Updated ${result.manifestPath}`
        : 'manifest.json is already up to date.',
      manifestPath: result.manifestPath,
    });

    nextSteps.push('Open the Unity project in the Editor to complete installation.');

    emitProgress(opts.onProgress, { phase: 'done', message: 'Install complete.' });

    return {
      kind: 'success',
      success: true,
      installedVersion: result.resolvedVersion,
      manifestPath: result.manifestPath,
      modified: result.modified,
      warnings,
      nextSteps,
    };
  } catch (err: unknown) {
    return {
      kind: 'failure',
      success: false,
      warnings,
      nextSteps,
      error: err instanceof Error ? err : new Error(String(err)),
    };
  }
}
