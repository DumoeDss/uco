// Post-call idle wait (COCli-05) — reuse the readiness stages and the
// read-only editor probe from `uco wait-for-ready` so a mutating call that
// triggered a refresh/compile/domain-reload can be followed by "wait until the
// Editor is idle again" instead of caller-side sleep loops.

import type { UnityCoTransport } from '../transport/index.js';
import { CliError, TransportError } from './errors.js';
import {
  editorReadiness,
  registrationReadiness,
  transportStage,
} from './readiness.js';

export interface IdleWaitOptions {
  /** Absolute bound for the whole wait. */
  timeoutMs: number;
  /** Poll interval (default 1s; readiness settles in frames, not minutes). */
  intervalMs?: number;
  /** Per-request timeout for health/probe calls (defaults to the CLI request timeout). */
  requestTimeoutMs?: number;
}

const DEFAULT_INTERVAL_MS = 1_000;
const PROBE_BUDGET_MS = 10_000;

/**
 * Poll the readiness health stages and the editor state probe until the Editor
 * reports not compiling, not updating, not importing, not domain-reloading,
 * and no play-mode transition. Resolves when idle; throws the documented
 * wait-timeout failure (exit 3) naming the last blocking stage and cause when
 * the bound expires.
 */
export async function waitForEditorIdle(
  transport: UnityCoTransport,
  options: IdleWaitOptions,
): Promise<void> {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const deadline = Date.now() + options.timeoutMs;
  const probeTimeout = Math.min(intervalMs, PROBE_BUDGET_MS, Math.max(50, options.timeoutMs));
  let attempt = 0;
  let lastStage = 'http';
  let lastCause = 'not-started';

  while (Date.now() < deadline) {
    attempt++;
    let activeStage = 'http';
    try {
      const health = await transport.health({
        timeoutMs: remainingBudget(deadline, probeTimeout, activeStage),
      });
      const registration = registrationReadiness(health);
      if (!registration.ready) {
        lastStage = registration.stage;
        lastCause = registration.cause;
        throw pendingError(`${registration.stage}: ${registration.cause}`);
      }

      activeStage = 'editor';
      lastStage = activeStage;
      const state = await transport.callTool('editor-application-get-state', {}, {
        timeoutMs: remainingBudget(deadline, probeTimeout, activeStage),
      });
      const editor = editorReadiness(state);
      if (!editor.ready) {
        lastStage = editor.stage;
        lastCause = editor.cause;
        throw pendingError(`${editor.stage}: ${editor.cause}`);
      }
      return;
    } catch (err) {
      if (err instanceof IdlePending) {
        // fall through to the bounded sleep below
      } else if (err instanceof TransportError) {
        lastStage = activeStage === 'editor' ? activeStage : transportStage(err);
        lastCause = err.kind;
      } else {
        throw err;
      }
      const remainingMs = deadline - Date.now();
      const sleepMs = Math.min(intervalMs, Math.max(0, remainingMs));
      if (sleepMs <= 0) break;
      await new Promise((resolve) => setTimeout(resolve, sleepMs));
    }
  }

  throw new CliError(
    `Editor did not become idle within ${(options.timeoutMs / 1000).toFixed(1)}s; last blocking stage: ${lastStage} (${lastCause}).`,
    'idle-wait-timeout',
    3,
    true,
    {
      stage: lastStage,
      cause: lastCause,
      attempts: attempt,
    },
  );
}

function remainingBudget(deadline: number, probeLimitMs: number, stage: string): number {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) {
    throw new CliError(`Idle wait budget exhausted at stage ${stage}.`, 'idle-wait-timeout', 3, true, {
      stage,
      cause: 'budget-exhausted',
    });
  }
  return Math.min(probeLimitMs, remainingMs);
}

/** Internal control-flow marker for "not idle yet, sleep and re-probe". */
class IdlePending extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IdlePending';
  }
}

function pendingError(message: string): IdlePending {
  return new IdlePending(message);
}
