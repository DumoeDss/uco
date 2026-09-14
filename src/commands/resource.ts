// uco resource [uri] — list Unity-MCP resources, or read one by URI.
//
// Resources are read-only state providers (editor state, project info, hierarchy, ...).
//   uco resource                → list available resources (GET /api/resources)
//   uco resource <uri>          → read a resource by URI (GET /api/resources/content?uri=)

import { Command } from 'commander';
import { runCommand } from '../util/cli-context.js';

interface ResourceOpts {
  filter?: string;
}

export function registerResource(program: Command): void {
  program
    .command('resource [uri]')
    .description('List Unity-MCP resources, or read one by URI (GET /api/resources/content?uri=).')
    .option('-f, --filter <substring>', 'Filter by URI/name substring (list mode, case-insensitive)')
    .action(function (this: Command, uri: string | undefined, opts: ResourceOpts) {
      return runCommand(this, async (ctx) => {
        if (!uri) {
          const resources = await ctx.transport.listResources();
          const filtered = opts.filter
            ? resources.filter((r) =>
                `${r.uri} ${r.name ?? ''}`.toLowerCase().includes(opts.filter!.toLowerCase()))
            : resources;
          return filtered.map((r) => ({
            uri: r.uri,
            ...(r.name ? { name: r.name } : {}),
            ...(r.description ? { description: r.description } : {}),
            ...(r.mimeType ? { mimeType: r.mimeType } : {}),
          }));
        }
        return ctx.transport.readResource(uri);
      })();
    });
}
