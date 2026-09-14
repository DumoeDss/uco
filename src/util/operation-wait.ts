// Terminal-state wait for durable operations (COCli-03) — after a tool call
// returns a durable operation handle, poll the authoritative record through
// the generic operation query surface until a terminal status or a caller
// bound, then hand the terminal envelope back so the CLI exits by the
// documented map without caller-side polling loops.

import type { UnityCoTransport } from '../transport/index.js';
import { CliError } from './errors.js';
import { toolPayloadRecords, unwrapToolPayload } from './tool-payload.js';

export interface OperationWaitOptions {
  /** Absolute bound for the whole wait. */
  timeoutMs: number;
  /** Poll interval (default 1s, reusing the readiness interval discipline). */
  intervalMs?: number;
}

export interface TerminalOperation {
  record: Record<string, unknown>;
  operationId: string;
  status: string;
}

const DEFAULT_INTERVAL_MS = 1_000;

/** Follow the first record that carries a durable operation handle. */
export function extractOperationHandle(result: unknown): { operationId: string } | undefined {
  for (const payload of toolPayloadRecords(result)) {
    const operationId = readOperationId(payload);
    if (operationId !== undefined) return { operationId };
  }
  return undefined;
}

function readOperationId(record: Record<string, unknown>): string | undefined {
  const value = record['OperationId'] ?? record['operationId'];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readString(record: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

function isTerminalStatus(status: string | undefined): status is string {
  return status === 'succeeded' || status === 'failed'
    || status === 'cancelled' || status === 'interrupted';
}

export interface InitialOperationState {
  operationId?: string;
  /** Terminal status already present in the initial response payload, if any. */
  terminalStatus?: string;
}

/**
 * Inspect an initial tool-call response for a durable handle and/or an
 * already-terminal status. `--wait` uses this to degrade gracefully: a call
 * that returned its final answer inline (older non-durable tools, fast
 * failures) must not be reported as a wait-protocol error.
 */
export function inspectInitialOperationState(result: unknown): InitialOperationState {
  for (const payload of toolPayloadRecords(result)) {
    const operationId = readOperationId(payload);
    const status = readString(payload, 'Status', 'status');
    if (operationId !== undefined) {
      return { operationId, terminalStatus: isTerminalStatus(status) ? status : undefined };
    }
    if (isTerminalStatus(status)) {
      return { terminalStatus: status };
    }
  }
  return {};
}

/**
 * Poll `editor-operation-get` until the operation reaches a terminal status.
 * Resolves with the terminal record (the envelope to print); throws the
 * documented wait-timeout failure (exit 3) with the last observed status and
 * phase when the bound expires.
 */
export async function waitForDurableOperation(
  transport: UnityCoTransport,
  result: unknown,
  options: OperationWaitOptions,
): Promise<TerminalOperation> {
  const handle = extractOperationHandle(result);
  if (handle === undefined) {
    throw new CliError(
      'The call did not return a durable operation handle; --wait needs an operationId to poll.',
      'operation-wait-invalid',
      1,
      false,
    );
  }
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const deadline = Date.now() + options.timeoutMs;
  let lastStatus = 'unknown';
  let lastPhase = 'unknown';

  while (true) {
    const query = await transport.callTool('editor-operation-get', {
      operationId: handle.operationId,
    });
    const record = unwrapToolPayload(query);
    const status = readString(record, 'Status', 'status');
    const phase = readString(record, 'Phase', 'phase');
    if (status !== undefined) lastStatus = status;
    if (phase !== undefined) lastPhase = phase;

    if (readOperationId(record) === undefined && Object.keys(record).length === 0) {
      throw new CliError(
        `Editor operation '${handle.operationId}' was not found while waiting.`,
        'operation_not_found',
        4,
        false,
        { operationId: handle.operationId },
      );
    }
    if (isTerminalStatus(status)) {
      return { record, operationId: handle.operationId, status: status! };
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new CliError(
        `Operation '${handle.operationId}' did not reach a terminal state within ${(options.timeoutMs / 1000).toFixed(1)}s; last status: ${lastStatus} (${lastPhase}).`,
        'operation-wait-timeout',
        3,
        true,
        {
          operationId: handle.operationId,
          lastStatus,
          lastPhase,
        },
      );
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(intervalMs, remainingMs)));
  }
}
