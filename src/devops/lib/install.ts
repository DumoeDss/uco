// uco `install` library — the end-user-facing "make Unity work" entry point.
//
// Unlike `installPlugin` (which only patches Packages/manifest.json against
// OpenUPM), `installAll` stages every artifact a fresh Unity project needs
// to run the Phase B forked toolchain:
//
//   1. Patch manifest.json to point com.atelierai.unity.copilot at the chosen
//      source (file:, git, or embed) AND strip the org.nuget.com.ivanmurzak.*
//      OpenUPM scopes so OpenUPM cannot race over our staged DLLs.
//   2. Delete packages-lock.json so Unity re-resolves on next open.
//   3. Copy unity-copilot/dist/nuget/* into <target>/Assets/Plugins/NuGet/,
//      preserving existing .meta files to keep Unity GUIDs stable across
//      projects.
//   4. Initialise UserSettings/uco-config.json IFF missing.
//
// No server staging: the Unity plugin auto-starts the Node.js MCP server
// (uco) on launch, so no server binaries are copied into the project.
//
// Library-safe: never calls `process.exit`, never prints, returns a
// discriminated-union result.

import * as fs from 'node:fs';
import * as path from 'node:path';
import process from 'node:process';
import { silentLogger, type LibLogger } from './logger.js';
import { emitProgress } from './progress.js';
import { requireUnityProject } from './validation.js';
import {
  UCO_UNITY_PACKAGE_ID,
  setPluginInManifest,
  type ManifestPluginSpec,
} from '../utils/manifest.js';
import { createDefaultConfig, writeConfig } from '../utils/config.js';
import type {
  InstallAllOptions,
  InstallAllResult,
  PlannedAction,
  PluginSource,
} from './types.js';

const NUGET_REL = 'Assets/Plugins/NuGet';
const CONFIG_REL = 'UserSettings/uco-config.json';
const LOCKFILE_REL = 'Packages/packages-lock.json';
const EMBED_REL = path.join('Packages', UCO_UNITY_PACKAGE_ID);

/**
 * Install the Unity-MCP toolchain into a target Unity project.
 *
 * This is the single end-user entry point. After it completes, the user
 * opens Unity once and the Plugin auto-starts the Node.js MCP server with
 * the correct token + port.
 */
