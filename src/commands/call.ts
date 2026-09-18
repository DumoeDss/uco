// uco call <tool> [--args '<json>'] — escape hatch for tools that
// don't have a first-class subcommand yet. Equivalent to the upstream
// the legacy `run-tool` command but with uco's transport and output rules.
//
// uco call get <callId> / uco call list — query the server's bounded
// durable call records (COCli-09): resolve an observed transport timeout
// ("result unknown") to its actual terminal state, including completions
// that arrived after the server stopped waiting.
//
// Agents should prefer typed subcommands (gameobject create, scene
// open, ...) when available; `call` exists for the long tail until
// codegen catches up.

import { Command, Option } from 'commander';
import { runCommand, CliError } from '../util/cli-context.js';
import { printInfo } from '../util/output.js';
import { resolveJsonObjectInput } from '../util/input.js';
import { parseBoundedInteger, MAX_TIMER_MILLISECONDS } from '../util/timeout.js';
import {
  addToolCallControlOptions,
  toolCallOptionsFromCli,
  type ToolCallCliOptions,
} from '../util/call-control.js';

interface CallOptions extends ToolCallCliOptions {
  args?: string;
  argsFile?: string;
  system?: boolean;
}

interface CallGetOptions {
  wait?: boolean;
  waitTimeoutMs?: string;
  intervalMs?: string;
}

interface CallListOptions {
  limit?: string;
  state?: string;
}

const DEFAULT_CALL_WAIT_TIMEOUT_MS = 600_000;
const DEFAULT_CALL_POLL_INTERVAL_MS = 1_000;

export function registerCall(program: Command): void {
  const command = program
    .command('call <tool>')
    .description('Invoke an arbitrary tool by name (POST /api/tools/{tool}); `call get/list` query durable call records.')
    .addOption(new Option('-a, --args <json>', 'Inline JSON object with tool arguments').conflicts('argsFile'))
    .addOption(new Option('--args-file <path>', 'Read a strict UTF-8 JSON object from a path or - (stdin)').conflicts('args'))
    .option('--system', 'Call /api/system-tools/{tool} instead (internal tools)')
    .addHelpText(
      'after',
      `
Authoring confirmation:
  A risky or unknown execution can first return confirmation_required without
  running the tool. Re-run the exact same command (including the same tool and
  canonical --args or --args-file input) and append the printed Retry fragment.
  The fragment preserves the bound logical context and opaque one-use token;
  do not edit it or reuse it after a successful execution.

Durable call records:
  uco call get <callId> [--wait]    Resolve a call record (e.g. after a timeout)
  uco call list [--limit N] [--state <s>]
  A tool literally named get/list is unreachable via this surface — invoke it
  through its generated command instead.

Examples:
  uco call asset-delete --args-file delete-request.json --call-id delete-1 --correlation-id authoring-1
  uco call asset-delete --args-file delete-request.json <printed Retry fragment>
      `,
    )
    .action(function (this: Command, tool: string, opts: CallOptions) {
      return runCommand(this, async (ctx) => {
        const args = loadArgs(opts);
        const control = toolCallOptionsFromCli(opts);
        const result = opts.system
          ? await ctx.transport.callSystemTool(tool, args, control)
          : await ctx.transport.callTool(tool, args, control);
        return result;
      })();
    });
  addToolCallControlOptions(command);

  command
    .command('get <callId>')
    .description('Fetch one durable call record; --wait polls it to a terminal state.')
    .option('--wait', 'Poll until the record reaches a terminal state (succeeded/failed/cancelled/abandoned).')
    .option('--wait-timeout-ms <ms>', `Poll bound in milliseconds (default: ${DEFAULT_CALL_WAIT_TIMEOUT_MS}; range: 1-${MAX_TIMER_MILLISECONDS})`)
    .option('--interval-ms <ms>', `Poll interval in milliseconds (default: ${DEFAULT_CALL_POLL_INTERVAL_MS}; range: 1-${MAX_TIMER_MILLISECONDS})`)
    .action(function (this: Command, callId: string, opts: CallGetOptions) {
      return runCommand(this, async (ctx) => {
        const record = opts.wait
          ? await waitForCallRecord(ctx.transport, callId, {
              timeoutMs: parseBoundedInteger(opts.waitTimeoutMs ?? String(DEFAULT_CALL_WAIT_TIMEOUT_MS), {
                option: '--wait-timeout-ms',
                unit: 'milliseconds',
                maximum: MAX_TIMER_MILLISECONDS,
              }),
              intervalMs: parseBoundedInteger(opts.intervalMs ?? String(DEFAULT_CALL_POLL_INTERVAL_MS), {
                option: '--interval-ms',
                unit: 'milliseconds',
                maximum: MAX_TIMER_MILLISECONDS,
              }),
            }, ctx.output)
          : unwrapCallRecord(await ctx.transport.getCall(callId));
        if (record.state === 'failed') {
          throw new CliError(
            `Call '${callId}' failed: ${record.error?.message ?? 'unknown error'}`,
            'call-failed',
            5,
            false,
            record,
          );
        }
        if (record.state === 'cancelled') {
          throw new CliError(
            `Call '${callId}' was cancelled.`,
            'call-cancelled',
            6,
            false,
            record,
          );
        }
        return record;
      })();
    });

  command
    .command('list')
    .description('List the most recent durable call records (newest first).')
    .option('--limit <n>', 'Maximum records to show (1-200, default 50)', '50')
    .option('--state <state>', 'Filter by state: pending, processing, succeeded, failed, cancelled, abandoned')
    .action(function (this: Command, opts: CallListOptions) {
      return runCommand(this, async (ctx) => {
        const limitRaw = Number.parseInt(opts.limit ?? '50', 10);
        if (!Number.isInteger(limitRaw) || limitRaw < 1 || limitRaw > 200) {
          throw new CliError('--limit must be an integer between 1 and 200.', 'invalid-limit', 1, false);
        }
        return ctx.transport.listCalls({
          limit: limitRaw,
          ...(opts.state !== undefined && opts.state.length > 0 ? { state: opts.state } : {}),
        });
      })();
    });
}

