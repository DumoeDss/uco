import * as path from 'node:path';
import { CliError } from '../../util/errors.js';
import {
  createProject as createHubProject,
  ensureUnityHub,
  installEditor as installHubEditor,
  listAvailableReleases as listHubAvailableReleases,
  listInstalledEditors as listHubInstalledEditors,
  silentUnityHubOutput,
  type AvailableRelease as HubAvailableRelease,
  type InstalledEditor as HubInstalledEditor,
  type UnityHubOperationOptions,
} from '../utils/unity-hub.js';
import {
  createUnityCli,
  type AvailableRelease as OfficialAvailableRelease,
  type CreateUnityProjectOptions,
  type InstalledEditor as OfficialInstalledEditor,
  type InstallEditorOptions,
  type UnityCli,
  type UnityCliArchitecture,
  type UnityCliFactoryOptions,
} from '../utils/unity-cli.js';

export type UnityLifecycleBackend = 'unity-cli' | 'unity-hub';
export type UnityCliPolicy = 'auto' | 'required' | 'hub';
export type LifecycleSelectionReason =
  | 'auto-detected'
  | 'auto-absent-fallback'
  | 'required-by-flag'
  | 'required-by-path-override'
  | 'forced-hub';

export interface LifecycleEditor {
  version: string;
  path: string;
  alias?: string;
  architecture?: string;
  modules?: string[];
  isDefault?: boolean;
}

export interface LifecycleRelease {
  version: string;
  alias?: string;
  architecture?: string;
  installedPath?: string;
  isStable: boolean;
}

export interface LifecycleDecision {
  policy: UnityCliPolicy;
  reason: LifecycleSelectionReason;
  overridePresent: boolean;
  officialAvailable: boolean;
  officialPath?: string;
  fallback: boolean;
}

export interface LifecycleDiagnostics {
  policy: UnityCliPolicy;
  selectedBackend: UnityLifecycleBackend;
  selectionReason: LifecycleSelectionReason;
  overridePresent: boolean;
  officialAvailable: boolean;
  officialPath: string | null;
  officialVersion: string | null;
  fallback: boolean;
}

export interface LifecycleInstallOptions extends InstallEditorOptions {
  prefetchedReleases?: readonly LifecycleRelease[];
}

export interface LifecycleCreateProjectOptions {
  projectPath: string;
  editorVersion?: string;
  template?: string;
  architecture?: UnityCliArchitecture;
}

export interface UnityLifecycleSession {
  readonly backend: UnityLifecycleBackend;
  readonly decision: LifecycleDecision;
  readonly unityCliPath: string | undefined;
  readonly hubPath: string | undefined;
  validateInstallOptions(options: InstallEditorOptions): void;
  validateCreateOptions(options: LifecycleCreateProjectOptions): void;
  listInstalledEditors(): Promise<LifecycleEditor[]>;
  listAvailableReleases(): Promise<LifecycleRelease[]>;
  installEditor(version: string, options?: LifecycleInstallOptions): Promise<void>;
  createProject(options: LifecycleCreateProjectOptions): Promise<void>;
  getDiagnostics(): LifecycleDiagnostics;
}

export interface UnityLifecycleSessionOptions {
  /** Suppress backend-owned progress for JSON or library-safe callers. */
  silent?: boolean;
}

export type UnityLifecycleSessionSelector = (
  options?: UnityLifecycleSessionOptions,
) => UnityLifecycleSession;

export interface BoundOfficialLifecycleAdapter {
  getUnityCliVersion(): string | null;
  listInstalledEditors(): Promise<OfficialInstalledEditor[]>;
  listAvailableReleases(): Promise<OfficialAvailableRelease[]>;
  installEditor(version: string, options?: InstallEditorOptions): Promise<void>;
  createProject(options: CreateUnityProjectOptions): Promise<void>;
}

export interface OfficialLifecycleAdapter extends BoundOfficialLifecycleAdapter {
  findUnityCli(): string | null;
  /** Bind operations to the selection result so this session never rediscovers. */
  bindExecutable?(executable: string | null): BoundOfficialLifecycleAdapter;
}

