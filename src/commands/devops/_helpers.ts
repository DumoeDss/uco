// Shared helpers for devops command wrappers.
//
// Devops commands sit on top of the vendored lib functions in
// `src/devops/lib/*` — those return discriminated-union results
// (`{kind: 'success'|'failure', ...}`) and emit progress via callbacks.
// This file maps that contract onto uco's runCommand/JSON IO style.

import path from 'node:path';
import process from 'node:process';
import { printInfo } from '../../util/output.js';
import { CliError } from '../../util/errors.js';
import type { CommandContext } from '../../util/cli-context.js';
import type { ProgressEvent } from '../../devops/lib/types.js';

/**
 * Resolve a Unity project path from CLI arguments. The path may come
 * from a positional argument, the global --project flag, or default to
 * the current working directory.
 *
 * @throws CliError if the resolved path doesn't exist on disk.
 */
export function resolveProjectArg(ctx: CommandContext, positional: string | undefined): string {
  const candidate = positional ?? ctx.resolved.projectPath ?? process.cwd();
  const abs = path.resolve(candidate);
  return abs;
}

/**
 * Build an onProgress callback that funnels lib progress events into
 * stderr via printInfo, respecting the JSON/verbose flags.
 */
export function progressLogger(ctx: CommandContext): (e: ProgressEvent) => void {
  return (event: ProgressEvent) => {
    // In JSON mode, suppress progress noise — agents only want the final payload.
    if (ctx.output.json) return;
    printInfo(ctx.output, `[${event.phase}] ${event.message}`);
  };
}

/**
 * Convert a discriminated-union result from lib into the value the
 * uco runCommand wrapper expects:
 *   - On success: return the result object (sans kind/success flags).
 *   - On failure: throw a CliError carrying the underlying error message.
 */
export function unwrapResult<S extends { kind: 'success' }, F extends { kind: 'failure'; error: Error }>(
  result: S | F,
): Omit<S, 'kind' | 'success'> {
  if (result.kind === 'failure') {
    throw new CliError(result.error.message || 'Operation failed', 'devops-failure');
  }
  // Strip discriminator fields for cleaner JSON output.
  const { kind: _kind, success: _success, ...rest } = result as { kind: string; success: boolean } & Record<string, unknown>;
  return rest as Omit<S, 'kind' | 'success'>;
}
