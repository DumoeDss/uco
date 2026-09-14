// uco ping — liveness probe against the Unity-MCP server.
//
// First step the Skill tells the agent to run before any other command:
// confirms the URL resolves, the server is up, and the Unity Editor /
// runtime build has the plugin connected.

import { Command } from 'commander';
import { runCommand } from '../util/cli-context.js';
import { printInfo } from '../util/output.js';

export function registerPing(program: Command): void {
  program
    .command('ping')
    .description('Health check the Unity-MCP server (POST /api/system-tools/ping).')
    .action(function (this: Command) {
      return runCommand(this, async (ctx) => {
        printInfo(ctx.output, `→ ${ctx.resolved.baseUrl} (${ctx.resolved.source})`);
        const data = await ctx.transport.ping();
        return {
          ok: true,
          url: ctx.resolved.baseUrl,
          source: ctx.resolved.source,
          data,
        };
      })();
    });
}
