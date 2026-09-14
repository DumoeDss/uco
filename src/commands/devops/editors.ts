import { Command } from 'commander';
import { runCommand } from '../../util/cli-context.js';
import { printInfo } from '../../util/output.js';
import {
  selectUnityLifecycleSession,
  type UnityLifecycleSession,
  type UnityLifecycleSessionSelector,
} from '../../devops/lib/unity-lifecycle.js';

export interface EditorsOptions {
  releases?: boolean;
  diagnostics?: boolean;
}

export async function executeEditors(
  options: EditorsOptions,
  session: UnityLifecycleSession,
): Promise<Record<string, unknown>> {
  const inventory = options.releases
    ? { releases: await session.listAvailableReleases() }
    : { editors: await session.listInstalledEditors() };

  return {
    backend: session.backend,
    ...inventory,
    ...(options.diagnostics ? { diagnostics: session.getDiagnostics() } : {}),
  };
}

export function registerEditors(
  program: Command,
  selectSession: UnityLifecycleSessionSelector = selectUnityLifecycleSession,
): void {
  program
    .command('editors')
    .description('List installed Unity editors or available releases.')
    .option('--releases', 'List available editor releases instead of installed editors')
    .option('--diagnostics', 'Include official Unity CLI routing diagnostics')
    .action(function (this: Command, options: EditorsOptions) {
      return runCommand(this, async (ctx) => {
        const session = selectSession({ silent: ctx.output.json });
        if (session.decision.fallback) {
          printInfo(
            ctx.output,
            'Official Unity CLI was not found; using Unity Hub. Install the official `unity` CLI to use the native inventory.',
          );
        }
        return executeEditors(options, session);
      })();
    });
}
