import { Command } from 'commander';
import { setupUnityCli, type SetupUnityCliOptions } from '../../devops/lib/setup-unity-cli.js';
import { runCommand } from '../../util/cli-context.js';
import { printInfo } from '../../util/output.js';

export interface SetupUnityCliCommandOptions {
  yes?: boolean;
  dryRun?: boolean;
}

export type SetupUnityCliExecutor = (
  options: SetupUnityCliOptions,
) => ReturnType<typeof setupUnityCli>;

export function registerSetupUnityCli(
  program: Command,
  execute: SetupUnityCliExecutor = setupUnityCli,
): void {
  program
    .command('setup-unity-cli')
    .description("Explicitly install Unity's official beta CLI using Unity's documented installer.")
    .option('--yes', "Approve downloading and executing Unity's installer without prompting")
    .option('--dry-run', 'Show the exact installer plan without prompting or changing the machine')
    .action(function (this: Command, options: SetupUnityCliCommandOptions) {
      return runCommand(this, async (ctx) => {
        const controller = new AbortController();
        const abort = (): void => controller.abort();
        process.once('SIGINT', abort);
        process.once('SIGTERM', abort);
        try {
          return await execute({
            yes: options.yes === true,
            dryRun: options.dryRun === true,
            json: ctx.output.json,
            interactive: !ctx.output.json
              && process.stdin.isTTY === true
              && process.stderr.isTTY === true,
            signal: controller.signal,
            onProgress: (message) => printInfo(ctx.output, message),
          });
        } finally {
          process.removeListener('SIGINT', abort);
          process.removeListener('SIGTERM', abort);
        }
      })();
    });
}
