// Shared public types for the uco library API.
//
// This file is re-exported from `lib.ts` — consumers should import
// from `@atelierai/uco` (the package root), NOT from deep paths.
//
// No top-level side effects, no runtime deps beyond TypeScript types.

// ---------------------------------------------------------------------------
// Progress events
// ---------------------------------------------------------------------------

/**
 * Discriminated union describing every progress event the library can
 * emit to the optional `onProgress` callback.
 *
 * Consumers can narrow on `event.phase` to decide what to render.
 */
export type ProgressEvent =
  | { phase: 'start'; message: string }
  | { phase: 'manifest-patched'; message: string; manifestPath: string }
  | { phase: 'dependencies-resolved'; message: string; version: string }
  // uco install (cross-project install) phases
  | { phase: 'validating'; message: string }
  | { phase: 'staging-nuget'; message: string; targetDir: string; fileCount?: number; bytes?: number }
  | { phase: 'config-initialized'; message: string; configPath: string }
  | { phase: 'config-preserved'; message: string; configPath: string }
  | { phase: 'lockfile-removed'; message: string; lockfilePath: string }
  // openProject phases
  | { phase: 'detecting-editor-version'; message: string }
  | { phase: 'editors-located'; message: string; found: boolean }
  | { phase: 'editor-resolved'; message: string; editorPath: string; version?: string }
  | { phase: 'starting-node-server'; message: string }
  | {
      phase: 'node-server-ready';
      message: string;
      alreadyRunning: boolean;
      pid?: number;
    }
  | {
      phase: 'connection-details';
      message: string;
      projectPath: string;
      editorPath: string;
      envVars: Record<string, string>;
    }
  | { phase: 'launching-editor'; message: string; editorPath: string; projectPath: string }
  | { phase: 'editor-launched'; message: string; pid?: number }
  | {
      phase: 'launch-errors-dismissed';
      message: string;
      /** Button label that was clicked (e.g. `Ignore`). */
      button: string;
      /** Platform on which the dismiss was performed (`win32` | `darwin` | `linux`). */
      platform: string;
    }
  | { phase: 'done'; message: string };

export type ProgressCallback = (event: ProgressEvent) => void;

// ---------------------------------------------------------------------------
// Result discriminator
// ---------------------------------------------------------------------------

/**
 * Discriminator literal for every library result type. Consumers should
 * narrow on `result.kind === 'success'` (or `=== 'failure'`) to access
 * variant-specific fields with full TypeScript type safety.
 *
 * Wire-compatible note: every result object also carries a `success`
 * boolean that satisfies `success === (kind === 'success')` so existing
 * consumers reading `result.success` continue to work without changes.
 *
 * Exported for consumer ergonomics (e.g. mapping a `ResultKind` to a UI
 * label). DO NOT use as a field type on a result variant — every variant
 * MUST inline the literal (`kind: 'success'` / `kind: 'failure'`) so
 * TypeScript's discriminated-union narrowing works. Declaring
 * `kind: ResultKind` on a variant silently collapses narrowing.
 */
export type ResultKind = 'success' | 'failure';

// ---------------------------------------------------------------------------
// install-plugin
// ---------------------------------------------------------------------------

export interface InstallPluginOptions {
  /** Absolute or relative path to the Unity project's root. */
  unityProjectPath: string;
  /**
   * Plugin version to install. When omitted, the latest version is
   * resolved from OpenUPM.
   */
  version?: string;
  /**
   * Plan only — resolve the version and report the planned manifest patch
   * without writing anything.
   */
  dryRun?: boolean;
  /**
   * Optional progress callback — fires for `start`,
   * `dependencies-resolved` (when the version was auto-resolved),
   * `manifest-patched`, and `done`.
   */
  onProgress?: ProgressCallback;
}

/** A planned action reported by install-plugin dry-run mode; nothing is written. */
export interface PluginPlannedAction {
  action: 'manifest-patch';
  path: string;
  version: string;
}

/** Successful `installPlugin` outcome. Narrow with `kind === 'success'`. */
export interface InstallSuccess {
  kind: 'success';
  /** Always `true` for the success variant. Wire-compatible alias for `kind === 'success'`. */
  success: true;
  /** Final plugin version in the manifest. */
  installedVersion: string;
  /** Absolute path to the manifest.json that was inspected / written. */
  manifestPath: string;
  /** True only when manifest.json was atomically replaced. */
  modified: boolean;
  /** Non-fatal warnings collected during the run (e.g. skipped downgrade). */
  warnings: string[];
  /** Suggested next steps for the caller to surface to a human user. */
  nextSteps: string[];
  /** Present only in dry-run mode: true (nothing was written). */
  dryRun?: boolean;
  /** Present only in dry-run mode: the writes that a real run would perform. */
  plannedActions?: PluginPlannedAction[];
}

