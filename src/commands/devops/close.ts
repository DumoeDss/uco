// uco close — gracefully terminate the Unity Editor for a project.
//
// Mirrors upstream's commands/close.ts behavior:
//   1. Resolve project path (canonicalize via realpath)
//   2. Verify it's a Unity project root (has ProjectSettings/ProjectVersion.txt)
//   3. Find the Editor PID via lockfile + process enumeration
//   4. Ask the plugin to preflight saved/idle state and schedule normal exit
//   5. Wait for exit without escalating to a force kill

import * as fs from 'node:fs';
import * as path from 'node:path';
import { platform as nodePlatform } from 'node:os';
import { Command } from 'commander';
import { runCommand, CliError } from '../../util/cli-context.js';
import { findUnityProcess } from '../../devops/utils/unity-process.js';
import {
  readLockfilePid,
  isProcessAlive,
  waitForExit,
  type SupportedPlatform,
} from '../../devops/utils/unity-shutdown.js';
import { unwrapToolPayload } from '../../util/tool-payload.js';
import { MAX_TIMER_SECONDS, parseBoundedInteger } from '../../util/timeout.js';

interface CloseOpts {
  timeout?: string;
  timeoutSeconds?: string;
  force?: boolean;
}

const DEFAULT_TIMEOUT_S = 30;

export function registerClose(program: Command): void {
  program
    .command('close [project]')
    .description('Preflight and normally close the saved, idle Unity Editor for a project.')
    .option('--timeout-seconds <seconds>', `Normal-close timeout in seconds (canonical; default: ${DEFAULT_TIMEOUT_S}; range: 1-${MAX_TIMER_SECONDS}; deprecated alias: --timeout)`)
    .option('--timeout <seconds>', `Deprecated alias for --timeout-seconds; seconds; default: ${DEFAULT_TIMEOUT_S}; range: 1-${MAX_TIMER_SECONDS}`)
    .option('--force', 'Deprecated and refused: close never force-kills an Editor', false)
    .action(function (this: Command, projectArg: string | undefined, opts: CloseOpts) {
      const projectPath = canonicalizePath(projectArg ?? process.cwd());
      return runCommand(this, async (ctx) => {
        if (!fs.existsSync(projectPath)) {
          throw new CliError(`Project path does not exist: ${projectPath}`, 'no-such-project');
        }
        if (!fs.existsSync(path.join(projectPath, 'ProjectSettings', 'ProjectVersion.txt'))) {
          throw new CliError(`Not a Unity project root: ${projectPath}`, 'not-unity-project');
        }
        const timeoutRaw = opts.timeoutSeconds ?? opts.timeout ?? String(DEFAULT_TIMEOUT_S);
        const timeoutS = parseBoundedInteger(timeoutRaw, {
          option: opts.timeoutSeconds !== undefined ? '--timeout-seconds' : '--timeout',
          unit: 'seconds',
          maximum: MAX_TIMER_SECONDS,
        });

        const platform = nodePlatform() as SupportedPlatform;
        const pid = resolveEditorPid(projectPath, platform);
        if (pid === null) {
          return { closed: false, reason: 'no-running-editor', projectPath };
        }

        if (opts.force) {
          throw new CliError(
            '--force is no longer permitted. Resolve the reported Editor blockers and request a normal close.',
            'force-close-disabled',
            1,
            false,
            { pid, projectPath },
          );
        }

        let closeResponse: unknown;
        try {
          closeResponse = await ctx.transport.callTool(
            'editor-application-request-close',
            {},
            { timeoutMs: Math.min(timeoutS * 1000, 10_000) },
          );
        } catch (error) {
          // The process may close the bridge before its response flushes. Treat that
          // narrow race as success only when the exact pre-resolved PID has exited.
          if (await waitForExit(pid, 1500, platform)) {
            return { closed: true, mode: 'normal-editor-exit', pid, projectPath };
          }
          throw new CliError(
            `Unable to run the Editor close preflight for PID ${pid}.`,
            'close-preflight-unavailable',
            1,
            true,
            { pid, cause: error instanceof Error ? error.message : String(error) },
          );
        }

        const preflight = unwrapToolPayload(closeResponse);
        if (readBoolean(preflight, 'Ok', 'ok') === false ||
            readBoolean(preflight, 'Accepted', 'accepted') !== true) {
          throw new CliError(
            `Unity Editor (PID ${pid}) refused normal close because it is not saved and idle.`,
            'close-refused',
            1,
            false,
            preflight,
          );
        }
        const responsePid = readNumber(preflight, 'EditorPid', 'editorPid');
        if (responsePid !== undefined && responsePid !== pid) {
          throw new CliError(
            `Close preflight targeted PID ${responsePid}, but project discovery resolved PID ${pid}.`,
            'close-pid-mismatch',
            1,
            false,
            { projectPath, resolvedPid: pid, responsePid },
          );
        }

        const exited = await waitForExit(pid, timeoutS * 1000, platform);
        if (exited) {
          return { closed: true, mode: 'normal-editor-exit', pid, projectPath, timeoutSeconds: timeoutS };
        }

        let finalState: unknown;
        try {
          finalState = await ctx.transport.callTool(
            'editor-application-get-state',
            {},
            { timeoutMs: 2_000 },
          );
        } catch (error) {
          finalState = { unavailable: true, cause: error instanceof Error ? error.message : String(error) };
        }
        throw new CliError(
          `Unity Editor (PID ${pid}) did not complete normal close within ${timeoutS}s; it was not force-killed.`,
          'graceful-timeout',
          1,
          true,
          { pid, projectPath, timeoutSeconds: timeoutS, finalState },
        );
      }, { project: projectPath })();
    });
}

function readBoolean(record: Record<string, unknown>, ...keys: string[]): boolean | undefined {
  for (const key of keys) if (typeof record[key] === 'boolean') return record[key] as boolean;
  return undefined;
}

function readNumber(record: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) if (typeof record[key] === 'number') return record[key] as number;
  return undefined;
}

function canonicalizePath(p: string): string {
  const r = path.resolve(p);
  try {
    return fs.realpathSync(r);
  } catch {
    return r;
  }
}

function resolveEditorPid(projectPath: string, platform: SupportedPlatform): number | null {
  const lockPid = readLockfilePid(projectPath);
  let proc = findUnityProcess(projectPath);
  if (!proc) {
    const noRealpath = path.resolve(projectPath);
    if (noRealpath !== projectPath) proc = findUnityProcess(noRealpath);
  }
  if (lockPid !== null && isProcessAlive(lockPid, platform)) {
    if (proc && proc.pid === lockPid) return lockPid;
    if (!proc) return lockPid; // lockfile alive, no enum match — trust lockfile
  }
  return proc ? proc.pid : null;
}
