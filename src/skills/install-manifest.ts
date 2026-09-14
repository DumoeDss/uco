// The project install manifest — uco's authoritative installed-state record.
//
// `uco init` writes `.uco/install-manifest.json` after a successful
// install; every command that refreshes, validates, or reports uco-installed
// agent assets (notably `uco update`) resolves the installed-agent set from
// it. Targets that predate the manifest are migrated once by seeding from
// on-disk uco-owned artifacts; the seed is idempotent and fails open.
//
// House style: canonical JSON (sorted keys, 2-space indent, trailing newline)
// written atomically via a staged unique temp file + rename.

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { canonicalJson } from '../catalog.js';
import { ENTRY_SKILL_IDS, isCocliOwnedSkillDirectory } from './bundle.js';
import { getSkillsCapableAgents } from '../devops/utils/agents.js';
import { UCO_UNITY_PACKAGE_ID } from '../devops/utils/manifest.js';

export const INSTALL_MANIFEST_SCHEMA_VERSION = 1;
export const INSTALL_MANIFEST_RELATIVE_PATH = path.join('.uco', 'install-manifest.json');

/**
 * Marker for a Unity toolchain whose plugin package is managed by uco's own
 * bundle (embed/vendor staging). Any other recorded `unity.source` value
 * (`file:<path>`, `git:<url>`, or a raw registry version) is user-managed:
 * `uco update` skips it with a note naming the source.
 */
export const UNITY_SOURCE_BUNDLE = 'bundle';

export interface InstallManifestAgent {
  id: string;
  /** Effective skills path (registry default or the `--skills-path` override). */
  skillsPath: string;
}

export interface InstallManifestUnity {
  installed: boolean;
  /**
   * How the plugin package is sourced: `bundle` (uco-managed, refreshed by
   * update), `file:<path>`, `git:<url>`, or a raw registry version — all
   * user-managed. Optional; older manifests may omit it.
   */
  source?: string;
  /** Unity project the toolchain surface was installed into (defaults to the target). */
  projectPath?: string;
}

export interface InstallManifest {
  schemaVersion: number;
  /** uco package version that performed the most recent successful write. */
  ucoVersion: string;
  updatedAt: string;
  agents: InstallManifestAgent[];
  unity: InstallManifestUnity;
}

export interface ReadManifestResult {
  /** `undefined` when no manifest file exists (or it is unparseable — fail open). */
  manifest: InstallManifest | undefined;
  warnings: string[];
}

export interface ReadOrSeedResult extends ReadManifestResult {
  /** `true` when no manifest existed and this call computed (and attempted to persist) a seed. */
  seeded: boolean;
  /** Agent ids the seed discovered, named for the user when `seeded` is true. */
  seedAgentIds: string[];
}

export interface DeselectionCleanupResult {
  /** Agent ids whose uco-owned skill directories were removed. */
  removedAgents: string[];
  /** Skill directories actually deleted (relative to the target). */
  removedDirectories: string[];
  warnings: string[];
}

let cachedCocliVersion: string | undefined;

/** The uco package's own version, from the package.json next to the build. */
export function getUcoVersion(): string {
  if (cachedCocliVersion !== undefined) return cachedCocliVersion;
  try {
    // src/skills/install-manifest.ts → ../../package.json (same hop from dist/skills).
    const packageJsonPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '..',
      '..',
      'package.json',
    );
    const raw = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as { version?: unknown };
    if (typeof raw.version === 'string' && raw.version.length > 0) {
      cachedCocliVersion = raw.version;
      return cachedCocliVersion;
    }
  } catch {
    // Fall through to the hardcoded fallback.
  }
  cachedCocliVersion = '0.2.1';
  return cachedCocliVersion;
}

export function installManifestPath(target: string): string {
  return path.join(target, INSTALL_MANIFEST_RELATIVE_PATH);
}

/**
 * Write the manifest as canonical JSON with a trailing newline, atomically
 * (unique staged temp file in the destination directory, then rename).
 */
