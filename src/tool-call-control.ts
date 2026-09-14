/**
 * Transport-neutral tool-call control metadata.
 *
 * This module is deliberately independent from the HTTP and WebSocket
 * adapters. Adapters can normalize a call once, carry the returned request
 * across a hop, and use the runtime context without ever serializing its
 * AbortSignal.
 */

export const TOOL_CALL_CONTROL_VERSION = 1 as const;
/** Alias retained for callers that prefer an explicit supported-version name. */
export const SUPPORTED_TOOL_CALL_CONTROL_VERSION = TOOL_CALL_CONTROL_VERSION;

const CONTROL_MEMBERS = new Set([
  'version',
  'callId',
  'correlationId',
  'parentCallId',
  'deadlineUnixMs',
  'cancellationId',
  'idempotencyKey',
  'confirm',
  'dryRun',
  'confirmation',
  'expectedProjectPath',
  'expectedInstanceId',
  'expectedPid',
]);

const DEFAULT_ERROR_MESSAGES: Record<ToolCallErrorCode, string> = {
  invalid_control: 'Tool call control metadata is invalid.',
  unsupported_control_version: 'Tool call control version is not supported.',
  deadline_exceeded: 'Tool call deadline expired.',
  cancelled: 'Tool call was cancelled.',
  middleware_rejected: 'Tool call was rejected by middleware.',
  tool_execution_failed: 'Tool execution failed.',
  validation_failed: 'The authoring call did not pass validation.',
  confirmation_required: 'A confirmation record is required for this tool call.',
  confirmation_invalid: 'The confirmation plan is invalid.',
  confirmation_expired: 'The confirmation plan has expired.',
  confirmation_stale: 'The confirmation plan no longer matches this call.',
  dry_run_unsupported: 'The requested dry-run mode is not supported by this tool.',
  path_policy_violation: 'The requested path is not allowed by project policy.',
  safety_unsupported: 'This tool call cannot be safely bound by the authoring policy.',
  undo_unavailable: 'The requested Undo guarantee is unavailable.',
  authoring_transaction_failed: 'The authoring transaction could not be completed safely.',
  editor_not_ready: 'The selected Editor is not ready.',
  editor_settling: 'The selected Editor generation is settling.',
  operation_capacity_exceeded: 'Editor operation capacity is full.',
  operation_not_found: 'The Editor operation was not found.',
  operation_owner_missing: 'The Editor operation owner is unavailable.',
  operation_interrupted: 'The Editor operation was interrupted.',
  cancellation_unavailable: 'Cancellation propagation is unavailable.',
  scheduling_metadata_invalid: 'Tool scheduling metadata is contradictory.',
  identity_mismatch: 'The routed Editor does not match the asserted identity constraints.',
  identity_unavailable: 'The routed connection did not report the asserted identity members.',
};

const NEVER_ABORTED_SIGNAL = new AbortController().signal;
let generatedIdCounter = 0;

/** A linked runtime signal and the cleanup hook for its listeners. */
export interface LinkedAbortSignals {
  signal?: AbortSignal;
  dispose: () => void;
}

/**
 * Link all supplied caller/runtime signals without ever putting the derived
 * signal on the wire.  A single signal is returned as-is; multiple signals
 * share one controller and are detached by `dispose()` when the operation
 * settles.
 */
export function linkAbortSignals(...signals: Array<AbortSignal | undefined>): LinkedAbortSignals {
  const unique: AbortSignal[] = [];
  for (const signal of signals) {
    if (signal !== undefined && !unique.includes(signal)) unique.push(signal);
  }

  if (unique.length === 0) return { signal: undefined, dispose: () => undefined };
  if (unique.length === 1) return { signal: unique[0], dispose: () => undefined };

  const controller = new AbortController();
  let disposed = false;
  const onAbort = (): void => {
    if (!disposed && !controller.signal.aborted) controller.abort();
  };
  for (const signal of unique) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  return {
    signal: controller.signal,
    dispose: (): void => {
      if (disposed) return;
      disposed = true;
      for (const signal of unique) signal.removeEventListener('abort', onAbort);
    },
  };
}

export type ToolCallErrorCode =
  | 'invalid_control'
  | 'unsupported_control_version'
  | 'deadline_exceeded'
  | 'cancelled'
  | 'middleware_rejected'
  | 'tool_execution_failed'
  | 'validation_failed'
  | 'confirmation_required'
  | 'confirmation_invalid'
  | 'confirmation_expired'
  | 'confirmation_stale'
  | 'dry_run_unsupported'
  | 'path_policy_violation'
  | 'safety_unsupported'
  | 'undo_unavailable'
  | 'authoring_transaction_failed'
  | 'editor_not_ready'
  | 'editor_settling'
  | 'operation_capacity_exceeded'
  | 'operation_not_found'
  | 'operation_owner_missing'
  | 'operation_interrupted'
  | 'cancellation_unavailable'
  | 'scheduling_metadata_invalid'
  | 'identity_mismatch'
  | 'identity_unavailable';

/** The only dry-run directives accepted by the g-005 authoring seam. */
export type ToolCallDryRun = 'none' | 'validate' | 'plan';

