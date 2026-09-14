// Output formatting — JSON for machines, pretty for humans.
//
// Commands return data; the CLI shell chooses format based on the global
// --json flag. JSON output is stable contract for agents and scripts.

import kleur from 'kleur';
import { TransportError, CliError } from './errors.js';
import { redactSensitiveText, redactSensitiveValue } from './redaction.js';

export interface OutputContext {
  json: boolean;
  verbose: boolean;
}

export function printResult(ctx: OutputContext, data: unknown): void {
  if (ctx.json) {
    process.stdout.write(JSON.stringify(redactSensitiveValue(data), null, 2) + '\n');
    return;
  }
  printPretty(data);
}

export function printError(ctx: OutputContext, err: unknown): void {
  if (ctx.json) {
    const payload = serializeError(err);
    process.stderr.write(JSON.stringify(payload, null, 2) + '\n');
    return;
  }
  if (err instanceof Error) {
    process.stderr.write(kleur.red('Error: ') + redactSensitiveText(displayMessage(err)) + '\n');
    if (ctx.verbose && err.stack) process.stderr.write(redactSensitiveText(err.stack) + '\n');
    const extra = (err as { toJSON?: () => unknown }).toJSON?.();
    if (extra && typeof extra === 'object') {
      process.stderr.write(kleur.gray(JSON.stringify(redactSensitiveValue(extra), null, 2)) + '\n');
      const retry = confirmationRetry(extra);
      if (retry !== undefined) process.stderr.write(kleur.yellow(`Retry: ${retry}\n`));
      const hint = transportHint(extra);
      if (hint !== undefined) process.stderr.write(kleur.yellow(`Hint: ${redactSensitiveText(hint)}\n`));
    }
  } else {
    process.stderr.write(kleur.red('Error: ') + redactSensitiveText(String(err)) + '\n');
  }
}

export function printInfo(ctx: OutputContext, msg: string): void {
  if (ctx.json) return; // info messages are noise in JSON mode
  process.stderr.write(kleur.gray(redactSensitiveText(msg)) + '\n');
}

function printPretty(data: unknown): void {
  if (data === undefined || data === null) {
    process.stdout.write('(no data)\n');
    return;
  }
  if (typeof data === 'string') {
    process.stdout.write(redactSensitiveText(data) + '\n');
    return;
  }
  if (typeof data === 'number' || typeof data === 'boolean') {
    process.stdout.write(String(data) + '\n');
    return;
  }
  process.stdout.write(JSON.stringify(redactSensitiveValue(data), null, 2) + '\n');
}

export function serializeError(err: unknown): Record<string, unknown> {
  const message = err instanceof Error ? err.message : String(err);
  const serialized = serializedErrorDetails(err);
  const code = errorCode(err, serialized);
  const retryable = err instanceof CliError
    ? err.retryable
    : err instanceof TransportError && ['timeout', 'connection-refused', 'connection-reset', 'dns'].includes(err.kind)
      || httpBodyRetryable(err);
  const details = err instanceof CliError && err.details !== undefined
    ? err.details
    : removeEnvelopeFields(serialized);

  const error: Record<string, unknown> = {
    code,
    message: redactSensitiveText(message),
    retryable,
    ...(details !== undefined && !isEmptyRecord(details)
      ? { details: redactSensitiveValue(details) }
      : {}),
  };

  // Timeout semantics (COCli-09): an observed transport timeout never means
  // the tool did not run — the plugin keeps executing after the CLI stops
  // waiting. Say so explicitly and point at the durable call record when the
  // logical call id is known, so automation does not blindly retry a
  // side-effecting call.
  if (err instanceof TransportError && err.kind === 'timeout') {
    const callId = err.callId;
    const mergedDetails = asRecord(error['details']) ?? {};
    error['details'] = {
      ...mergedDetails,
      resultUnknown: true,
      ...(callId !== undefined ? { callId } : {}),
    };
    error['message'] = callId !== undefined
      ? `${message} — result unknown: the tool may still be running in the Unity Editor. Check \`uco call get ${callId}\` before retrying.`
      : `${message} — result unknown: the tool may still be running in the Unity Editor. Find the call with \`uco call list\` before retrying.`;
  }

  // Structured control failures carry logical-call identity at the same
  // positions as the server's wire error; mirror them so a cancelled or
  // deadline-exceeded envelope identifies its logical call without digging
  // through `details`.
  const structuredCallId = typeof serialized['callId'] === 'string' ? serialized['callId'] : undefined;
  const structuredCorrelationId = typeof serialized['correlationId'] === 'string' ? serialized['correlationId'] : undefined;
  if (structuredCallId !== undefined) error['callId'] = structuredCallId;
  if (structuredCorrelationId !== undefined) error['correlationId'] = structuredCorrelationId;

  // Retry continuity (COCli-02): a confirmation-retryable failure always
  // exposes `error.requestId` plus a redaction-bounded, size-capped
  // `error.details.retryWith` so automation resumes without parsing the
  // human-readable `Retry:` hint.
  if (code === 'confirmation_required') {
    const continuity = retryContinuity(details ?? serialized);
    if (continuity.requestId !== undefined) error['requestId'] = continuity.requestId;
    if (continuity.retryWith !== undefined) {
      const merged = asRecord(error['details']) ?? {};
      error['details'] = { ...merged, retryWith: continuity.retryWith };
    }
  }

  return { ok: false, error };
}

