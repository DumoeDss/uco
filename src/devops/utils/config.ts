import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'node:crypto';
import { generatePortFromDirectory } from './port.js';

export const CONFIG_RELATIVE_PATH = 'UserSettings/AI-Game-Developer-Config.json';

export interface McpFeature {
  name: string;
  enabled: boolean;
}

export interface UnityConnectionConfig {
  host?: string;
  token?: string;
  keepConnected?: boolean;
  logLevel?: number | string;
  timeoutMs?: number;
  keepServerRunning?: boolean;
  transportMethod?: string;
  authOption?: string;
  connectionMode?: string | number;
  cloudToken?: string | null;
  tools?: McpFeature[];
  prompts?: McpFeature[];
  resources?: McpFeature[];
  [key: string]: unknown;
}

function getConfigPath(projectPath: string): string {
  return path.join(projectPath, CONFIG_RELATIVE_PATH);
}

export interface AtomicConfigWriteDependencies {
  openSync: typeof fs.openSync;
  writeFileSync: typeof fs.writeFileSync;
  fsyncSync: typeof fs.fsyncSync;
  closeSync: typeof fs.closeSync;
  renameSync: typeof fs.renameSync;
  unlinkSync: typeof fs.unlinkSync;
}

const defaultAtomicWriteDependencies: AtomicConfigWriteDependencies = {
  openSync: fs.openSync,
  writeFileSync: fs.writeFileSync,
  fsyncSync: fs.fsyncSync,
  closeSync: fs.closeSync,
  renameSync: fs.renameSync,
  unlinkSync: fs.unlinkSync,
};

/** Generate the shared project credential used by uco and the Unity plugin. */
export function generateConnectionToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

/**
 * Create a default config for a Unity project.
 */
export function createDefaultConfig(projectPath: string): UnityConnectionConfig {
  const port = generatePortFromDirectory(projectPath);
  return {
    host: `http://127.0.0.1:${port}`,
    token: generateConnectionToken(),
    logLevel: 'Warning',
    keepServerRunning: true,
    keepConnected: true,
    timeoutMs: 10000,
    transportMethod: 'streamableHttp',
    authOption: 'required',
    connectionMode: 'Custom',
    allowLanBind: false,
    allowInsecureRemoteHttp: false,
    forceTokenWhenLanBind: true,
    cloudToken: null,
    tools: [],
    prompts: [],
    resources: [],
    skillAutoGenerate: {},
    generateSkillFiles: false,
    skillsPath: '.claude/skills',
  };
}

/**
 * Read the AI-Game-Developer-Config.json from a Unity project.
 * Returns null if the file doesn't exist.
 */
export function readConfig(projectPath: string): UnityConnectionConfig | null {
  const configPath = getConfigPath(projectPath);
  if (!fs.existsSync(configPath)) {
    return null;
  }
  const json = fs.readFileSync(configPath, 'utf-8');
  try {
    return JSON.parse(json) as UnityConnectionConfig;
  } catch (err) {
    if (err instanceof SyntaxError) {
      throw new SyntaxError(`Malformed JSON in config file: ${configPath}\n${err.message}`);
    }
    throw err;
  }
}

/**
 * Write the AI-Game-Developer-Config.json to a Unity project.
 * Creates the UserSettings directory if needed.
 */