/**
 * Caller-asserted Editor identity constraints (COCli-01). Evaluated by the Node
 * server against the routed connection's handshake identity after connection
 * resolution and before forwarding; any mismatch or unavailable member rejects
 * the call fail-closed. Paths compare case-insensitively on Windows; instance
 * ids and PIDs compare exactly.
 */
export interface ToolCallIdentityConstraints {
  projectPath?: string;
  instanceId?: string;
  pid?: number;
}

/** Opaque confirmation material returned by a Unity plan. */
export interface ToolCallConfirmation {
  planId: string;
  planHash: string;
  expiresAtUnixMs: number;
  /** Forward-compatible token members are retained but never interpreted by Node. */
  [member: string]: unknown;
}

/** The serializable, version-one control envelope. */
export interface ToolCallControl {
  version?: number | null;
  callId?: string | null;
  correlationId?: string | null;
  parentCallId?: string | null;
  deadlineUnixMs?: number | null;
  cancellationId?: string | null;
  idempotencyKey?: string | null;
  /** Explicit approval directive; it is not sufficient without a confirmation token. */
  confirm?: boolean | null;
  /** Omitted means `none`; any supplied value must be one of the three literals. */
  dryRun?: ToolCallDryRun | null;
  /** Opaque confirmation token produced by Unity's policy. */
  confirmation?: ToolCallConfirmation | null;
  /** Optional Editor identity constraints (fail-closed at Node routing time). */
  expectedProjectPath?: string | null;
  expectedInstanceId?: string | null;
  expectedPid?: number | null;
  /** Forward-compatible fields unknown to this version. */
  [member: string]: unknown;
}

/** A normalized request accepted by the Node adapters. */
export interface ToolCallRequest {
  name: string;
  arguments: Record<string, unknown>;
  requestID?: string | null;
  control?: ToolCallControl | null;
  [member: string]: unknown;
}

/** Runtime-only context. `signal` is intentionally not serializable. */
export interface ToolCallContext {
  version: typeof TOOL_CALL_CONTROL_VERSION;
  requestID: string;
  /** Readable alias for integrations that use lower-camel request naming. */
  readonly requestId?: string;
  callId: string;
  correlationId: string;
  parentCallId?: string;
  deadlineUnixMs?: number;
  cancellationId?: string;
  idempotencyKey?: string;
  confirm?: boolean;
  dryRun: ToolCallDryRun;
  confirmation?: ToolCallConfirmation;
  /** Caller-asserted identity constraints present on a controlled call. */
  identity?: ToolCallIdentityConstraints;
  signal: AbortSignal;
  /** Readable alias; both names refer to the same runtime signal. */
  readonly abortSignal?: AbortSignal;
  legacy: boolean;
  unknownMembers: Record<string, unknown>;
}

export interface NormalizedToolCall {
  request: ToolCallRequest & { requestID: string };
  context: ToolCallContext;
}

/** The controlled body shape sent to a REST endpoint. */
export interface SerializedToolCallBody {
  arguments: Record<string, unknown>;
  control: ToolCallControl;
  requestID?: string;
  [member: string]: unknown;
}

/** A normalized call together with its controlled REST representation. */
export interface SerializedToolCall {
  body: Record<string, unknown> | SerializedToolCallBody;
  request: ToolCallRequest & { requestID: string };
  context: ToolCallContext;
}

export interface NormalizeToolCallOptions {
  /** Test and adapter hook for deterministic ids. */
  generateId?: () => string;
  /** Runtime cancellation signal; it never enters the wire request. */
  signal?: AbortSignal;
  /** Per-hop WebSocket correlation; deliberately not copied into context ids. */
  envelopeId?: string;
}

/** Values accepted by transport/library adapters when selecting a context. */
export interface ToolCallOptionValues {
  /** Serializable control metadata or a runtime context to serialize. */
  control?: ToolCallControl | ToolCallContext | null;
  /** Alias for callers that already hold a runtime context. */
  context?: ToolCallContext | null;
  /** Compatibility/deferred-completion id when it differs from callId. */
  requestID?: string | null;
  callId?: string | null;
  correlationId?: string | null;
  parentCallId?: string | null;
  deadlineUnixMs?: number | null;
  cancellationId?: string | null;
  idempotencyKey?: string | null;
  /** Optional explicit control version (normally supplied through `control`). */
  controlVersion?: number | null;
  confirm?: boolean | null;
  dryRun?: ToolCallDryRun | null;
  confirmation?: ToolCallConfirmation | null;
  expectedProjectPath?: string | null;
  expectedInstanceId?: string | null;
  expectedPid?: number | null;
}

/** Options used when converting a normalized call to a REST body. */
export interface ToolCallSerializationOptions extends NormalizeToolCallOptions {
  requestID?: string | null;
}

export interface DeriveChildToolCallOptions extends NormalizeToolCallOptions {
  /** Optional compatibility/deferred-completion id for the child. */
  requestID?: string;
}

export interface ToolCallStructuredError {
  code: ToolCallErrorCode;
  message: string;
  retryable: boolean;
  callId?: string;
  correlationId?: string;
  details?: Record<string, unknown>;
}