export async function installAll(opts: InstallAllOptions): Promise<InstallAllResult> {
  const actions: PlannedAction[] = [];
  const warnings: string[] = [];
  const summary: string[] = [];
  const nextSteps: string[] = [];
  const logger: LibLogger = silentLogger;
  const dryRun = opts.dryRun === true;

  try {
    emitProgress(opts.onProgress, { phase: 'validating', message: 'Validating target Unity project' });

    const validated = requireUnityProject(opts.unityProjectPath);
    if (!validated.ok) {
      return {
        kind: 'failure',
        success: false,
        manifestPath: validated.manifestPath,
        warnings,
        actions,
        error: validated.error,
      };
    }
    const { projectPath, manifestPath } = validated;

    // --- Step 1: Patch manifest.json (delegated to setPluginInManifest)
    if (opts.skipPlugin !== true) {
      // Refresh mode gates the lockfile reset (and reports package siblings)
      // on whether the plugin surface actually differs from the source bundle.
      let pluginContentChanged = true;
      if (opts.refresh === true) {
        pluginContentChanged = pluginSurfaceDiffers(projectPath, opts.pluginSource);
        for (const sibling of detectPackageSiblings(projectPath)) {
          warnings.push(
            `Possible stale copy of ${UCO_UNITY_PACKAGE_ID} in Packages/: "${sibling}" — review and remove it manually if obsolete (uco never deletes it).`,
          );
        }
      }
      const manifestSpec = pluginSpecToManifestSpec(opts.pluginSource);
      actions.push({
        kind: 'patch-manifest',
        detail: describePluginSpec(opts.pluginSource),
        target: manifestPath,
      });
      if (!dryRun) {
        const patch = setPluginInManifest(projectPath, manifestSpec, logger);
        if (patch.removedScopes.length > 0) {
          warnings.push(
            `Removed OpenUPM scopes (we ship NuGet DLLs directly): ${patch.removedScopes.join(', ')}`,
          );
        }
        summary.push(`manifest.json -> ${UCO_UNITY_PACKAGE_ID} = ${patch.dependencyValue}`);
        emitProgress(opts.onProgress, {
          phase: 'manifest-patched',
          message: `Patched ${patch.manifestPath}`,
          manifestPath: patch.manifestPath,
        });
      }

      // --- Step 1b: Embed mode also needs the package source copied in
      if (opts.pluginSource.kind === 'embed') {
        const embedDest = path.join(projectPath, EMBED_REL);
        actions.push({
          kind: 'embed-plugin',
          detail: `Copy plugin source from ${opts.pluginSource.sourcePath}`,
          target: embedDest,
        });
        if (!dryRun) {
          mirrorDirectory(opts.pluginSource.sourcePath, embedDest);
          summary.push(`Embedded plugin -> ${embedDest}`);
        }
      }

      // --- Step 1c: Delete packages-lock.json so Unity re-resolves.
      // In refresh mode the reset is gated on the plugin surface actually
      // changing; an unchanged refresh leaves the lockfile in place.
      const lockfilePath = path.join(projectPath, LOCKFILE_REL);
      if (fs.existsSync(lockfilePath) && (opts.refresh !== true || pluginContentChanged)) {
        actions.push({
          kind: 'remove-lockfile',
          detail: 'Delete packages-lock.json so Unity re-resolves on next open',
          target: lockfilePath,
        });
        if (!dryRun) {
          fs.unlinkSync(lockfilePath);
          emitProgress(opts.onProgress, {
            phase: 'lockfile-removed',
            message: `Removed ${lockfilePath}`,
            lockfilePath,
          });
        }
      }
    }

    // --- Step 2: Stage NuGet DLLs (with GUID-preserving meta merge)
    if (opts.skipNuget !== true) {
      const stagedNuget = opts.stagedNugetPath;
      const nugetDest = path.join(projectPath, NUGET_REL);

      if (!stagedNuget) {
        return failureResult(
          new Error('stagedNugetPath is required unless skipNuget is true.'),
          { unityProjectPath: projectPath, manifestPath, warnings, actions },
        );
      }
      if (!fs.existsSync(stagedNuget)) {
        return failureResult(
          new Error(`Staged NuGet path does not exist: ${stagedNuget}\nRun scripts/stage-nuget-dlls.ps1 first.`),
          { unityProjectPath: projectPath, manifestPath, warnings, actions },
        );
      }
      const nugetStat = countDir(stagedNuget);
      actions.push({
        kind: 'stage-nuget',
        detail: `Stage ${nugetStat.files} file(s) (${humanBytes(nugetStat.bytes)}) into Assets/Plugins/NuGet/ (preserving existing .meta GUIDs)`,
        target: nugetDest,
      });
      if (!dryRun) {
        ensureDir(nugetDest);
        stageNugetWithMetaPreservation(stagedNuget, nugetDest);
        emitProgress(opts.onProgress, {
          phase: 'staging-nuget',
          message: `Staged ${nugetStat.files} NuGet files into ${nugetDest}`,
          targetDir: nugetDest,
          fileCount: nugetStat.files,
          bytes: nugetStat.bytes,
        });
        summary.push(`NuGet -> ${nugetDest} (${nugetStat.files} files, ${humanBytes(nugetStat.bytes)})`);
      }
    }

    // --- Step 3: Init config IFF missing
    let configPath: string | undefined;
    if (opts.skipConfig !== true) {
      configPath = path.join(projectPath, CONFIG_REL);
      // Honor a legacy-named config (pre-uco-0.3.0) so install does not
      // overwrite it with fresh defaults; the plugin migrates the file itself.
      const exists = fs.existsSync(configPath)
        || fs.existsSync(path.join(projectPath, 'UserSettings', 'AI-Game-Developer-Config.json'));

      if (exists && !opts.overwriteConfig) {
        actions.push({
          kind: 'preserve-config',
          detail: 'Existing config preserved — re-run with --overwrite-config to regenerate',
          target: configPath,
        });
        if (!dryRun) {
          emitProgress(opts.onProgress, {
            phase: 'config-preserved',
            message: `Preserved existing ${configPath}`,
            configPath,
          });
          summary.push(`Config preserved: ${configPath}`);
        }
      } else {
        actions.push({
          kind: 'init-config',
          detail: 'Initialise UserSettings/uco-config.json (host = http://127.0.0.1:<hash>, random token, keepServerRunning=true)',
          target: configPath,
        });
        if (!dryRun) {
          writeDefaultConfig(projectPath, configPath);
          emitProgress(opts.onProgress, {
            phase: 'config-initialized',
            message: `Created ${configPath}`,
            configPath,
          });
          summary.push(`Config initialised: ${configPath}`);
        }
      }
    }

    nextSteps.push(`Open Unity Editor at ${projectPath} — the Plugin auto-starts its Node MCP server on first launch.`);
    nextSteps.push('Run `uco ping` from the project directory to verify the bridge is live.');

    return {
      kind: 'success',
      success: true,
      unityProjectPath: projectPath,
      manifestPath,
      nugetDir: opts.skipNuget ? undefined : path.join(projectPath, NUGET_REL),
      configPath,
      summary,
      nextSteps,
      warnings,
      actions,
      dryRun,
    };
  } catch (err: unknown) {
    return failureResult(
      err instanceof Error ? err : new Error(String(err)),
      { warnings, actions },
    );
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/**
 * Whether the plugin surface at the target differs from what the given source
 * would produce: the `Packages/manifest.json` dependency value (including
 * legacy package ids) or — for embed staging — any file of the mirrored
 * package source that is missing or byte-different at the target, or any
 * extra file at the target with no counterpart in the source (stale version
 * leftover; mirrorDirectory prunes those on restage). Used by
 * refresh mode to gate the lockfile reset and to detect hand-edited drift.
 * Exported for `uco update`'s needs-refresh pre-check (matched-set heal).
 */
export function pluginSurfaceDiffers(projectPath: string, source: PluginSource): boolean {
  const manifestPath = path.join(projectPath, 'Packages', 'manifest.json');
  if (!fs.existsSync(manifestPath)) return true;
  let manifest: { dependencies?: Record<string, string> };
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { dependencies?: Record<string, string> };
  } catch {
    return true;
  }
  const dependencies = manifest.dependencies ?? {};
  for (const legacyId of ['com.ivanmurzak.unity.mcp']) {
    if (dependencies[legacyId] !== undefined) return true;
  }
  const expected = source.kind === 'embed'
    ? `file:./${UCO_UNITY_PACKAGE_ID}`
    : source.kind === 'file'
      ? `file:${source.path.replace(/\\/g, '/')}`
      : source.url;
  if (dependencies[UCO_UNITY_PACKAGE_ID] !== expected) return true;

  if (source.kind === 'embed') {
    const embedDest = path.join(projectPath, EMBED_REL);
    if (!fs.existsSync(embedDest)) return true;
    if (directoryContentDiffers(source.sourcePath, embedDest)) return true;
  }
  return false;
}

/**
 * True when the trees differ in either direction: a file under `src` that is
 * missing or byte-different under `dst`, or a file under `dst` with no
 * counterpart under `src`. The dst-only direction matters as much as the
 * src-only one: a file deleted upstream (stale version leftover) used to
 * count as "matching", so refresh mode reported `unchanged` for embed
 * directories that were actually broken by stale compile-breaking files.
 */
function directoryContentDiffers(src: string, dst: string): boolean {
  let differs = false;
  const walk = (srcDir: string, dstDir: string): void => {
    if (differs) return;
    for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
      const srcPath = path.join(srcDir, entry.name);
      const dstPath = path.join(dstDir, entry.name);
      if (entry.isDirectory()) {
        walk(srcPath, dstPath);
      } else if (entry.isFile()) {
        if (!fs.existsSync(dstPath) || !fs.statSync(dstPath).isFile()) {
          differs = true;
          return;
        }
        if (!fs.readFileSync(srcPath).equals(fs.readFileSync(dstPath))) {
          differs = true;
          return;
        }
      }
    }
    if (fs.existsSync(dstDir) && fs.statSync(dstDir).isDirectory()) {
      for (const entry of fs.readdirSync(dstDir, { withFileTypes: true })) {
        if (differs) return;
        if (!fs.existsSync(path.join(srcDir, entry.name))) {
          differs = true;
          return;
        }
      }
    }
  };
  walk(src, dst);
  return differs;
}

