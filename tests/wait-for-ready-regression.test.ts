import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { editorReadiness } from '../src/commands/devops/wait-for-ready.js';
import { buildProgram } from '../src/program.js';
import { RestTransport } from '../src/transport/rest.js';
import { TransportError } from '../src/util/errors.js';

const temporaryDirectories: string[] = [];

function projectWithConnection(host: string): string {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'uco-wait-ready-'));
  temporaryDirectories.push(project);
  const settings = path.join(project, 'UserSettings');
  fs.mkdirSync(settings);
  fs.writeFileSync(
    path.join(settings, 'AI-Game-Developer-Config.json'),
    JSON.stringify({ host }),
  );
  return project;
}

// COCli-10: the fixture previously hand-rolled a root that OMITTED
// --timeout-ms, so the option-shadowing bug (the root consuming post-
// subcommand flags) could not reproduce here. Build the real program so the
// regression surface matches production.
function rootProgram(): Command {
  return buildProgram().exitOverride();
}

async function runWait(tokens: readonly string[]): Promise<Record<string, unknown>> {
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const program = rootProgram();
  await program.parseAsync(['node', 'uco', ...tokens]);
  return JSON.parse(stdout.mock.calls.map(([chunk]) => String(chunk)).join('')) as Record<string, unknown>;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('wait-for-ready project connection context', () => {
  it('uses the positional project ahead of a suffix root --project without network access', async () => {
    const positionalProject = projectWithConnection('http://positional.example:23456');
    const rootProject = projectWithConnection('http://root.example:34567');
    const health = vi.spyOn(RestTransport.prototype, 'health').mockResolvedValue(readyHealth());
    const probe = vi.spyOn(RestTransport.prototype, 'callTool').mockResolvedValue({
      status: 'success', structured: { result: editorState() },
    });

    const result = await runWait([
      'wait-for-ready', positionalProject, '--project', rootProject, '--json',
    ]);

    expect(health).toHaveBeenCalledOnce();
    expect(probe).toHaveBeenCalledWith('editor-application-get-state', {}, expect.any(Object));
    expect(result).toMatchObject({
      ok: true,
      url: 'http://positional.example:23456',
      attempts: 1,
      ready: true,
      stages: { toolRunner: { ready: true }, editor: { ready: true }, probe: { ready: true } },
    });
  });

  it('retains root --project connection resolution when the positional is omitted', async () => {
    const rootProject = projectWithConnection('http://root.example:34567');
    const health = vi.spyOn(RestTransport.prototype, 'health').mockResolvedValue(readyHealth());
    vi.spyOn(RestTransport.prototype, 'callTool').mockResolvedValue({
      status: 'success', structured: { result: editorState() },
    });

    const result = await runWait([
      'wait-for-ready', '--project', rootProject, '--json',
    ]);

    expect(health).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ ok: true, url: 'http://root.example:34567' });
  });

  it.each([
    ['compilation', { IsCompiling: true }, 'compiling'],
    ['asset update/import', { IsUpdating: true }, 'updating-or-importing'],
    ['domain reload', { IsReloading: true }, 'domain-reloading'],
    ['entering PlayMode', { IsPlaying: false, IsPlayingOrWillChangePlaymode: true }, 'play-mode-transition'],
    ['exiting PlayMode', { IsPlaying: true, IsPlayingOrWillChangePlaymode: false }, 'play-mode-transition'],
  ])('rejects the installed nested PascalCase %s state', (_label, overrides, cause) => {
    expect(editorReadiness({
      status: 'success',
      StructuredContent: { Result: editorState(overrides) },
    })).toEqual({ ready: false, stage: 'editor', cause });
  });

  it('accepts stable EditMode and stable PlayMode but rejects unknown state shapes', () => {
    expect(editorReadiness({ structured: { result: editorState() } })).toEqual({
      ready: true,
      stage: 'probe',
      cause: 'ready',
    });
    expect(editorReadiness({
      structured: { result: editorState({ IsPlaying: true, IsPlayingOrWillChangePlaymode: true }) },
    })).toEqual({ ready: true, stage: 'probe', cause: 'ready' });
    expect(editorReadiness({ structured: { result: {} } })).toEqual({
      ready: false,
      stage: 'editor',
      cause: 'invalid-editor-state',
    });
    const missingCompiling = editorState();
    delete missingCompiling['IsCompiling'];
    expect(editorReadiness({ structured: { result: missingCompiling } })).toEqual({
      ready: false,
      stage: 'editor',
      cause: 'missing-editor-state-fields:isCompiling',
    });
  });

  it('preserves a nested probe failure as the probe stage', () => {
    expect(editorReadiness({
      Value: { Structured: { Result: { Ok: false, Error: 'probe unavailable' } } },
    })).toEqual({
      ready: false,
      stage: 'probe',
      cause: 'editor-probe-failed:probe unavailable',
    });
  });

  it('returns health connection/generation and per-stage timing while bounding each probe to the remaining budget', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(10_000));
    const health = vi.spyOn(RestTransport.prototype, 'health').mockImplementation(async () => {
      vi.setSystemTime(new Date(10_008));
      return readyHealth();
    });
    const probe = vi.spyOn(RestTransport.prototype, 'callTool').mockResolvedValue({
      status: 'success', structured: { result: editorState() },
    });

    const result = await runWait([
      'wait-for-ready', '--url', 'http://root.example:34567', '--json',
      '--timeout-ms', '10', '--interval', '10',
    ]);

    expect(health).toHaveBeenCalledWith({ timeoutMs: 10 });
    expect(probe).toHaveBeenCalledWith(
      'editor-application-get-state',
      {},
      { timeoutMs: 2 },
    );
    expect(result).toMatchObject({
      connection: { id: 'c17', instanceId: 'fixture-instance' },
      generation: 'c17',
      stages: {
        process: { ready: true, elapsedMs: 8 },
        toolRunner: { ready: true, elapsedMs: 8 },
        editor: { ready: true, elapsedMs: 8 },
        probe: { ready: true, elapsedMs: 8 },
      },
      timing: {
        totalElapsedMs: 8,
        stages: {
          process: { elapsedMs: 8 },
          editor: { elapsedMs: 8 },
          probe: { elapsedMs: 8 },
        },
      },
    });
  });

  it('keeps Editor probe transport failures attributed to the editor stage', async () => {
    vi.useFakeTimers();
    vi.spyOn(RestTransport.prototype, 'health').mockResolvedValue(readyHealth());
    vi.spyOn(RestTransport.prototype, 'callTool').mockRejectedValue(new TransportError({
      kind: 'timeout',
      url: 'http://root.example:34567/api/tools/editor-application-get-state',
      method: 'POST',
      message: 'late',
    }));
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code ?? 0}`);
    }) as never);
    const program = rootProgram();
    const pending = program.parseAsync([
      'node', 'uco', 'wait-for-ready', '--url', 'http://root.example:34567', '--json',
      '--timeout-ms', '10', '--interval', '10',
    ]);
    const rejection = expect(pending).rejects.toThrow('exit:3');
    await vi.runAllTimersAsync();
    await rejection;

    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(stderr.mock.calls[0]?.[0]))).toMatchObject({
      ok: false,
      error: {
        code: 'wait-timeout',
        retryable: true,
        details: { stage: 'editor', cause: 'timeout', attempts: 1 },
      },
    });
  });

  it('does not start an Editor probe after the health call exhausts the total budget', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(20_000));
    vi.spyOn(RestTransport.prototype, 'health').mockImplementation(async () => {
      vi.setSystemTime(new Date(20_010));
      return readyHealth();
    });
    const probe = vi.spyOn(RestTransport.prototype, 'callTool');
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code ?? 0}`);
    }) as never);
    const program = rootProgram();

    await expect(program.parseAsync([
      'node', 'uco', 'wait-for-ready', '--url', 'http://root.example:34567', '--json',
      '--timeout-ms', '10', '--interval', '10',
    ])).rejects.toThrow('exit:3');

    expect(probe).not.toHaveBeenCalled();
    expect(JSON.parse(String(stderr.mock.calls[0]?.[0]))).toMatchObject({
      error: {
        details: {
          stage: 'editor',
          cause: 'budget-exhausted',
          generation: 'c17',
          timing: { totalElapsedMs: 10 },
        },
      },
    });
  });
});

function readyHealth(): Record<string, unknown> {
  return {
    ok: true,
    generation: 'c17',
    connection: { id: 'c17', instanceId: 'fixture-instance' },
    stages: {
      process: { ready: true },
      http: { ready: true },
      webSocket: { ready: true },
      handshake: { ready: true },
      capabilities: { ready: true },
      toolRunner: { ready: true },
    },
  };
}

function editorState(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    IsPlaying: false,
    IsPaused: false,
    IsCompiling: false,
    IsPlayingOrWillChangePlaymode: false,
    IsUpdating: false,
    TimeSinceStartup: 12.5,
    Blockers: [],
    ...overrides,
  };
}