export interface HubLifecycleAdapter {
  ensureUnityHub(options?: UnityHubOperationOptions): Promise<string>;
  listInstalledEditors(hubPath: string, options?: UnityHubOperationOptions): HubInstalledEditor[];
  listAvailableReleases(hubPath: string, options?: UnityHubOperationOptions): HubAvailableRelease[];
  installEditor(
    hubPath: string,
    version: string,
    prefetchedReleases?: HubAvailableRelease[],
    options?: UnityHubOperationOptions,
  ): Promise<void>;
  createProject(
    hubPath: string,
    projectPath: string,
    editorVersion?: string,
    options?: UnityHubOperationOptions,
  ): void;
}

export interface UnityLifecycleRouterOptions {
  environment?: NodeJS.ProcessEnv;
  official?: OfficialLifecycleAdapter;
  hub?: HubLifecycleAdapter;
}

export class UnityLifecycleError extends CliError {
  toJSON(): Record<string, unknown> {
    return {
      error: true,
      message: this.message,
      code: this.code,
      exitCode: this.exitCode,
    };
  }
}

function officialOperations(client: UnityCli): BoundOfficialLifecycleAdapter {
  return {
    getUnityCliVersion: client.getUnityCliVersion,
    listInstalledEditors: client.listInstalledEditorsU,
    listAvailableReleases: client.listAvailableReleasesU,
    installEditor: client.installEditorU,
    createProject: client.createProjectU,
  };
}

/** @internal Production-shaped adapter factory used by lifecycle contract tests. */
export function createOfficialLifecycleAdapter(
  options: UnityCliFactoryOptions = {},
): OfficialLifecycleAdapter {
  const discoveryClient = createUnityCli(options);
  return {
    findUnityCli: discoveryClient.findUnityCli,
    ...officialOperations(discoveryClient),
    bindExecutable(executable) {
      const selectedEnvironment = {
        ...(options.environment ?? process.env),
      };
      return officialOperations(createUnityCli({
        ...options,
        environment: selectedEnvironment,
        pinnedExecutable: executable,
      }));
    },
  };
}

const productionOfficialAdapter = createOfficialLifecycleAdapter();

const productionHubAdapter: HubLifecycleAdapter = {
  ensureUnityHub,
  listInstalledEditors: listHubInstalledEditors,
  listAvailableReleases: listHubAvailableReleases,
  installEditor: installHubEditor,
  createProject: createHubProject,
};

function parsePolicy(environment: NodeJS.ProcessEnv): UnityCliPolicy {
  const raw = environment['UCO_USE_UNITY_CLI'];
  if (raw === undefined || raw === '' || raw === 'auto') return 'auto';
  if (raw === '1') return 'required';
  if (raw === '0') return 'hub';
  throw new UnityLifecycleError(
    `Invalid UCO_USE_UNITY_CLI value: ${JSON.stringify(raw)}. Expected auto, 1, or 0.`,
    'invalid-unity-cli-policy',
  );
}

function hasPathOverride(environment: NodeJS.ProcessEnv): boolean {
  return Boolean(environment['UNITY_CLI_PATH']?.trim());
}

function unsupportedInstallOption(options: InstallEditorOptions): string | undefined {
  if ((options.modules?.length ?? 0) > 0) return '--module';
  if (options.architecture !== undefined) return '--architecture';
  if (options.changeset !== undefined) return '--changeset';
  if (options.childModules !== undefined) return options.childModules ? '--child-modules' : '--no-child-modules';
  if (options.force === true) return '--force';
  if (options.acceptEula === true) return '--accept-eula';
  if (options.resume === true) return '--resume';
  if (options.noElevate === true) return '--no-elevate';
  return undefined;
}

function unsupportedCreateOption(options: LifecycleCreateProjectOptions): string | undefined {
  if (options.template !== undefined) return '--template';
  if (options.architecture !== undefined) return '--architecture';
  return undefined;
}

function officialOnlyError(option: string): UnityLifecycleError {
  return new UnityLifecycleError(
    `${option} requires the official Unity CLI. Remove the option or set UCO_USE_UNITY_CLI=1.`,
    'unity-cli-required',
  );
}