/** Alias matching the terminology used by the wire contract. */
export type StructuredToolCallError = ToolCallStructuredError;

export interface ToolCallErrorOptions {
  callId?: string;
  correlationId?: string;
  retryable?: boolean;
  details?: Record<string, unknown>;
  cause?: unknown;
}

/**
 * A safe, structured validation/control error. The error itself is useful to
 * local callers while `toStructuredError()` is the machine contract for
 * HTTP/WebSocket adapters.
 */
export class ToolCallControlError extends Error {
  readonly code: ToolCallErrorCode;
  readonly retryable: boolean;
  readonly callId?: string;
  readonly correlationId?: string;
  readonly details?: Record<string, unknown>;
  readonly cause?: unknown;

  constructor(code: ToolCallErrorCode, message?: string, options: ToolCallErrorOptions = {}) {
    super(message ?? DEFAULT_ERROR_MESSAGES[code]);
    this.name = 'ToolCallControlError';
    this.code = code;
    this.retryable = options.retryable ?? retryableForCode(code);
    this.callId = options.callId;
    this.correlationId = options.correlationId;
    this.details = options.details;
    this.cause = options.cause;
  }

  toStructuredError(): ToolCallStructuredError {
    const result: ToolCallStructuredError = {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
    };
    if (this.callId !== undefined) result.callId = this.callId;
    if (this.correlationId !== undefined) result.correlationId = this.correlationId;
    if (this.details !== undefined) result.details = this.details;
    return result;
  }

  toJSON(): ToolCallStructuredError {
    return this.toStructuredError();
  }
}

/** Build a structured error without exposing an underlying exception message. */
export function createToolCallError(
  code: ToolCallErrorCode,
  options: ToolCallErrorOptions = {},
): ToolCallStructuredError {
  return new ToolCallControlError(code, undefined, options).toStructuredError();
}

/** Convert a local control error to its stable wire value. */
export function toStructuredToolCallError(error: unknown): ToolCallStructuredError {
  if (error instanceof ToolCallControlError) return error.toStructuredError();
  return createToolCallError('tool_execution_failed');
}

/** Return true for errors created by this module, including cross-realm-like values. */
export function isToolCallControlError(error: unknown): error is ToolCallControlError {
  return error instanceof ToolCallControlError
    || (isRecord(error) && typeof error.code === 'string' && error.name === 'ToolCallControlError');
}

/**
 * Normalize a regular or system request. This function does not mutate the
 * input and does not serialize the runtime signal.
 */
export function normalizeToolCall(
  request: ToolCallRequest,
  options: NormalizeToolCallOptions = {},
): NormalizedToolCall {
  if (!isRecord(request)) {
    throw new ToolCallControlError('invalid_control', 'Tool call request must be an object.');
  }
  if (typeof request.name !== 'string' || request.name.trim().length === 0) {
    throw new ToolCallControlError('invalid_control', 'Tool call name must be a non-empty string.');
  }
  if (!isRecord(request.arguments)) {
    throw new ToolCallControlError('invalid_control', 'Tool call arguments must be an object.');
  }

  const hasControl = hasOwn(request, 'control')
    && request.control !== undefined
    && request.control !== null;
  if (!hasControl) return normalizeLegacyToolCall(request, options);

  if (!isRecord(request.control)) {
    throw new ToolCallControlError('invalid_control', 'Tool call control must be an object.');
  }

  return normalizeControlledToolCall(request, request.control, options);
}

/**
 * Normalize either REST body form:
 *
 *   legacy:     { ...tool arguments }
 *   controlled: { arguments: { ... }, control: { ... } }
 *
 * The wrapper is recognized only when both members are own object members.
 * This keeps a legitimate legacy argument named `control` intact.
 */
export function normalizeRestToolCall(
  name: string,
  body: unknown,
  options: NormalizeToolCallOptions = {},
): NormalizedToolCall {
  if (typeof name !== 'string' || name.trim().length === 0) {
    throw new ToolCallControlError('invalid_control', 'Tool call name must be a non-empty string.');
  }

  const bodyObject = body === null || body === undefined ? {} : body;
  if (!isRecord(bodyObject)) {
    throw new ToolCallControlError('invalid_control', 'Request body must be a JSON object.');
  }

  const hasWrapperMembers = hasOwn(bodyObject, 'arguments') && hasOwn(bodyObject, 'control');
  if (!hasWrapperMembers) {
    return normalizeToolCall({ name, arguments: bodyObject }, options);
  }

  if (!isRecord(bodyObject.arguments) || !isRecord(bodyObject.control)) {
    throw new ToolCallControlError('invalid_control', 'Controlled tool body requires object arguments and control members.');
  }

  const request: ToolCallRequest = {
    name,
    arguments: bodyObject.arguments,
    control: bodyObject.control,
  };
  if (hasOwn(bodyObject, 'requestID')) request.requestID = bodyObject.requestID as string | null;
  return normalizeToolCall(request, options);
}