/**
 * Directories under `Packages/` that look like copies or backups of the uco
 * package directory (the package id prefix) other than the live embedded copy.
 * Reported as warnings only — uco never deletes them. On Windows the
 * comparison is case-insensitive to match the filesystem (a
 * `Com.Atelierai.unity.copilot.bak` sibling would otherwise escape the
 * advisory).
 */
export function detectPackageSiblings(projectPath: string): string[] {
  const packagesDir = path.join(projectPath, 'Packages');
  if (!fs.existsSync(packagesDir)) return [];
  const caseInsensitive = process.platform === 'win32';
  const liveName = caseInsensitive ? UCO_UNITY_PACKAGE_ID.toLowerCase() : UCO_UNITY_PACKAGE_ID;
  const isSibling = (name: string): boolean => {
    const candidate = caseInsensitive ? name.toLowerCase() : name;
    return candidate.startsWith(liveName) && candidate !== liveName;
  };
  return fs.readdirSync(packagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && isSibling(entry.name))
    .map((entry) => entry.name)
    .sort();
}

/**
 * Whether the staged NuGet set differs from what is installed under
 * `Assets/Plugins/NuGet/`: any non-`.meta` file missing or byte-different.
 * Existing `.meta` files count as in sync regardless of content — staging
 * preserves target GUIDs, so a differing `.meta` is expected, not drift.
 * Exported for `uco update`'s needs-refresh pre-check.
 */
