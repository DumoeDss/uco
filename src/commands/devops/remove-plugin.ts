// uco remove-plugin — undo install-plugin.

import { Command } from 'commander';
import { runCommand } from '../../util/cli-context.js';
import { removePlugin } from '../../devops/lib/remove-plugin.js';
import { resolveProjectArg, progressLogger, unwrapResult } from './_helpers.js';
import { UCO_UNITY_PACKAGE_ID } from '../../devops/utils/manifest.js';

export function registerRemovePlugin(program: Command): void {
  program
    .command('remove-plugin [project]')
    .description(`Remove ${UCO_UNITY_PACKAGE_ID} from a Unity project's manifest.json.`)
    .action(function (this: Command, projectArg: string | undefined) {
      return runCommand(this, async (ctx) => {
        const projectPath = resolveProjectArg(ctx, projectArg);
        const result = await removePlugin({
          unityProjectPath: projectPath,
          onProgress: progressLogger(ctx),
        });
        return unwrapResult(result);
      })();
    });
}
