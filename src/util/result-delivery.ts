import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, linkSync, openSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CliError } from './errors.js';
import { redactSensitiveValue } from './redaction.js';

export type ResultView = 'full' | 'ref' | 'compact' | 'auto';
type DeliveredView = Exclude<ResultView, 'auto'>;

export interface ResultDeliveryOptions {
  view?: string;
  evidenceFile?: string;
  evidenceDir?: string;
  toolName: string;
  /** Catalog readOnlyHint, supplied only by generated typed tool commands. */
  autoReadOnly?: boolean;
}

export interface EvidenceReference {
  path: string;
  sha256: string;
  bytes: number;
}

const COMPACT_TOOLS = new Set(['scene-get-data', 'console-get-logs', 'batch-execute']);
const WRAPPERS = ['structured', 'Structured', 'structuredContent', 'StructuredContent', 'result', 'Result', 'value', 'Value'];
/** Initial, deliberately conservative gates; tune only with task-level measurements. */
export const AUTO_COMPACT_MIN_BYTES = 8 * 1024;
export const AUTO_REF_MIN_BYTES = 32 * 1024;
const AUTO_MIN_SAVED_BYTES = 2 * 1024;

/** Validate before calling Unity: an unsupported view must never run a mutating tool. */
export function validateResultDelivery(options: ResultDeliveryOptions, checkDirectory = true): ResultView {
  const view = options.view ?? 'full';
  if (view !== 'full' && view !== 'ref' && view !== 'compact' && view !== 'auto') {
    throw new CliError('--result-view must be full, ref, compact, or auto.', 'invalid-result-view');
  }
  if (options.evidenceFile && options.evidenceDir) {
    throw new CliError('--evidence-file and --evidence-dir are mutually exclusive.', 'evidence-path-conflict');
  }
  if ((view === 'ref' || view === 'compact') && !options.evidenceFile && !options.evidenceDir) {
    throw new CliError(`--result-view ${view} requires --evidence-file or --evidence-dir.`, 'evidence-file-required');
  }
  if (view === 'full' && options.evidenceDir) {
    throw new CliError('--evidence-dir requires --result-view ref, compact, or auto.', 'evidence-dir-unused');
  }
  if (checkDirectory && options.evidenceDir) {
    try {
      if (!statSync(options.evidenceDir).isDirectory()) throw new Error('not a directory');
    } catch {
      throw new CliError('--evidence-dir must name an existing directory.', 'evidence-dir-invalid');
    }
  }
  if (view === 'compact' && !COMPACT_TOOLS.has(options.toolName)) {
    throw new CliError(`No compact view is registered for '${options.toolName}'; use --result-view ref.`, 'compact-view-unsupported');
  }
  return view;
}

/** Returns a redacted full result on evidence-write failure; the Unity operation has already run. */
export function deliverResult(
  result: unknown,
  options: ResultDeliveryOptions,
): { value: unknown; view: DeliveredView; warning?: { code: string; message: string; operationExecuted: true } } {
  // Pre-call validation checks directory existence. Do not repeat that check
  // after Unity has run: a directory disappearing mid-call must become a
  // recoverable evidence-write warning, never an apparent operation failure.
  const requestedView = validateResultDelivery(options, false);
  if (requestedView === 'full' && !options.evidenceFile) return { value: result, view: 'full' };
  const safeResult = redactSensitiveValue(result);
  const auto = requestedView === 'auto' ? selectAutoView(safeResult, options) : undefined;
  const view: DeliveredView = auto?.view ?? (requestedView as DeliveredView);
  if (view === 'full' && !options.evidenceFile) return { value: result, view: 'full' };
  let evidence: EvidenceReference;
  try {
    evidence = writeEvidence(options.evidenceFile ?? generatedEvidencePath(options), safeResult);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      value: safeResult,
      view: 'full',
      warning: { code: 'evidence-write-failed', message, operationExecuted: true },
    };
  }
  if (view === 'full') return { value: safeResult, view: 'full' };
  const shape = describeShape(safeResult);
  const reference = { tool: options.toolName, evidence, shape,
    status: resultStatus(safeResult), identity: resultIdentity(safeResult) };
  if (view === 'ref') return { value: { ...reference, resultView: 'ref' }, view: 'ref' };
  const compact = auto?.compact ?? compactResult(options.toolName, safeResult);
  return { value: { ...reference, resultView: 'compact', ...compact }, view: 'compact' };
}