export function nugetSurfaceDiffers(stagedNugetPath: string, projectPath: string): boolean {
  const nugetDest = path.join(projectPath, NUGET_REL);
  if (!fs.existsSync(stagedNugetPath)) return true;
  let differs = false;
  const walk = (dir: string): void => {
    if (differs) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (differs) return;
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile()) {
        const installed = path.join(nugetDest, path.relative(stagedNugetPath, absolute));
        if (entry.name.endsWith('.meta') && fs.existsSync(installed)) {
          continue; // GUID-owned by the target
        }
        if (!fs.existsSync(installed) || !fs.statSync(installed).isFile()
          || !fs.readFileSync(absolute).equals(fs.readFileSync(installed))) {
          differs = true;
        }
      }
    }
  };
  walk(stagedNugetPath);
  return differs;
}

function pluginSpecToManifestSpec(src: PluginSource): ManifestPluginSpec {
  switch (src.kind) {
    case 'file':
      return { kind: 'file', path: src.path };
    case 'git':
      return { kind: 'git', url: src.url };
    case 'embed':
      return { kind: 'embed' };
  }
}

function describePluginSpec(src: PluginSource): string {
  switch (src.kind) {
    case 'file':
      return `Patch manifest.json -> ${UCO_UNITY_PACKAGE_ID} = "file:${src.path.replace(/\\/g, '/')}"`;
    case 'git':
      return `Patch manifest.json -> ${UCO_UNITY_PACKAGE_ID} = "${src.url}"`;
    case 'embed':
      return `Patch manifest.json -> ${UCO_UNITY_PACKAGE_ID} = "file:./${UCO_UNITY_PACKAGE_ID}" + copy source into Packages/`;
  }
}

function ensureDir(p: string): void {
  if (!fs.existsSync(p)) {
    fs.mkdirSync(p, { recursive: true });
  }
}

function mirrorDirectory(src: string, dst: string): void {
  ensureDir(dst);
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const sp = path.join(src, entry.name);
    const dp = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      mirrorDirectory(sp, dp);
    } else if (entry.isFile()) {
      fs.copyFileSync(sp, dp);
    }
  }
  pruneDirectory(src, dst);
}

/**
 * Delete everything under `dst` that does not exist under `src`, so the
 * embedded package directory is a true mirror of the bundle. The embed
 * target is fully bundle-managed: a file removed between plugin versions
 * (e.g. 1.0.3's Cloud-era DeviceAuthFlow.cs) must not survive a restage —
 * a stale .cs referencing since-deleted APIs breaks the whole asmdef
 * compile, and a copy-over mirror used to leave exactly that behind.
 */