export function writeInstallManifest(target: string, manifest: InstallManifest): string {
  const manifestPath = installManifestPath(target);
  const directory = path.dirname(manifestPath);
  fs.mkdirSync(directory, { recursive: true });
  const content = canonicalJson(manifest);
  const tempPath = path.join(
    directory,
    `.${path.basename(manifestPath)}.${process.pid}.${process.hrtime.bigint().toString(36)}.tmp`,
  );
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(tempPath, 'wx');
    fs.writeFileSync(descriptor, content, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(tempPath, manifestPath);
  } catch (error) {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch { /* best-effort close */ }
    }
    try { fs.unlinkSync(tempPath); } catch { /* best-effort cleanup */ }
    throw error;
  }
  return manifestPath;
}

/**
 * Tolerant reader. Optional fields may be absent (an older binary's manifest
 * parses without error); unknown agent ids are dropped with a warning naming
 * the id; a missing `skillsPath` falls back to the registry default. An
 * unparseable manifest is reported as a warning and treated as absent so the
 * caller can fail open.
 */
export function readInstallManifest(target: string): ReadManifestResult {
  const warnings: string[] = [];
  let manifestPath = installManifestPath(target);
  if (!fs.existsSync(manifestPath)) {
    // Pre-rename layout: .uco/install-manifest.json -> .cocli/install-manifest.json
    const legacy = path.join(target, '.cocli', 'install-manifest.json');
    if (fs.existsSync(legacy)) manifestPath = legacy;
    else return { manifest: undefined, warnings };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    warnings.push(
      `Install manifest is unparseable and was ignored: ${manifestPath} (${error instanceof Error ? error.message : String(error)})`,
    );
    return { manifest: undefined, warnings };
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    warnings.push(`Install manifest has an unexpected shape and was ignored: ${manifestPath}`);
    return { manifest: undefined, warnings };
  }
  const record = raw as Record<string, unknown>;

  const agents: InstallManifestAgent[] = [];
  if (Array.isArray(record['agents'])) {
    for (const entry of record['agents']) {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue;
      const id = (entry as Record<string, unknown>)['id'];
      if (typeof id !== 'string' || id.length === 0) continue;
      const agent = getSkillsCapableAgents().find((candidate) => candidate.id === id);
      if (!agent) {
        warnings.push(`Install manifest lists unknown agent "${id}"; the entry was dropped.`);
        continue;
      }
      const skillsPathRaw = (entry as Record<string, unknown>)['skillsPath'];
      const skillsPath = typeof skillsPathRaw === 'string' && skillsPathRaw.length > 0 && isSafeRelativePath(skillsPathRaw)
        ? skillsPathRaw
        : (agent.skillsPath as string);
      if (agents.some((existing) => existing.id === id)) continue;
      agents.push({ id, skillsPath });
    }
  } else if (record['agents'] !== undefined) {
    warnings.push(`Install manifest "agents" is not an array and was treated as empty: ${manifestPath}`);
  }

  const unity: InstallManifestUnity = { installed: false };
  const unityRaw = record['unity'];
  if (unityRaw !== null && typeof unityRaw === 'object' && !Array.isArray(unityRaw)) {
    const unityRecord = unityRaw as Record<string, unknown>;
    unity.installed = unityRecord['installed'] === true;
    const source = unityRecord['source'];
    if (typeof source === 'string' && source.length > 0) {
      unity.source = source;
    }
    const projectPath = unityRecord['projectPath'];
    if (typeof projectPath === 'string' && projectPath.length > 0) {
      unity.projectPath = projectPath;
    }
  }

  return {
    manifest: {
      schemaVersion: typeof record['schemaVersion'] === 'number' ? record['schemaVersion'] : INSTALL_MANIFEST_SCHEMA_VERSION,
      ucoVersion: typeof record['ucoVersion'] === 'string' ? record['ucoVersion'] : '',
      updatedAt: typeof record['updatedAt'] === 'string' ? record['updatedAt'] : '',
      agents,
      unity,
    },
    warnings,
  };
}

export interface SeedOptions {
  /**
   * Persist the computed seed to `.uco/install-manifest.json` (default
   * `true`). A caller planning a dry run passes `false`: the seed is still
   * computed in memory — so the plan can report the would-be migration — but
   * nothing is written.
   */
  persist?: boolean;
}