interface RetryContinuity {
  requestId?: string;
  retryWith?: Record<string, unknown>;
}

/**
 * Locate the retry inputs for a confirmation-retryable failure. The upstream
 * control failure nests them as `details.retryWith = { requestID, control }`;
 * CliError details may carry one less or one more envelope level, so both
 * shapes are probed. Values are redaction-checked and size-capped before
 * being surfaced at the documented positions.
 */
function retryContinuity(details: unknown): RetryContinuity {
  const retryWith = asRecord(asRecord(details)?.['retryWith'])
    ?? asRecord(asRecord(asRecord(details)?.['details'])?.['retryWith'])
    ?? asRecord(asRecord(asRecord(asRecord(details)?.['details'])?.['details'])?.['retryWith']);
  if (retryWith === undefined) return {};
  const requestId = retryWith['requestID'] ?? retryWith['requestId'];
  if (typeof requestId !== 'string' || requestId.length === 0) return {};
  if (!boundedSafeValue(retryWith)) {
    // Keep the resume id but drop an oversized control payload rather than
    // emit an unbounded envelope member.
    return { requestId, retryWith: { requestID: requestId, control: { omitted: 'size-exceeded' } } };
  }
  return { requestId, retryWith: redactSensitiveValue(retryWith) as Record<string, unknown> };
}

function serializedErrorDetails(err: unknown): Record<string, unknown> {
  if (err && typeof err === 'object' && 'toJSON' in err && typeof (err as { toJSON: () => unknown }).toJSON === 'function') {
    const value = (err as { toJSON: () => unknown }).toJSON();
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
  }
  return {};
}

function errorCode(err: unknown, details: Record<string, unknown>): string {
  if (err instanceof CliError) return err.code;
  if (err instanceof TransportError) return `transport-${err.kind}`;
  if (typeof details['code'] === 'string') return details['code'];
  if (typeof details['kind'] === 'string') return String(details['kind']);
  return 'unexpected-error';
}

function removeEnvelopeFields(details: Record<string, unknown>): Record<string, unknown> | undefined {
  const result = Object.fromEntries(
    Object.entries(details).filter(([key]) => !['error', 'code', 'message', 'retryable'].includes(key)),
  );
  return Object.keys(result).length > 0 ? result : undefined;
}

const MAX_RETRY_COMMAND_BYTES = 16_384;
const MAX_RETRY_DEPTH = 6;
const MAX_RETRY_MEMBERS = 48;
const MAX_RETRY_ARRAY_ITEMS = 32;
const MAX_RETRY_NODES = 256;
const MAX_RETRY_STRING_LENGTH = 160;

function confirmationRetry(value: unknown): string | undefined {
  const root = asRecord(value);
  const body = asRecord(root?.['body']);
  const nested = asRecord(body?.['error']);
  const error = nested?.['code'] === 'confirmation_required'
    ? nested
    : root?.['code'] === 'confirmation_required' ? root : undefined;
  if (error === undefined) return undefined;
  const details = asRecord(error['details']);
  const retryWith = asRecord(details?.['retryWith']);
  const control = asRecord(retryWith?.['control']);
  const token = asRecord(control?.['confirmation']);
  const requestID = retryWith?.['requestID'];
  if (control === undefined || typeof requestID !== 'string') return undefined;
  if (control['confirm'] !== true || control['dryRun'] !== 'none' || token === undefined) return undefined;
  if (typeof token['planId'] !== 'string' || typeof token['planHash'] !== 'string'
    || typeof token['expiresAtUnixMs'] !== 'number') return undefined;
  if (!boundedSafeValue(retryWith)) return undefined;

  const controlJson = JSON.stringify(control);
  const command = `--request-id ${quoteCliValue(requestID)} --control ${quoteCliValue(controlJson)}`;
  return Buffer.byteLength(command, 'utf8') <= MAX_RETRY_COMMAND_BYTES ? command : undefined;
}

