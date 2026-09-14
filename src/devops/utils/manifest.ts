import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'node:crypto';
import { isNewerVersion, isValidVersion } from './semver.js';
import { silentLogger, type LibLogger } from '../lib/logger.js';

export const UCO_UNITY_PACKAGE_ID = 'com.atelierai.unity.copilot';
// Older package ids uco must clean out of a manifest when (re)installing,
// so a Phase-C rename leaves no dangling dependency behind.
export const COCLI_LEGACY_UNITY_PACKAGE_IDS = ['com.ivanmurzak.unity.mcp'] as const;
const REGISTRY_NAME = 'package.openupm.com';
const REGISTRY_URL = 'https://package.openupm.com';
export const COCLI_OPENUPM_REQUIRED_SCOPES = [
  'com.atelierai',
  'com.ivanmurzak',
  'extensions.unity',
  'org.nuget.com.ivanmurzak',
  'org.nuget.microsoft',
  'org.nuget.system',
  'org.nuget.r3',
];
const COCLI_INSTALL_OPENUPM_REQUIRED_SCOPES = ['extensions.unity'] as const;

interface ScopedRegistry {
  name: string;
  url: string;
  scopes: string[];
}

interface Manifest {
  dependencies?: Record<string, string>;
  scopedRegistries?: ScopedRegistry[];
  [key: string]: unknown;
}

export interface ManifestFileSystem {
  statSync(filePath: string): { mode: number };
  writeFileSync(filePath: string, content: string, options: { encoding: 'utf8'; mode: number; flag: 'wx' }): void;
  renameSync(oldPath: string, newPath: string): void;
  unlinkSync(filePath: string): void;
}

export class AtomicManifestReplaceError extends Error {
  readonly temporaryPath: string;
  readonly replacementError: unknown;
  readonly cleanupError: unknown;

  constructor(temporaryPath: string, replacementError: unknown, cleanupError: unknown) {
    const replacementMessage = replacementError instanceof Error
      ? replacementError.message
      : String(replacementError);
    const cleanupMessage = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
    super(
      `Atomic manifest replacement failed (${replacementMessage}); cleanup also failed `
      + `and the temporary manifest may remain at ${temporaryPath} (${cleanupMessage}).`,
      { cause: new AggregateError([replacementError, cleanupError]) },
    );
    this.name = 'AtomicManifestReplaceError';
    this.temporaryPath = temporaryPath;
    this.replacementError = replacementError;
    this.cleanupError = cleanupError;
  }
}

const manifestFileSystem: ManifestFileSystem = {
  statSync: (filePath) => fs.statSync(filePath),
  writeFileSync: (filePath, content, options) => fs.writeFileSync(filePath, content, options),
  renameSync: (oldPath, newPath) => fs.renameSync(oldPath, newPath),
  unlinkSync: (filePath) => fs.unlinkSync(filePath),
};

