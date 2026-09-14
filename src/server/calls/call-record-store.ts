/**
 * Bounded durable call records (COCli-09) — one entry per forwarded tool
 * call, queryable by callId so an observed transport timeout ("result
 * unknown") can be resolved to a terminal state afterwards.
 *
 * The store intentionally survives PendingTracker settlement: durable tools
 * reply `processing` immediately (settling the tracker entry), and the late
 * NotifyToolRequestCompleted would otherwise be dropped. A requestId→callId
 * index here is the authoritative correlation for those late completions.
 *
 * Records are process-local and bounded (count + TTL); they are diagnostics,
 * not a durable queue.
 */

export type CallRecordState =
  | 'pending'
  | 'processing'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'abandoned';

export type AbandonReason = 'server-wait-timeout' | 'caller-disconnect';

export interface CallRecordError {
  code: string;
  message: string;
  retryable: boolean;
}

export interface CallRecord {
  callId: string;
  requestId: string;
  tool: string;
  mode: 'sync' | 'async';
  state: CallRecordState;
  abandonReason?: AbandonReason;
  /** A terminal completion arrived after the server stopped waiting. */
  lateCompletion?: boolean;
  operationId?: string;
  identity?: Record<string, unknown>;
  connectionId?: string;
  generation?: number;
  createdAtUtc: string;
  dispatchedAtUtc?: string;
  settledAtUtc?: string;
  /** Bounded first text of the terminal result (≤1024 chars). */
  resultPreview?: string;
  error?: CallRecordError;
}

export const MAX_CALL_RECORDS = 256;
export const CALL_RECORD_TTL_MS = 30 * 60_000;
const MAX_TOOL_NAME_LENGTH = 160;
const MAX_TEXT_LENGTH = 1024;
const GENERIC_TOOL_FAILURE_MESSAGES = new Set(['Tool call failed.', 'Tool execution failed.']);

export interface CallRecordBeginInput {
  callId: string;
  requestId: string;
  tool: string;
  mode: 'sync' | 'async';
  connectionId?: string;
  generation?: number;
}

interface TerminalResponseShape {
  status?: string | null;
  message?: string | null;
  /** ResponseData<ResponseCallTool> nests content under `value`; a deferred completion result carries it at the top level. */
  content?: { type?: string | null; text?: string | null }[] | null;
  value?: {
    content?: { type?: string | null; text?: string | null }[] | null;
  } | null;
  error?: { code?: unknown; message?: unknown; retryable?: unknown } | null;
}

export class CallRecordStore {
  private readonly byCallId = new Map<string, CallRecord>();
  private readonly callIdByRequestId = new Map<string, string>();

  begin(input: CallRecordBeginInput): void {
    const callId = boundText(input.callId, 160);
    const requestId = boundText(input.requestId, 160);
    if (callId === undefined || requestId === undefined) return;
    const record: CallRecord = {
      callId,
      requestId,
      tool: boundText(input.tool, MAX_TOOL_NAME_LENGTH) ?? '(unknown)',
      mode: input.mode,
      state: 'pending',
      createdAtUtc: new Date().toISOString(),
      ...(input.connectionId !== undefined ? { connectionId: input.connectionId } : {}),
      ...(input.generation !== undefined ? { generation: input.generation } : {}),
    };
    // A re-issued callId supersedes the earlier record entirely.
    this.byCallId.delete(callId);
    this.evictIfNeeded();
    this.byCallId.set(callId, record);
    this.callIdByRequestId.set(requestId, callId);
  }

  markDispatched(callId: string, identity?: Record<string, unknown>): void {
    const record = this.byCallId.get(callId);
    if (!record) return;
    if (record.state === 'pending') record.state = 'processing';
    record.dispatchedAtUtc = new Date().toISOString();
    if (identity !== undefined && record.identity === undefined) {
      record.identity = identity;
    }
  }

  noteOperationId(callId: string, operationId: string | undefined): void {
    if (operationId === undefined) return;
    const record = this.byCallId.get(callId);
    if (record && record.operationId === undefined) record.operationId = boundText(operationId, 160);
  }

  /** Settle from a plugin ResponseData envelope (sync/async forward completion). */
  settleFromResponse(callId: string, response: TerminalResponseShape | null): void {
    const record = this.byCallId.get(callId);
    if (!record || isTerminal(record)) return;
    if (response === null || response === undefined) {
      this.settleFailed(callId, { code: 'tool_execution_failed', message: 'Tool hub returned a null response.', retryable: false });
      return;
    }
    const status = typeof response.status === 'string' ? response.status.toLowerCase() : undefined;
    if (status === 'error') {
      const message = boundText(
        pickDiagnostic(response.error?.message, firstText(response)),
        MAX_TEXT_LENGTH,
      ) ?? 'Tool execution failed.';
      const code = typeof response.error?.code === 'string' && response.error.code.length > 0
        ? response.error.code
        : 'tool_execution_failed';
      this.settleFailed(callId, { code, message, retryable: response.error?.retryable === true });
      return;
    }
    if (status === 'processing') {
      record.state = 'processing';
      const preview = firstText(response);
      if (preview !== undefined) record.resultPreview = preview;
      record.settledAtUtc = new Date().toISOString();
      return;
    }
    record.state = 'succeeded';
    const preview = firstText(response);
    if (preview !== undefined) record.resultPreview = preview;
    record.settledAtUtc = new Date().toISOString();
  }