/**
 * Serialize a controlled REST body using the same canonical member ordering
 * as the forwarding adapters. Unknown members are sorted after known ones.
 */
export function serializeControlledToolBody(
  arguments_: Record<string, unknown>,
  control: ToolCallControl | ToolCallContext,
  options: NormalizeToolCallOptions = {},
): { arguments: Record<string, unknown>; control: ToolCallControl; requestID?: string } {
  if (!isRecord(arguments_)) {
    throw new ToolCallControlError('invalid_control', 'Tool call arguments must be an object.');
  }
  const input = isToolCallContext(control) ? contextAsControl(control) : control;
  if (!isRecord(input)) {
    throw new ToolCallControlError('invalid_control', 'Tool call control must be an object.');
  }

  const normalized = normalizeControl(input, {
    ...options,
    fallbackRequestID: isToolCallContext(control) ? control.requestID : undefined,
  });
  const result: { arguments: Record<string, unknown>; control: ToolCallControl; requestID?: string } = {
    arguments: arguments_,
    control: normalized.control,
  };
  if (normalized.context.requestID !== normalized.context.callId) {
    result.requestID = normalized.context.requestID;
  }
  return result;
}

/**
 * Normalize and serialize a named controlled call. This is the adapter seam
 * shared by REST transports, library helpers, and command-facing adapters.
 * Runtime signals are used for local cancellation only and never enter the
 * returned body.
 */
export function serializeToolCallBody(
  name: string,
  arguments_: Record<string, unknown>,
  control: ToolCallControl | ToolCallContext,
  options: ToolCallSerializationOptions = {},
): SerializedToolCall {
  const contextSignal = isToolCallContext(control) ? control.signal : undefined;
  const requestID = options.requestID ?? (isToolCallContext(control) ? control.requestID : undefined);
  const requestControl = isToolCallContext(control) ? contextAsControl(control) : control;
  const request: ToolCallRequest = { name, arguments: arguments_, control: requestControl };
  if (requestID !== undefined) request.requestID = requestID;

  const normalized = normalizeToolCall(request, {
    ...options,
    signal: options.signal ?? contextSignal,
  });
  const body = serializeNormalizedToolCall(normalized);
  return { body, request: normalized.request, context: normalized.context };
}

/** Serialize a previously normalized call without normalizing it again. */
export function serializeNormalizedToolCall(normalized: NormalizedToolCall): Record<string, unknown> {
  if (normalized.context.legacy) return { ...normalized.request.arguments };

  const body: SerializedToolCallBody = {
    arguments: normalized.request.arguments,
    control: normalized.request.control as ToolCallControl,
  };
  // The common controlled form derives requestID from callId. Keep a separate
  // compatibility id only when the caller explicitly supplied one.
  if (normalized.request.requestID !== normalized.context.callId) {
    body.requestID = normalized.request.requestID;
  }
  return body;
}

/**
 * Resolve an adapter's optional control/context fields into one value. Direct
 * fields are useful to CLI adapters; an explicit `control` object remains the
 * source of truth when it already contains the corresponding member.
 */
export function resolveToolCallControl(
  options: ToolCallOptionValues,
): ToolCallControl | ToolCallContext | undefined {
  const base = options.control ?? options.context ?? undefined;
  const hasDirect = hasValue(options.requestID)
    || hasValue(options.callId)
    || hasValue(options.correlationId)
    || hasValue(options.parentCallId)
    || hasValue(options.deadlineUnixMs)
    || hasValue(options.cancellationId)
    || hasValue(options.idempotencyKey)
    || hasValue(options.controlVersion)
    || hasValue(options.confirm)
    || hasValue(options.dryRun)
    || hasValue(options.confirmation)
    || hasValue(options.expectedProjectPath)
    || hasValue(options.expectedInstanceId)
    || hasValue(options.expectedPid);

  if (base !== undefined && !isRecord(base)) {
    throw new ToolCallControlError('invalid_control', 'Tool call control must be an object.');
  }
  // A legacy runtime context represents the absence of a wire control object.
  // Keep it legacy unless the caller explicitly adds a control member.
  if (base !== undefined && isToolCallContext(base) && base.legacy && !hasDirect) return undefined;
  if (!hasDirect) return base;

  const merged: ToolCallControl = base === undefined
    ? {}
    : isToolCallContext(base) ? contextAsControl(base) : { ...base };
  if (hasValue(options.controlVersion)) merged.version = options.controlVersion;
  if (hasValue(options.callId)) merged.callId = options.callId;
  if (hasValue(options.correlationId)) merged.correlationId = options.correlationId;
  if (hasValue(options.parentCallId)) merged.parentCallId = options.parentCallId;
  if (hasValue(options.deadlineUnixMs)) merged.deadlineUnixMs = options.deadlineUnixMs;
  if (hasValue(options.cancellationId)) merged.cancellationId = options.cancellationId;
  if (hasValue(options.idempotencyKey)) merged.idempotencyKey = options.idempotencyKey;
  if (hasValue(options.confirm)) merged.confirm = options.confirm;
  if (hasValue(options.dryRun)) merged.dryRun = options.dryRun;
  if (hasValue(options.confirmation)) merged.confirmation = options.confirmation;
  if (hasValue(options.expectedProjectPath)) merged.expectedProjectPath = options.expectedProjectPath;
  if (hasValue(options.expectedInstanceId)) merged.expectedInstanceId = options.expectedInstanceId;
  if (hasValue(options.expectedPid)) merged.expectedPid = options.expectedPid;
  return merged;
}

