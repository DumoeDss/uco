// uco setup-mcp — write an MCP client config file for a chosen AI agent
// (claude-code, cursor, codex, ...). Lets a normal MCP client connect to
// the same uco bridge server uco targets, when the user wants to mix
// both modalities.

import { Command } from 'commander';
import { runCommand, CliError } from '../../util/cli-context.js';
import { setupMcp, listAgentIds } from '../../devops/lib/setup-mcp.js';
import type { McpTransport } from '../../devops/lib/types.js';
import { resolveProjectArg, progressLogger, unwrapResult } from './_helpers.js';

interface SetupMcpOpts {
  transport?: string;
  url?: string;
  token?: string;
  list?: boolean;
}

export function registerSetupMcp(program: Command): void {
  program
    .command('setup-mcp [agent] [project]')
    .description('Write an MCP client config for the chosen agent. Run with --list to see supported agents.')
    .option('--list', 'List supported agent IDs and exit')
    .option('--transport <kind>', 'Transport: http (default) or stdio', 'http')
    .option('--url <url>', 'Server URL override')
    .option('--token <token>', 'Bearer token override')
    .action(function (this: Command, agentArg: string | undefined, projectArg: string | undefined, opts: SetupMcpOpts) {
      return runCommand(this, async (ctx) => {
        if (opts.list) {
          return { agents: listAgentIds() };
        }
        if (!agentArg) {
          throw new CliError('Missing <agent>. Use `uco setup-mcp --list` to see available agents.', 'missing-agent');
        }
        const transport = (opts.transport ?? 'http') as McpTransport;
        if (transport !== 'http' && transport !== 'stdio') {
          throw new CliError(`Invalid --transport: ${transport}. Use 'http' or 'stdio'.`, 'invalid-transport');
        }
        const projectPath = resolveProjectArg(ctx, projectArg);
        const result = await setupMcp({
          agentId: agentArg,
          unityProjectPath: projectPath,
          transport,
          ...(opts.url ? { url: opts.url } : {}),
          ...(opts.token ? { token: opts.token } : {}),
          onProgress: progressLogger(ctx),
        });
        return unwrapResult(result);
      })();
    });
}
