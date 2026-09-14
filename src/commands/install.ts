// uco install — end-user-facing single-shot install into a Unity project.
//
// Stages the artifacts needed for the forked (Phase B) toolchain:
//   - Plugin (UPM package) — via file:, git, or embedded source
//   - NuGet DLLs   — copied to <target>/Assets/Plugins/NuGet/ (.meta-preserving)
//   - Initial config — UserSettings/uco-config.json (if missing)
//
// The tool server itself is not staged: the Unity plugin auto-starts the
// Node.js MCP server (uco) on launch, so no server binaries live in the
// project.
//
// Wraps `devops/lib/install.installAll`.

import path from 'node:path';
import { Command } from 'commander';
import kleur from 'kleur';
import { runCommand } from '../util/cli-context.js';
import { CliError } from '../util/errors.js';
import { installAll } from '../devops/lib/install.js';
import { resolveProjectArg, progressLogger, unwrapResult } from './devops/_helpers.js';
import type { PluginSource, InstallAllOptions } from '../devops/lib/types.js';
import { UCO_UNITY_PACKAGE_ID } from '../devops/utils/manifest.js';
import {
  hasVendorPlugin,
  resolveDefaultNugetSource,
  resolveDefaultPluginSource,
  vendorPath,
} from '../devops/utils/vendor.js';
import {
  UNITY_SOURCE_BUNDLE,
  recordUnityInInstallManifest,
} from '../skills/install-manifest.js';

interface InstallOpts {
  fromFile?: string;
  fromGit?: string;
  embed?: boolean;
  dryRun?: boolean;
  skipNuget?: boolean;
  skipPlugin?: boolean;
  skipConfig?: boolean;
  overwriteConfig?: boolean;
  nugetDir?: string;
}

export function registerInstall(program: Command): void {
  program
    .command('install [project]')
    .description(
      'Install the Unity-MCP toolchain into a Unity project (Plugin UPM + NuGet DLLs + initial config). One-shot, idempotent.',
    )
    .option('--from-file <path>', 'Plugin source: local file: path (default: workspace-relative fork)')
    .option('--from-git <url>', 'Plugin source: git URL (alternative to --from-file)')
    .option('--embed', 'Plugin source: copy package source into <target>/Packages/ (offline)')
    .option('--dry-run', 'Print planned actions without writing anything')
    .option('--skip-nuget', 'Do not stage the NuGet DLLs')
    .option('--skip-plugin', 'Do not patch Packages/manifest.json')
    .option('--skip-config', 'Do not initialise UserSettings config')
    .option('--overwrite-config', 'Re-create UserSettings config even if it exists')
    .option('--nuget-dir <path>', 'Override staged NuGet folder (default: <workspace>/dist/nuget/)')
    .action(function (this: Command, projectArg: string | undefined, opts: InstallOpts) {
      return runCommand(this, async (ctx) => {
        const projectPath = resolveProjectArg(ctx, projectArg);

        const pluginSource = resolvePluginSource(opts);
        // Default artifact sources, in priority order:
        //   1. explicit --nuget-dir override
        //   2. bundled vendor/ (self-contained tgz install — `npm i -g uco.tgz`)
        //   3. dev workspace dist/ (local checkout fallback)
        // vendor/ lets a globally-installed uco stage artifacts with no workspace present.
        const stagedNugetPath = path.resolve(opts.nugetDir ?? resolveDefaultNugetSource());

        const callOpts: InstallAllOptions = {
          unityProjectPath: projectPath,
          pluginSource,
          stagedNugetPath,
          dryRun: Boolean(opts.dryRun),
          skipNuget: Boolean(opts.skipNuget),
          skipPlugin: Boolean(opts.skipPlugin),
          skipConfig: Boolean(opts.skipConfig),
          overwriteConfig: Boolean(opts.overwriteConfig),
          onProgress: progressLogger(ctx),
        };

        const result = await installAll(callOpts);
        const unwrapped = unwrapResult(result);

        // Record the Unity toolchain surface in the install manifest so
        // `uco update` knows this project is uco-installed (and how the
        // plugin is sourced). Fails open: a manifest problem never fails an
        // otherwise-successful install.
        if (result.kind === 'success' && !result.dryRun) {
          const record = recordUnityInInstallManifest(projectPath, {
            installed: opts.skipPlugin !== true,
            source: describePluginSourceKind(pluginSource),
            projectPath,
          });
          if ('warning' in record && result.kind === 'success') {
            result.warnings.push(record.warning);
          }
        }

        // Human pretty-print (suppressed under --json by printResult).
        if (!ctx.output.json) {
          printHumanSummary(result);
          return undefined; // already printed
        }
        return unwrapped;
      })();
    });
}