function validateProjectTarget(projectPath: string): { name: string; parent: string } {
  const normalized = path.resolve(projectPath);
  const name = path.basename(normalized);
  const parent = path.dirname(normalized);
  if (!name || normalized === parent) {
    throw new UnityLifecycleError(
      `Project path must include a project folder name: ${normalized}`,
      'invalid-project-path',
    );
  }
  return { name, parent };
}

function compareUnityVersions(a: string, b: string): number {
  const tokens = (value: string): Array<number | string> => (
    value.match(/\d+|[a-zA-Z]+/g)?.map((token) => {
      const numeric = Number(token);
      return Number.isNaN(numeric) ? token.toLowerCase() : numeric;
    }) ?? []
  );
  const left = tokens(a);
  const right = tokens(b);
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = left[index];
    const rightPart = right[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    if (typeof leftPart === 'number' && typeof rightPart === 'number') {
      if (leftPart !== rightPart) return leftPart - rightPart;
      continue;
    }
    const compared = String(leftPart).localeCompare(String(rightPart));
    if (compared !== 0) return compared;
  }
  return 0;
}

export function findHighestLifecycleEditor(
  editors: readonly LifecycleEditor[],
): LifecycleEditor | null {
  if (editors.length === 0) return null;
  return editors.reduce((highest, current) => (
    compareUnityVersions(current.version, highest.version) > 0 ? current : highest
  ));
}

export function findLatestStableLifecycleRelease(
  releases: readonly LifecycleRelease[],
): LifecycleRelease | null {
  const stable = releases.filter((release) => release.isStable);
  if (stable.length === 0) return null;
  return stable.reduce((highest, current) => (
    compareUnityVersions(current.version, highest.version) > 0 ? current : highest
  ));
}