/** Failed `installPlugin` outcome. Narrow with `kind === 'failure'`. */
export interface InstallFailure {
  kind: 'failure';
  /** Always `false` for the failure variant. Wire-compatible alias for `kind === 'failure'`. */
  success: false;
  /** Manifest path may be known even on failure (e.g. when validation reaches the manifest). */
  manifestPath?: string;
  /** Non-fatal warnings collected before the failure. */
  warnings: string[];
  /** Suggested next steps the caller may surface to a human user. */
  nextSteps: string[];
  /** The captured error. Never thrown past this boundary. */
  error: Error;
}

export type InstallResult = InstallSuccess | InstallFailure;

// ---------------------------------------------------------------------------
// install (uco's cross-project install — nuget + plugin + config)
// ---------------------------------------------------------------------------

/** Plugin sourcing mode for `installAll`. */
export type PluginSource =
  | { kind: 'file'; path: string }      // `file:<path>` in manifest.json
  | { kind: 'git'; url: string }        // git URL in manifest.json
  | { kind: 'embed'; sourcePath: string }; // copy source into target/Packages/

export interface InstallAllOptions {
  /** Absolute / relative path to the target Unity project. */
  unityProjectPath: string;
  /** Where the Plugin (UPM package) comes from. Default: file: pointing
   *  at the workspace-local fork. */
  pluginSource: PluginSource;
  /** Absolute path to the staged NuGet DLL folder
   *  (`unity-copilot/dist/nuget/`). */
  stagedNugetPath?: string;
  /** When true, only report planned actions — touch no files. */
  dryRun?: boolean;
  /**
   * Refresh mode (`uco update`): the plugin and DLL set are re-staged as one
   * matched set, `packages-lock.json` is deleted only when the plugin content
   * actually changes, and unrecognized sibling copies of the package directory
   * under `Packages/` are reported as warnings (never deleted).
   */
  refresh?: boolean;
  /** Skip NuGet DLL staging step. */
  skipNuget?: boolean;
  /** Skip Plugin manifest patch. */
  skipPlugin?: boolean;
  /** Skip token / config init step. */
  skipConfig?: boolean;
  /** Force a fresh config write even if one already exists. */
  overwriteConfig?: boolean;
  onProgress?: ProgressCallback;
}

/** A planned action; produced in dry-run mode. */
export interface PlannedAction {
  kind:
    | 'patch-manifest'
    | 'remove-lockfile'
    | 'stage-nuget'
    | 'embed-plugin'
    | 'init-config'
    | 'preserve-config';
  detail: string;
  target?: string;
}

export interface InstallAllSuccess {
  kind: 'success';
  success: true;
  unityProjectPath: string;
  manifestPath: string;
  /** Plugin NuGet staging dir under target project. */
  nugetDir?: string;
  /** UserSettings config path (whether created or preserved). */
  configPath?: string;
  /** Plain summary lines suitable for printing. */
  summary: string[];
  /** Suggested next steps. */
  nextSteps: string[];
  /** Non-fatal warnings collected during the run. */
  warnings: string[];
  /** Planned action list (always populated, including in non-dry runs). */
  actions: PlannedAction[];
  /** True iff this was a dry run — no filesystem writes happened. */
  dryRun: boolean;
}

export interface InstallAllFailure {
  kind: 'failure';
  success: false;
  unityProjectPath?: string;
  manifestPath?: string;
  warnings: string[];
  actions: PlannedAction[];
  error: Error;
}

export type InstallAllResult = InstallAllSuccess | InstallAllFailure;

// ---------------------------------------------------------------------------
// remove-plugin
// ---------------------------------------------------------------------------

export interface RemovePluginOptions {
  unityProjectPath: string;
  onProgress?: ProgressCallback;
}

export interface RemoveSuccess {
  kind: 'success';
  success: true;
  /** `true` when the plugin dependency was present and has been removed. */
  removed: boolean;
  manifestPath: string;
  warnings: string[];
}

export interface RemoveFailure {
  kind: 'failure';
  success: false;
  manifestPath?: string;
  warnings: string[];
  error: Error;
}

export type RemoveResult = RemoveSuccess | RemoveFailure;

// ---------------------------------------------------------------------------
// configure
// ---------------------------------------------------------------------------

/** Action applied to a set of managed features (tools, prompts, or resources). */
export interface FeatureAction {
  /** Explicit names to enable. */
  enableNames?: string[];
  /** Explicit names to disable. */
  disableNames?: string[];
  /** Enable every feature already present in the config. */
  enableAll?: boolean;
  /** Disable every feature already present in the config. */
  disableAll?: boolean;
}