function selectAutoView(result: unknown, options: ResultDeliveryOptions):
  { view: DeliveredView; compact?: Record<string, unknown> } {
  // Never suppress inline visual data or a command not explicitly marked read-only.
  if (options.autoReadOnly !== true || options.toolName.startsWith('screenshot-') || containsInlineImage(result)) {
    return { view: 'full' };
  }
  const fullBytes = Buffer.byteLength(
    typeof result === 'string' ? result : JSON.stringify(result, null, 2) ?? 'null', 'utf8');
  if (fullBytes < AUTO_COMPACT_MIN_BYTES) return { view: 'full' };
  if (COMPACT_TOOLS.has(options.toolName)) {
    const compact = compactResult(options.toolName, result);
    if (compact['compactUnavailable'] === undefined) {
      // Include a conservative allowance for evidence path, hash, shape and status.
      const estimatedBytes = Buffer.byteLength(JSON.stringify(compact), 'utf8') + 512;
      if (fullBytes - estimatedBytes >= AUTO_MIN_SAVED_BYTES && estimatedBytes <= fullBytes * 0.75) {
        return { view: 'compact', compact };
      }
    }
  }
  return fullBytes >= AUTO_REF_MIN_BYTES ? { view: 'ref' } : { view: 'full' };
}

function generatedEvidencePath(options: ResultDeliveryOptions): string {
  const directory = options.evidenceDir ?? tmpdir();
  const tool = options.toolName.replace(/[^a-zA-Z0-9-]/g, '-').slice(0, 48);
  return path.join(directory, `uco-evidence-${tool}-${randomUUID()}.json`);
}

function containsInlineImage(value: unknown): boolean {
  const pending = [value];
  let inspected = 0;
  while (pending.length > 0 && inspected++ < 2_048) {
    const current = pending.pop();
    if (!current || typeof current !== 'object') continue;
    if (Array.isArray(current)) {
      for (const child of current) pending.push(child);
      continue;
    }
    const entry = current as Record<string, unknown>;
    if (entry['type'] === 'image' || typeof entry['mimeType'] === 'string' && entry['mimeType'].startsWith('image/')) return true;
    for (const [key, child] of Object.entries(entry)) {
      if (typeof child === 'string') {
        if (child.startsWith('data:image/') || /(?:image|png|jpe?g|base64)/i.test(key) && child.length > 1_024) return true;
      } else if (child && typeof child === 'object') pending.push(child);
    }
  }
  return false;
}