/** Same-directory unique write followed by atomic replacement. */
export function atomicReplaceManifest(
  manifestPath: string,
  content: string,
  fileSystem: ManifestFileSystem = manifestFileSystem,
): void {
  const mode = fileSystem.statSync(manifestPath).mode;
  const temporaryPath = path.join(
    path.dirname(manifestPath),
    `.${path.basename(manifestPath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let temporaryExists = false;
  try {
    // Mark ownership before the call: a filesystem can create/partially write
    // the file and still throw. ENOENT during cleanup means creation never
    // happened and is the only safe cleanup error to ignore.
    temporaryExists = true;
    fileSystem.writeFileSync(temporaryPath, content, { encoding: 'utf8', mode, flag: 'wx' });
    fileSystem.renameSync(temporaryPath, manifestPath);
    temporaryExists = false;
  } catch (replacementError) {
    if (temporaryExists) {
      try {
        fileSystem.unlinkSync(temporaryPath);
      } catch (cleanupError) {
        if ((cleanupError as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
          throw replacementError;
        }
        throw new AtomicManifestReplaceError(temporaryPath, replacementError, cleanupError);
      }
    }
    throw replacementError;
  }
}

export interface PluginManifestInspection {
  manifestPath: string;
  activeSource: string | undefined;
  activeSourceIsNonSemver: boolean;
}

function isNonSemverPackageSource(value: string): boolean {
  return ['file:', 'git:', 'git+', 'ssh:', 'http:', 'https:']
    .some((prefix) => value.toLowerCase().startsWith(prefix));
}

export function inspectPluginManifest(projectPath: string): PluginManifestInspection {
  const manifestPath = path.join(projectPath, 'Packages', 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`manifest.json not found at: ${manifestPath}`);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Manifest;
  const activeSource = manifest.dependencies?.[UCO_UNITY_PACKAGE_ID];
  return {
    manifestPath,
    activeSource,
    activeSourceIsNonSemver: activeSource !== undefined && isNonSemverPackageSource(activeSource),
  };
}

/**
 * Resolve the latest plugin version from the OpenUPM registry.
 * Throws an error with actionable suggestions if the network request fails.
 *
 * @param logger Optional logger. Defaults to `silentLogger` so library
 *   callers stay side-effect-free; CLI call sites must pass a chalk-
 *   styled logger adapter explicitly to preserve the historical output.
 */
export async function resolveLatestVersion(logger: LibLogger = silentLogger): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  try {
    const res = await fetch(`https://package.openupm.com/${UCO_UNITY_PACKAGE_ID}`, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });

    if (res.ok) {
      const data: unknown = await res.json();
      const latest = data !== null && typeof data === 'object' && !Array.isArray(data)
        ? (data as Record<string, unknown>)['dist-tags']
        : undefined;
      const latestValue = latest !== null && typeof latest === 'object' && !Array.isArray(latest)
        ? (latest as Record<string, unknown>)['latest']
        : undefined;
      if (typeof latestValue === 'string'
        && latestValue === latestValue.trim()
        && !/[\u0000-\u001f\u007f]/.test(latestValue)
        && isValidVersion(latestValue)) {
        logger.info(`Resolved latest version from OpenUPM: ${latestValue}`);
        return latestValue;
      }
      throw new Error(
        'OpenUPM returned an invalid latest plugin version. '
        + 'Retry, or run `uco install-plugin <project> --version <version>`.',
      );
    }

    throw new Error(
      `OpenUPM returned status ${res.status}. ` +
      'Check your network connection and retry, or run `uco install-plugin <project> --version <version>`.'
    );
  } catch (err) {
    if (err instanceof Error && err.message.includes('uco install-plugin')) {
      throw err;
    }
    throw new Error(
      'Failed to resolve latest plugin version from OpenUPM. ' +
      'Check your network connection and retry, or run `uco install-plugin <project> --version <version>`.'
    );
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Determines if the version should be updated.
 * Only update if the new version is higher than the current version.
 * Ports the C# Installer.ShouldUpdateVersion() logic.
 */
export function shouldUpdateVersion(currentVersion: string, newVersion: string): boolean {
  if (!currentVersion) return true;
  if (!newVersion) return false;

  // Skip automatic update for non-semver specs (file:, git+, http, etc.)
  const nonSemverPrefixes = ['file:', 'git+', 'http:', 'https:'];
  if (nonSemverPrefixes.some((prefix) => currentVersion.startsWith(prefix))) {
    return false;
  }

  if (isValidVersion(currentVersion) && isValidVersion(newVersion)) {
    return isNewerVersion(currentVersion, newVersion);
  }

  // Automatic resolution never overwrites an unrecognised dependency value.
  // Explicit --version retains force semantics in addPluginToManifest.
  return false;
}

export interface AddPluginResult {
  /** Whether the file was modified on disk (false = already up to date). */
  modified: boolean;
  /** Final plugin version in the manifest (may differ from the requested
   *  version if the existing version was higher and force was false). */
  resolvedVersion: string;
  /** Absolute path to the manifest.json that was inspected / written. */
  manifestPath: string;
}

/**
 * Add Unity-MCP plugin to a Unity project's Packages/manifest.json.
 * Ports the C# Installer.Manifest.cs logic:
 * - Adds OpenUPM scoped registry with required scopes
 * - Adds/updates the plugin dependency
 * - When force is false (auto-resolved version): never downgrades
 * - When force is true (user-specified --plugin-version): allows downgrade
 *
 * @param logger Optional logger. Defaults to `silentLogger` so library
 *   callers stay side-effect-free; CLI call sites must pass a chalk-
 *   styled logger adapter explicitly to preserve the historical output.
 */
export function addPluginToManifest(
  projectPath: string,
  version: string,
  force = false,
  logger: LibLogger = silentLogger,
  fileSystem: ManifestFileSystem = manifestFileSystem,
): AddPluginResult {
  const manifestPath = path.join(projectPath, 'Packages', 'manifest.json');

  if (!fs.existsSync(manifestPath)) {
    throw new Error(`manifest.json not found at: ${manifestPath}`);
  }

  const rawJson = fs.readFileSync(manifestPath, 'utf-8');
  const manifest: Manifest = JSON.parse(rawJson);
  let modified = false;

  // --- Ensure scopedRegistries array exists
  if (!manifest.scopedRegistries) {
    manifest.scopedRegistries = [];
    modified = true;
  }

  // --- Find or create the OpenUPM registry
  let openUpmRegistry = manifest.scopedRegistries.find(
    (r) => r.name === REGISTRY_NAME
  );

  if (!openUpmRegistry) {
    openUpmRegistry = {
      name: REGISTRY_NAME,
      url: REGISTRY_URL,
      scopes: [],
    };
    manifest.scopedRegistries.push(openUpmRegistry);
    modified = true;
  }

  if (openUpmRegistry.url !== REGISTRY_URL) {
    openUpmRegistry.url = REGISTRY_URL;
    modified = true;
  }

  // --- Add missing scopes
  if (!openUpmRegistry.scopes) {
    openUpmRegistry.scopes = [];
    modified = true;
  }

  for (const scope of COCLI_OPENUPM_REQUIRED_SCOPES) {
    if (!openUpmRegistry.scopes.includes(scope)) {
      openUpmRegistry.scopes.push(scope);
      modified = true;
    }
  }

  // --- Add/update dependency (version-aware, never downgrade)
  if (!manifest.dependencies) {
    manifest.dependencies = {};
    modified = true;
  }

  for (const legacyId of COCLI_LEGACY_UNITY_PACKAGE_IDS) {
    if (manifest.dependencies[legacyId] !== undefined) {
      delete manifest.dependencies[legacyId];
      modified = true;
    }
  }

  const currentVersion = manifest.dependencies[UCO_UNITY_PACKAGE_ID];
  let resolvedVersion = version;
  if (!currentVersion || force || shouldUpdateVersion(currentVersion, version)) {
    manifest.dependencies[UCO_UNITY_PACKAGE_ID] = version;
    modified = true;
  } else {
    resolvedVersion = currentVersion;
    logger.info(
      `Plugin already at version ${currentVersion} (>= ${version}). Skipping version update. Use \`uco install-plugin <project> --version <version>\` to force a specific version.`
    );
  }

  // --- Write back
  if (modified) {
    atomicReplaceManifest(manifestPath, JSON.stringify(manifest, null, 2) + '\n', fileSystem);
    logger.success(`Updated ${manifestPath}`);
  } else {
    logger.info('manifest.json is already up to date.');
  }

  return { modified, resolvedVersion, manifestPath };
}

// ---------------------------------------------------------------------------
// uco install — cross-project manifest patching
// ---------------------------------------------------------------------------

/** Plugin sourcing mode for `setPluginInManifest`. */
export type ManifestPluginSpec =
  | { kind: 'file'; path: string }
  | { kind: 'git'; url: string }
  | { kind: 'embed' }; // embed mode: dependency value is workspace-relative file:?
                        //  embed currently writes "file:./com.atelierai.unity.copilot"
                        //  matching Unity's embedded-package convention.

export interface PatchManifestResult {
  /** Whether the file was modified on disk. */
  modified: boolean;
  /** Absolute path to the manifest.json. */
  manifestPath: string;
  /** Final dependency value written under `com.atelierai.unity.copilot`. */
  dependencyValue: string;
  /** Scoped registry scopes that were removed (so caller can warn). */
  removedScopes: string[];
}

/**
 * Patch `Packages/manifest.json` for the uco `install` flow.
 *
 *   - Set `dependencies["com.atelierai.unity.copilot"]` to the chosen sourcing
 *     spec (file:, git, or embed).
 *   - Strip the OpenUPM `org.nuget.com.ivanmurzak.*` scopes from any
 *     existing `scopedRegistries[].scopes` array (we ship DLLs directly,
 *     so OpenUPM must not race the install and re-introduce upstream
 *     binaries).
 *   - Keep the OpenUPM `extensions.unity` scope needed by the embedded
 *     plugin's Unity package dependencies.
 *   - If another scopedRegistry ends up with zero scopes after stripping,
 *     remove that registry entry.
 *
 * Idempotent: re-running with the same spec is a no-op.
 *
 * NB: this is intentionally separate from `addPluginToManifest`, which
 *     installs the plugin itself from OpenUPM. uco's install path only
 *     keeps scopes needed by transitive Unity packages.
 */
export function setPluginInManifest(
  projectPath: string,
  spec: ManifestPluginSpec,
  logger: LibLogger = silentLogger,
  fileSystem: ManifestFileSystem = manifestFileSystem,
): PatchManifestResult {
  const manifestPath = path.join(projectPath, 'Packages', 'manifest.json');

  if (!fs.existsSync(manifestPath)) {
    throw new Error(`manifest.json not found at: ${manifestPath}`);
  }

  const rawJson = fs.readFileSync(manifestPath, 'utf-8');
  const manifest: Manifest = JSON.parse(rawJson);
  let modified = false;
  const removedScopes: string[] = [];

  // --- Compute the new dependency value
  let dependencyValue: string;
  switch (spec.kind) {
    case 'file': {
      // Normalize: Unity wants forward slashes after `file:`.
      const normalized = spec.path.replace(/\\/g, '/');
      dependencyValue = `file:${normalized}`;
      break;
    }
    case 'git':
      dependencyValue = spec.url;
      break;
    case 'embed':
      // Embedded packages live under <target>/Packages/<name>/ — Unity
      // resolves them implicitly from the directory; the manifest entry
      // typically points at the embedded folder via `file:` syntax.
      dependencyValue = `file:./${UCO_UNITY_PACKAGE_ID}`;
      break;
    default: {
      const _exhaustive: never = spec;
      throw new Error(`Unknown plugin spec kind: ${JSON.stringify(_exhaustive)}`);
    }
  }

  // --- Replace dependency
  if (!manifest.dependencies) {
    manifest.dependencies = {};
    modified = true;
  }
  // Drop legacy package keys so a project installed before the Phase C
  // rename doesn't keep a stale dependency pointing at a now-renamed (and
  // therefore non-existent) file: path — Unity would fail to resolve it.
  for (const legacyId of COCLI_LEGACY_UNITY_PACKAGE_IDS) {
    if (manifest.dependencies[legacyId] !== undefined) {
      delete manifest.dependencies[legacyId];
      modified = true;
    }
  }
  if (manifest.dependencies[UCO_UNITY_PACKAGE_ID] !== dependencyValue) {
    manifest.dependencies[UCO_UNITY_PACKAGE_ID] = dependencyValue;
    modified = true;
  }

  // --- Strip OpenUPM org.nuget.com.ivanmurzak.* scopes so OpenUPM
  //     cannot race-install upstream NuGet packages over our staged DLLs.
  const registries = Array.isArray(manifest.scopedRegistries)
    ? manifest.scopedRegistries
    : [];
  const filteredRegistries: ScopedRegistry[] = [];
  for (const reg of registries) {
    if (!Array.isArray(reg.scopes)) {
      filteredRegistries.push(reg);
      continue;
    }
    const before = reg.scopes.length;
    const kept = reg.scopes.filter((s) => {
      const drop = s === 'org.nuget.com.ivanmurzak' || s.startsWith('org.nuget.com.ivanmurzak.');
      if (drop) removedScopes.push(s);
      return !drop;
    });
    if (kept.length !== before) {
      modified = true;
      reg.scopes = kept;
    }
    if (kept.length === 0) {
      // Drop it here; required OpenUPM scopes are restored below.
      modified = true;
      continue;
    }
    filteredRegistries.push(reg);
  }

  // --- Keep OpenUPM available for Unity-package dependencies that are not
  //     part of uco's staged NuGet DLL set (currently PlayerPrefsEx).
  let openUpmRegistry = filteredRegistries.find((reg) => reg.name === REGISTRY_NAME);
  if (!openUpmRegistry) {
    openUpmRegistry = {
      name: REGISTRY_NAME,
      url: REGISTRY_URL,
      scopes: [],
    };
    filteredRegistries.push(openUpmRegistry);
    modified = true;
  }
  if (openUpmRegistry.url !== REGISTRY_URL) {
    openUpmRegistry.url = REGISTRY_URL;
    modified = true;
  }
  if (!Array.isArray(openUpmRegistry.scopes)) {
    openUpmRegistry.scopes = [];
    modified = true;
  }
  for (const scope of COCLI_INSTALL_OPENUPM_REQUIRED_SCOPES) {
    if (!openUpmRegistry.scopes.includes(scope)) {
      openUpmRegistry.scopes.push(scope);
      modified = true;
    }
  }
  manifest.scopedRegistries = filteredRegistries;

  if (modified) {
    atomicReplaceManifest(manifestPath, JSON.stringify(manifest, null, 2) + '\n', fileSystem);
    logger.success(`Patched ${manifestPath}`);
  } else {
    logger.info('manifest.json is already up to date.');
  }

  return { modified, manifestPath, dependencyValue, removedScopes };
}

export interface RemovePluginResult {
  /** Whether the plugin was present and has been removed. */
  removed: boolean;
  /** Absolute path to the manifest.json that was inspected. */
  manifestPath: string;
}

/**
 * Remove Unity-MCP plugin from a Unity project's Packages/manifest.json.
 * Only removes the plugin dependency — scoped registries and scopes are
 * left untouched because other packages may depend on them.
 *
 * @param logger Optional logger. Defaults to `silentLogger` so library
 *   callers stay side-effect-free; CLI call sites must pass a chalk-
 *   styled logger adapter explicitly to preserve the historical output.
 */
export function removePluginFromManifest(
  projectPath: string,
  logger: LibLogger = silentLogger,
  fileSystem: ManifestFileSystem = manifestFileSystem,
): RemovePluginResult {
  const manifestPath = path.join(projectPath, 'Packages', 'manifest.json');

  if (!fs.existsSync(manifestPath)) {
    throw new Error(`manifest.json not found at: ${manifestPath}`);
  }

  const rawJson = fs.readFileSync(manifestPath, 'utf-8');
  const manifest: Manifest = JSON.parse(rawJson);

  if (!manifest.dependencies || !(UCO_UNITY_PACKAGE_ID in manifest.dependencies)) {
    logger.info('Unity-MCP plugin is not installed. Nothing to remove.');
    return { removed: false, manifestPath };
  }

  delete manifest.dependencies[UCO_UNITY_PACKAGE_ID];
  atomicReplaceManifest(manifestPath, JSON.stringify(manifest, null, 2) + '\n', fileSystem);
  logger.success(`Removed ${UCO_UNITY_PACKAGE_ID} from ${manifestPath}`);
  return { removed: true, manifestPath };
}