function boundedSafeValue(value: unknown): boolean {
  let remainingNodes = MAX_RETRY_NODES;
  const visit = (entry: unknown, depth: number): boolean => {
    if (depth > MAX_RETRY_DEPTH || --remainingNodes < 0) return false;
    if (typeof entry === 'string') {
      return entry.length <= MAX_RETRY_STRING_LENGTH && redactSensitiveText(entry) === entry;
    }
    if (entry === null || typeof entry === 'number' || typeof entry === 'boolean') return true;
    if (Array.isArray(entry)) {
      return entry.length <= MAX_RETRY_ARRAY_ITEMS && entry.every((item) => visit(item, depth + 1));
    }
    const record = asRecord(entry);
    if (record === undefined) return false;
    const entries = Object.entries(record);
    if (entries.length > MAX_RETRY_MEMBERS) return false;
    return entries.every(([key, item]) => key.length <= MAX_RETRY_STRING_LENGTH
      && JSON.stringify(redactSensitiveValue({ [key]: item })) === JSON.stringify({ [key]: item })
      && visit(item, depth + 1));
  };
  return visit(value, 0);
}

function quoteCliValue(value: string): string {
  return `'${value.replace(/'/g, "'\"'\"'")}'`;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

const GENERIC_FAILURE_MESSAGES = new Set([
  'Tool call failed.',
  'Tool execution failed.',
  'Tool call failed for tool.',
]);

/**
 * Human-mode headline: when the transport message is a generic placeholder
 * ("HTTP 500", "Tool call failed."), surface the bounded diagnostic the
 * failure actually carried (tool error text, exception message, compile
 * error) instead of making the user dig through details.
 */
function displayMessage(err: Error): string {
  if (err instanceof TransportError && err.kind === 'http') {
    const bodyMessage = asRecord(asRecord(err.body as unknown)?.['error'])?.['message'];
    if (typeof bodyMessage === 'string' && bodyMessage.trim().length > 0
      && !GENERIC_FAILURE_MESSAGES.has(bodyMessage)) {
      return bodyMessage;
    }
  }
  if (!GENERIC_FAILURE_MESSAGES.has(err.message)) return err.message;
  const serialized = serializedErrorDetails(err);
  const diagnostic = firstDiagnosticText(serialized)
    ?? firstDiagnosticText(asRecord(err instanceof TransportError ? err.body : undefined)?.['error']);
  return diagnostic !== undefined && diagnostic.length > 0 ? diagnostic : err.message;
}

/** First bounded actionable text inside a structured error envelope. */
function firstDiagnosticText(envelope: unknown): string | undefined {
  const record = asRecord(envelope);
  if (record === undefined) return undefined;
  const details = asRecord(record['details']);
  const candidates = [
    typeof record['diagnostic'] === 'string' ? record['diagnostic'] : undefined,
    typeof details?.['diagnostic'] === 'string' ? details['diagnostic'] : undefined,
    typeof details?.['exceptionMessage'] === 'string' ? details['exceptionMessage'] : undefined,
    typeof record['exceptionMessage'] === 'string' ? record['exceptionMessage'] : undefined,
  ];
  for (const candidate of candidates) {
    if (candidate === undefined) continue;
    const trimmed = candidate.trim();
    if (trimmed.length > 0 && !GENERIC_FAILURE_MESSAGES.has(trimmed)) return trimmed;
  }
  return undefined;
}

/** Server-provided hint from a normalized HTTP error body. */
function transportHint(extra: unknown): string | undefined {
  const record = asRecord(extra);
  const body = asRecord(record?.['body']);
  const hint = asRecord(body?.['error'])?.['hint'] ?? asRecord(body?.['error'])?.['details'];
  const hintText = asRecord(hint)?.['hint'];
  return typeof hintText === 'string' && hintText.length > 0 ? hintText : undefined;
}

/** Honor an explicit retryable classification from a normalized HTTP body. */
function httpBodyRetryable(err: unknown): boolean {
  if (!(err instanceof TransportError) || err.kind !== 'http') return false;
  const retryable = asRecord(asRecord(err.body as unknown)?.['error'])?.['retryable'];
  return retryable === true;
}

function isEmptyRecord(value: unknown): boolean {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.keys(value as Record<string, unknown>).length === 0;
}