export function writeEvidence(file: string, value: unknown): EvidenceReference {
  const target = path.resolve(file);
  const bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n', 'utf8');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.tmp`);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, 'wx', 0o600);
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    // Same-directory hard link is an atomic no-clobber commit, including on Windows.
    linkSync(temporary, target);
    return { path: target, sha256, bytes: bytes.length };
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

function compactResult(tool: string, result: unknown): Record<string, unknown> {
  const located = locatePayload(result);
  const payload = located.value;
  if (tool === 'scene-get-data') return compactScene(payload, located.pointer);
  if (tool === 'console-get-logs') return compactLogs(payload, located.pointer);
  return compactBatch(payload, located.pointer);
}

function compactScene(payload: Record<string, unknown>, pointer: string): Record<string, unknown> {
  const roots = payload['RootGameObjects'];
  if (!Array.isArray(roots)) return { compactUnavailable: 'RootGameObjects absent; inspect evidence (for example, a path/view query).', sourcePointer: pointer };
  const rows: unknown[][] = [];
  let count = 0;
  const missingHierarchyRoots = roots.filter((root) => !record(record(root)?.['Hierarchy'])).length;
  const pending = roots.map((root) => record(root)?.['Hierarchy']).reverse();
  while (pending.length > 0) {
    const node = record(pending.pop());
    if (!node) continue;
    count += 1;
    if (rows.length < 80) rows.push([
      shorten(node['path'] ?? node['name'], 240), node['instanceID'], node['activeSelf'], node['activeInHierarchy'],
    ]);
    const children = node['children'];
    if (Array.isArray(children)) for (let i = children.length - 1; i >= 0; i -= 1) pending.push(children[i]);
  }
  return {
    sourcePointer: pointer,
    scene: pick(payload, ['Name', 'path', 'RootCount', 'IsLoaded', 'IsDirty', 'IsValidScene']),
    hierarchy: { total: count, shown: rows.length, omitted: count - rows.length, missingHierarchyRoots,
      columns: ['pathOrName', 'instanceID', 'activeSelf', 'activeInHierarchy'], rows },
  };
}

function compactLogs(payload: Record<string, unknown>, pointer: string): Record<string, unknown> {
  const entries = payload['Entries'];
  if (!Array.isArray(entries)) return { compactUnavailable: 'Entries absent; inspect evidence.', sourcePointer: pointer };
  const shown = entries.slice(0, 50).map((item, index) => {
    const entry = record(item) ?? {};
    return { index, ...pick(entry, ['LogType', 'Timestamp', 'Source', 'CorrelationId', 'OperationId']),
      Message: shorten(entry['Message'], 240), hasStackTrace: typeof entry['StackTrace'] === 'string' && entry['StackTrace'].length > 0 };
  });
  return { sourcePointer: pointer, total: entries.length, shown: shown.length, omitted: entries.length - shown.length,
    DroppedEntries: payload['DroppedEntries'], TruncatedEntries: payload['TruncatedEntries'], entries: shown };
}

function compactBatch(payload: Record<string, unknown>, pointer: string): Record<string, unknown> {
  const results = payload['Results'];
  if (!Array.isArray(results)) return { compactUnavailable: 'Results absent; inspect evidence.', sourcePointer: pointer };
  // Show all failures first, then successful children, while preserving input indexes.
  const indexed = results.map((item, index) => ({ item: record(item) ?? {}, index }));
  const selected = [...indexed.filter(({ item }) => item['Ok'] !== true), ...indexed.filter(({ item }) => item['Ok'] === true)]
    .slice(0, 100).sort((a, b) => a.index - b.index);
  return { sourcePointer: pointer, ...pick(payload, ['TotalCommands', 'Succeeded', 'Failed', 'Aborted', 'RanInParallel', 'Note']),
    shown: selected.length, omitted: results.length - selected.length,
    omittedFailures: indexed.filter(({ item }) => item['Ok'] !== true).length - selected.filter(({ item }) => item['Ok'] !== true).length,
    results: selected.map(({ item, index }) => ({ index, ...pick(item, ['Tool', 'Ok', 'Skipped', 'ErrorCode', 'Error']),
      hasData: item['Data'] !== undefined, transaction: transactionSummary(item['Transaction']) })) };
}

function transactionSummary(value: unknown): unknown {
  const transaction = record(value);
  if (!transaction) return undefined;
  const fields = pick(transaction, ['undo', 'mutated', 'rollback', 'completed', 'aborted', 'shared', 'pending',
    'status', 'Status', 'Rollback', 'rolledBack', 'RolledBack']);
  return { present: true, ...Object.fromEntries(Object.entries(fields).map(([key, entry]) =>
    [key, entry !== null && typeof entry === 'object' ? '[see evidence]' : entry])) };
}

function resultIdentity(value: unknown): Record<string, unknown> {
  const root = record(value) ?? {};
  const located = locatePayload(value).value;
  return { ...pick(root, ['callId', 'correlationId', 'operationId', 'requestId']),
    ...pick(located, ['callId', 'correlationId', 'operationId', 'requestId', 'CallId', 'CorrelationId', 'OperationId']) };
}

function resultStatus(value: unknown): Record<string, unknown> {
  const root = record(value) ?? {};
  const located = locatePayload(value).value;
  return { ...pick(root, ['ok', 'Ok', 'status', 'Status', 'transportStatus', 'operationStatus']),
    ...pick(located, ['ok', 'Ok', 'status', 'Status', 'transportStatus', 'operationStatus']) };
}

function locatePayload(value: unknown): { value: Record<string, unknown>; pointer: string } {
  let current = record(value) ?? {};
  let pointer = '';
  for (let depth = 0; depth < 8; depth += 1) {
    const key = WRAPPERS.find((candidate) => record(current[candidate]));
    if (!key) break;
    current = record(current[key])!;
    pointer += `/${key}`;
  }
  return { value: current, pointer };
}

function describeShape(value: unknown): Record<string, unknown> {
  if (Array.isArray(value)) return { type: 'array', length: value.length };
  const root = record(value);
  if (root) return { type: 'object', keys: Object.keys(root).slice(0, 24), keyCount: Object.keys(root).length };
  return { type: value === null ? 'null' : typeof value };
}

function pick(source: Record<string, unknown>, names: string[]): Record<string, unknown> {
  return Object.fromEntries(names.filter((name) => source[name] !== undefined).map((name) => [name, shorten(source[name], 240)]));
}

function shorten(value: unknown, limit: number): unknown {
  return typeof value === 'string' && value.length > limit ? `${value.slice(0, limit)}…` : value;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