/** Serialize just the control envelope, omitting runtime-only members. */
export function serializeToolCallControl(
  control: ToolCallControl | ToolCallContext,
  options: NormalizeToolCallOptions = {},
): ToolCallControl {
  return serializeControlledToolBody({}, control, options).control;
}

/**
 * Derive a child context for an internal/batch invocation. A child always
 * receives a new logical id, inherits the top-level correlation id, and never
 * inherits its parent's idempotency key.
 */
export function deriveChildToolCallContext(
  parent: ToolCallContext,
  childControl: ToolCallControl = {},
  options: DeriveChildToolCallOptions = {},
): ToolCallContext {
  if (!isToolCallContext(parent)) {
    throw new ToolCallControlError('invalid_control', 'Parent tool call context is invalid.');
  }
  if (!isRecord(childControl)) {
    throw new ToolCallControlError('invalid_control', 'Child tool call control must be an object.');
  }

  // Validate the child version and known fields first. We then override the
  // relationship fields that are owned by the parent/dispatcher.
  const checked = normalizeControl(childControl, {
    ...options,
    fallbackRequestID: options.requestID,
  });
  let callId = checked.context.callId;
  if (callId === parent.callId) callId = generateFreshId(options, parent.callId);

  const childDeadline = checked.context.deadlineUnixMs;
  const deadlineUnixMs = minDeadline(parent.deadlineUnixMs, childDeadline);
  const requestID = options.requestID ?? checked.context.requestID ?? callId;
  validateRequiredId(requestID, 'requestID');

  return withRuntimeSignal({
    version: TOOL_CALL_CONTROL_VERSION,
    requestID,
    callId,
    correlationId: parent.correlationId,
    parentCallId: parent.callId,
    deadlineUnixMs,
    cancellationId: checked.context.cancellationId,
    confirm: checked.context.confirm,
    dryRun: checked.context.dryRun,
    confirmation: checked.context.confirmation,
    // A child executes within the same parent invocation, so it inherits the
    // parent's Editor pin: routing a child to a different Editor would be
    // exactly the wrong-Editor hazard the constraints exist to prevent.
    identity: checked.context.identity ?? parent.identity,
    // Idempotency is deliberately not inherited by children. An explicit
    // child key remains valid and is preserved by the child normalizer.
    idempotencyKey: checked.context.idempotencyKey,
    legacy: false,
    unknownMembers: { ...checked.context.unknownMembers },
  }, options.signal ?? parent.signal);
}

/** Alias for callers that use the shorter context terminology. */
export const deriveChildContext = deriveChildToolCallContext;

/** Normalize a standalone control object into a runtime context. */
export function normalizeToolCallContext(
  control: ToolCallControl,
  options: NormalizeToolCallOptions & { requestID?: string } = {},
): ToolCallContext {
  if (!isRecord(control)) {
    throw new ToolCallControlError('invalid_control', 'Tool call control must be an object.');
  }
  return normalizeControl(control, {
    ...options,
    fallbackRequestID: options.requestID,
  }).context;
}

/** Explicit aliases for adapters that name the operation after its input. */
export const normalizeToolCallControl = normalizeToolCallContext;
export const createToolCallContext = normalizeToolCallContext;

function normalizeLegacyToolCall(
  request: ToolCallRequest,
  options: NormalizeToolCallOptions,
): NormalizedToolCall {
  const requestID = normalizeRequestID(request.requestID, options);
  const requestWithoutControl = { ...request } as ToolCallRequest & { requestID: string };
  delete requestWithoutControl.control;
  requestWithoutControl.requestID = requestID;

  return {
    request: requestWithoutControl,
    context: withRuntimeSignal({
      version: TOOL_CALL_CONTROL_VERSION,
      requestID,
      callId: requestID,
      correlationId: requestID,
      parentCallId: undefined,
      deadlineUnixMs: undefined,
      cancellationId: undefined,
      idempotencyKey: undefined,
      confirm: undefined,
      dryRun: 'none',
      confirmation: undefined,
      legacy: true,
      unknownMembers: {},
    }, options.signal ?? NEVER_ABORTED_SIGNAL),
  };
}

function normalizeControlledToolCall(
  request: ToolCallRequest,
  control: ToolCallControl,
  options: NormalizeToolCallOptions,
): NormalizedToolCall {
  const normalized = normalizeControl(control, {
    ...options,
    fallbackRequestID: request.requestID,
  });
  const normalizedRequest = { ...request, control: normalized.control } as ToolCallRequest & { requestID: string };
  normalizedRequest.requestID = normalized.context.requestID;
  return { request: normalizedRequest, context: normalized.context };
}

interface InternalNormalizeOptions extends NormalizeToolCallOptions {
  fallbackRequestID?: string | null;
}

