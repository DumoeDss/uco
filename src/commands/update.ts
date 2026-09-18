// uco update — refresh everything uco installed into a target, per the
// install manifest: every agent's entry Skills + the shared agent-runtime
// (content-diff driven, no running Unity Editor required), the Unity plugin
// package + NuGet DLL set as one matched set for bundle-sourced installs,
//
// Upgrading the uco npm package itself stays `npm i -g uco@latest` —
// update refreshes only what uco installed. Wraps `devops/lib/update.runUpdate`.

import process from 'node:process';
import path from 'node:path';
import { Command } from 'commander';
import kleur from 'kleur';
import { runCommand } from '../util/cli-context.js';
import { runUpdate } from '../devops/lib/update.js';
import { unwrapResult } from './devops/_helpers.js';

interface UpdateOpts {
  dryRun?: boolean;
  force?: boolean;
  skipUnity?: boolean;
}

export function registerUpdate(program: Command): void {
  program
    .command('update [target]')
    .description(
      'Refresh the uco-installed Skills, shared runtime, and Unity toolchain (matched set) recorded in .uco/install-manifest.json. Default target: current directory. Idempotent — run it after every uco upgrade.',
    )
    .option('--dry-run', 'Print the planned changes without writing anything')
    .option('--force', 'Refresh every recorded agent even when content-identical')
    .option('--skip-unity', 'Leave the Unity plugin package and NuGet DLL set untouched')
    .action(function (this: Command, targetArg: string | undefined, opts: UpdateOpts) {
      return runCommand(this, async (ctx) => {
        const target = path.resolve(targetArg ?? process.cwd());
        const result = await runUpdate({
          targetPath: target,
          dryRun: opts.dryRun === true,
          force: opts.force === true,
          skipUnity: opts.skipUnity === true,
        });
        const unwrapped = unwrapResult(result);

        // Human pretty-print (suppressed under --json by printResult).
        if (result.kind === 'success' && !ctx.output.json) {
          printUpdateSummary(result);
          return undefined;
        }
        return unwrapped;
      })();
    });
}

type UpdateSuccess = Awaited<ReturnType<typeof runUpdate>> & { kind: 'success' };

function printUpdateSummary(result: UpdateSuccess): void {
  const out = process.stderr;
  const w = (s: string): void => { out.write(s + '\n'); };

  if (result.upToDate) {
    w(kleur.bold().gray('uco update — Already up to date.'));
  } else if (result.dryRun) {
    w(kleur.bold().yellow('uco update — DRY RUN (no files written)'));
  } else {
    w(kleur.bold().green('uco update — done'));
  }
  w(kleur.gray(`  target     : ${result.targetPath}`));
  if (result.versionBefore !== result.versionAfter) {
    w(kleur.gray(result.upToDate
      ? `  uco      : installed by v${result.versionBefore || 'unknown'} — every managed file already matches v${result.versionAfter}, nothing to restamp`
      : `  uco      : installed by v${result.versionBefore || 'unknown'} → refreshed with v${result.versionAfter}`));
  } else {
    w(kleur.gray(`  uco      : v${result.versionAfter}`));
  }
  if (result.seeded && result.seedAgentIds.length > 0) {
    w(kleur.gray(`  migrated   : seeded the install manifest from ${result.seedAgentIds.join(', ')}`));
  }

  if (result.agents.length > 0) {
    w('');
    w(kleur.bold('Agent Skills:'));
    for (const agent of result.agents) {
      const mark = agent.status === 'updated'
        ? kleur.green(`✓ ${agent.changedFileCount} file${agent.changedFileCount === 1 ? '' : 's'} ${result.dryRun ? 'would change' : 'refreshed'}`)
        : agent.status === 'failed'
          ? kleur.red(`✗ ${agent.error ?? 'failed'}`)
          : kleur.gray('  unchanged');
      w(`  ${kleur.cyan(agent.id.padEnd(16))} ${kleur.gray(agent.skillsPath)}  ${mark}`);
    }
    const runtimeLabel = result.runtime.liveCatalogPreserved ? 'agent-runtime (live catalog preserved)' : 'agent-runtime';
    const runtimeMark = result.runtime.status === 'updated'
      ? kleur.green(`✓ ${result.runtime.changedFileCount} file${result.runtime.changedFileCount === 1 ? '' : 's'} refreshed`)
      : result.runtime.status === 'failed'
        ? kleur.red(`✗ ${result.runtime.error ?? 'failed'}`)
        : kleur.gray('  unchanged');
    w(`  ${kleur.cyan(runtimeLabel.padEnd(16))} ${runtimeMark}`);
  }

  w('');
  w(kleur.bold('Unity toolchain:'));
  {
    const mark = result.unity.status === 'refreshed'
      ? kleur.green(`✓ ${result.dryRun ? 'would refresh' : 'refreshed'} (matched set)`)
      : result.unity.status === 'failed'
        ? kleur.red(`✗ ${result.unity.detail}`)
        : kleur.gray(`  ${result.unity.status}`);
    w(`  ${mark}${kleur.gray(result.unity.status !== 'failed' ? ` — ${result.unity.detail}` : '')}`);
  }

  if (result.newAgentAdvisories.length > 0) {
    w('');
    w(kleur.bold('New agents detected (not auto-added):'));
    for (const advisory of result.newAgentAdvisories) {
      w(`  ${kleur.cyan(advisory.id)} — present at ${advisory.detectionPaths.join(', ')}; run ${kleur.gray(`uco init --agent ${advisory.id}`)} to install.`);
    }
  }

  if (result.warnings.length > 0) {
    w('');
    w(kleur.bold().yellow('Warnings:'));
    for (const warning of result.warnings) w(`  ${warning}`);
  }
}