export function loadArgs(opts: CallOptions): Record<string, unknown> {
  return resolveJsonObjectInput(opts.args, opts.argsFile);
}

interface CallRecordView {
  callId: string;
  state: string;
  error?: { code: string; message: string; retryable: boolean };
  [member: string]: unknown;
}

function unwrapCallRecord(payload: unknown): CallRecordView {
  const record = (payload && typeof payload === 'object'
    ? (payload as Record<string, unknown>)['call']
    : undefined) ?? payload;
  if (!record || typeof record !== 'object' || typeof (record as CallRecordView).state !== 'string') {
    throw new CliError('The server response did not contain a call record.', 'call-record-invalid', 1, false, payload);
  }
  return record as CallRecordView;
}

const TERMINAL_CALL_STATES = new Set(['succeeded', 'failed', 'cancelled', 'abandoned']);

async function waitForCallRecord(
  transport: import('../transport/index.js').UnityCoTransport,
  callId: string,
  options: { timeoutMs: number; intervalMs: number },
  output: { json: boolean; verbose: boolean },
): Promise<CallRecordView> {
  const deadline = Date.now() + options.timeoutMs;
  let last: CallRecordView | undefined;
  for (;;) {
    last = unwrapCallRecord(await transport.getCall(callId));
    if (TERMINAL_CALL_STATES.has(last.state)) {
      if (last.state === 'abandoned') {
        printInfo(output, `Call '${callId}' reached 'abandoned' (${String(last.abandonReason ?? 'unknown')}): the server stopped waiting; the plugin may still complete the work late (lateCompletion=${String(last.lateCompletion === true)}).`);
      }
      return last;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new CliError(
        `Call '${callId}' did not reach a terminal state within ${(options.timeoutMs / 1000).toFixed(1)}s; last state: ${last.state}.`,
        'call-wait-timeout',
        3,
        true,
        { callId, lastState: last.state },
      );
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(options.intervalMs, remaining)));
  }
}
