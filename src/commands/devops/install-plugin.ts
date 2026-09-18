// uco install-plugin — install Unity Copilot plugin into a Unity project.
//
// Wraps devops/lib/install-plugin.ts (upstream's installPlugin).
// Side effects:
//   - Patches Packages/manifest.json (adds OpenUPM scoped registry + dependency)
//   - Resolves latest version from OpenUPM unless --version is given
//   - Never downgrades — preserves a higher already-installed version
//   - --dry-run resolves the target version and prints the planned patch
//     without writing anything

import { Command } from 'commander';
import { runCommand } from '../../util/cli-context.js';
import { printInfo } from '../../util/output.js';
import { installPlugin } from '../../devops/lib/install-plugin.js';
import { resolveProjectArg, progressLogger, unwrapResult } from './_helpers.js';
import { UCO_UNITY_PACKAGE_ID } from '../../devops/utils/manifest.js';

interface InstallPluginOpts {
  version?: string;
  dryRun?: boolean;
}

export function registerInstallPlugin(program: Command): void {
  program
    .command('install-plugin [project]')
    .description(`Install ${UCO_UNITY_PACKAGE_ID} into a Unity project's manifest.json.`)
    .option('--version <ver>', 'Plugin version to install (default: latest from OpenUPM)')
    .option('--dry-run', 'Print planned actions without writing anything')
    .action(function (this: Command, projectArg: string | undefined, opts: InstallPluginOpts) {
      return runCommand(this, async (ctx) => {
        const projectPath = resolveProjectArg(ctx, projectArg);
        const result = await installPlugin({
          unityProjectPath: projectPath,
          ...(opts.version ? { version: opts.version } : {}),
          ...(opts.dryRun ? { dryRun: true } : {}),
          onProgress: progressLogger(ctx),
        });
        const unwrapped = unwrapResult(result);
        if (result.kind === 'success' && result.dryRun === true) {
          printInfo(ctx.output, `DRY RUN (no files written) — planned actions for ${UCO_UNITY_PACKAGE_ID}:`);
          for (const action of result.plannedActions ?? []) {
            printInfo(ctx.output, `  - ${action.action}: ${action.path} -> ${action.version}`);
          }
        }
        return unwrapped;
      })();
    });
}
