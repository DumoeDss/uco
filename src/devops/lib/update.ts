// uco `update` library — the single idempotent refresh path for everything
// uco installed into a target, resolved from `.uco/install-manifest.json`:
//
//   1. Every manifest agent's entry Skills, refreshed from the current static
//      templates (content-diff driven — no running Unity Editor required).
//   2. The shared `.uco/agent-runtime` support tree, exactly once per run,
//      without regressing a live catalog installed by `uco setup-skills`.
//   3. The Unity plugin package + NuGet DLL set as ONE matched set for
//      bundle-sourced installs (the stale-DLL CS0246 class of breakage is not
//      reachable through this path).
//
// Never onboards an agent that is not in the manifest (new agents surface only
// through the advisory). Upgrading the uco npm package itself stays
// `npm i -g uco@latest`. Library-safe: no process.exit, no printing,
// discriminated-union result.

import fs from 'node:fs';
import path from 'node:path';
import {
  installStaticSkillBundle,
  loadToolsFromManifest,
  refreshLiveAgentRuntimeScripts,
  resolvePluginManifestPath,
} from '../../skills/bundle.js';
import {
  UNITY_SOURCE_BUNDLE,
  getUcoVersion,
  inferUnitySource,
  installManifestPath,
  readOrSeedInstallManifest,
  writeInstallManifest,
  type InstallManifest,
} from '../../skills/install-manifest.js';
import {
  getAgentById,
  detectAgentsAt,
} from '../utils/agents.js';
import { UCO_UNITY_PACKAGE_ID } from '../utils/manifest.js';
import { resolveDefaultNugetSource, resolveDefaultPluginSource } from '../utils/vendor.js';
import { installAll, nugetSurfaceDiffers, pluginSurfaceDiffers } from './install.js';
import type { InstallAllOptions } from './types.js';
import { emitProgress } from './progress.js';
import type { ProgressCallback } from './types.js';

export interface UpdateOptions {
  /** The directory whose installed state should be refreshed. */
  targetPath: string;
  /** Report the planned changes without writing anything. */
  dryRun?: boolean;
  /** Refresh all manifest agents even when content-identical. */
  force?: boolean;
  /** Skip the entire Unity toolchain surface. */
  skipUnity?: boolean;
  /**
   * Test seam: override the bundle's plugin package source and NuGet folder
   * (defaults: the uco package's vendor/ directory, dev workspace fallback).
   */
  pluginSourcePath?: string;
  /** Test seam: see {@link pluginSourcePath}. */
  nugetSourcePath?: string;
  onProgress?: ProgressCallback;
}

export interface AgentRefreshReport {
  id: string;
  skillsPath: string;
  status: 'updated' | 'unchanged' | 'failed';
  changedFileCount: number;
  error?: string;
}

export interface RuntimeRefreshReport {
  status: 'updated' | 'unchanged' | 'failed';
  changedFileCount: number;
  /** True when a live catalog was detected and preserved. */
  liveCatalogPreserved: boolean;
  error?: string;
}

export interface UnityRefreshReport {
  status: 'refreshed' | 'unchanged' | 'skipped' | 'failed';
  detail: string;
  warnings: string[];
}

export interface NewAgentAdvisory {
  id: string;
  detectionPaths: readonly string[];
}

export interface UpdateSuccess {
  kind: 'success';
  success: true;
  targetPath: string;
  manifestPath: string;
  seeded: boolean;
  seedAgentIds: string[];
  agents: AgentRefreshReport[];
  runtime: RuntimeRefreshReport;
  unity: UnityRefreshReport;
  newAgentAdvisories: NewAgentAdvisory[];
  /** True when nothing needed refreshing — the command prints "Already up to date." */
  upToDate: boolean;
  versionBefore: string;
  versionAfter: string;
  warnings: string[];
  dryRun: boolean;
}

export interface UpdateFailure {
  kind: 'failure';
  success: false;
  targetPath?: string;
  warnings: string[];
  error: Error;
}