  settleFailed(callId: string, error: CallRecordError): void {
    const record = this.byCallId.get(callId);
    if (!record || isTerminal(record)) return;
    record.state = 'failed';
    record.error = {
      code: boundText(error.code, 160) ?? 'tool_execution_failed',
      message: boundText(error.message, MAX_TEXT_LENGTH) ?? 'Tool execution failed.',
      retryable: error.retryable === true,
    };
    record.settledAtUtc = new Date().toISOString();
  }

  settleCancelled(callId: string): void {
    const record = this.byCallId.get(callId);
    if (!record || isTerminal(record)) return;
    record.state = 'cancelled';
    record.settledAtUtc = new Date().toISOString();
  }

  /** The server stopped waiting; the plugin may still complete the work late. */
  settleAbandoned(callId: string, reason: AbandonReason): void {
    const record = this.byCallId.get(callId);
    if (!record || isTerminal(record)) return;
    record.state = 'abandoned';
    record.abandonReason = reason;
    record.settledAtUtc = new Date().toISOString();
  }

  /**
   * Late/deferred completion by requestId — works even after the pending
   * tracker settled or expired. Flips abandoned records to their terminal
   * state with `lateCompletion: true`.
   */
  completeByRequestId(
    requestId: string,
    operationId: string | undefined,
    result: unknown,
    isError: boolean,
  ): void {
    const callId = this.callIdByRequestId.get(boundText(requestId, 160) ?? '');
    if (callId === undefined) return;
    if (operationId !== undefined) this.noteOperationId(callId, operationId);
    const record = this.byCallId.get(callId);
    if (!record) return;
    const wasAbandoned = record.state === 'abandoned' || record.state === 'pending' || record.state === 'processing';
    if (isError) {
      if (isTerminal(record) && record.state !== 'abandoned') return;
      record.state = 'failed';
      const envelope = result as TerminalResponseShape | undefined;
      const message = boundText(
        pickDiagnostic(envelope?.error?.message, firstText(envelope)),
        MAX_TEXT_LENGTH,
      ) ?? 'Deferred tool call failed.';
      const code = typeof envelope?.error?.code === 'string' && envelope.error.code.length > 0
        ? envelope.error.code
        : 'tool_execution_failed';
      record.error = { code, message, retryable: false };
    } else {
      if (isTerminal(record) && record.state !== 'abandoned') return;
      record.state = 'succeeded';
      const envelope = result as TerminalResponseShape | undefined;
      const preview = firstText(envelope);
      if (preview !== undefined) record.resultPreview = preview;
    }
    if (wasAbandoned) record.lateCompletion = true;
    record.settledAtUtc = new Date().toISOString();
  }

  get(callId: string): CallRecord | undefined {
    return this.byCallId.get(callId);
  }

  list(opts?: { limit?: number; state?: CallRecordState }): CallRecord[] {
    const limit = Math.max(1, Math.min(200, opts?.limit ?? 50));
    const records = [...this.byCallId.values()].reverse();
    const filtered = opts?.state === undefined
      ? records
      : records.filter((record) => record.state === opts.state);
    return filtered.slice(0, limit);
  }

  /** Evict records past the TTL; returns the number removed. */
  sweep(now: number = Date.now()): number {
    let removed = 0;
    for (const [callId, record] of this.byCallId) {
      const anchor = Date.parse(record.settledAtUtc ?? record.createdAtUtc);
      if (Number.isFinite(anchor) && now - anchor > CALL_RECORD_TTL_MS) {
        this.byCallId.delete(callId);
        if (this.callIdByRequestId.get(record.requestId) === callId) {
          this.callIdByRequestId.delete(record.requestId);
        }
        removed++;
      }
    }
    return removed;
  }

  startSweeper(intervalMs = 5 * 60_000): ReturnType<typeof setInterval> {
    const timer = setInterval(() => {
      this.sweep();
    }, intervalMs);
    timer.unref?.();
    return timer;
  }

  private evictIfNeeded(): void {
    while (this.byCallId.size >= MAX_CALL_RECORDS) {
      const oldest = this.byCallId.keys().next().value;
      if (oldest === undefined) break;
      const record = this.byCallId.get(oldest);
      this.byCallId.delete(oldest);
      if (record && this.callIdByRequestId.get(record.requestId) === oldest) {
        this.callIdByRequestId.delete(record.requestId);
      }
    }
  }
}

function isTerminal(record: CallRecord): boolean {
  return record.state === 'succeeded' || record.state === 'failed'
    || record.state === 'cancelled' || record.state === 'abandoned';
}

function firstText(response: TerminalResponseShape | undefined | null): string | undefined {
  const content = response?.content ?? response?.value?.content;
  if (!Array.isArray(content)) return undefined;
  for (const block of content) {
    if (block?.type !== 'text' || typeof block.text !== 'string') continue;
    const trimmed = block.text.trim();
    if (trimmed.length > 0) return trimmed.length <= MAX_TEXT_LENGTH ? trimmed : `${trimmed.slice(0, MAX_TEXT_LENGTH)}…`;
  }
  return undefined;
}

function boundText(value: string | undefined | null, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.length <= max ? trimmed : trimmed.slice(0, max);
}

/** Prefer an actionable diagnostic over a generic placeholder message. */
function pickDiagnostic(structuredMessage: unknown, contentText: string | undefined): string | undefined {
  if (typeof structuredMessage === 'string'
    && structuredMessage.trim().length > 0
    && !GENERIC_TOOL_FAILURE_MESSAGES.has(structuredMessage.trim())) {
    return structuredMessage;
  }
  return contentText ?? (typeof structuredMessage === 'string' && structuredMessage.trim().length > 0 ? structuredMessage : undefined);
}
