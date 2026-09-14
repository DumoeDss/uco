// COCli-10 regression: option routing under enablePositionalOptions.
//
// Historically the root program consumed same-named options (notably
// --timeout-ms/--timeout) placed AFTER the subcommand name, so e.g.
// `wait-for-ready --timeout-ms 45000` never reached the command and its own
// default always won (feedback stage197/263: the wait always ran 120s). The
// fix enables positional option scoping and re-registers the shared globals
// on every subcommand; these tests pin the full routing matrix so neither
// the shadowing bug nor the enablePositionalOptions regression (globals
// after the subcommand becoming `unknown option`) can return.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildProgram } from '../src/program.js';

afterEach(() => {
  vi.restoreAllMocks();
});

function freshProgram() {
  return buildProgram().exitOverride();
}

function commandNamed(program: ReturnType<typeof buildProgram>, name: string) {
  const command = program.commands.find((entry) => entry.name() === name);
  expect(command, `command ${name} is registered`).toBeDefined();
  return command!;
}

describe('option routing under enablePositionalOptions', () => {
  it('routes a post-subcommand --timeout-ms to wait-for-ready instead of the root shadow', async () => {
    const program = freshProgram();
    const wait = commandNamed(program, 'wait-for-ready');
    wait.action(() => {});
    await program.parseAsync(['node', 'uco', 'wait-for-ready', '.', '--timeout-ms', '45000']);

    expect(wait.opts().timeoutMs).toBe('45000');
    // The command's deprecated alias must not materialize from a default.
    expect(wait.opts().timeout).toBeUndefined();
    // The root stopped parsing at the first positional, so it never saw the flag.
    expect(program.opts().timeoutMs).toBeUndefined();
    expect(program.opts().timeout).toBe('60000');
  });

  it('routes a post-subcommand deprecated --timeout alias to wait-for-ready', async () => {
    const program = freshProgram();
    const wait = commandNamed(program, 'wait-for-ready');
    wait.action(() => {});
    await program.parseAsync(['node', 'uco', 'wait-for-ready', '.', '--timeout', '180000']);

    expect(wait.opts().timeout).toBe('180000');
    expect(wait.opts().timeoutMs).toBeUndefined();
  });

  it('keeps a pre-subcommand global on the root while the command stays default-free', async () => {
    const program = freshProgram();
    const wait = commandNamed(program, 'wait-for-ready');
    wait.action(() => {});
    await program.parseAsync(['node', 'uco', '--timeout-ms', '30000', 'wait-for-ready', '.']);

    expect(program.opts().timeoutMs).toBe('30000');
    expect(wait.opts().timeoutMs).toBeUndefined();
    expect(wait.opts().timeout).toBeUndefined();
  });

  it('still accepts globals placed after the subcommand via the passthrough registrations', async () => {
    const program = freshProgram();
    const exec = commandNamed(program, 'exec');
    const observed: unknown[] = [];
    exec.action(function (this: typeof exec, ...args: unknown[]) {
      observed.push(this.opts());
    });
    await program.parseAsync(['node', 'uco', 'exec', '--json', '--verbose']);

    expect(observed[0]).toMatchObject({ json: true, verbose: true });
    expect(program.opts().json).toBeUndefined();
  });

  it('keeps globals working in front of the subcommand as well', async () => {
    const program = freshProgram();
    const exec = commandNamed(program, 'exec');
    const observed: unknown[] = [];
    exec.action(function (this: typeof exec) {
      observed.push(this.opts());
    });
    await program.parseAsync(['node', 'uco', '--json', 'exec']);

    expect(program.opts().json).toBe(true);
    expect(observed[0]).toMatchObject({});
  });

  it('does not shadow a generated command\'s own same-named options', async () => {
    const program = freshProgram();
    const close = commandNamed(program, 'close');
    close.action(() => {});
    // close owns --timeout (seconds); the post-subcommand flag must reach it.
    await program.parseAsync(['node', 'uco', 'close', '.', '--timeout', '60']);
    expect(close.opts().timeout).toBe('60');
    expect(program.opts().timeout).toBe('60000');
  });

  it('parses globals after a generated tool command without unknown-option errors', async () => {
    const program = freshProgram();
    const sceneSave = commandNamed(program, 'scene-save');
    const observed: unknown[] = [];
    sceneSave.action(function (this: typeof sceneSave) {
      observed.push(this.opts());
    });
    await program.parseAsync(['node', 'uco', 'scene-save', '--json', '--project', 'X:\\proj']);

    expect(observed[0]).toMatchObject({ json: true, project: 'X:\\proj' });
  });
});