interface NormalizedControl {
  control: ToolCallControl;
  context: ToolCallContext;
}

function normalizeControl(control: ToolCallControl, options: InternalNormalizeOptions): NormalizedControl {
  const suppliedRequestID = normalizeOptionalRequestID(options.fallbackRequestID);
  const suppliedCallId = normalizeOptionalId(control.callId, 'callId');
  const callId = suppliedCallId ?? suppliedRequestID ?? generateId(options);
  validateRequiredId(callId, 'callId');

  const suppliedCorrelationId = normalizeOptionalId(control.correlationId, 'correlationId');
  const correlationId = suppliedCorrelationId ?? callId;
  validateRequiredId(correlationId, 'correlationId');

  // Validate the version after extracting valid logical ids so a controlled
  // future-version rejection remains correlated to the call that supplied it.
  // No generated id is needed for the error path when the caller omitted ids.
  const version = normalizeVersion(control.version, {
    callId: suppliedCallId ?? suppliedRequestID,
    correlationId: suppliedCorrelationId ?? (suppliedCallId ?? suppliedRequestID),
  });

  let parentCallId: string | undefined;
  let deadlineUnixMs: number | undefined;
  let cancellationId: string | undefined;
  let idempotencyKey: string | undefined;
  try {
    parentCallId = normalizeOptionalId(control.parentCallId, 'parentCallId');
    deadlineUnixMs = normalizeDeadline(control.deadlineUnixMs);
    cancellationId = normalizeOpaqueString(control.cancellationId, 'cancellationId');
    idempotencyKey = normalizeOpaqueString(control.idempotencyKey, 'idempotencyKey');
  } catch (error: unknown) {
    if (error instanceof ToolCallControlError) {
      throw new ToolCallControlError(error.code, error.message, {
        callId: error.callId ?? suppliedCallId ?? suppliedRequestID,
        correlationId: error.correlationId ?? suppliedCorrelationId ?? (suppliedCallId ?? suppliedRequestID),
        details: error.details,
        cause: error.cause,
      });
    }
    throw error;
  }
  const requestID = suppliedRequestID ?? callId;

  const unknownMembers: Record<string, unknown> = {};
  for (const key of Object.keys(control)) {
    if (!CONTROL_MEMBERS.has(key)) setOwn(unknownMembers, key, control[key]);
  }

  const identity = normalizeIdentityConstraints(control, {
    callId: suppliedCallId ?? suppliedRequestID,
    correlationId: suppliedCorrelationId ?? (suppliedCallId ?? suppliedRequestID),
  });

  const normalizedControl: ToolCallControl = {};
  normalizedControl.version = version;
  normalizedControl.callId = callId;
  normalizedControl.correlationId = correlationId;
  if (parentCallId !== undefined) normalizedControl.parentCallId = parentCallId;
  if (deadlineUnixMs !== undefined) normalizedControl.deadlineUnixMs = deadlineUnixMs;
  if (cancellationId !== undefined) normalizedControl.cancellationId = cancellationId;
  if (idempotencyKey !== undefined) normalizedControl.idempotencyKey = idempotencyKey;
  if (identity?.projectPath !== undefined) normalizedControl.expectedProjectPath = identity.projectPath;
  if (identity?.instanceId !== undefined) normalizedControl.expectedInstanceId = identity.instanceId;
  if (identity?.pid !== undefined) normalizedControl.expectedPid = identity.pid;
  const hasConfirm = hasOwn(control, 'confirm');
  const confirm = normalizeConfirm(control.confirm, {
    callId: suppliedCallId ?? suppliedRequestID,
    correlationId: suppliedCorrelationId ?? (suppliedCallId ?? suppliedRequestID),
  });
  if (hasConfirm) normalizedControl.confirm = confirm;

  const hasDryRun = hasOwn(control, 'dryRun');
  const dryRun = normalizeDryRun(control.dryRun, {
    callId: suppliedCallId ?? suppliedRequestID,
    correlationId: suppliedCorrelationId ?? (suppliedCallId ?? suppliedRequestID),
  });
  // Keep the legacy controlled wire shape compact when the directive was
  // omitted; the runtime context still exposes the semantic `none` default.
  if (hasDryRun) normalizedControl.dryRun = dryRun;

  const hasConfirmation = hasOwn(control, 'confirmation');
  const confirmation = normalizeConfirmation(control.confirmation, {
    callId: suppliedCallId ?? suppliedRequestID,
    correlationId: suppliedCorrelationId ?? (suppliedCallId ?? suppliedRequestID),
  });
  if (hasConfirmation) normalizedControl.confirmation = confirmation;
  for (const key of Object.keys(unknownMembers).sort()) setOwn(normalizedControl, key, unknownMembers[key]);

  return {
    control: normalizedControl,
    context: withRuntimeSignal({
      version: TOOL_CALL_CONTROL_VERSION,
      requestID,
      callId,
      correlationId,
      parentCallId,
      deadlineUnixMs,
      cancellationId,
      idempotencyKey,
      confirm,
      dryRun,
      confirmation,
      identity,
      legacy: false,
      unknownMembers,
    }, options.signal ?? NEVER_ABORTED_SIGNAL),
  };
}