function pruneDirectory(src: string, dst: string): void {
  for (const entry of fs.readdirSync(dst, { withFileTypes: true })) {
    const sp = path.join(src, entry.name);
    const dp = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      if (fs.existsSync(sp)) {
        pruneDirectory(sp, dp);
      } else {
        fs.rmSync(dp, { recursive: true, force: true });
      }
    } else if (entry.isFile()) {
      if (!fs.existsSync(sp)) {
        fs.rmSync(dp, { force: true });
      }
    }
  }
}

/**
 * Stage NuGet payload with `.meta` GUID preservation.
 *
 *   - For each `*.dll` / `*.xml` / `*.json` in src: overwrite the target file.
 *   - For each `*.meta` in src: copy ONLY IF the target lacks an existing
 *     .meta (preserve existing GUIDs so Unity asset refs across projects
 *     don't break).
 */
function stageNugetWithMetaPreservation(src: string, dst: string): void {
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const sp = path.join(src, entry.name);
    const dp = path.join(dst, entry.name);
    const isMeta = entry.name.endsWith('.meta');
    if (isMeta && fs.existsSync(dp)) {
      // Preserve existing meta -> keep existing GUID.
      continue;
    }
    fs.copyFileSync(sp, dp);
  }
  removeRenamedFrameworkDlls(dst);
}

/**
 * Phase E4 renamed the framework DLLs (uco 0.3.0 / plugin 0.76.0):
 * McpPlugin.dll -> Uco.Framework.dll, McpPlugin.Common.dll ->
 * Uco.Framework.Common.dll. Leftover same-named old DLLs in an installed
 * project would compile alongside the new ones and clash with the asmdef
 * references — delete them (with their .meta) after staging the new set.
 */
function removeRenamedFrameworkDlls(nugetDir: string): void {
  // McpPlugin*: the pre-rename DLL names. The three current framework DLLs
  // (ReflectorNet/Uco.Framework/Uco.Framework.Common) moved INTO the plugin
  // package (Plugins/) as of 1.0.1 — project-level copies would collide with
  // the embedded assemblies, so they are removed on every install.
  const legacy = [
    'McpPlugin.dll',
    'McpPlugin.Common.dll',
    'ReflectorNet.dll',
    'Uco.Framework.dll',
    'Uco.Framework.Common.dll',
  ];
  for (const name of legacy) {
    for (const suffix of ['', '.meta']) {
      const p = path.join(nugetDir, name + suffix);
      try {
        if (fs.existsSync(p)) fs.rmSync(p);
      } catch {
        // Best-effort: a locked file just stays; the new DLLs still win.
      }
    }
  }
}

function countDir(p: string): { files: number; bytes: number } {
  let files = 0;
  let bytes = 0;
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const f = path.join(dir, e.name);
      if (e.isDirectory()) walk(f);
      else if (e.isFile()) {
        files++;
        bytes += fs.statSync(f).size;
      }
    }
  };
  walk(p);
  return { files, bytes };
}

function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

/**
 * Generate a default UserSettings/uco-config.json matching
 * Unity-MCP-Plugin defaults: host = http://127.0.0.1:<hash>, random token,
 * keepServerRunning=true (so the Node server stays up between Editor
 * play-mode toggles), authOption=required.
 */
function writeDefaultConfig(projectPath: string, configPath: string): void {
  const expectedPath = path.join(projectPath, CONFIG_REL);
  if (path.resolve(configPath) !== path.resolve(expectedPath)) {
    throw new Error(`Unexpected project config path: ${configPath}`);
  }
  writeConfig(projectPath, createDefaultConfig(projectPath));
}

function failureResult(
  error: Error,
  fields: {
    unityProjectPath?: string;
    manifestPath?: string;
    warnings: string[];
    actions: PlannedAction[];
  },
): InstallAllResult {
  return {
    kind: 'failure',
    success: false,
    unityProjectPath: fields.unityProjectPath,
    manifestPath: fields.manifestPath,
    warnings: fields.warnings,
    actions: fields.actions,
    error,
  };
}