export interface ConfigureOptions {
  unityProjectPath: string;
  /** Whether to apply changes to tools. Omit to leave tools untouched. */
  tools?: FeatureAction;
  prompts?: FeatureAction;
  resources?: FeatureAction;
  onProgress?: ProgressCallback;
}

export interface ManagedFeatureSnapshot {
  name: string;
  enabled: boolean;
}

export interface ConfigureSnapshot {
  host?: string;
  keepConnected?: boolean;
  transportMethod?: string;
  authOption?: string;
  tools: ManagedFeatureSnapshot[];
  prompts: ManagedFeatureSnapshot[];
  resources: ManagedFeatureSnapshot[];
}

export interface ConfigureSuccess {
  kind: 'success';
  success: true;
  /** Absolute path to the `AI-Game-Developer-Config.json` that was written. */
  configPath: string;
  /** A read-only snapshot of the post-write config. */
  snapshot: ConfigureSnapshot;
  warnings: string[];
}

export interface ConfigureFailure {
  kind: 'failure';
  success: false;
  warnings: string[];
  error: Error;
}

export type ConfigureResult = ConfigureSuccess | ConfigureFailure;

// ---------------------------------------------------------------------------
// open-project
// ---------------------------------------------------------------------------

/** Auth option propagated to the Editor as `UNITY_COPILOT_AUTH_OPTION`. */
export type OpenProjectAuthOption = 'none' | 'required';

/** Transport propagated to the Editor as `UNITY_COPILOT_TRANSPORT`. */
export type OpenProjectTransport = 'streamableHttp' | 'stdio';

export interface OpenProjectOptions {
  /**
   * Path to the Unity project to open. Absolute or relative; defaults
   * to `process.cwd()` if omitted.
   */
  projectPath?: string;
  /** Specific Unity Editor version to use (e.g. `"2022.3.62f3"`). */
  unityVersion?: string;
  /**
   * If `true`, skip wiring the bridge connection environment variables
   * onto the spawned editor process. Mirrors the CLI's `--no-connect`
   * flag semantics. Defaults to `false`.
   */
  noConnect?: boolean;
  /** bridge URL — sets `UNITY_COPILOT_HOST` on the editor process. */
  url?: string;
  /** Auth token — sets `UNITY_COPILOT_TOKEN` on the editor process. */
  token?: string;
  /** Auth option — sets `UNITY_COPILOT_AUTH_OPTION` on the editor process. */
  auth?: OpenProjectAuthOption;
  /** Comma-separated list of tool names — sets `UNITY_COPILOT_TOOLS`. */
  tools?: string;
  /**
   * If `true`, sets `UNITY_COPILOT_KEEP_CONNECTED=true`. Auto-enabled by
   * Cloud-mode auto-detection when a `cloudToken` is present in the
   * project's config.
   */
  keepConnected?: boolean;
  /** Transport — sets `UNITY_COPILOT_TRANSPORT`. */
  transport?: OpenProjectTransport;
  /**
   * When `true`, uco starts or reuses its own local Node bridge, waits for
   * authenticated readiness, and only then launches Unity with
   * `UNITY_COPILOT_START_SERVER=false` so the plugin does not start a duplicate.
   * A running Editor cannot receive that new environment, so this mode asks
   * the caller to close and reopen it. When explicitly `false`, uco skips
   * the owned preflight and passes `UNITY_COPILOT_START_SERVER=false` through.
   */
  startServer?: boolean;
  /**
   * If `true` (the default), poll for the Unity Editor's
   * "compile errors at launch" dialog after the editor process has
   * been spawned and click `Ignore` (or the platform-equivalent
   * button) so the editor finishes initialising. Set to `false` to
   * disable the polling loop entirely — corresponds to the CLI's
   * `--no-auto-dismiss-launch-errors` flag.
   *
   * The polling loop runs concurrently with the existing wait-for-
   * ready logic (which is the authoritative ready signal); when no
   * dialog appears, behaviour is unchanged from the pre-feature
   * baseline (no spurious clicks, no extra delay).
   */
  autoDismissLaunchErrors?: boolean;
  /**
   * Overall timeout (milliseconds) for the launch-errors dismissal
   * polling loop. The loop ticks every
   * `launchDismissPollIntervalMs` until either the dialog is
   * dismissed, this timeout elapses, or `openProject` returns. Default
   * `30000` (30 s).
   */
  launchDismissTimeoutMs?: number;
  /**
   * Polling tick interval (milliseconds) for the launch-errors
   * dismissal loop. Default `1500`.
   */
  launchDismissPollIntervalMs?: number;
  /**
   * Optional abort signal that, when fired, stops the launch-errors
   * dismissal polling loop early. Intended for callers that have an
   * authoritative "Unity is ready" signal in scope (e.g. a parallel
   * `wait-for-ready` poll) so the dismissal loop does not keep
   * ticking after Unity has finished initialising.
   *
   * When omitted, the loop falls back to a grace window after the
   * editor process is spawned: if no dialog has been observed within
   * ~15s of polling, the loop exits early on the assumption that the
   * dialog is not going to appear for this launch. The grace window
   * has to cover Unity's full startup phase (process spawn → Package
   * Manager connect → first compile pass) because the launch-errors
   * dialog (`"Enter Safe Mode?"` on Unity 2020.2+) appears at the end
   * of that phase, not the start of it (issue #737).
   */
  launchDismissAbortSignal?: AbortSignal;
  /**
   * Optional progress callback — fires for `start`,
   * `detecting-editor-version`, `editors-located`, `editor-resolved`,
   * `connection-details`, `launching-editor`, `editor-launched`,
   * `launch-errors-dismissed` (only when a dialog was actually
   * dismissed), and `done`.
   */
  onProgress?: ProgressCallback;
}