const MAX_IDENTITY_PATH_LENGTH = 1024;
const MAX_IDENTITY_ID_LENGTH = 160;

/**
 * Validate the three optional identity constraint members. Absent members stay
 * absent; a present member must be well-formed so a typo fails fast with
 * `invalid_control` instead of routing to (or refusing) the wrong Editor.
 */
function normalizeIdentityConstraints(
  control: ToolCallControl,
  ids: { callId?: string; correlationId?: string },
): ToolCallIdentityConstraints | undefined {
  const projectPath = normalizeIdentityPath(control.expectedProjectPath, 'expectedProjectPath', ids);
  const instanceId = normalizeIdentityId(control.expectedInstanceId, 'expectedInstanceId', ids);
  const pid = normalizeIdentityPid(control.expectedPid, ids);
  if (projectPath === undefined && instanceId === undefined && pid === undefined) return undefined;
  return {
    ...(projectPath === undefined ? {} : { projectPath }),
    ...(instanceId === undefined ? {} : { instanceId }),
    ...(pid === undefined ? {} : { pid }),
  };
}

function normalizeIdentityPath(
  value: unknown,
  member: string,
  ids: { callId?: string; correlationId?: string },
): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ToolCallControlError(
      'invalid_control',
      `${member} must be a non-empty string when supplied.`,
      ids,
    );
  }
  const trimmed = value.trim();
  if (trimmed.length > MAX_IDENTITY_PATH_LENGTH) {
    throw new ToolCallControlError(
      'invalid_control',
      `${member} must not exceed ${MAX_IDENTITY_PATH_LENGTH} characters.`,
      ids,
    );
  }
  return trimmed;
}

function normalizeIdentityId(
  value: unknown,
  member: string,
  ids: { callId?: string; correlationId?: string },
): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ToolCallControlError(
      'invalid_control',
      `${member} must be a non-empty string when supplied.`,
      ids,
    );
  }
  const trimmed = value.trim();
  if (trimmed.length > MAX_IDENTITY_ID_LENGTH) {
    throw new ToolCallControlError(
      'invalid_control',
      `${member} must not exceed ${MAX_IDENTITY_ID_LENGTH} characters.`,
      ids,
    );
  }
  return trimmed;
}

function normalizeIdentityPid(
  value: unknown,
  ids: { callId?: string; correlationId?: string },
): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new ToolCallControlError(
      'invalid_control',
      'expectedPid must be a positive integer when supplied.',
      ids,
    );
  }
  return value;
}

function normalizeVersion(
  value: unknown,
  ids: { callId?: string; correlationId?: string } = {},
): typeof TOOL_CALL_CONTROL_VERSION {
  if (value === undefined) return TOOL_CALL_CONTROL_VERSION;
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
    throw new ToolCallControlError('invalid_control', 'Tool call control version must be an integer.', {
      callId: ids.callId,
      correlationId: ids.correlationId,
    });
  }
  if (value !== TOOL_CALL_CONTROL_VERSION) {
    throw new ToolCallControlError(
      'unsupported_control_version',
      undefined,
      {
        callId: ids.callId,
        correlationId: ids.correlationId,
        details: { supportedVersion: TOOL_CALL_CONTROL_VERSION, receivedVersion: value },
      },
    );
  }
  return TOOL_CALL_CONTROL_VERSION;
}

function normalizeConfirm(
  value: unknown,
  ids: { callId?: string; correlationId?: string },
): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') {
    throw new ToolCallControlError('invalid_control', 'confirm must be a boolean.', ids);
  }
  return value;
}

function normalizeDryRun(
  value: unknown,
  ids: { callId?: string; correlationId?: string },
): ToolCallDryRun {
  if (value === undefined) return 'none';
  if (value !== 'none' && value !== 'validate' && value !== 'plan') {
    throw new ToolCallControlError(
      'invalid_control',
      'dryRun must be one of: none, validate, plan.',
      ids,
    );
  }
  return value;
}

function normalizeConfirmation(
  value: unknown,
  ids: { callId?: string; correlationId?: string },
): ToolCallConfirmation | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new ToolCallControlError('invalid_control', 'confirmation must be an object.', ids);
  }
  if (typeof value.planId !== 'string' || value.planId.trim().length === 0) {
    throw new ToolCallControlError('invalid_control', 'confirmation.planId must be a non-empty string.', ids);
  }
  if (typeof value.planHash !== 'string' || value.planHash.trim().length === 0) {
    throw new ToolCallControlError('invalid_control', 'confirmation.planHash must be a non-empty string.', ids);
  }
  if (typeof value.expiresAtUnixMs !== 'number'
    || !Number.isSafeInteger(value.expiresAtUnixMs)
    || value.expiresAtUnixMs < 0) {
    throw new ToolCallControlError(
      'invalid_control',
      'confirmation.expiresAtUnixMs must be a non-negative integer.',
      ids,
    );
  }
  // Copy the token so normalizing a request never mutates a caller-owned
  // object. Unknown members remain opaque and forward-compatible.
  return { ...value, planId: value.planId, planHash: value.planHash, expiresAtUnixMs: value.expiresAtUnixMs };
}