/**
 * Resolve the installed state, seeding the manifest once from on-disk
 * uco-owned artifacts when no manifest exists:
 *
 *   - every skills-capable agent whose skills path holds a uco-owned
 *     entry-skill directory (valid `.uco-skill.json`), plus
 *   - a `unity` record when the target is a Unity project whose
 *     `Packages/manifest.json` references the uco package.
 *
 * Idempotent: a present manifest is returned verbatim and never re-seeded
 * regardless of disk state. A seed write failure degrades to the in-memory
 * seed for the current run with a warning naming the manifest path — it never
 * aborts solely because the seed could not be persisted. When neither a
 * manifest nor any uco-owned artifact exists, `manifest` is `undefined` and
 * nothing is written.
 */
export function readOrSeedInstallManifest(target: string, options: SeedOptions = {}): ReadOrSeedResult {
  const existing = readInstallManifest(target);
  if (existing.manifest !== undefined) {
    return { ...existing, seeded: false, seedAgentIds: [] };
  }

  const seed = computeInstallSeed(target);
  if (seed.agents.length === 0 && !seed.unity.installed) {
    return { manifest: undefined, warnings: existing.warnings, seeded: false, seedAgentIds: [] };
  }

  const manifest: InstallManifest = {
    schemaVersion: INSTALL_MANIFEST_SCHEMA_VERSION,
    ucoVersion: getUcoVersion(),
    updatedAt: new Date().toISOString(),
    agents: seed.agents,
    unity: seed.unity,
  };
  const warnings = [...existing.warnings];
  if (options.persist !== false) {
    try {
      writeInstallManifest(target, manifest);
    } catch (error) {
      warnings.push(
        `Could not persist the install manifest at ${installManifestPath(target)} (${error instanceof Error ? error.message : String(error)}); using on-disk detection for this run.`,
      );
    }
  }
  return {
    manifest,
    warnings,
    seeded: true,
    seedAgentIds: seed.agents.map((agent) => agent.id),
  };
}

/** On-disk detection union used by the one-time migration seed. */
export function computeInstallSeed(target: string): { agents: InstallManifestAgent[]; unity: InstallManifestUnity } {
  const agents: InstallManifestAgent[] = [];
  for (const agent of getSkillsCapableAgents()) {
    const skillsRoot = path.join(target, agent.skillsPath as string);
    if (ENTRY_SKILL_IDS.some((skillId) => isCocliOwnedSkillDirectory(skillsRoot, skillId))) {
      agents.push({ id: agent.id, skillsPath: agent.skillsPath as string });
    }
  }
  return { agents, unity: detectUnitySeed(target) };
}

/**
 * Detect whether the target is a Unity project whose `Packages/manifest.json`
 * references the uco package, inferring the source kind from the dependency
 * value. Used by the migration seed and by `uco init`'s first manifest
 * write on a target that already carries a uco Unity install.
 */
export function detectUnitySeed(target: string): InstallManifestUnity {
  const manifestPath = path.join(target, 'Packages', 'manifest.json');
  if (!fs.existsSync(manifestPath)) return { installed: false };
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
      dependencies?: Record<string, unknown>;
    };
    const dependency = manifest.dependencies?.[UCO_UNITY_PACKAGE_ID];
    if (typeof dependency !== 'string' || dependency.length === 0) return { installed: false };
    return { installed: true, source: inferUnitySource(dependency), projectPath: target };
  } catch {
    return { installed: false };
  }
}

/**
 * Infer the `unity.source` value from a `Packages/manifest.json` dependency
 * value: the embedded-package pointer maps to `bundle` (uco-managed); other
 * `file:` paths and git/ssh/http(s) URLs map to user-managed `file:<path>` /
 * `git:<url>` markers; a registry version is recorded verbatim.
 */
export function inferUnitySource(dependency: string): string {
  const normalized = dependency.toLowerCase();
  if (normalized === `file:./${UCO_UNITY_PACKAGE_ID}` || normalized === `file:${UCO_UNITY_PACKAGE_ID}`) {
    return UNITY_SOURCE_BUNDLE;
  }
  if (normalized.startsWith('file:')) return dependency;
  if (normalized.startsWith('git+')) return `git:${dependency.slice('git+'.length)}`;
  if (normalized.startsWith('git:') || normalized.startsWith('ssh:') || normalized.startsWith('http:') || normalized.startsWith('https:')) {
    return `git:${dependency}`;
  }
  return dependency;
}

