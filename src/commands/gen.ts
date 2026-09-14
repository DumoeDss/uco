// uco gen — regenerate the typed command suite from a live Unity-MCP server.
//
// Reads GET /api/tools, writes src/generated/tools.json (the snapshot
// for offline build) and src/generated/tools.ts (the commander
// registrations). Re-run whenever upstream tools or schemas change.

import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { runCommand } from '../util/cli-context.js';
import { printInfo } from '../util/output.js';
import { fetchTools, writeCatalog } from '../codegen/fetch.js';
import { emitToolCommands } from '../codegen/emit.js';

interface GenOpts {
  out?: string;
  tools?: string;
}

export function registerGen(program: Command): void {
  program
    .command('gen [project]')
    .description('Regenerate typed tool commands from a live Unity-MCP server (writes src/generated/).')
    .option('--out <dir>', 'Output directory (default: this package\'s src/generated/)')
    .option('--tools <file>', 'Path for the catalog JSON snapshot (default: <out>/tools.json)')
    .action(function (this: Command, _projectArg: string | undefined, opts: GenOpts) {
      return runCommand(this, async (ctx) => {
        const outDir = opts.out ?? defaultOutDir();
        const toolsJson = opts.tools ?? path.join(outDir, 'tools.json');
        const toolsTs = path.join(outDir, 'tools.ts');

        printInfo(ctx.output, `→ ${ctx.resolved.baseUrl} (${ctx.resolved.source})`);
        const catalog = await fetchTools({
          ...(ctx.resolved.projectPath ? { projectPath: ctx.resolved.projectPath } : {}),
          url: ctx.resolved.baseUrl,
          ...(ctx.resolved.token ? { token: ctx.resolved.token } : {}),
        });

        writeCatalog(catalog, toolsJson);
        const code = emitToolCommands(catalog);
        writeFileSync(toolsTs, code, 'utf8');

        return {
          tools: catalog.length,
          enabled: catalog.filter((t) => t.enabled !== false).length,
          wrote: { json: toolsJson, ts: toolsTs },
        };
      })();
    });
}

function defaultOutDir(): string {
  // dist/commands/gen.js → ../../src/generated/
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '../../src/generated');
}
