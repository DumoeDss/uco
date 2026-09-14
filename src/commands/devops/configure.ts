// uco configure — enable/disable MCP tools, prompts, resources in
// a Unity project's UserSettings/uco-config.json.

import { Command } from 'commander';
import { runCommand } from '../../util/cli-context.js';
import { configure } from '../../devops/lib/configure.js';
import type { FeatureAction } from '../../devops/lib/types.js';
import { resolveProjectArg, progressLogger, unwrapResult } from './_helpers.js';

interface ConfigureOpts {
  enableTools?: string;
  disableTools?: string;
  enableAllTools?: boolean;
  disableAllTools?: boolean;
  enablePrompts?: string;
  disablePrompts?: string;
  enableAllPrompts?: boolean;
  disableAllPrompts?: boolean;
  enableResources?: string;
  disableResources?: string;
  enableAllResources?: boolean;
  disableAllResources?: boolean;
  list?: boolean;
}

function toFeatureAction(opts: ConfigureOpts, kind: 'tools' | 'prompts' | 'resources'): FeatureAction | undefined {
  const enableNames = opts[`enable${cap(kind)}` as keyof ConfigureOpts] as string | undefined;
  const disableNames = opts[`disable${cap(kind)}` as keyof ConfigureOpts] as string | undefined;
  const enableAll = opts[`enableAll${cap(kind)}` as keyof ConfigureOpts] as boolean | undefined;
  const disableAll = opts[`disableAll${cap(kind)}` as keyof ConfigureOpts] as boolean | undefined;

  if (!enableNames && !disableNames && !enableAll && !disableAll) return undefined;

  const action: FeatureAction = {};
  if (enableNames) action.enableNames = enableNames.split(',').map((s) => s.trim()).filter(Boolean);
  if (disableNames) action.disableNames = disableNames.split(',').map((s) => s.trim()).filter(Boolean);
  if (enableAll) action.enableAll = true;
  if (disableAll) action.disableAll = true;
  return action;
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function registerConfigure(program: Command): void {
  program
    .command('configure [project]')
    .description('Configure enabled tools/prompts/resources in the project config.')
    .option('--list', 'Show current config and exit (no changes)')
    .option('--enable-tools <list>', 'Comma-separated tool names to enable')
    .option('--disable-tools <list>', 'Comma-separated tool names to disable')
    .option('--enable-all-tools', 'Enable every tool present in config')
    .option('--disable-all-tools', 'Disable every tool present in config')
    .option('--enable-prompts <list>', 'Comma-separated prompt names to enable')
    .option('--disable-prompts <list>', 'Comma-separated prompt names to disable')
    .option('--enable-all-prompts', 'Enable every prompt present in config')
    .option('--disable-all-prompts', 'Disable every prompt present in config')
    .option('--enable-resources <list>', 'Comma-separated resource names to enable')
    .option('--disable-resources <list>', 'Comma-separated resource names to disable')
    .option('--enable-all-resources', 'Enable every resource present in config')
    .option('--disable-all-resources', 'Disable every resource present in config')
    .action(function (this: Command, projectArg: string | undefined, opts: ConfigureOpts) {
      return runCommand(this, async (ctx) => {
        const projectPath = resolveProjectArg(ctx, projectArg);
        // --list ≡ no actions; configure() returns the snapshot anyway.
        const tools = opts.list ? undefined : toFeatureAction(opts, 'tools');
        const prompts = opts.list ? undefined : toFeatureAction(opts, 'prompts');
        const resources = opts.list ? undefined : toFeatureAction(opts, 'resources');
        const result = await configure({
          unityProjectPath: projectPath,
          ...(tools ? { tools } : {}),
          ...(prompts ? { prompts } : {}),
          ...(resources ? { resources } : {}),
          onProgress: progressLogger(ctx),
        });
        return unwrapResult(result);
      })();
    });
}
