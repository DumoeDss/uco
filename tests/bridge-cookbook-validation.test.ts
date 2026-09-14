// Bridge cookbook validation (COCli-08) — every command, flag, and exit code
// referenced by docs/bridge-cookbook.md must exist on the shipped CLI command
// registry, so recipes cannot drift into fictional flags.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildProgram } from '../src/program.js';
import type { Command } from 'commander';

const PACKAGE_ROOT = process.cwd();
const COOKBOOK = path.join(PACKAGE_ROOT, 'docs', 'bridge-cookbook.md');

interface CommandIndex {
  /** Full command path ('uco tests-run') -> set of long option names. */
  commands: Map<string, Set<string>>;
  rootOptions: Set<string>;
}

function indexProgram(): CommandIndex {
  const program = buildProgram();
  const commands = new Map<string, Set<string>>();
  const rootOptions = new Set<string>();

  const optionNames = (cmd: Command): Set<string> => {
    const names = new Set<string>();
    for (const option of cmd.options) {
      for (const flag of option.flags.matchAll(/--([a-z0-9-]+)/gi)) {
        names.add(flag[1]!);
      }
    }
    // Commander merges parent options into a subcommand's effective opts.
    return names;
  };

  for (const option of program.options) {
    for (const flag of option.flags.matchAll(/--([a-z0-9-]+)/gi)) {
      rootOptions.add(flag[1]!);
    }
  }

  const walk = (cmd: Command, prefix: string, inherited: Set<string>): void => {
    const merged = new Set([...inherited, ...optionNames(cmd)]);
    for (const child of cmd.commands) {
      const childPath = `${prefix} ${child.name()}`;
      commands.set(childPath, new Set([...merged, ...optionNames(child)]));
      walk(child, childPath, merged);
    }
  };
  walk(program, 'uco', rootOptions);

  return { commands, rootOptions };
}

interface CookbookCommand {
  line: string;
  path: string[];
  flags: string[];
}

function extractCookbookCommands(markdown: string): CookbookCommand[] {
  const results: CookbookCommand[] = [];
  const lines = markdown.split('\n');
  let inFence = false;
  // Shell continuation lines (trailing backslash) are joined so multi-line
  // recipes are validated as one command with all of their flags.
  const logical: string[] = [];
  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (line.trimStart().startsWith('```')) {
      inFence = !inFence;
      continue;
    }
    if (!inFence) continue;
    const trimmedStart = line.trimStart();
    if (trimmedStart.startsWith('uco ') && line.endsWith('\\')) {
      logical.push(trimmedStart.slice(0, -1));
      continue;
    }
    if (logical.length > 0) {
      if (line.endsWith('\\')) {
        logical.push(trimmedStart.slice(0, -1));
        continue;
      }
      logical.push(trimmedStart);
      const joined = logical.join(' ');
      logical.length = 0;
      pushCommand(joined, results);
      continue;
    }
    if (trimmedStart.startsWith('uco ')) {
      pushCommand(trimmedStart, results);
    }
  }
  return results;
}

function pushCommand(line: string, results: CookbookCommand[]): void {
  const tokens = line
    .split(/\s+/)
    .slice(1)
    .filter((token) => token.length > 0);
  const pathSegments: string[] = [];
  const flags: string[] = [];
  for (const token of tokens) {
    if (token.startsWith('--')) {
      flags.push(token.replace(/^--/, '').split(/[= ]/)[0]!);
      continue;
    }
    if (token.startsWith('-') && token.length > 1) continue;
    if (pathSegments.length > 0 && !/^[a-z0-9][a-z0-9-]*$/i.test(token)) break;
    if (flags.length > 0) continue; // positional values after flags end the path
    pathSegments.push(token);
  }
  results.push({
    line,
    path: ['uco', ...pathSegments],
    flags,
  });
}

/** Exit codes cited anywhere in the cookbook (e.g. "exit 5", "→ 6"). */
function extractCitedExitCodes(markdown: string): number[] {
  const codes = new Set<number>();
  for (const match of markdown.matchAll(/exit\s+(?:code\s+)?(\d+)/gi)) {
    codes.add(Number(match[1]));
  }
  for (const match of markdown.matchAll(/→\s*(\d+)/g)) {
    codes.add(Number(match[1]));
  }
  return [...codes];
}

const KNOWN_EXIT_CODES = new Set([0, 1, 2, 3, 4, 5, 6, 7]);

describe('bridge cookbook validation', () => {
  const markdown = fs.readFileSync(COOKBOOK, 'utf8');
  const index = indexProgram();
  const cookbookCommands = extractCookbookCommands(markdown);

  it('the cookbook references commands at all', () => {
    // Five recipes reference seven command invocations (wait-for-ready twice).
    expect(cookbookCommands.length).toBeGreaterThanOrEqual(7);
  });

  for (const entry of cookbookCommands) {
    it(`references a real command with real flags: ${entry.line.trim().split('\n')[0]}`, () => {
      // The deepest indexed command path that is a prefix of the cited path.
      // Generated tools are leaf commands; devops commands may be nested.
      let matched: { name: string; options: Set<string> } | undefined;
      for (let depth = entry.path.length; depth >= 2; depth--) {
        const candidate = entry.path.slice(0, depth).join(' ');
        const options = index.commands.get(candidate);
        if (options !== undefined) {
          matched = { name: candidate, options };
          break;
        }
      }
      expect(
        matched,
        `command path '${entry.path.join(' ')}' not found in the CLI registry`,
      ).toBeDefined();

      for (const flag of entry.flags) {
        expect(
          matched!.options.has(flag),
          `flag '--${flag}' does not exist on '${matched!.name}'`,
        ).toBe(true);
      }
    });
  }

  it('cites only documented exit codes', () => {
    const cited = extractCitedExitCodes(markdown);
    expect(cited.length).toBeGreaterThan(0);
    const unknown = cited.filter((code) => !KNOWN_EXIT_CODES.has(code));
    expect(unknown, `unknown exit codes cited: ${unknown.join(', ')}`).toEqual([]);
  });

  it('documents all five required recipes', () => {
    expect(markdown).toContain('Recipe 1 — Connect to a chosen project');
    expect(markdown).toContain('Recipe 2 — Wait for compilation');
    expect(markdown).toContain('Recipe 3 — Fresh EditMode test run');
    expect(markdown).toContain('Recipe 4 — Read only the console errors');
    expect(markdown).toContain('Recipe 5 — Run a script in a disposable scene');
    expect(markdown).toContain('## script-execute compile context');
  });

  it('the identity and wait flags used by the recipes exist on tool commands', () => {
    const callOptions = index.commands.get('uco call')!;
    for (const flag of [
      'expected-project-path',
      'expected-instance-id',
      'expected-pid',
      'wait',
      'wait-timeout-ms',
      'wait-until-idle',
      'idle-timeout-ms',
      'request-id',
      'control',
      'confirm',
      'confirmation',
    ]) {
      expect(callOptions.has(flag), `uco call must expose --${flag}`).toBe(true);
    }
    const waitReadyOptions = index.commands.get('uco wait-for-ready')!;
    for (const flag of ['expected-project-path', 'expected-instance-id', 'expected-pid', 'timeout-ms']) {
      expect(waitReadyOptions.has(flag), `uco wait-for-ready must expose --${flag}`).toBe(true);
    }
  });
});
