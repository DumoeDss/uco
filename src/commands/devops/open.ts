// uco open — launch the Unity Editor for a project, optionally
// pre-wiring MCP connection env vars (UNITY_MCP_HOST/TOKEN/...).
//
// Wraps devops/lib/open.ts which:
//   - Detects the Editor version from ProjectSettings/ProjectVersion.txt
//   - Locates the matching Unity Editor binary
//   - Spawns it with env vars for the plugin to pick up
//   - Optionally auto-dismisses the "compile errors at launch" dialog

import { Command } from 'commander';
import { runCommand, CliError } from '../../util/cli-context.js';
import { openProject } from '../../devops/lib/open.js';
import type { OpenProjectAuthOption, OpenProjectTransport } from '../../devops/lib/types.js';
import { resolveProjectArg, progressLogger, unwrapResult } from './_helpers.js';
import { MAX_TIMER_MILLISECONDS, parseBoundedInteger } from '../../util/timeout.js';

interface OpenOpts {
  unity?: string;
  noConnect?: boolean;
  url?: string;
  token?: string;
  auth?: string;
  keepConnected?: boolean;
  tools?: string;
  transport?: string;
  startServer?: string;
  noAutoDismissLaunchErrors?: boolean;
  launchDismissTimeoutMs?: string;
  launchDismissPollIntervalMs?: string;
}

export function registerOpen(program: Command): void {
  program
    .command('open [project]')
    .description('Open a Unity project in the Unity Editor, optionally pre-wiring MCP connection env vars.')
    .option('--unity <version>', 'Unity Editor version (default: from ProjectVersion.txt or highest installed)')
    .option('--no-connect', 'Open without MCP connection env vars')
    .option('--url <url>', 'MCP server URL (sets UNITY_MCP_HOST)')
    .option('--token <token>', 'Auth token (sets UNITY_MCP_TOKEN)')
    .option('--auth <mode>', 'Auth mode: none | required')
    .option('--keep-connected', 'Keep MCP connection alive (sets UNITY_MCP_KEEP_CONNECTED)')
    .option('--tools <list>', 'Comma-separated tool IDs to enable (UNITY_MCP_TOOLS)')
    .option('--transport <kind>', 'Transport: streamableHttp | stdio')
    .option('--start-server <bool>', 'true: start/verify a uco-owned bridge before Unity; false: disable Unity-side auto-start')
    .option('--no-auto-dismiss-launch-errors', 'Disable auto-dismiss of the "compile errors at launch" dialog')
    .option('--launch-dismiss-timeout-ms <ms>', `Launch-error dismiss timeout in milliseconds (default: 30000; range: 1-${MAX_TIMER_MILLISECONDS})`, '30000')
    .option('--launch-dismiss-poll-interval-ms <ms>', `Launch-error dismiss poll interval in milliseconds (default: 1500; range: 1-${MAX_TIMER_MILLISECONDS})`, '1500')
    .action(function (this: Command, projectArg: string | undefined, opts: OpenOpts) {
      return runCommand(this, async (ctx) => {
        const projectPath = resolveProjectArg(ctx, projectArg);

        let auth: OpenProjectAuthOption | undefined;
        if (opts.auth) {
          if (opts.auth !== 'none' && opts.auth !== 'required') {
            throw new CliError(`Invalid --auth: ${opts.auth}. Use 'none' or 'required'.`, 'invalid-auth');
          }
          auth = opts.auth;
        }

        let transport: OpenProjectTransport | undefined;
        if (opts.transport) {
          if (opts.transport !== 'streamableHttp' && opts.transport !== 'stdio') {
            throw new CliError(`Invalid --transport: ${opts.transport}. Use 'streamableHttp' or 'stdio'.`, 'invalid-transport');
          }
          transport = opts.transport;
        }

        let startServer: boolean | undefined;
        if (opts.startServer !== undefined) {
          const lower = opts.startServer.toLowerCase();
          if (lower !== 'true' && lower !== 'false') {
            throw new CliError(`--start-server must be true|false, got: ${opts.startServer}`, 'invalid-start-server');
          }
          startServer = lower === 'true';
        }

        const launchDismissTimeoutMs = parseBoundedInteger(opts.launchDismissTimeoutMs ?? '30000', {
          option: '--launch-dismiss-timeout-ms',
          unit: 'milliseconds',
          maximum: MAX_TIMER_MILLISECONDS,
        });
        const launchDismissPollIntervalMs = parseBoundedInteger(opts.launchDismissPollIntervalMs ?? '1500', {
          option: '--launch-dismiss-poll-interval-ms',
          unit: 'milliseconds',
          maximum: MAX_TIMER_MILLISECONDS,
          code: 'invalid-interval',
        });

        const result = await openProject({
          projectPath,
          ...(opts.unity ? { unityVersion: opts.unity } : {}),
          noConnect: Boolean(opts.noConnect),
          ...(opts.url ? { url: opts.url } : {}),
          ...(opts.token ? { token: opts.token } : {}),
          ...(auth ? { auth } : {}),
          ...(opts.keepConnected !== undefined ? { keepConnected: opts.keepConnected } : {}),
          ...(opts.tools ? { tools: opts.tools } : {}),
          ...(transport ? { transport } : {}),
          ...(startServer !== undefined ? { startServer } : {}),
          autoDismissLaunchErrors: !opts.noAutoDismissLaunchErrors,
          launchDismissTimeoutMs,
          launchDismissPollIntervalMs,
          onProgress: progressLogger(ctx),
        });
        return unwrapResult(result);
      })();
    });
}