/** Successful `openProject` outcome. Narrow with `kind === 'success'`. */
export interface OpenProjectSuccess {
  kind: 'success';
  /** Always `true` for the success variant. */
  success: true;
  /** Absolute path to the Unity Editor binary that was launched. */
  editorPath: string;
  /**
   * PID of the spawned editor process. May be `undefined` if the OS
   * has not yet reported a PID by the time the call returns (rare;
   * the value is captured asynchronously from the child process's
   * `spawn` event).
   */
  editorPid?: number;
  /** Editor version string used (e.g. `"2022.3.62f3"`), if known. */
  unityVersion?: string;
  /** Resolved absolute project path. */
  projectPath: string;
  /** Non-fatal warnings collected during the run. */
  warnings: string[];
  /**
   * `true` when an existing Unity Editor process was already running
   * with this project and a launch was therefore skipped. The
   * `editorPid` will be the existing process's PID in that case.
   */
  alreadyRunning?: boolean;
}

/** Failed `openProject` outcome. Narrow with `kind === 'failure'`. */
export interface OpenProjectFailure {
  kind: 'failure';
  /** Always `false` for the failure variant. */
  success: false;
  /** Resolved absolute project path, if it could be determined. */
  projectPath?: string;
  /** Editor path, if locating the editor succeeded. */
  editorPath?: string;
  /** Editor version, if it could be detected before failure. */
  unityVersion?: string;
  /** Non-fatal warnings collected before the failure. */
  warnings: string[];
  /** Human-readable error message — never thrown past the public boundary. */
  errorMessage: string;
  /** The captured error. */
  error: Error;
}

export type OpenProjectResult = OpenProjectSuccess | OpenProjectFailure;

/**
 * Subset of `OpenProjectOptions` consumed by `buildOpenEnv` — every
 * field on this interface is potentially mapped to a `UNITY_COPILOT_*`
 * environment variable. Declared as a dedicated interface (rather
 * than a `Pick<OpenProjectOptions, …>` re-listed inline) so adding a
 * new env-bearing option to `OpenProjectOptions` is a one-step change
 * here that `buildOpenEnv` picks up by signature, with no risk of the
 * Pick list silently drifting.
 */
export interface OpenEnvInputs {
  noConnect?: OpenProjectOptions['noConnect'];
  url?: OpenProjectOptions['url'];
  token?: OpenProjectOptions['token'];
  auth?: OpenProjectOptions['auth'];
  tools?: OpenProjectOptions['tools'];
  keepConnected?: OpenProjectOptions['keepConnected'];
  transport?: OpenProjectOptions['transport'];
  startServer?: OpenProjectOptions['startServer'];
}

// ---------------------------------------------------------------------------
// run-tool / run-system-tool
// ---------------------------------------------------------------------------

import type {
  ToolCallControl,
  ToolCallContext,
  ToolCallStructuredError,
} from '../../tool-call-control.js';

/**
 * Coarse failure category for {@link RunToolFailure}. Mirrors the
 * branches the CLI's `run-tool` command surfaces in its error path so
 * library consumers can render the same diagnostics without re-deriving
 * them from the underlying `Error`.
 */
export type RunToolFailureReason =
  | 'invalid-input'
  | 'connection-refused'
  | 'connection-reset'
  | 'network-error'
  | 'timeout'
  | 'http-error'
  | 'unknown';