export function writeConfig(
  projectPath: string,
  config: UnityConnectionConfig,
  dependencies: AtomicConfigWriteDependencies = defaultAtomicWriteDependencies,
): void {
  const configPath = getConfigPath(projectPath);
  const dir = path.dirname(configPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Never convert a malformed descriptor into a seemingly valid one. Callers
  // must surface the parse error so the user can recover the original file.
  if (fs.existsSync(configPath)) {
    readConfig(projectPath);
  }

  const tempPath = path.join(
    dir,
    `.${path.basename(configPath)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`,
  );
  let descriptor: number | undefined;
  try {
    descriptor = dependencies.openSync(tempPath, 'wx', 0o600);
    dependencies.writeFileSync(descriptor, JSON.stringify(config, null, 2) + '\n', { encoding: 'utf8' });
    dependencies.fsyncSync(descriptor);
    dependencies.closeSync(descriptor);
    descriptor = undefined;
    dependencies.renameSync(tempPath, configPath);
  } catch (error) {
    if (descriptor !== undefined) {
      try { dependencies.closeSync(descriptor); } catch { /* best-effort close */ }
    }
    try { dependencies.unlinkSync(tempPath); } catch { /* best-effort cleanup */ }
    throw error;
  }
}

/**
 * Read config or create with defaults if it doesn't exist.
 */
export function getOrCreateConfig(projectPath: string): UnityConnectionConfig {
  if (fs.existsSync(getConfigPath(projectPath))) {
    return readConfig(projectPath) as UnityConnectionConfig;
  }

  const config = createDefaultConfig(projectPath);
  writeConfig(projectPath, config);
  return config;
}

/**
 * Update features (tools, prompts, or resources) in the config.
 * - enableNames: set these to enabled=true
 * - disableNames: set these to enabled=false
 * - enableAll/disableAll: override all features
 */
export function updateFeatures(
  config: UnityConnectionConfig,
  featureType: 'tools' | 'prompts' | 'resources',
  options: {
    enableNames?: string[];
    disableNames?: string[];
    enableAll?: boolean;
    disableAll?: boolean;
  }
): void {
  const rawFeatures = config[featureType];
  const features: McpFeature[] = Array.isArray(rawFeatures)
    ? rawFeatures.filter(
        (f): f is McpFeature =>
          typeof f === 'object' && f !== null && typeof f.name === 'string' && typeof f.enabled === 'boolean'
      )
    : [];

  if (options.enableAll) {
    for (const f of features) f.enabled = true;
    config[featureType] = features;
    return;
  }

  if (options.disableAll) {
    for (const f of features) f.enabled = false;
    config[featureType] = features;
    return;
  }

  if (options.enableNames) {
    for (const name of options.enableNames) {
      const existing = features.find((f) => f.name === name);
      if (existing) {
        existing.enabled = true;
      } else {
        features.push({ name, enabled: true });
      }
    }
  }

  if (options.disableNames) {
    for (const name of options.disableNames) {
      const existing = features.find((f) => f.name === name);
      if (existing) {
        existing.enabled = false;
      } else {
        features.push({ name, enabled: false });
      }
    }
  }

  config[featureType] = features;
}

/**
 * Determine whether the config is in Cloud mode.
 * Handles both string ("Cloud") and legacy integer (1) representations
 * of the ConnectionMode enum.
 */
export function isCloudMode(config: UnityConnectionConfig): boolean {
  const mode = config.connectionMode;
  return mode === 'Cloud' || mode === 1;
}

export const CLOUD_SERVER_BASE_URL = 'https://ai-game.dev';
export const CLOUD_SERVER_URL = 'https://ai-game.dev/mcp';

/**
 * Resolve the server URL and auth token from a project config based on connectionMode.
 * - Custom mode (string "Custom" or integer 0): uses `host` and `token`
 * - Cloud mode (string "Cloud" or integer 1): uses hardcoded cloud URL and `cloudToken`
 * In Custom mode, `url` and `token` may be undefined if the corresponding config fields are not set.
 * In Cloud mode, `url` is always the hardcoded cloud URL, while `token` comes from `cloudToken` and may be undefined.
 */
export function resolveConnectionFromConfig(config: UnityConnectionConfig): {
  url: string | undefined;
  token: string | undefined;
} {
  const cloud = isCloudMode(config);

  return {
    url: cloud ? CLOUD_SERVER_URL : config.host,
    token: cloud ? (config.cloudToken ?? undefined) : config.token,
  };
}