/** Map the plugin source actually used onto the manifest's `unity.source` value. */
function describePluginSourceKind(source: PluginSource): string {
  switch (source.kind) {
    case 'embed':
      return UNITY_SOURCE_BUNDLE;
    case 'file':
      return `file:${source.path}`;
    case 'git':
      return `git:${source.url}`;
  }
}

function resolvePluginSource(opts: InstallOpts): PluginSource {
  const explicitSources = [opts.fromFile, opts.fromGit, opts.embed].filter(Boolean).length;
  if (explicitSources > 1) {
    throw new CliError(
      'Choose at most one of --from-file, --from-git, --embed.',
      'invalid-flags',
    );
  }

  if (opts.fromGit) {
    return { kind: 'git', url: opts.fromGit };
  }
  if (opts.fromFile) {
    return { kind: 'file', path: path.resolve(opts.fromFile) };
  }

  // Plugin source candidates, in priority order:
  //   1. bundled vendor/plugin/<id>  (self-contained tgz install) — preferred
  //   2. workspace fork              (dev checkout)
  const hasVendor = hasVendorPlugin();
  const defaultPluginPath = resolveDefaultPluginSource();

  if (opts.embed) {
    return { kind: 'embed', sourcePath: defaultPluginPath };
  }

  // No explicit flag: a vendor install defaults to embed (the Unity project then
  // owns its own plugin copy under Packages/ and survives uco uninstall/upgrade);
  // a dev-workspace install keeps the historical file: default.
  if (hasVendor) {
    return { kind: 'embed', sourcePath: vendorPath('plugin', UCO_UNITY_PACKAGE_ID) };
  }
  return { kind: 'file', path: path.resolve(defaultPluginPath) };
}

function printHumanSummary(result: ReturnType<typeof installAll> extends Promise<infer R> ? R : never): void {
  if (result.kind === 'failure') {
    // The CliError thrown by unwrapResult already aborts; this branch
    // is only reachable in --json mode (which short-circuits above).
    return;
  }
  const out = process.stderr;
  const w = (s: string): void => { out.write(s + '\n'); };

  if (result.dryRun) {
    w(kleur.bold().yellow('uco install — DRY RUN (no files written)'));
  } else {
    w(kleur.bold().green('uco install — done'));
  }
  w(kleur.gray(`  project : ${result.unityProjectPath}`));

  if (result.actions.length > 0) {
    w('');
    w(kleur.bold('Actions:'));
    for (const a of result.actions) {
      const target = a.target ? kleur.gray(` -> ${a.target}`) : '';
      w(`  ${kleur.cyan(a.kind.padEnd(18))} ${a.detail}${target}`);
    }
  }

  if (!result.dryRun && result.summary.length > 0) {
    w('');
    w(kleur.bold('Summary:'));
    for (const s of result.summary) w(`  ${s}`);
  }

  if (result.warnings.length > 0) {
    w('');
    w(kleur.bold().yellow('Warnings:'));
    for (const s of result.warnings) w(`  ${s}`);
  }

  if (result.nextSteps.length > 0) {
    w('');
    w(kleur.bold('Next steps:'));
    for (const s of result.nextSteps) w(`  - ${s}`);
  }
}