/**
 * Remove the uco-owned entry-skill directories of agents absent from a new
 * selection. Every removal is guarded by the ownership manifest plus the
 * no-unmanaged-files check (see `isCocliOwnedSkillDirectory`); any refusal is
 * warned about and skipped — this helper never throws and never touches
 * directories uco does not own.
 *
 * A deselected agent whose recorded skills path is also recorded by a
 * SURVIVING agent keeps its directories: several registry entries share one
 * path (`.github/skills` for vscode-copilot / vs-copilot / github-copilot-cli),
 * and after a shrink the survivor still owns that directory.
 */
export function removeDeselectedAgentSkills(
  target: string,
  deselected: readonly InstallManifestAgent[],
  survivingAgents: readonly InstallManifestAgent[] = [],
): DeselectionCleanupResult {
  const removedAgents: string[] = [];
  const removedDirectories: string[] = [];
  const warnings: string[] = [];

  for (const entry of deselected) {
    if (!isSafeRelativePath(entry.skillsPath)) {
      warnings.push(`Refusing to clean up agent "${entry.id}" with an unsafe skills path: ${entry.skillsPath}`);
      continue;
    }
    const sharingSurvivors = survivingAgents.filter((survivor) => skillsPathsEqual(survivor.skillsPath, entry.skillsPath));
    if (sharingSurvivors.length > 0) {
      warnings.push(
        `Kept the skills directories of deselected agent "${entry.id}": ${entry.skillsPath} is still used by retained agent(s) ${sharingSurvivors.map((survivor) => survivor.id).join(', ')}.`,
      );
      continue;
    }
    const skillsRoot = path.join(target, entry.skillsPath);
    if (!fs.existsSync(skillsRoot)) continue;
    let removedAny = false;
    for (const skillId of ENTRY_SKILL_IDS) {
      const directory = path.join(skillsRoot, skillId);
      if (!fs.existsSync(directory)) continue;
      if (!isCocliOwnedSkillDirectory(skillsRoot, skillId)) {
        warnings.push(
          `Refusing to remove directory without verifiable uco ownership: ${path.relative(target, directory).replace(/\\/g, '/')} (review it manually)`,
        );
        continue;
      }
      fs.rmSync(directory, { recursive: true, force: false });
      removedDirectories.push(path.relative(target, directory).replace(/\\/g, '/'));
      removedAny = true;
    }
    if (removedAny) removedAgents.push(entry.id);
  }

  return { removedAgents, removedDirectories, warnings };
}

/** Same recorded skills path (separators normalized; case-insensitive on Windows). */
function skillsPathsEqual(left: string, right: string): boolean {
  const normalize = (value: string): string => {
    const slashed = value.replace(/\\/g, '/');
    return process.platform === 'win32' ? slashed.toLowerCase() : slashed;
  };
  return normalize(left) === normalize(right);
}

/**
 * Record (or update) the Unity toolchain section after `uco install`
 * succeeds, creating the manifest when absent (install may run before any
 * `uco init`). Fails open with a warning — a manifest problem must never
 * fail an otherwise-successful install.
 */
export function recordUnityInInstallManifest(
  target: string,
  unity: InstallManifestUnity,
): { manifestPath: string } | { warning: string } {
  const existing = readInstallManifest(target);
  const base = existing.manifest;
  const manifest: InstallManifest = {
    schemaVersion: INSTALL_MANIFEST_SCHEMA_VERSION,
    ucoVersion: getUcoVersion(),
    updatedAt: new Date().toISOString(),
    agents: base?.agents ?? [],
    unity,
  };
  try {
    const manifestPath = writeInstallManifest(target, manifest);
    return { manifestPath };
  } catch (error) {
    return {
      warning: `Could not record the Unity install in ${installManifestPath(target)} (${error instanceof Error ? error.message : String(error)}).`,
    };
  }
}

function isSafeRelativePath(value: string): boolean {
  const normalized = value.replace(/\\/g, '/');
  const segments = normalized.split('/');
  return normalized !== ''
    && !path.isAbsolute(value)
    && !path.win32.isAbsolute(value)
    && segments.every((segment) => segment !== '' && segment !== '..');
}
