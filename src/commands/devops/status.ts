// uco status — quick health overview: Unity process, MCP server reachability.

import { Command } from 'commander';
import { runCommand } from '../../util/cli-context.js';
import { TransportError } from '../../util/errors.js';
import { MAX_TIMER_MILLISECONDS, parseBoundedInteger } from '../../util/timeout.js';
import { generatePortFromDirectory } from '../../config/port.js';
import { lookupUnityProcess } from '../../devops/utils/unity-process.js';
import { resolveProjectArg } from './_helpers.js';

interface StatusOpts {
  timeout?: string;
  timeoutMs?: string;
}

const DEFAULT_STATUS_TIMEOUT_MS = 5_000;

export function registerStatus(program: Command): void {
  program
    .command('status [project]')
    .description('Show Unity process / MCP server reachability for a project.')
    .option('--timeout-ms <ms>', `Per-probe timeout in milliseconds (canonical; default: ${DEFAULT_STATUS_TIMEOUT_MS}; range: 1-${MAX_TIMER_MILLISECONDS}; deprecated alias: --timeout)`)
    .option('--timeout <ms>', `Deprecated alias for --timeout-ms; milliseconds; default: ${DEFAULT_STATUS_TIMEOUT_MS}; range: 1-${MAX_TIMER_MILLISECONDS}`)
    .action(function (this: Command, projectArg: string | undefined, opts: StatusOpts) {
      return runCommand(this, async (ctx) => {
        const projectPath = resolveProjectArg(ctx, projectArg);
        const timeoutRaw = opts.timeoutMs ?? opts.timeout ?? String(DEFAULT_STATUS_TIMEOUT_MS);
        const timeoutMs = parseBoundedInteger(timeoutRaw, {
          option: opts.timeoutMs !== undefined ? '--timeout-ms' : '--timeout',
          unit: 'milliseconds',
          maximum: MAX_TIMER_MILLISECONDS,
        });

        // Unity process
        const lookup = lookupUnityProcess(projectPath);

        // Probe configured / resolved URL
        const reachable = await probeOnce(ctx.transport.ping.bind(ctx.transport), timeoutMs);

        // Probe deterministic-port URL too (it may differ if --url was passed)
        const localPort = generatePortFromDirectory(projectPath);
        const localUrl = `http://127.0.0.1:${localPort}`;
        const deterministicReachable =
          ctx.resolved.baseUrl === localUrl
            ? reachable
            : await probeUrl(localUrl, timeoutMs);

        return {
          projectPath,
          unity: lookup.process
            ? { running: true, pid: lookup.process.pid }
            : { running: false, ...(lookup.detectionError !== undefined ? { detectionError: lookup.detectionError } : {}) },
          mcpServer: {
            resolvedUrl: ctx.resolved.baseUrl,
            source: ctx.resolved.source,
            reachable: reachable.ok,
            ...(reachable.ok ? { data: reachable.data } : { error: reachable.error }),
          },
          deterministicPort: {
            url: localUrl,
            reachable: deterministicReachable.ok,
            ...(deterministicReachable.ok ? {} : { error: deterministicReachable.error }),
          },
        };
      })();
    });
}

type ProbeOutcome = { ok: true; data: unknown } | { ok: false; error: string };

async function probeOnce(ping: (opts?: { timeoutMs?: number }) => Promise<unknown>, timeoutMs: number): Promise<ProbeOutcome> {
  try {
    const data = await ping({ timeoutMs });
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: classify(err) };
  }
}

async function probeUrl(url: string, timeoutMs: number): Promise<ProbeOutcome> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`${url}/api/system-tools/ping`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
      signal: ctl.signal,
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const text = await res.text();
    try { return { ok: true, data: JSON.parse(text) }; } catch { return { ok: true, data: text }; }
  } catch (err) {
    return { ok: false, error: classify(err) };
  } finally {
    clearTimeout(timer);
  }
}

function classify(err: unknown): string {
  if (err instanceof TransportError) return err.kind;
  if (err instanceof Error) return err.message;
  return String(err);
}
