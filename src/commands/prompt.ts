// uco prompt [name] [--args '<json>'] — list or resolve Unity-MCP prompts.
//
// Prompts are preset instruction templates (slash-commands) the Unity plugin exposes.
//   uco prompt                 → list available prompts (GET /api/prompts)
//   uco prompt <name>          → resolve a prompt by name (POST /api/prompts/{name})

import { Command } from 'commander';
import { runCommand, CliError } from '../util/cli-context.js';

interface PromptOpts {
  args?: string;
  filter?: string;
}

export function registerPrompt(program: Command): void {
  program
    .command('prompt [name]')
    .description('List Unity-MCP prompts, or resolve one by name (POST /api/prompts/{name}).')
    .option('-a, --args <json>', 'JSON arguments for the prompt (resolve mode)', '{}')
    .option('-f, --filter <substring>', 'Filter prompt names by substring (list mode, case-insensitive)')
    .action(function (this: Command, name: string | undefined, opts: PromptOpts) {
      return runCommand(this, async (ctx) => {
        if (!name) {
          const prompts = await ctx.transport.listPrompts();
          const filtered = opts.filter
            ? prompts.filter((p) => p.name.toLowerCase().includes(opts.filter!.toLowerCase()))
            : prompts;
          return filtered.map((p) => ({
            name: p.name,
            ...(p.title ? { title: p.title } : {}),
            ...(p.description ? { description: p.description } : {}),
          }));
        }
        const args = parsePromptArgs(opts);
        return ctx.transport.callPrompt(name, args);
      })();
    });
}

function parsePromptArgs(opts: PromptOpts): Record<string, unknown> {
  try {
    const parsed = JSON.parse(opts.args ?? '{}');
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new CliError('--args must be a JSON object', 'args-not-object');
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    if (err instanceof CliError) throw err;
    throw new CliError(`Invalid JSON in --args: ${(err as Error).message}`, 'args-invalid-json');
  }
}