function normalizeRequestID(value: unknown, options: NormalizeToolCallOptions): string {
  if (value !== undefined && value !== null && typeof value !== 'string') {
    throw new ToolCallControlError('invalid_control', 'requestID must be a string when supplied.');
  }
  if (typeof value === 'string' && value.trim().length > 0) return value;
  return generateId(options);
}

function normalizeOptionalRequestID(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new ToolCallControlError('invalid_control', 'requestID must be a string when supplied.');
  }
  if (value.length === 0) return undefined;
  if (value.trim().length === 0) {
    throw new ToolCallControlError('invalid_control', 'requestID must be a non-empty string.');
  }
  return value;
}

function normalizeOptionalId(value: unknown, member: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ToolCallControlError('invalid_control', `${member} must be a non-empty string.`);
  }
  return value;
}

function validateRequiredId(value: unknown, member: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ToolCallControlError('invalid_control', `${member} must be a non-empty string.`);
  }
}

function normalizeOpaqueString(value: unknown, member: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new ToolCallControlError('invalid_control', `${member} must be a string.`);
  }
  return value;
}

function normalizeDeadline(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new ToolCallControlError('invalid_control', 'deadlineUnixMs must be a non-negative integer.');
  }
  return value;
}

function minDeadline(parent: number | undefined, child: number | undefined): number | undefined {
  if (parent === undefined) return child;
  if (child === undefined) return parent;
  return Math.min(parent, child);
}

function generateId(options: NormalizeToolCallOptions): string {
  const supplied = options.generateId?.();
  if (supplied !== undefined) {
    if (typeof supplied !== 'string' || supplied.trim().length === 0) {
      throw new ToolCallControlError('invalid_control', 'Generated tool call id must be a non-empty string.');
    }
    return supplied;
  }

  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return `call-${globalThis.crypto.randomUUID()}`;
  }
  generatedIdCounter += 1;
  return `call-${Date.now().toString(36)}-${generatedIdCounter.toString(36)}`;
}

function generateFreshId(options: NormalizeToolCallOptions, existingId: string): string {
  const generated = generateId(options);
  if (generated === existingId) {
    throw new ToolCallControlError('invalid_control', 'Child call id must differ from its parent call id.');
  }
  return generated;
}

function contextAsControl(context: ToolCallContext): ToolCallControl {
  const control: ToolCallControl = {
    ...context.unknownMembers,
    version: context.version,
    callId: context.callId,
    correlationId: context.correlationId,
    parentCallId: context.parentCallId,
    deadlineUnixMs: context.deadlineUnixMs,
    cancellationId: context.cancellationId,
    idempotencyKey: context.idempotencyKey,
    ...(context.confirm === undefined ? {} : { confirm: context.confirm }),
    ...(context.dryRun === 'none' ? {} : { dryRun: context.dryRun }),
    ...(context.confirmation === undefined ? {} : { confirmation: context.confirmation }),
    ...(context.identity?.projectPath === undefined ? {} : { expectedProjectPath: context.identity.projectPath }),
    ...(context.identity?.instanceId === undefined ? {} : { expectedInstanceId: context.identity.instanceId }),
    ...(context.identity?.pid === undefined ? {} : { expectedPid: context.identity.pid }),
  };
  return control;
}

export function isToolCallContext(value: unknown): value is ToolCallContext {
  return isRecord(value)
    && typeof value.callId === 'string'
    && typeof value.correlationId === 'string'
    && typeof value.requestID === 'string'
    && typeof value.signal === 'object'
    && typeof value.legacy === 'boolean'
    && isRecord(value.unknownMembers);
}

function retryableForCode(_code: ToolCallErrorCode): boolean {
  // A tool call can have side effects, so none of the initial failures is
  // safe to replay implicitly. Callers may opt in explicitly per error.
  return false;
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function hasValue(value: unknown): boolean {
  return value !== undefined && value !== null;
}

function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function setOwn(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}

/** Keep runtime cancellation state out of JSON serialization. */
function withRuntimeSignal(
  context: Omit<ToolCallContext, 'signal'>,
  signal: AbortSignal,
): ToolCallContext {
  Object.defineProperty(context, 'signal', {
    configurable: true,
    enumerable: true,
    value: signal,
    writable: false,
  });
  // Keep the runtime primitive visible to in-process middleware/tests while
  // making accidental JSON serialization safe and deterministic.
  Object.defineProperty(context, 'toJSON', {
    configurable: true,
    enumerable: false,
    value: (): Record<string, unknown> => {
      const serialized = { ...context } as Record<string, unknown>;
      delete serialized.signal;
      return serialized;
    },
  });
  Object.defineProperty(context, 'requestId', {
    configurable: true,
    enumerable: false,
    get: (): string => context.requestID,
  });
  Object.defineProperty(context, 'abortSignal', {
    configurable: true,
    enumerable: false,
    get: (): AbortSignal => signal,
  });
  return context as ToolCallContext;
}
