// uco login — authenticate with Unity-MCP cloud (ai-game.dev).
//
// Only relevant if the user opts into the cloud mode of the upstream
// uco bridge server. For local/custom-host usage, this command is a no-op.

import { Command } from 'commander';
import { runCommand, CliError } from '../../util/cli-context.js';
import { getOrCreateConfig, CLOUD_SERVER_BASE_URL } from '../../devops/utils/config.js';
import { runCloudLogin } from '../../devops/utils/cloud-login.js';
import { resolveProjectArg } from './_helpers.js';

interface LoginOpts {
  force?: boolean;
}

export function registerLogin(program: Command): void {
  program
    .command('login [project]')
    .description(`Authenticate with the Unity-MCP cloud server (${CLOUD_SERVER_BASE_URL}).`)
    .option('--force', 'Re-authenticate even if already logged in', false)
    .action(function (this: Command, projectArg: string | undefined, opts: LoginOpts) {
      return runCommand(this, async (ctx) => {
        const projectPath = resolveProjectArg(ctx, projectArg);
        const config = getOrCreateConfig(projectPath);
        if (config.cloudToken && !opts.force) {
          return { authenticated: true, alreadyLoggedIn: true, server: CLOUD_SERVER_BASE_URL };
        }
        const token = await runCloudLogin(projectPath);
        if (!token) {
          throw new CliError('Cloud login failed or was cancelled.', 'login-failed');
        }
        return { authenticated: true, alreadyLoggedIn: false, server: CLOUD_SERVER_BASE_URL };
      })();
    });
}
