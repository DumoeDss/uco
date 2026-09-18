// Resolve the (url, token) pair to talk to the uco bridge, given:
//   1. Explicit CLI overrides (--url, --token)
//   2. The Unity project's UserSettings/AI-Game-Developer-Config.json
//   3. Deterministic-port localhost fallback
//
// Priority: explicit override > project config > deterministic port.

import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { generatePortFromDirectory } from './port.js';

const CONFIG_RELATIVE_PATH = 'UserSettings/uco-config.json';
// Pre-rename filename (uco 0.3.0): read as a fallback until every project
// has been migrated (the plugin migrates it on first Editor start).
const LEGACY_CONFIG_RELATIVE_PATH = 'UserSettings/AI-Game-Developer-Config.json';

export interface ProjectConfig {
  host?: string;
  token?: string;
  connectionMode?: string | number; // legacy Cloud value loads as Custom (host-driven)
  // Other fields exist but uco doesn't care.
  [key: string]: unknown;
}

export interface ResolveOptions {
  /** Path to the Unity project root (the folder that contains Assets/, ProjectSettings/, UserSettings/). */
  projectPath?: string;
  /** Direct server URL override. Wins over everything else. */
  url?: string;
  /** Direct bearer token override. */
  token?: string;
}

export interface Resolved {
  baseUrl: string;
  token: string | undefined;
  /** Where the URL came from — useful for diagnostics. */
  source: 'override' | 'config-custom' | 'deterministic';
  /** Resolved project path (absolute), if any. */
  projectPath: string | undefined;
}

export function resolveConnection(opts: ResolveOptions): Resolved {
  // 1. Explicit override wins outright.
  if (opts.url) {
    return {
      baseUrl: stripTrailingSlash(opts.url),
      token: opts.token,
      source: 'override',
      projectPath: opts.projectPath ? resolve(opts.projectPath) : undefined,
    };
  }

  // 2. Try to load project config.
  if (opts.projectPath) {
    const absProjectPath = resolve(opts.projectPath);
    const cfg = tryReadConfig(absProjectPath);

    if (cfg) {
      if (cfg.host) {
        return {
          baseUrl: stripTrailingSlash(cfg.host),
          token: opts.token ?? cfg.token,
          source: 'config-custom',
          projectPath: absProjectPath,
        };
      }
    }

    // 3. Deterministic port fallback for the given project path.
    return {
      baseUrl: `http://127.0.0.1:${generatePortFromDirectory(absProjectPath)}`,
      token: opts.token,
      source: 'deterministic',
      projectPath: absProjectPath,
    };
  }

  throw new Error(
    'uco: cannot resolve server URL — supply --url, or --project <path>, ' +
      'or cd into a Unity project directory.',
  );
}

function tryReadConfig(projectPath: string): ProjectConfig | null {
  const configPath = join(projectPath, CONFIG_RELATIVE_PATH);
  const legacyConfigPath = join(projectPath, LEGACY_CONFIG_RELATIVE_PATH);
  const effectivePath = existsSync(configPath) ? configPath : legacyConfigPath;
  if (!existsSync(effectivePath)) return null;
  try {
    return JSON.parse(readFileSync(effectivePath, 'utf8')) as ProjectConfig;
  } catch {
    // Malformed config — treat as missing.
    return null;
  }
}

function stripTrailingSlash(s: string): string {
  return s.replace(/\/+$/, '');
}