export function createUnityLifecycleRouter(
  options: UnityLifecycleRouterOptions = {},
): { selectSession: UnityLifecycleSessionSelector } {
  const environment = options.environment ?? process.env;
  const official = options.official ?? productionOfficialAdapter;
  const hub = options.hub ?? productionHubAdapter;

  const selectSession = (sessionOptions: UnityLifecycleSessionOptions = {}): UnityLifecycleSession => {
    const policy = parsePolicy(environment);
    const overridePresent = hasPathOverride(environment);
    const officialPath = official.findUnityCli();
    const officialAvailable = officialPath !== null;

    let backend: UnityLifecycleBackend;
    let reason: LifecycleSelectionReason;
    if (policy === 'hub') {
      backend = 'unity-hub';
      reason = 'forced-hub';
    } else if (policy === 'required') {
      backend = 'unity-cli';
      reason = 'required-by-flag';
    } else if (overridePresent) {
      backend = 'unity-cli';
      reason = 'required-by-path-override';
    } else if (officialAvailable) {
      backend = 'unity-cli';
      reason = 'auto-detected';
    } else {
      backend = 'unity-hub';
      reason = 'auto-absent-fallback';
    }

    const decision: LifecycleDecision = {
      policy,
      reason,
      overridePresent,
      officialAvailable,
      ...(officialPath !== null ? { officialPath } : {}),
      fallback: reason === 'auto-absent-fallback',
    };
    const selectedOfficial = official.bindExecutable?.(officialPath) ?? official;
    const hubOperationOptions: UnityHubOperationOptions = {
      strictInventory: true,
      ...(sessionOptions.silent ? { output: silentUnityHubOutput } : {}),
    };

    let resolvedHubPath: string | undefined;
    let hubPromise: Promise<string> | undefined;
    const resolveHub = (): Promise<string> => {
      hubPromise ??= hub.ensureUnityHub(hubOperationOptions).then((value) => {
        resolvedHubPath = value;
        return value;
      });
      return hubPromise;
    };

    const validateInstallOptions = (installOptions: InstallEditorOptions): void => {
      if (backend !== 'unity-hub') return;
      const unsupported = unsupportedInstallOption(installOptions);
      if (unsupported !== undefined) throw officialOnlyError(unsupported);
    };

    const validateCreateOptions = (projectOptions: LifecycleCreateProjectOptions): void => {
      validateProjectTarget(projectOptions.projectPath);
      if (backend !== 'unity-hub') return;
      const unsupported = unsupportedCreateOption(projectOptions);
      if (unsupported !== undefined) throw officialOnlyError(unsupported);
    };

    return {
      backend,
      decision,
      get unityCliPath() {
        return backend === 'unity-cli' ? officialPath ?? undefined : undefined;
      },
      get hubPath() {
        return backend === 'unity-hub' ? resolvedHubPath : undefined;
      },
      validateInstallOptions,
      validateCreateOptions,
      async listInstalledEditors() {
        if (backend === 'unity-cli') {
          return (await selectedOfficial.listInstalledEditors()).map((editor) => ({
            version: editor.version,
            path: editor.path,
            ...(editor.alias !== undefined ? { alias: editor.alias } : {}),
            ...(editor.architecture !== undefined ? { architecture: editor.architecture } : {}),
            modules: [...editor.modules],
            isDefault: editor.isDefault,
          }));
        }
        return hub.listInstalledEditors(await resolveHub(), hubOperationOptions).map((editor) => ({
          version: editor.version,
          path: editor.path,
        }));
      },
      async listAvailableReleases() {
        if (backend === 'unity-cli') {
          return (await selectedOfficial.listAvailableReleases()).map((release) => ({
            version: release.version,
            ...(release.alias !== undefined ? { alias: release.alias } : {}),
            ...(release.architecture !== undefined ? { architecture: release.architecture } : {}),
            ...(release.installedPath !== undefined ? { installedPath: release.installedPath } : {}),
            isStable: release.isStable,
          }));
        }
        return hub.listAvailableReleases(await resolveHub(), hubOperationOptions).map((release) => ({
          version: release.version,
          isStable: release.isStable,
        }));
      },
      async installEditor(version, installOptions = {}) {
        validateInstallOptions(installOptions);
        if (backend === 'unity-cli') {
          const { prefetchedReleases: _prefetchedReleases, ...officialOptions } = installOptions;
          await selectedOfficial.installEditor(version, officialOptions);
          return;
        }
        const prefetched = installOptions.prefetchedReleases?.map((release) => ({
          version: release.version,
          isStable: release.isStable,
        }));
        await hub.installEditor(await resolveHub(), version, prefetched, hubOperationOptions);
      },
      async createProject(projectOptions) {
        validateCreateOptions(projectOptions);
        const target = path.resolve(projectOptions.projectPath);
        if (backend === 'unity-cli') {
          const { name, parent } = validateProjectTarget(target);
          await selectedOfficial.createProject({
            name,
            parent,
            ...(projectOptions.editorVersion !== undefined
              ? { editorVersion: projectOptions.editorVersion }
              : {}),
            ...(projectOptions.template !== undefined ? { template: projectOptions.template } : {}),
            ...(projectOptions.architecture !== undefined
              ? { architecture: projectOptions.architecture }
              : {}),
          });
          return;
        }
        hub.createProject(
          await resolveHub(),
          target,
          projectOptions.editorVersion,
          hubOperationOptions,
        );
      },
      getDiagnostics() {
        return {
          policy,
          selectedBackend: backend,
          selectionReason: reason,
          overridePresent,
          officialAvailable,
          officialPath,
          officialVersion: officialAvailable ? selectedOfficial.getUnityCliVersion() : null,
          fallback: reason === 'auto-absent-fallback',
        };
      },
    };
  };

  return { selectSession };
}

const productionRouter = createUnityLifecycleRouter();

export function selectUnityLifecycleSession(
  options?: UnityLifecycleSessionOptions,
): UnityLifecycleSession {
  return productionRouter.selectSession(options);
}

export function lifecycleBackendMetadata(
  session: UnityLifecycleSession,
): Record<string, string> {
  if (session.backend === 'unity-cli') {
    return {
      backend: session.backend,
      ...(session.unityCliPath !== undefined ? { unityCliPath: session.unityCliPath } : {}),
    };
  }
  return {
    backend: session.backend,
    ...(session.hubPath !== undefined ? { hubPath: session.hubPath } : {}),
  };
}