/**
 * Options accepted by both {@link runTool} and {@link runSystemTool}.
 *
 * Either `unityProjectPath` (preferred — resolves URL + token from the
 * project's `UserSettings/AI-Game-Developer-Config.json`, falling back
 * to a deterministic localhost port when the file is absent) or `url`
 * (explicit endpoint override) MUST be provided.
 */
export interface RunToolOptions {
  /**
   * Tool name to invoke. Forwarded as the `{name}` segment of the
   * route — the function URL-encodes it before issuing the request.
   */
  toolName: string;
  /**
   * Absolute or relative path to the Unity project. Used to read the
   * project's config (host + token) and, as a last resort, to derive
   * the deterministic localhost port mirroring the C# plugin's hash.
   */
  unityProjectPath?: string;
  /** Explicit base URL override (no trailing slash required). */
  url?: string;
  /** Bearer token override. */
  token?: string;
  /**
   * Tool arguments, serialized as the JSON request body. When omitted,
   * the body is `{}`. Anything other than `undefined` / `null` /
   * `object` is rejected with a `kind: 'failure'` result.
   */
  input?: unknown;
  /**
   * Per-request timeout in milliseconds. Defaults to `60000` (matching
   * the CLI command's `--timeout` default). Values <= 0 are treated as
   * the default to keep accidental "0 = disable" mistakes from
   * stalling polling callers.
   */
  timeoutMs?: number;
  /**
   * Optional abort signal. When fired, the in-flight fetch is
   * cancelled and the result resolves to a `kind: 'failure'` with
   * `reason: 'timeout'`.
   */
  signal?: AbortSignal;
  /** Optional versioned control metadata forwarded in the REST wrapper. */
  control?: ToolCallControl | ToolCallContext | null;
  /** Alias for `control` when a runtime context is already available. */
  context?: ToolCallContext | null;
  /** Compatibility/deferred-completion id when it differs from callId. */
  requestID?: string | null;
  callId?: string | null;
  correlationId?: string | null;
  parentCallId?: string | null;
  deadlineUnixMs?: number | null;
  cancellationId?: string | null;
  idempotencyKey?: string | null;
  controlVersion?: number | null;
  /**
   * Optional injection point so tests can swap the `fetch`
   * implementation. Defaults to the global `fetch`.
   */
  fetchImpl?: typeof fetch;
}

/** Successful `runTool` / `runSystemTool` outcome. Narrow with `kind === 'success'`. */
export interface RunToolSuccess {
  kind: 'success';
  /** Always `true` for the success variant. Wire-compatible alias for `kind === 'success'`. */
  success: true;
  /** Resolved endpoint URL that was hit (post URL/token resolution). */
  endpoint: string;
  /** HTTP status code returned by the Unity plugin. */
  httpStatus: number;
  /**
   * Parsed response body. The Unity plugin returns
   * `{ status: "success", structured?: <tool output>, content?: <text blocks[]> }`
   * — consumers typically read `data.structured` or `data.content`
   * depending on whether the invoked tool returns structured content.
   * Non-JSON responses surface the raw text string.
   */
  data: unknown;
}

/** Failed `runTool` / `runSystemTool` outcome. Narrow with `kind === 'failure'`. */
export interface RunToolFailure {
  kind: 'failure';
  /** Always `false` for the failure variant. Wire-compatible alias for `kind === 'failure'`. */
  success: false;
  /**
   * Resolved endpoint URL. Empty string when the failure is
   * `reason: 'invalid-input'` and resolution never happened.
   */
  endpoint: string;
  /** Coarse cause — see {@link RunToolFailureReason}. */
  reason: RunToolFailureReason;
  /** HTTP status code when `reason === 'http-error'`. */
  httpStatus?: number;
  /**
   * Response body for diagnostics on `http-error` (parsed JSON when the
   * server returned JSON, otherwise the raw text). Omitted on transport
  * failures where no response was received.
  */
  data?: unknown;
  /** Structured control/execution error when the call used a control context. */
  structuredError?: ToolCallStructuredError;
  /** Human-readable failure summary; never thrown past the public boundary. */
  message: string;
  /** Captured error, when applicable. */
  error?: Error;
}

export type RunToolResult = RunToolSuccess | RunToolFailure;

// `runSystemTool` shares the exact shape of `runTool`; these aliases
// exist purely for naming symmetry at the consumer site.
export type RunSystemToolOptions = RunToolOptions;
export type RunSystemToolResult = RunToolResult;
export type RunSystemToolSuccess = RunToolSuccess;
export type RunSystemToolFailure = RunToolFailure;
