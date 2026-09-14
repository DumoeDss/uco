// uco list — enumerate the tool catalog the server exposes.
//
// Use cases:
//   - Agent self-discovery: "what's available?" before composing a workflow
//   - Codegen input (Phase 2 wires this into build-time command generation)

import { Command } from 'commander';
import { runCommand } from '../util/cli-context.js';

interface ListOptions {
  filter?: string;
}

const SAFETY_HINTS = [
  'readOnlyHint',
  'destructiveHint',
  'idempotentHint',
  'openWorldHint',
] as const;

export function registerList(program: Command): void {
  program
    .command('list')
    .description('List tools the server exposes (GET /api/tools).')
    .option('-f, --filter <substring>', 'Filter tool names by substring (case-insensitive)')
    .action(function (this: Command, opts: ListOptions) {
      return runCommand(this, async (ctx) => {
        const tools = await ctx.transport.listTools();
        const filtered = opts.filter
          ? tools.filter((t) => t.name.toLowerCase().includes(opts.filter!.toLowerCase()))
          : tools;
        // Keep the JSON shape stable: an array of {name, title?, description?}.
        return filtered.map((tool) => {
          const entry: Record<string, unknown> = {
            name: tool.name,
            ...(tool.title ? { title: tool.title } : {}),
            ...(tool.description ? { description: tool.description } : {}),
          };
          for (const hint of SAFETY_HINTS) {
            if (Object.hasOwn(tool, hint)) entry[hint] = tool[hint];
          }
          return entry;
        });
      })();
    });
}