export type UpdateResult = UpdateSuccess | UpdateFailure;

const LIVE_CATALOG_MARKER = path.join('.uco', 'agent-runtime', 'catalog', 'project.json');

export async function runUpdate(opts: UpdateOptions): Promise<UpdateResult> {
  const warnings: string[] = [];
  const dryRun = opts.dryRun === true;
  try {
    emitProgress(opts.onProgress, { phase: 'validating', message: `Resolving install state at ${opts.targetPath}` });

    const target = path.resolve(opts.targetPath);
    if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) {
      return {
        kind: 'failure',
        success: false,
        warnings,
        error: new Error(`Target directory does not exist or is not a directory: ${target}`),
      };
    }

    // A dry run computes the seed in memory (so the plan can report the
    // would-be migration) but must not persist anything — including the seed.
    const state = readOrSeedInstallManifest(target, { persist: !dryRun });
    warnings.push(...state.warnings);
    if (state.manifest === undefined) {
      return {
        kind: 'failure',
        success: false,
        targetPath: target,
        warnings,
        error: new Error(
          `No uco install found at ${target} (no install manifest and no uco-owned artifacts on disk). Run \`uco init\` there first, then re-run \`uco update\`.`,
        ),
      };
    }
    const manifest = state.manifest;
    const manifestRecordPath = installManifestPath(target);
    const versionBefore = manifest.ucoVersion;
    const versionAfter = getUcoVersion();
    if (state.seeded && state.seedAgentIds.length > 0) {
      warnings.push(`Seeded install manifest from on-disk artifacts: ${state.seedAgentIds.join(', ')}.`);
    }

    if (manifest.agents.length === 0 && !manifest.unity.installed) {
      return {
        kind: 'success',
        success: true,
        targetPath: target,
        manifestPath: manifestRecordPath,
        seeded: state.seeded,
        seedAgentIds: state.seedAgentIds,
        agents: [],
        runtime: { status: 'unchanged', changedFileCount: 0, liveCatalogPreserved: false },
        unity: { status: 'skipped', detail: 'no Unity toolchain recorded', warnings: [] },
        newAgentAdvisories: [],
        upToDate: true,
        versionBefore,
        versionAfter,
        warnings: [
          ...warnings,
          'Install manifest records no agents and no Unity toolchain — nothing to update. Run `uco init` to install agent Skills.',
        ],
        dryRun,
      };
    }

    // --- 1 + 2: per-agent Skills refresh and the (single) runtime refresh ---
    const liveCatalogInstalled = fs.existsSync(path.join(target, LIVE_CATALOG_MARKER));
    const tools = loadToolsFromManifest(resolvePluginManifestPath());
    const primary = manifest.agents[0];
    const runtimeSkillsPath = primary?.skillsPath;

    const agentReports: AgentRefreshReport[] = [];
    let runtimeWrittenFiles = 0;
    for (const entry of manifest.agents) {
      const agent = getAgentById(entry.id);
      if (!agent) continue; // the tolerant reader already dropped unknown ids
      try {
        const result = installStaticSkillBundle({
          projectPath: target,
          skillsRoot: path.resolve(target, entry.skillsPath),
          dryRun,
          force: opts.force,
          tools,
          // The shared runtime records the primary agent's path; skip it per
          // agent when a live catalog owns the runtime (refreshed separately).
          ...(runtimeSkillsPath !== undefined ? { runtimeSkillsPath } : {}),
          ...(liveCatalogInstalled ? { skipRuntime: true } : {}),
        });
        const runtimeFiles = result.written.filter((file) => file.startsWith('agent-runtime/')).length;
        runtimeWrittenFiles = Math.max(runtimeWrittenFiles, runtimeFiles);
        agentReports.push({
          id: entry.id,
          skillsPath: entry.skillsPath,
          // --force regenerates every manifest agent even when content-identical.
          status: result.written.length > 0 || opts.force === true ? 'updated' : 'unchanged',
          changedFileCount: result.written.length,
        });
      } catch (error) {
        agentReports.push({
          id: entry.id,
          skillsPath: entry.skillsPath,
          status: 'failed',
          changedFileCount: 0,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    let runtime: RuntimeRefreshReport;
    if (liveCatalogInstalled) {
      try {
        const live = refreshLiveAgentRuntimeScripts({ projectPath: target, dryRun, force: opts.force });
        runtime = {
          status: live.status === 'would-change' ? 'updated' : live.status,
          changedFileCount: live.written.length,
          liveCatalogPreserved: true,
        };
        warnings.push(...live.warnings);
      } catch (error) {
        runtime = {
          status: 'failed',
          changedFileCount: 0,
          liveCatalogPreserved: true,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    } else {
      const changed = runtimeWrittenFiles > 0 || opts.force === true;
      runtime = {
        status: changed ? 'updated' : 'unchanged',
        changedFileCount: runtimeWrittenFiles,
        liveCatalogPreserved: false,
      };
    }

    // --- 3: Unity toolchain refresh (matched set) ---
    const unity = await refreshUnitySurface(target, manifest, opts, warnings);

    // --- New-agent advisory (never auto-adds) ---
    const installedIds = new Set(manifest.agents.map((entry) => entry.id));
    const newAgentAdvisories: NewAgentAdvisory[] = [];
    for (const id of detectAgentsAt(target)) {
      if (installedIds.has(id)) continue;
      const agent = getAgentById(id);
      if (agent) {
        newAgentAdvisories.push({ id, detectionPaths: agent.detectionPaths });
      }
    }

    const allAgentsQuiet = agentReports.every((report) => report.status === 'unchanged');
    const unityQuiet = unity.status === 'unchanged' || unity.status === 'skipped';
    // The no-op decision is content-only: after a uco upgrade whose
    // templates are content-identical, every managed file already matches the
    // current output, so the run reports "Already up to date." and the version
    // restamp is included in the no-op (nothing was refreshed to restamp).
    const upToDate = allAgentsQuiet
      && runtime.status === 'unchanged'
      && unityQuiet;

    // One-shot source inference (design D4 "runs at most once per project"):
    // a sourceless legacy `unity` record gets its inferred source persisted
    // even on an otherwise-quiet run. This is a manifest-only field heal, not
    // a content write — it does not affect the no-op decision above, and like
    // every write it is gated on `!dryRun`. When inference cannot resolve a
    // source (no plugin dependency on disk), nothing is persisted and the
    // inference simply re-runs next time.
    const inferredUnitySource = manifest.unity.installed && manifest.unity.source === undefined
      ? inferUnitySourceFromProject(manifest.unity.projectPath ?? target)
      : undefined;

    // --- Restamp the manifest after a run that wrote something ---
    let restamped = manifest;
    if (!dryRun && (!upToDate || inferredUnitySource !== undefined)) {
      restamped = {
        ...manifest,
        ucoVersion: versionAfter,
        updatedAt: new Date().toISOString(),
        ...(inferredUnitySource !== undefined
          ? { unity: { ...manifest.unity, source: inferredUnitySource } }
          : {}),
      };
      try {
        writeInstallManifest(target, restamped);
      } catch (error) {
        warnings.push(
          `Could not restamp the install manifest at ${manifestRecordPath} (${error instanceof Error ? error.message : String(error)}).`,
        );
      }
    }

    emitProgress(opts.onProgress, { phase: 'done', message: upToDate ? 'Already up to date.' : 'Update complete.' });

    return {
      kind: 'success',
      success: true,
      targetPath: target,
      manifestPath: manifestRecordPath,
      seeded: state.seeded,
      seedAgentIds: state.seedAgentIds,
      agents: agentReports,
      runtime,
      unity,
      newAgentAdvisories,
      upToDate,
      versionBefore,
      versionAfter,
      warnings,
      dryRun,
    };
  } catch (err: unknown) {
    return {
      kind: 'failure',
      success: false,
      warnings,
      error: err instanceof Error ? err : new Error(String(err)),
    };
  }
}

/** Read the plugin dependency value from a project's Packages/manifest.json. */
function readPluginDependency(projectPath: string): string | undefined {
  const manifestPath = path.join(projectPath, 'Packages', 'manifest.json');
  if (!fs.existsSync(manifestPath)) return undefined;
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
      dependencies?: Record<string, unknown>;
    };
    const dependency = manifest.dependencies?.[UCO_UNITY_PACKAGE_ID];
    return typeof dependency === 'string' ? dependency : undefined;
  } catch {
    return undefined;
  }
}

function inferUnitySourceFromProject(projectPath: string): string | undefined {
  const dependency = readPluginDependency(projectPath);
  return dependency !== undefined ? inferUnitySource(dependency) : undefined;
}

async function refreshUnitySurface(
  target: string,
  manifest: InstallManifest,
  opts: UpdateOptions,
  warnings: string[],
): Promise<UnityRefreshReport> {
  if (!manifest.unity.installed) {
    return { status: 'skipped', detail: 'no Unity toolchain recorded in the install manifest', warnings: [] };
  }
  if (opts.skipUnity === true) {
    return { status: 'skipped', detail: '--skip-unity', warnings: [] };
  }

  const unityProjectPath = path.resolve(manifest.unity.projectPath ?? target);
  // Resolve the source deterministically: the recorded value, or a one-shot
  // inference from the package manifest when the field is absent.
  const source = manifest.unity.source ?? inferUnitySourceFromProject(unityProjectPath);
  if (source === undefined) {
    return {
      status: 'skipped',
      detail: `no plugin source recorded and no ${UCO_UNITY_PACKAGE_ID} dependency found under ${unityProjectPath}`,
      warnings: [],
    };
  }
  if (source !== UNITY_SOURCE_BUNDLE) {
    return {
      status: 'skipped',
      detail: `user-managed plugin source (${source}) — re-run \`uco install ${unityProjectPath}\` deliberately to restage`,
      warnings: [],
    };
  }

  const pluginSourcePath = opts.pluginSourcePath ?? resolveDefaultPluginSource();
  const stagedNugetPath = opts.nugetSourcePath ?? resolveDefaultNugetSource();
  const embedSource = { kind: 'embed' as const, sourcePath: pluginSourcePath };

  // Matched-set heal: refresh when EITHER surface drifted from the bundle.
  const pluginChanged = pluginSurfaceDiffers(unityProjectPath, embedSource);
  const nugetChanged = nugetSurfaceDiffers(stagedNugetPath, unityProjectPath);
  if (!pluginChanged && !nugetChanged && opts.force !== true) {
    return { status: 'unchanged', detail: 'plugin and NuGet set already match the current uco bundle', warnings: [] };
  }

  // The Unity refresh never stages a tool server, so `skipServer: true` is
  // the semantically correct ask on every shape of `installAll`. The field
  // exists only in the pre-Node-migration `InstallAllOptions` (where omitting
  // it makes installAll demand a `stagedServerPath`); the intersection keeps
  // this call type-valid before and after the migration deletes the field,
  // and the extra property is a harmless no-op on the post-migration shape.
  const refreshCall: InstallAllOptions & { skipServer?: boolean } = {
    unityProjectPath,
    pluginSource: embedSource,
    stagedNugetPath,
    dryRun: opts.dryRun === true,
    refresh: true,
    skipConfig: true, // UserSettings config is preserved byte-for-byte.
    skipServer: true,
    ...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
  };
  const result = await installAll(refreshCall);
  warnings.push(...result.warnings);
  if (result.kind === 'failure') {
    return {
      status: 'failed',
      detail: result.error.message,
      warnings: result.warnings,
    };
  }
  return {
    status: 'refreshed',
    detail: opts.dryRun === true
      ? 'plugin package and NuGet DLL set would be re-staged from the uco bundle as one matched set'
      : 'plugin package and NuGet DLL set re-staged from the uco bundle as one matched set',
    warnings: result.warnings,
  };
}
