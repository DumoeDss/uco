// uco program factory — the full command registry without any argv
// side effects. The CLI entry (index.ts) and registry-validating tests
// (bridge-cookbook-validation) both build the program from here.

import { Command } from 'commander';
import { registerPing } from './commands/ping.js';
import { registerList } from './commands/list.js';
import { registerCall } from './commands/call.js';
import { registerExec } from './commands/exec.js';
import { registerDevopsCommands } from './commands/devops/index.js';
import { registerGen } from './commands/gen.js';
import { registerInstall } from './commands/install.js';
import { registerInit } from './commands/init.js';
import { registerUpdate } from './commands/update.js';
import { registerPrompt } from './commands/prompt.js';
import { registerResource } from './commands/resource.js';
import { registerGeneratedTools } from './generated/tools.js';
import { MAX_TIMER_MILLISECONDS } from './util/timeout.js';
import { getUcoVersion } from './skills/install-manifest.js';

// Single source of truth: package.json via the skills manifest resolver
// (source and dist layouts both supported, cached).
const VERSION = getUcoVersion();

export function buildProgram(): Command {
  const program = new Command();
  program
    .name('uco')
    .description(
      'uco — Unity Co-Pilot CLI: drive Unity Editor via plain HTTP.\n' +
        'Backed by the Unity Copilot Node bridge (plain REST + WebSocket wire).',
    )
    .version(VERSION)
    // Global options — every subcommand inherits these.
    .option(
      '-P, --project <path>',
      'Unity project path (used to find config + derive deterministic port). Defaults to $CWD.',
    )
    .option('-u, --url <url>', 'Override server URL (e.g. http://localhost:23456). Wins over config.')
    .option('-t, --token <token>', 'Override bearer auth token. Wins over config.')
    .option('-j, --json', 'Output raw JSON to stdout (default: pretty for humans, JSON for objects)')
    .option('-v, --verbose', 'Print verbose diagnostics to stderr')
    .option('--timeout-ms <ms>', `Per-request timeout in milliseconds (canonical; default: 60000; range: 1-${MAX_TIMER_MILLISECONDS}; deprecated alias: --timeout)`)
    .option('--timeout <ms>', `Deprecated alias for --timeout-ms; milliseconds; default: 60000; range: 1-${MAX_TIMER_MILLISECONDS}`, '60000');

  // Positional option scoping (COCli-10): once the first positional (the
  // subcommand name) appears, the root stops consuming option tokens. Without
  // this, root-level options with the same long name (notably --timeout-ms /
  // --timeout) silently swallowed flags placed after the subcommand, so e.g.
  // `wait-for-ready --timeout-ms 45000` never reached the command and its own
  // default always won. The shared globals are re-registered on every
  // subcommand below so the historical "globals anywhere" placements keep
  // working; a subcommand's own same-named option always takes precedence.
  program.enablePositionalOptions();

  // uco-specific ergonomic shortcuts.
  registerPing(program);
  registerList(program);
  registerCall(program);
  registerExec(program);
  registerGen(program);
  registerInstall(program);
  registerInit(program);
  registerUpdate(program);
  registerPrompt(program);
  registerResource(program);

  // Dev-ops command suite (install-plugin, open, configure, status, etc.) —
  // vendored from upstream bridge/cli (Apache-2.0).
  registerDevopsCommands(program);

  // All bridge tools mirrored 1:1 as `uco <tool-name>`.
  // Run `uco gen` against a running server to refresh.
  registerGeneratedTools(program);

  applyGlobalPassthroughOptions(program);

  return program;
}

interface PassthroughOptionSpec {
  readonly short?: string;
  readonly long: string;
  readonly arg: string;
  readonly description: string;
}

/**
 * Root-level globals that remain usable after a subcommand name. Registered
 * without defaults: a subcommand value exists only when the caller actually
 * placed the flag after the subcommand, so the root→child merge can let an
 * explicit child value win without any defaulted clobbering.
 */
const PASSTHROUGH_OPTIONS: readonly PassthroughOptionSpec[] = [
  { short: '-P', long: '--project', arg: '<path>', description: 'Unity project path (root global).' },
  { short: '-u', long: '--url', arg: '<url>', description: 'Override server URL (root global).' },
  { short: '-t', long: '--token', arg: '<token>', description: 'Override bearer auth token (root global).' },
  { long: '--json', arg: '', description: 'Output raw JSON to stdout (root global).' },
  { long: '--verbose', arg: '', description: 'Print verbose diagnostics to stderr (root global).' },
  { long: '--timeout-ms', arg: '<ms>', description: 'Per-request timeout in milliseconds (root global).' },
  { long: '--timeout', arg: '<ms>', description: 'Deprecated alias for --timeout-ms (root global).' },
];

function applyGlobalPassthroughOptions(program: Command): void {
  const visit = (cmd: Command): void => {
    if (cmd.name() !== 'help') {
      for (const spec of PASSTHROUGH_OPTIONS) {
        if (hasLongOption(cmd, spec.long)) continue;
        if (spec.arg === '') cmd.option(spec.long, spec.description);
        else cmd.option(`${spec.short ? `${spec.short}, ` : ''}${spec.long} ${spec.arg}`, spec.description);
      }
    }
    for (const child of cmd.commands) visit(child);
  };
  for (const child of program.commands) visit(child);
}

function hasLongOption(cmd: Command, long: string): boolean {
  return cmd.options.some((option) => option.long === long);
}
